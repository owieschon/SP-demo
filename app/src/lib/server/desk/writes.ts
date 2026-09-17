// Every write the desk makes, and there are only eight of them.
//
// Each one is a call to the SQL function of the same name in migration 0021,
// which claims the request id, checks who is asking, checks the row version
// and writes the audit row. Nothing in this file decides anything; it exists
// so the rest of the app never writes SQL by hand and never forgets a request
// id.
import { z } from 'zod';
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';

const requestId = z.string().min(8).max(100);
const rowVersion = z.iso.datetime({ offset: true });

interface WriteRow<T> {
	result: T;
}

// ---------------------------------------------------------------------------
// The agent's writes (inside the run's own transaction)
// ---------------------------------------------------------------------------

export interface IncomingMessage {
	mailboxId: number;
	providerMessageId: string | null;
	providerThreadId: string | null;
	fromAddress: string;
	fromName: string;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	bodyStripped: string;
	receivedAt: string;
	attachments: {
		provider_attachment_id?: string | null;
		file_name: string;
		media_type: string;
		size_bytes: number;
		base64?: string;
		document_attachment_id?: number | null;
	}[];
}

/** Store one inbound message. `duplicate` means it was already here. */
export async function recordMessage(
	tx: Tx,
	input: IncomingMessage,
	request: string
): Promise<{ messageId: number; duplicate: boolean }> {
	const [row] = await tx.sql<WriteRow<{ message_id: number; duplicate: boolean }>>`
		select nl.record_mail_message(
			${input.mailboxId}, ${input.providerMessageId}, ${input.providerThreadId},
			${input.fromAddress}, ${input.fromName},
			array(select jsonb_array_elements_text(${JSON.stringify(input.to)}::jsonb)),
			array(select jsonb_array_elements_text(${JSON.stringify(input.cc)}::jsonb)),
			${input.subject}, ${input.body}, ${input.bodyStripped}, ${input.receivedAt}::timestamptz,
			${JSON.stringify(input.attachments)}::jsonb, ${request}) as result`;
	return { messageId: row.result.message_id, duplicate: row.result.duplicate === true };
}

export async function startRun(
	tx: Tx,
	input: { messageId: number; mode: 'mock' | 'live'; model: string | null },
	request: string
): Promise<{ runId: number; runsToday: number; cap: number }> {
	const [row] = await tx.sql<WriteRow<{ run_id: number; runs_today: number; cap: number }>>`
		select nl.start_mail_run(${input.messageId}, ${input.mode}, ${input.model}, ${request}) as result`;
	return { runId: row.result.run_id, runsToday: row.result.runs_today, cap: row.result.cap };
}

export interface FinishRun {
	runId: number;
	outcome: 'drafted' | 'needs_person' | 'ignored' | 'failed';
	intent: string | null;
	confidence: number | null;
	summary: string;
	customerNo: string | null;
	vendorNo: string | null;
	contactId: number | null;
	matchReason: string;
	messageStatus: 'drafted' | 'needs_person' | 'ignored' | 'working';
	lookups: unknown[];
	rounds: number;
	inputTokens: number;
	outputTokens: number;
	draftId: number | null;
	rfqDraftId: number | null;
	error: string | null;
}

export async function finishRun(tx: Tx, input: FinishRun, request: string): Promise<void> {
	await tx.sql`
		select nl.finish_mail_run(
			${input.runId}, ${input.outcome}, ${input.intent}, ${input.confidence},
			${input.summary}, ${input.customerNo}, ${input.vendorNo}, ${input.contactId},
			${input.matchReason}, ${input.messageStatus},
			${JSON.stringify(input.lookups)}::jsonb, ${input.rounds},
			${input.inputTokens}, ${input.outputTokens},
			${input.draftId}, ${input.rfqDraftId}, ${input.error}, ${request})`;
}

export interface QueueDraft {
	mailboxId: number;
	inReplyToId: number | null;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	intent: string;
	facts: unknown[];
	attachments: unknown[];
	blockedReason: string;
}

export async function queueDraft(tx: Tx, input: QueueDraft, request: string): Promise<{ draftId: number }> {
	const [row] = await tx.sql<WriteRow<{ draft_id: number }>>`
		select nl.queue_mail_draft(
			${input.mailboxId}, ${input.inReplyToId},
			array(select jsonb_array_elements_text(${JSON.stringify(input.to)}::jsonb)),
			array(select jsonb_array_elements_text(${JSON.stringify(input.cc)}::jsonb)),
			${input.subject}, ${input.body}, ${input.intent},
			${JSON.stringify(input.facts)}::jsonb, ${JSON.stringify(input.attachments)}::jsonb,
			${input.blockedReason}, ${request}) as result`;
	return { draftId: row.result.draft_id };
}

// ---------------------------------------------------------------------------
// A person's decisions (from the queue)
// ---------------------------------------------------------------------------

const decision = { draftId: z.coerce.number().int().positive(), expectedUpdatedAt: rowVersion, requestId };

export const approveInput = z.object({
	...decision,
	// Empty means "send it as the agent wrote it".
	subject: z.string().trim().max(300).default(''),
	body: z.string().trim().max(20_000).default('')
});
export type ApproveInput = z.infer<typeof approveInput>;

export const rejectInput = z.object({ ...decision, reason: z.string().trim().max(500).default('') });
export type RejectInput = z.infer<typeof rejectInput>;

export interface DecisionResult {
	draftId: number;
	status: string;
	edited?: boolean;
	updatedAt: string;
	replayed: boolean;
}

function toDecision(row: WriteRow<Record<string, unknown>>): DecisionResult {
	return {
		draftId: Number(row.result.draft_id),
		status: String(row.result.status ?? 'approved'),
		edited: row.result.edited === true,
		updatedAt: String(row.result.updated_at),
		replayed: row.result.replayed === true
	};
}

export async function approveDraft(db: Db, userId: number, input: ApproveInput): Promise<DecisionResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<Record<string, unknown>>>`
				select nl.approve_mail_draft(${input.draftId}, ${input.subject}, ${input.body},
				                             ${input.expectedUpdatedAt}::timestamptz, ${input.requestId}) as result`
		)
	);
	return toDecision(row);
}

export async function rejectDraft(db: Db, userId: number, input: RejectInput): Promise<DecisionResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<Record<string, unknown>>>`
				select nl.reject_mail_draft(${input.draftId}, ${input.reason},
				                            ${input.expectedUpdatedAt}::timestamptz, ${input.requestId}) as result`
		)
	);
	return toDecision(row);
}

/** Only ever called after a send came back with an id. */
export async function markSent(
	db: Db,
	userId: number,
	input: { draftId: number; providerMessageId: string; requestId: string }
): Promise<DecisionResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<Record<string, unknown>>>`
				select nl.mark_mail_sent(${input.draftId}, ${input.providerMessageId}, ${input.requestId}) as result`
		)
	);
	return toDecision(row);
}

/** A transient failure leaves the draft approved; a permanent one sets failed. */
export async function markFailed(
	db: Db,
	userId: number,
	input: { draftId: number; error: string; permanent: boolean; requestId: string }
): Promise<DecisionResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<Record<string, unknown>>>`
				select nl.mark_mail_failed(${input.draftId}, ${input.error}, ${input.permanent},
				                           ${input.requestId}) as result`
		)
	);
	return toDecision(row);
}
