// A quote request somebody typed at the desk, because a customer telephoned.
//
// It is the same kind of desk item as one that arrived as mail, on purpose:
// the same message row, the same run machinery (nl.start_mail_run and
// nl.finish_mail_run from migration 0021, so the harness's run log picks it up
// with no special case), the same extractor and the same validation. It
// differs in two honest ways, and both are on the record:
//
//   * its source is a person, not mail (nl.mail_messages.source), and
//   * it drafts no reply, because nobody emailed in. The customer is on the
//     telephone. What it produces is a quote request.
//
// The reading leaves the same trail an emailed request does: the files it
// read, the lines it took out of them and where each one sat, what the
// deterministic validation accepted, and what it would not guess at.
import type { Disclosure } from '$lib/desk/types';
import type { Db } from '../db/types.ts';
import { guarded } from '../errors.ts';
import type { StoredFile } from '../documents/read.ts';
import type { ParsedDocument } from '../documents/types.ts';
import type { RequestExtraction } from '../documents/request.ts';
import { finishRun as finishMailRun, startRun as startMailRun } from '../desk/writes.ts';
import { createDraft, getDraft } from '../rfq/drafts.ts';
import { deskAgentName, deskRunKey } from './desk.ts';
import { Trail, readTrailCapabilities } from './trail.ts';
import { recordDeskRequest, recordTrail } from './writes.ts';

/** Where a hand-entered request comes from when nobody gave an address. */
export const TAKEN_BY_PERSON = 'taken-at-the-desk@northline.example';

export interface HandEntryInput {
	/** The desk it belongs to. */
	mailboxId: number;
	mailboxAddress: string;
	mailboxLabel: string;
	mailboxKind: 'orders' | 'procurement';
	disclosure: Disclosure;
	/** The customer's own address, when there is one. */
	from: string;
	fromName: string;
	subject: string;
	documents: ParsedDocument[];
	stored: StoredFile[];
	sourceName: string;
	extraction: RequestExtraction;
	requestId: string;
}

export interface HandEntryResult {
	messageId: number;
	draftId: number;
	runKey: string;
	needsReview: number;
	customerName: string | null;
}

/**
 * Enter one request by hand. Returns the desk item, the quote request read
 * out of it, and the key of the run that did the reading.
 */
export async function enterQuoteRequest(
	db: Db,
	userId: number,
	input: HandEntryInput
): Promise<HandEntryResult> {
	const request = input.requestId;
	const from = input.from.trim() === '' ? TAKEN_BY_PERSON : input.from.trim();
	const body = input.extraction.sourceText;
	const started = Date.now();

	// 1. The desk item. Its source says a person typed it.
	const message = await guarded(() =>
		db.asUser(userId, (tx) =>
			recordDeskRequest(
				tx,
				{
					mailboxId: input.mailboxId,
					from,
					fromName: input.fromName,
					subject: input.subject,
					body,
					bodyStripped: body
				},
				`${request}:item`
			)
		)
	);

	// 2. The quote request, through the same pipeline an emailed one goes
	// through: the same validation against the catalog and the account, and
	// the files kept with it so a person can open what was read.
	const created = await createDraft(db, userId, {
		source: body,
		sourceName: input.sourceName,
		extraction: input.extraction,
		attachments: input.stored,
		requestId: `${request}:request`
	});
	const draft = await getDraft(db, userId, created.draftId);
	if (!draft) {
		throw Object.assign(new Error('The quote request could not be read back.'), { code: 'NL404' });
	}
	const validation = draft.validation;
	const needsReview = validation.needs_review;
	const subject = validation.customer.customer_no;

	// 3. The run, opened and closed through the desk's own functions, so this
	// is one of the desk's runs and not a shape of its own.
	const runKey = await guarded(() =>
		db.asUser(userId, async (tx) => {
			const { runId } = await startMailRun(
				tx,
				{
					messageId: message.messageId,
					mode: input.extraction.extractor === 'claude' ? 'live' : 'mock',
					model: input.extraction.model
				},
				`${request}:run`
			);
			const key = deskRunKey(input.mailboxKind, runId);
			const capabilities = await readTrailCapabilities(tx);

			const trail = new Trail({ reader: 'internal', subject });
			trail.read(
				'The request, as it was typed',
				[
					`From ${input.fromName ? `${input.fromName}, ` : ''}${from}`,
					`Subject "${input.subject || '(none)'}"`,
					`${body.length} characters`
				].join('. ')
			);
			for (const document of input.documents) {
				if (document.kind === 'paste') continue;
				trail.read(
					`Read ${document.name}`,
					`${document.summary}. ${
						document.tables.length > 0
							? `${document.tables.length} ${document.tables.length === 1 ? 'table' : 'tables'}: where a file has columns, the columns are the lines and nothing is guessed.`
							: 'No table in it, so its text was read by the extractor.'
					}`
				);
			}

			const withSource = input.extraction.draft.lines.filter((line) => line.source).length;
			const lineCount = input.extraction.draft.lines.length;
			trail.decide(
				`Took ${lineCount} ${lineCount === 1 ? 'line' : 'lines'} out of it`,
				[
					`${withSource} of them carry the file, sheet or page and the row they came from.`,
					input.extraction.extractor === 'claude'
						? `Prose was read by ${input.extraction.model ?? 'the live model'} in ${input.extraction.extractorCalls} ${input.extraction.extractorCalls === 1 ? 'call' : 'calls'}.`
						: 'Read by the rules extractor, with no model call.'
				].join(' ')
			);

			const settled = validation.lines.filter((line) => !line.removed && line.item_no !== null).length;
			const unmatched = validation.lines.filter((line) => !line.removed && line.item_no === null);
			const validationMs = Date.now() - started;
			trail.tool(
				'validate_quote_request',
				{ quote_request_id: created.draftId, lines: validation.lines.length },
				`${settled} of ${validation.lines.length} ${validation.lines.length === 1 ? 'line' : 'lines'} matched the catalog and priced against the account. ${validation.customer.check.reason}`,
				{ rows: validation.lines.length, ms: validationMs }
			);

			for (const line of unmatched) {
				trail.refuse(
					`Did not guess at "${line.item_as_written ?? line.raw_text.slice(0, 60)}"`,
					'unresolvedLine',
					line.item_check.reason
				);
			}
			if (validation.customer.customer_no === null) {
				trail.refuse('Did not settle the account', 'unmatchedSender', validation.customer.check.reason);
			}

			trail.produce(
				`A quote request, R-${created.draftId}`,
				needsReview > 0
					? `${needsReview} ${needsReview === 1 ? 'field needs' : 'fields need'} a person before it can be approved. Nothing is created until somebody approves it.`
					: 'Every field checked out. Nothing is created until somebody approves it.'
			);

			const outcome = needsReview > 0 ? 'needs_person' : 'drafted';
			const summary = [
				`Entered at the desk by hand and read into quote request R-${created.draftId}.`,
				validation.customer.check.reason
			]
				.filter(Boolean)
				.join(' ');

			await recordTrail(
				tx,
				{
					runKey: key,
					agent: deskAgentName(input.mailboxKind),
					wokeBy: 'person',
					wokeNote: `Somebody entered a request at ${input.mailboxLabel}`,
					entity: 'mail_message',
					entityId: message.messageId,
					reader: 'internal',
					subjectNo: subject,
					bundleVersion: capabilities.bundleVersion,
					decision: summary,
					inputs: {
						kind: 'hand_entry',
						message: { id: message.messageId, from, subject: input.subject, chars: body.length },
						mailbox: {
							address: input.mailboxAddress,
							label: input.mailboxLabel,
							kind: input.mailboxKind,
							disclosure: input.disclosure
						},
						subjectNo: subject,
						quote_request_id: created.draftId
					},
					steps: trail.rows()
				},
				`${request}:trail`
			);

			// The validation is this run's one lookup, so the harness's run log
			// counts it as the tool call it is.
			await finishMailRun(
				tx,
				{
					runId,
					outcome,
					intent: 'rfq',
					confidence: 1,
					summary,
					customerNo: validation.customer.customer_no,
					vendorNo: null,
					contactId: validation.customer.contact_id,
					matchReason: validation.customer.check.reason,
					messageStatus: outcome,
					lookups: [
						{
							name: 'validate_quote_request',
							input: { quote_request_id: created.draftId, lines: validation.lines.length },
							rows: validation.lines.length,
							ms: validationMs
						}
					],
					rounds: input.extraction.extractorCalls,
					inputTokens: input.extraction.usage?.input_tokens ?? 0,
					outputTokens: input.extraction.usage?.output_tokens ?? 0,
					draftId: null,
					rfqDraftId: created.draftId,
					error: null
				},
				`${request}:finish`
			);

			return key;
		})
	);

	return {
		messageId: message.messageId,
		draftId: created.draftId,
		runKey,
		needsReview,
		customerName: validation.customer.name
	};
}
