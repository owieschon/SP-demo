// A quote request somebody typed at the desk, because a customer telephoned.
//
// It is the same kind of desk item as one that arrived as mail. It differs in
// two honest ways, and both are on the record:
//
//   * its source is a person, not mail (nl.mail_messages.source), and
//   * it produces no reply to send, because nobody emailed in. The customer
//     is on the telephone. What it produces is a quote request, read and
//     validated exactly as an emailed one is.
//
// The reading is a run like any other, woken by a person, and it leaves the
// same trail: the files it read, the lines it took out of them and where each
// one sat, what the deterministic validation accepted, and what it would not
// guess at.
import type { Disclosure } from '$lib/desk/types';
import type { RunOutcome } from '$lib/agentruns/types';
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import type { StoredFile } from '../documents/read.ts';
import type { ParsedDocument } from '../documents/types.ts';
import type { RequestExtraction } from '../documents/request.ts';
import { createDraft, getDraft } from '../rfq/drafts.ts';
import { deskAgentName } from './desk.ts';
import { Trail, readTrailCapabilities } from './trail.ts';
import { appendSteps, finishRun, recordDeskRequest, startRun } from './writes.ts';

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
	runId: number;
	needsReview: number;
	customerName: string | null;
}

async function attachDraft(
	tx: Tx,
	input: {
		messageId: number;
		draftId: number;
		status: 'drafted' | 'needs_person';
		summary: string;
		customerNo: string | null;
		contactId: number | null;
		matchReason: string;
	},
	request: string
): Promise<void> {
	await tx.sql`
		select nl.attach_desk_request_draft(
			${input.messageId}, ${input.draftId}, ${input.status}, 'rfq', 1.0,
			${input.summary}, ${input.customerNo}, ${input.contactId}, ${input.matchReason}, ${request})`;
}

/**
 * Enter one request by hand. Returns the desk item, the quote request read
 * out of it, and the run that did the reading.
 */
export async function enterQuoteRequest(
	db: Db,
	userId: number,
	input: HandEntryInput
): Promise<HandEntryResult> {
	const request = input.requestId;
	const from = input.from.trim() === '' ? TAKEN_BY_PERSON : input.from.trim();
	const body = input.extraction.sourceText;

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

	// 3. The run that did the reading.
	const started = new Date();
	const runId = await guarded(() =>
		db.asUser(userId, async (tx) => {
			const capabilities = await readTrailCapabilities(tx);
			const subject = validation.customer.customer_no;
			const { runId: id } = await startRun(
				tx,
				{
					agent: deskAgentName(input.mailboxKind),
					wokeBy: 'person',
					wokeNote: `Somebody entered a request at ${input.mailboxLabel}`,
					entity: 'mail_message',
					entityId: message.messageId,
					reader: 'internal',
					subjectNo: subject,
					mode: input.extraction.extractor === 'claude' ? 'live' : 'mock',
					model: input.extraction.model,
					bundleVersion: capabilities.bundleVersion,
					inputs: {
						kind: 'hand_entry',
						message: { id: message.messageId, from, subject: input.subject, chars: body.length },
						mailbox: {
							id: input.mailboxId,
							address: input.mailboxAddress,
							label: input.mailboxLabel,
							kind: input.mailboxKind,
							disclosure: input.disclosure
						},
						subjectNo: subject,
						quote_request_id: created.draftId
					},
					replayOf: null,
					sourceKind: 'hand_entry',
					sourceId: message.messageId,
					startedAt: started.toISOString()
				},
				`${request}:run`
			);

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
					`${document.summary}. ${document.tables.length > 0 ? `${document.tables.length} ${document.tables.length === 1 ? 'table' : 'tables'}: where a file has columns, the columns are the lines and no extractor guesses.` : 'No table in it, so its text was read by the extractor.'}`
				);
			}

			const withSource = input.extraction.draft.lines.filter((line) => line.source).length;
			trail.decide(
				`Took ${input.extraction.draft.lines.length} ${input.extraction.draft.lines.length === 1 ? 'line' : 'lines'} out of it`,
				[
					`${withSource} of them carry the file, sheet or page and the row they came from.`,
					input.extraction.extractor === 'claude'
						? `Prose was read by ${input.extraction.model ?? 'the live model'} in ${input.extraction.extractorCalls} ${input.extraction.extractorCalls === 1 ? 'call' : 'calls'}.`
						: 'Read by the rules extractor, with no model call.'
				].join(' ')
			);

			const settled = validation.lines.filter((line) => !line.removed && line.item_no !== null).length;
			const unmatched = validation.lines.filter((line) => !line.removed && line.item_no === null);
			trail.tool(
				'validate_quote_request',
				{ quote_request_id: created.draftId, lines: validation.lines.length },
				`${settled} of ${validation.lines.length} ${validation.lines.length === 1 ? 'line' : 'lines'} matched the catalog and priced against the account. ${validation.customer.check.reason}`,
				{ rows: validation.lines.length }
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

			await appendSteps(tx, id, trail.rows(), `${request}:steps`);

			const outcome: Exclude<RunOutcome, 'running'> = needsReview > 0 ? 'needs_person' : 'drafted';
			const summary = [
				`Entered at the desk by hand and read into quote request R-${created.draftId}.`,
				validation.customer.check.reason
			]
				.filter(Boolean)
				.join(' ');

			await attachDraft(
				tx,
				{
					messageId: message.messageId,
					draftId: created.draftId,
					status: outcome,
					summary,
					customerNo: validation.customer.customer_no,
					contactId: validation.customer.contact_id,
					matchReason: validation.customer.check.reason
				},
				`${request}:attach`
			);

			await finishRun(
				tx,
				{
					runId: id,
					outcome,
					decision: summary,
					durationMs: Math.max(0, Date.now() - started.getTime()),
					inputTokens: input.extraction.usage?.input_tokens ?? 0,
					outputTokens: input.extraction.usage?.output_tokens ?? 0,
					producedKind: 'quote_request',
					producedId: created.draftId,
					produced: { quote_request_id: created.draftId, needs_review: needsReview },
					diff: null,
					error: null
				},
				`${request}:finish`
			);
			return id;
		})
	);

	return {
		messageId: message.messageId,
		draftId: created.draftId,
		runId,
		needsReview,
		customerName: validation.customer.name
	};
}
