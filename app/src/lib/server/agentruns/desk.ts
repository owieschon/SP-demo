// The order desk's runs, as a trail.
//
// The desk agent already keeps a record of its own work: migration 0021
// stores one row per run with every lookup on it, the message it worked
// carries what it decided, and migration 0028 reads both into nl.agent_runs
// under the key '<agent>:<mail_run_id>'. This file reads that same record and
// writes the trail beside it, which is why it does not touch the agent's code
// at all. The agent runs; the trail is taken from what the agent recorded,
// under the harness's own key.
//
// It is idempotent on that key, so the same work is never transcribed twice
// however many times a poll, a retry or a page asks for it.
//
// What it cannot show, it says. The desk records each lookup's name, its
// arguments, how many rows came back and how long it took, and not the rows
// themselves, so the trail says "eight rows back" and not what was in them.
// docs/agent-runs.md says what a real deployment would add.
import type { Disclosure, Fact, Intent } from '$lib/desk/types';
import { INTENT_LABEL } from '$lib/desk/types';
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import { LOW_CONFIDENCE } from '../desk/classify.ts';
import { Trail, readTrailCapabilities } from './trail.ts';
import { recordTrail } from './writes.ts';

/** The agent behind each desk, in the harness's vocabulary. */
export function deskAgentName(kind: 'orders' | 'procurement'): string {
	return kind === 'orders' ? 'order_desk' : 'procurement_desk';
}

/** The harness's key for one desk run (migration 0028). */
export function deskRunKey(kind: 'orders' | 'procurement', mailRunId: number): string {
	return `${deskAgentName(kind)}:${mailRunId}`;
}

export interface ItemSource {
	/** How this desk item arrived. */
	source: 'mail' | 'person';
	/** Who typed it, when a person did. */
	enteredByName: string | null;
}

/**
 * How one desk item arrived. Two columns migration 0039 added, read on their
 * own rather than widening the desk's own query.
 */
export async function readItemSource(
	db: Db,
	userId: number,
	messageId: number
): Promise<ItemSource | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ source: 'mail' | 'person'; entered_by_name: string | null }>`
			select m.source, u.full_name as entered_by_name
			from nl.mail_messages m
			left join nl.users u on u.id = m.entered_by
			where m.id = ${messageId}`
	);
	return row ? { source: row.source, enteredByName: row.entered_by_name } : null;
}

/** The desk item one quote request was read out of, when there is one. */
export async function findDeskItem(
	db: Db,
	userId: number,
	quoteRequestId: number
): Promise<{ messageId: number; source: 'mail' | 'person' } | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ id: number; source: 'mail' | 'person' }>`
			select id, source from nl.mail_messages
			where rfq_draft_id = ${quoteRequestId}
			order by id desc limit 1`
	);
	return row ? { messageId: row.id, source: row.source } : null;
}

interface SourceRow {
	run_id: number;
	mode: 'mock' | 'live';
	model: string | null;
	lookups: { name: string; input: Record<string, unknown>; rows: number; ms: number }[];
	rounds: number;
	run_outcome: 'running' | 'drafted' | 'needs_person' | 'ignored' | 'failed';
	draft_id: number | null;
	run_error: string | null;
	message_id: number;
	from_address: string;
	from_name: string;
	subject: string;
	body_text: string;
	body_stripped: string;
	message_source: 'mail' | 'person';
	intent: Intent | null;
	intent_confidence: number | null;
	summary: string;
	customer_no: string | null;
	vendor_no: string | null;
	match_reason: string;
	rfq_draft_id: number | null;
	attachments: number;
	mailbox_address: string;
	mailbox_label: string;
	mailbox_kind: 'orders' | 'procurement';
	disclosure: Disclosure;
	entered_by_name: string | null;
	draft_subject: string | null;
	draft_body: string | null;
	draft_facts: Fact[] | null;
	blocked_reason: string | null;
	today: string;
}

async function readSource(tx: Tx, mailRunId: number): Promise<SourceRow | null> {
	const [row] = await tx.sql<SourceRow>`
		select r.id as run_id, r.mode, r.model, r.lookups, r.rounds,
		       r.outcome as run_outcome, r.draft_id, r.error as run_error,
		       m.id as message_id, m.from_address, m.from_name, m.subject, m.body_text,
		       m.body_stripped, m.source as message_source, m.intent,
		       m.intent_confidence, m.summary, m.customer_no, m.vendor_no, m.match_reason,
		       m.rfq_draft_id,
		       (select count(*)::int from nl.mail_attachments a where a.message_id = m.id) as attachments,
		       b.address as mailbox_address, b.label as mailbox_label, b.kind as mailbox_kind,
		       b.disclosure, eu.full_name as entered_by_name,
		       d.subject as draft_subject, d.body as draft_body, d.facts as draft_facts,
		       d.blocked_reason,
		       nl.today() as today
		from nl.mail_runs r
		join nl.mail_messages m on m.id = r.message_id
		join nl.mailboxes b on b.id = r.mailbox_id
		left join nl.users eu on eu.id = m.entered_by
		left join nl.mail_drafts d on d.id = r.draft_id
		where r.id = ${mailRunId}`;
	return row ?? null;
}

/** The sentences a held draft was held for, as the desk stored them. */
function heldReasons(row: SourceRow, given: string[] | undefined): string[] {
	if (given && given.length > 0) return given;
	const stored = (row.blocked_reason ?? '').trim();
	if (stored === '') return [];
	// The desk joins its reasons with a space and each one ends in a full
	// stop, which is the only seam there is to cut on.
	return stored
		.split(/(?<=\.)\s+/)
		.map((part) => part.trim())
		.filter(Boolean);
}

/**
 * The first sentence of the run's summary, which is the classifier's own
 * reason: the desk joins the classifier's reason, the sender match and
 * anything it asked, in that order, each ending in a full stop (see
 * ../desk/run.ts). The split needs whitespace after the stop, so an address
 * or a part number with a dot in it does not split.
 */
function classifierReason(summary: string): string {
	return summary.split(/(?<=\.)\s+/)[0]?.trim() ?? '';
}

/** A reason that is the "mail is data" note rather than a policy refusal. */
function isInstructionNote(reason: string): boolean {
	return reason.toLowerCase().includes('written as instructions');
}

/** Money never goes in a trail step unless the step carries the fact it came from. */
function withoutMoney(text: string): string {
	return text.replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, 'a figure');
}

function shorten(text: string, max = 1800): string {
	return text.length <= max ? text : `${text.slice(0, max)} [...]`;
}

export interface RecordDeskTrailInput {
	/** The run the desk agent recorded (nl.mail_runs.id). */
	mailRunId: number;
	/** The policy's own words, when the caller has them from the run result. */
	refusals?: string[];
	/** What let the agent in, for the record: "the Check mail button", say. */
	wokeNote?: string;
	/** The level the trail is read at. Inside the company: everything. */
	reader?: Disclosure;
}

/**
 * Write the trail for one desk run. Returns its run key, or null when there
 * is no such desk run (a message deleted under us, say).
 *
 * `userId` is the desk's reviewer, the same person the agent worked as, so
 * the trail is written under the row-level security the work happened under.
 */
export async function recordDeskTrail(
	db: Db,
	userId: number,
	input: RecordDeskTrailInput
): Promise<string | null> {
	// Deterministic, so transcribing the same run twice writes it once. The
	// user is in it because nl.request_log is per person: another person asking
	// gets their own claim and then finds the trail already there.
	const request = `trail-${input.mailRunId}-u${userId}`;

	return guarded(() =>
		db.asUser(userId, async (tx) => {
			const row = await readSource(tx, input.mailRunId);
			if (!row) return null;

			const runKey = deskRunKey(row.mailbox_kind, row.run_id);
			const reader: Disclosure = input.reader ?? 'internal';
			const subject = row.customer_no ?? row.vendor_no;
			const capabilities = await readTrailCapabilities(tx);

			// A hand-typed request was a person asking. Everything else is mail
			// arriving, whichever of the three doors it came through.
			const wokeBy = row.message_source === 'person' ? 'person' : 'mail';
			const wokeNote =
				row.message_source === 'person'
					? `${row.entered_by_name ?? 'Somebody'} entered a request at ${row.mailbox_label}`
					: (input.wokeNote ?? `Mail arrived at ${row.mailbox_address}`);

			const trail = new Trail({ reader, subject });
			const facts = row.draft_facts ?? [];
			const refusals = heldReasons(row, input.refusals);
			const policyRefusals = refusals.filter((reason) => !isInstructionNote(reason));
			const instructionNote = refusals.find(isInstructionNote) ?? null;

			// 1. What it read.
			trail.read(
				row.message_source === 'person' ? 'The request, as it was typed' : 'The message, as it arrived',
				[
					`From ${row.from_name ? `${row.from_name}, ` : ''}${row.from_address}`,
					`Subject "${row.subject || '(none)'}"`,
					`${row.body_text.length} characters`,
					row.attachments > 0
						? `${row.attachments} ${row.attachments === 1 ? 'attachment' : 'attachments'}`
						: 'no attachments'
				].join('. ')
			);
			trail.read(
				`The desk it came to: ${row.mailbox_label}`,
				`Worked as its reviewer, so the agent read under the same row-level security a person would. Replies from this desk are written at ${row.disclosure} disclosure level.`
			);

			// 2. What it made of it.
			if (row.intent) {
				trail.decide(
					`Read it as ${INTENT_LABEL[row.intent].toLowerCase()}`,
					[
						row.intent_confidence !== null ? `${Math.round(row.intent_confidence * 100)}% sure.` : '',
						row.mode === 'live'
							? `Classified by ${row.model ?? 'the live model'}.`
							: 'Classified by the rules classifier, with no model call.',
						`${row.rounds} ${row.rounds === 1 ? 'round' : 'rounds'}.`
					]
						.filter(Boolean)
						.join(' ')
				);
			}
			if (row.intent_confidence !== null && row.intent_confidence < LOW_CONFIDENCE) {
				trail.refuse(
					'Did not act on the intent it read',
					'lowConfidence',
					`It was ${Math.round(row.intent_confidence * 100)}% sure, under the ${Math.round(LOW_CONFIDENCE * 100)}% floor, so it asked a short question instead of guessing.`
				);
			}

			// 3. Who it is from.
			if (subject) {
				trail.decide('Matched the sender', row.match_reason || `Matched to ${subject}.`);
			} else {
				trail.refuse(
					'Did not price anything',
					'unmatchedSender',
					row.match_reason || 'The sender matched no contact, no domain and no company name.'
				);
			}

			// 4. Every lookup, in the order it made them, WITH what it asked.
			for (const lookup of row.lookups ?? []) {
				trail.tool(lookup.name, lookup.input ?? null, `${lookup.rows} ${lookup.rows === 1 ? 'row' : 'rows'} back.`, {
					rows: lookup.rows,
					ms: lookup.ms
				});
			}
			if ((row.lookups ?? []).length === 0) {
				trail.note('No lookup was needed', 'Nothing in this message could be answered from the book.');
			}

			// 5. What it would not do.
			for (const reason of policyRefusals) {
				trail.refuse('Refused to send the reply it wrote', 'disclosure', withoutMoney(reason));
			}
			if (instructionNote) {
				trail.refuse(
					'Read instruction-shaped text as data',
					'instructionShaped',
					'The message contains text written as instructions to an automated system. It was recorded and changed nothing about what the agent looked up or said.'
				);
			}
			const question = row.summary.match(/Asks the sender:\s*(.+)$/);
			if (question) {
				trail.refuse('Asked instead of assuming', 'questionAsked', withoutMoney(question[1].trim()));
			}

			// 6. What came out.
			if (row.draft_id !== null) {
				const held = policyRefusals.length > 0;
				const produced = [
					`Subject "${row.draft_subject ?? ''}"`,
					`${facts.length} ${facts.length === 1 ? 'fact' : 'facts'} cited.`,
					'',
					row.draft_body ?? ''
				].join('\n');
				trail.produce(
					held
						? 'A held reply, with the reason on it and nothing sendable in it'
						: 'A reply, into the queue nobody has approved yet',
					// A held draft's body is the refusal, which quotes the figure it
					// refused. That figure is by definition one no fact stands
					// behind, so it is masked rather than repeated here.
					shorten(held ? withoutMoney(produced) : produced),
					facts
				);
			}
			if (row.rfq_draft_id !== null) {
				trail.produce(
					`A quote request, R-${row.rfq_draft_id}`,
					"Put through the same validation as one a person entered, in the reviewer's name, so approving the quote and approving the reply are one flow."
				);
			}
			if (row.run_error) {
				trail.note('The run failed', row.run_error);
			}

			await recordTrail(
				tx,
				{
					runKey,
					agent: deskAgentName(row.mailbox_kind),
					wokeBy,
					wokeNote,
					entity: 'mail_message',
					entityId: row.message_id,
					reader,
					subjectNo: subject,
					bundleVersion: capabilities.bundleVersion,
					decision: row.summary || (row.run_error ?? ''),
					inputs: {
						kind: 'desk_message',
						message: {
							id: row.message_id,
							from: row.from_address,
							fromName: row.from_name,
							subject: row.subject,
							body: row.body_text,
							bodyStripped: row.body_stripped,
							today: row.today
						},
						mailbox: {
							address: row.mailbox_address,
							label: row.mailbox_label,
							kind: row.mailbox_kind,
							disclosure: row.disclosure
						},
						subjectNo: subject,
						decision: {
							intent: row.intent,
							confidence: row.intent_confidence,
							outcome: row.run_outcome,
							summary: row.summary,
							reason: classifierReason(row.summary)
						},
						draft: row.draft_id
							? {
									id: row.draft_id,
									subject: row.draft_subject,
									body: row.draft_body,
									facts
								}
							: null
					},
					steps: trail.rows()
				},
				request
			);

			return runKey;
		})
	);
}

/**
 * The trails for a whole poll. A trail that cannot be written is never a
 * reason a poll fails: the work is already done and recorded by the agent.
 */
export async function recordDeskTrails(
	db: Db,
	results: { runId: number; messageId: number; policyRefusals: string[] }[],
	options: { userId: number; wokeNote?: string }
): Promise<{ recorded: number; problems: string[] }> {
	let recorded = 0;
	const problems: string[] = [];
	for (const result of results) {
		try {
			const key = await recordDeskTrail(db, options.userId, {
				mailRunId: result.runId,
				refusals: result.policyRefusals,
				wokeNote: options.wokeNote
			});
			if (key !== null) recorded += 1;
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	return { recorded, problems };
}

/**
 * The trails for a whole poll, whichever of the three doors it came through:
 * the Check mail button, the scheduled poll or the provider's webhook. Each
 * desk's runs are transcribed as that desk's reviewer.
 */
export async function recordPollTrails(
	db: Db,
	mailboxes: { address: string; reviewerId: number }[],
	summaries: {
		mailbox: string;
		runs: { runId: number; messageId: number; policyRefusals: string[] }[];
	}[],
	wokeNote?: (address: string) => string
): Promise<number> {
	let recorded = 0;
	for (const summary of summaries) {
		const mailbox = mailboxes.find((m) => m.address === summary.mailbox);
		if (!mailbox || summary.runs.length === 0) continue;
		const result = await recordDeskTrails(db, summary.runs, {
			userId: mailbox.reviewerId,
			wokeNote: wokeNote?.(mailbox.address)
		});
		recorded += result.recorded;
	}
	return recorded;
}
