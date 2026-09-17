// Deciding one item in the workspace queue.
//
// This file routes. It does NOT approve anything itself. Every guarantee that
// matters (the request id, who may decide, the row version, the audit row, and
// the rule that what gets written comes from the stored record rather than
// from the form) belongs to the source feature's own write function, and this
// calls exactly those:
//
//   rfq        nl.revise_rfq_draft, nl.approve_rfq_draft, nl.reject_rfq_draft
//              through app/src/lib/server/rfq/drafts.ts
//   assistant  nl.decide_assistant_proposal and the assistant's own execution
//              path, through app/src/lib/server/assistant/proposals.ts
//   mail       nl.approve_mail_draft / nl.reject_mail_draft (migration 0021)
//   purchase   nl.approve_purchase_request / nl.reject_purchase_request (0022)
//
// The last two are being built elsewhere. When they are not in this database
// the queue has no rows from them and a decision on one is refused with a
// plain reason; nothing here pretends to do their work.
//
// The order of a decision, and why:
//   1. a decision already recorded under this request id is handed straight
//      back, so a double submit writes once;
//   2. the item is read from nl.agent_queue as this person. Row-level security
//      means somebody else's is simply not there, which is a 404;
//   3. the row version has to match what the page loaded, else 409;
//   4. the item has to be this person's to decide (its reviewer, or an admin),
//      else 403;
//   5. corrections first, through the source's own revise step, then the
//      source's own approve or reject;
//   6. nl.record_queue_decision writes the workspace's own history row, and
//      says whether the person corrected it first.
import { z } from 'zod';
import { AppError, guarded } from '../errors.ts';
import type { Db, Param, Tx } from '../db/types.ts';
import type { SessionUser } from '$lib/types';
import { SOURCE_LABEL, type QueueSource } from '$lib/workspace/types';
import { approveDraft, rejectDraft, reviseDraft } from '../rfq/drafts.ts';
import { decideProposal } from '../assistant/proposals.ts';

/** What a person may correct before approving, per source. */
const editSchema = z.object({
	/** Quote request: a new quantity for a line, by its position in the draft. */
	lines: z
		.array(z.object({ line: z.number().int().min(0).max(999), quantity: z.number().int().min(1).max(10_000) }))
		.max(50)
		.optional(),
	/** Quote request: a needed-by date, or '' for none. */
	neededBy: z.union([z.iso.date(), z.literal('')]).optional(),
	/** Mail draft: what the person wants sent instead. */
	subject: z.string().trim().max(300).optional(),
	body: z.string().max(20_000).optional()
});

export type QueueEdit = z.infer<typeof editSchema>;

export const decideQueueInput = z
	.object({
		source: z.enum(['rfq', 'assistant', 'mail', 'purchase']),
		sourceId: z.coerce.number().int().positive(),
		decision: z.enum(['approve', 'reject']),
		note: z.string().trim().max(500).default(''),
		expectedUpdatedAt: z.iso.datetime({ offset: true }),
		requestId: z.string().min(8).max(100),
		/** Assistant proposals only: which of its options was chosen. */
		optionIndex: z.coerce.number().int().min(0).max(2).nullable().default(null),
		/** The corrections, as JSON from the form. Absent means "as proposed". */
		edit: z
			.string()
			.max(30_000)
			.optional()
			.transform((raw, ctx) => {
				if (raw === undefined || raw.trim() === '') return undefined;
				let parsed: unknown;
				try {
					parsed = JSON.parse(raw);
				} catch {
					ctx.addIssue({ code: 'custom', message: 'The corrections were not readable.' });
					return undefined;
				}
				const checked = editSchema.safeParse(parsed);
				if (!checked.success) {
					ctx.addIssue({ code: 'custom', message: 'Those corrections are not valid.' });
					return undefined;
				}
				return checked.data;
			})
	})
	.refine((input) => input.source !== 'assistant' || input.decision === 'reject' || input.optionIndex !== null, {
		path: ['optionIndex'],
		message: 'Approving a proposal needs the option you chose.'
	});

export type DecideQueueInput = z.infer<typeof decideQueueInput>;

export interface QueueDecisionResult {
	source: QueueSource;
	sourceId: number;
	decision: 'approved' | 'edited_approved' | 'rejected';
	/** What to tell the person. */
	message: string;
	/** What the source's write returned, when it ran. */
	result: Record<string, unknown> | null;
	/** True when this decision had already been recorded under this request id. */
	replayed: boolean;
}

interface QueueItemRow {
	source: QueueSource;
	source_id: number;
	row_version: Date;
	reviewer_id: number | null;
}

export async function decideQueueItem(
	db: Db,
	user: SessionUser,
	raw: unknown
): Promise<QueueDecisionResult> {
	const parsed = decideQueueInput.safeParse(raw);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw new AppError(
			422,
			'NL422',
			`That decision does not make sense (${first.path.join('.') || 'form'}: ${first.message}).`
		);
	}
	const input = parsed.data;

	// 1. Already decided under this request id: hand back what was recorded.
	const prior = await readDecision(db, user.id, input);
	if (prior) {
		return {
			source: input.source,
			sourceId: input.sourceId,
			decision: prior,
			message: 'That decision was already recorded. Nothing was written twice.',
			result: null,
			replayed: true
		};
	}

	// 2. The item, as this person sees it.
	const [item] = await db.asUser(user.id, (tx) =>
		tx.sql<QueueItemRow>`
			select q.source, q.source_id, q.row_version, q.reviewer_id
			from nl.agent_queue q
			where q.source = ${input.source} and q.source_id = ${input.sourceId}`
	);
	if (!item) {
		throw new AppError(
			404,
			'NL404',
			`${SOURCE_LABEL[input.source]} ${input.sourceId} is not waiting in your workspace. It may have been decided already.`
		);
	}

	// 3. The row version the page loaded.
	if (item.row_version.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()) {
		throw new AppError(
			409,
			'NL409',
			`${SOURCE_LABEL[input.source]} ${input.sourceId} changed since this page loaded it. Reload and decide again.`
		);
	}

	// 4. Whose decision it is. A row with no reviewer is anyone's to decide;
	//    one with a reviewer is theirs, or an admin's.
	if (item.reviewer_id !== null && item.reviewer_id !== user.id && user.role !== 'admin') {
		throw new AppError(
			403,
			'NL403',
			`${SOURCE_LABEL[input.source]} ${input.sourceId} is waiting on someone else. Only its reviewer or an admin can decide it.`
		);
	}

	// 5. Route it to the source's own writes.
	const routed = await route(db, user, input);

	// 6. The workspace's own history. If this fails the whole decision is
	//    reported as failed, even though the source write already committed.
	//    That is the safe way round: the person tries again, the source write
	//    replays on its own request id instead of writing twice, and the
	//    history row is written on the second attempt.
	await guarded(() =>
		db.asUser(user.id, (tx) =>
			tx.sql`select nl.record_queue_decision(${input.source}, ${input.sourceId}, ${routed.decision},
			                                       ${input.note}, ${input.requestId},
			                                       ${`${input.requestId}-queue`}) as result`
		)
	);

	return {
		source: input.source,
		sourceId: input.sourceId,
		decision: routed.decision,
		message: routed.message,
		result: routed.result,
		replayed: false
	};
}

interface Routed {
	decision: QueueDecisionResult['decision'];
	message: string;
	result: Record<string, unknown> | null;
}

function route(db: Db, user: SessionUser, input: DecideQueueInput): Promise<Routed> {
	if (input.source === 'rfq') return routeRfq(db, user, input);
	if (input.source === 'assistant') return routeAssistant(db, user, input);
	return routeStoredFunction(db, user, input);
}

/** Has this exact decision already been recorded? */
async function readDecision(
	db: Db,
	userId: number,
	input: DecideQueueInput
): Promise<QueueDecisionResult['decision'] | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ decision: QueueDecisionResult['decision'] }>`
			select d.decision
			from nl.queue_decisions d
			where d.source = ${input.source} and d.source_id = ${input.sourceId}
			  and d.request_id = ${input.requestId}`
	);
	return row?.decision ?? null;
}

// ---------------------------------------------------------------------------
// Quote requests (migration 0011)
// ---------------------------------------------------------------------------

/**
 * Corrections go through nl.revise_rfq_draft one at a time, which is how the
 * quote request page does it too: the draft is re-validated on the server
 * after each one, and each carries the row version the last one returned.
 * Then nl.approve_rfq_draft, with nothing but the id, that version and a
 * request id.
 */
async function routeRfq(db: Db, user: SessionUser, input: DecideQueueInput): Promise<Routed> {
	if (input.decision === 'reject') {
		const result = await rejectDraft(db, user.id, {
			draftId: input.sourceId,
			reason: input.note,
			expectedUpdatedAt: input.expectedUpdatedAt,
			requestId: input.requestId
		});
		return {
			decision: 'rejected',
			message: 'Rejected. No quote and no commitment were created.',
			result: { ...result }
		};
	}

	let version = input.expectedUpdatedAt;
	let edited = false;
	const changes = rfqChanges(input);
	for (const [n, change] of changes.entries()) {
		const result = await reviseDraft(db, user.id, {
			...change,
			draftId: input.sourceId,
			expectedUpdatedAt: version,
			// One id per correction, derived from the decision's own id, so a
			// retry of the whole decision replays each correction instead of
			// applying it twice.
			requestId: `${input.requestId}-edit-${n + 1}`
		});
		version = result.updatedAt;
		edited = true;
	}

	const result = await approveDraft(db, user.id, {
		draftId: input.sourceId,
		expectedUpdatedAt: version,
		requestId: input.requestId
	});
	return {
		decision: edited ? 'edited_approved' : 'approved',
		message: `Approved. Quote SQ-${result.quoteId} and commitment C-${result.commitmentId} were created.`,
		result: { ...result }
	};
}

/**
 * The two corrections the queue offers, in the shape nl.revise_rfq_draft's own
 * input takes. Anything else about a quote request is corrected on its page,
 * which has the whole draft and every check beside it.
 */
type RfqCorrection =
	| { change: 'quantity'; line: number; quantity: number }
	| { change: 'needed_by'; neededBy: string };

function rfqChanges(input: DecideQueueInput): RfqCorrection[] {
	const edit = input.edit;
	if (!edit) return [];
	const changes: RfqCorrection[] = [];
	for (const line of edit.lines ?? []) {
		changes.push({ change: 'quantity', line: line.line, quantity: line.quantity });
	}
	if (edit.neededBy !== undefined) {
		changes.push({ change: 'needed_by', neededBy: edit.neededBy });
	}
	return changes;
}

// ---------------------------------------------------------------------------
// Assistant proposals (migration 0017)
// ---------------------------------------------------------------------------

/**
 * Straight to the assistant's own decideProposal, which records the decision
 * with nl.decide_assistant_proposal and then runs the chosen option through
 * the same SQL function the pages use. The conversation id it wants is read
 * from the stored proposal, not taken from the form.
 */
async function routeAssistant(db: Db, user: SessionUser, input: DecideQueueInput): Promise<Routed> {
	const [row] = await db.asUser(user.id, (tx) =>
		tx.sql<{ conversation_id: number }>`
			select p.conversation_id from nl.assistant_proposals p where p.id = ${input.sourceId}`
	);
	if (!row) {
		throw new AppError(404, 'NL404', `Proposal ${input.sourceId} does not exist.`);
	}

	const decided = await decideProposal(db, user.id, {
		proposalId: input.sourceId,
		conversationId: row.conversation_id,
		decision: input.decision,
		optionIndex: input.optionIndex,
		reason: input.note,
		expectedUpdatedAt: input.expectedUpdatedAt,
		requestId: input.requestId
	});
	return {
		decision: input.decision === 'reject' ? 'rejected' : 'approved',
		message: decided.message,
		result: decided.result
	};
}

// ---------------------------------------------------------------------------
// Mail drafts (0021) and purchase requests (0022)
// ---------------------------------------------------------------------------

/** The write function each of those sources is expected to have. */
const STORED_FUNCTION: Record<'mail' | 'purchase', { approve: string; reject: string }> = {
	mail: { approve: 'approve_mail_draft', reject: 'reject_mail_draft' },
	purchase: { approve: 'approve_purchase_request', reject: 'reject_purchase_request' }
};

/**
 * These two features own their own tables and their own write functions, and
 * this branch does not have either. Rather than guess at an argument order,
 * the router reads the function's parameter NAMES from the catalog and fills
 * each one from:
 *
 *   p_request_id            the decision's request id
 *   p_expected_updated_at   the row version the page loaded
 *   p_reason / p_note       what the person typed
 *   p_subject / p_body      what the person corrected, or the stored value
 *   anything ending in _id  the record's own id
 *   p_<name>                the stored record's column of the same name
 *
 * A parameter it cannot fill is refused by name, which is a clear message
 * rather than a wrong write. The repository's own naming (p_<field>) is what
 * makes this work; docs/workspace.md says so plainly.
 */
async function routeStoredFunction(db: Db, user: SessionUser, input: DecideQueueInput): Promise<Routed> {
	const source = input.source as 'mail' | 'purchase';
	const names = STORED_FUNCTION[source];
	const wanted = input.decision === 'approve' ? names.approve : names.reject;

	const routed = await guarded(() =>
		db.asUser(user.id, async (tx) => {
			const signature = await readSignature(tx, wanted);
			if (!signature) {
				throw new AppError(
					422,
					'NL422',
					`This database has no nl.${wanted}, so a ${SOURCE_LABEL[source].toLowerCase()} cannot be decided here yet.`
				);
			}
			const stored = await readStoredRow(tx, source, input.sourceId);
			const values = fillArguments(signature.names, input, stored, wanted);
			// Named arguments, so the order in the function does not matter.
			const call = signature.names.map((name, i) => `${quoteIdent(name)} => $${i + 1}`).join(', ');
			const [row] = await tx.query<{ result: unknown }>(
				`select nl.${quoteIdent(wanted)}(${call}) as result`,
				values
			);
			return row?.result ?? null;
		})
	);

	const edited =
		input.decision === 'approve' && (input.edit?.subject !== undefined || input.edit?.body !== undefined);
	return {
		decision: input.decision === 'reject' ? 'rejected' : edited ? 'edited_approved' : 'approved',
		message:
			input.decision === 'reject'
				? 'Rejected. Nothing was sent.'
				: `Approved. The write ran through nl.${wanted}.`,
		result: (routed as Record<string, unknown> | null) ?? null
	};
}

/** An identifier from the catalog, quoted so it can only ever be one name. */
function quoteIdent(name: string): string {
	return `"${name.replace(/"/g, '""')}"`;
}

async function readSignature(tx: Tx, name: string): Promise<{ names: string[] } | null> {
	const [row] = await tx.sql<{ argnames: string[] | null }>`
		select p.proargnames as argnames
		from pg_catalog.pg_proc p
		join pg_catalog.pg_namespace n on n.oid = p.pronamespace
		where n.nspname = 'nl' and p.proname = ${name}
		order by p.pronargs desc
		limit 1`;
	if (!row) return null;
	return { names: row.argnames ?? [] };
}

async function readStoredRow(
	tx: Tx,
	source: 'mail' | 'purchase',
	id: number
): Promise<Record<string, unknown>> {
	const [table] = await tx.sql<{ name: string | null }>`
		select nl.agent_queue_table(${source === 'mail' ? '{mail_drafts}' : '{purchase_requests,purchase_request_drafts}'}::text[]) as name`;
	if (!table?.name) return {};
	const rows = await tx.query<Record<string, unknown>>(
		`select * from nl.${quoteIdent(table.name)} where id = $1`,
		[id]
	);
	return rows[0] ?? {};
}

function fillArguments(
	names: string[],
	input: DecideQueueInput,
	stored: Record<string, unknown>,
	functionName: string
): Param[] {
	return names.map((name) => {
		const field = name.replace(/^p_/, '');
		if (field === 'request_id') return input.requestId;
		if (field === 'expected_updated_at') return input.expectedUpdatedAt;
		if (field === 'reason' || field === 'note') return input.note;
		if (field === 'subject' && input.edit?.subject !== undefined) return input.edit.subject;
		if (field === 'body' && input.edit?.body !== undefined) return input.edit.body;
		if (field.endsWith('_id') && field !== 'user_id' && field !== 'actor_id') return input.sourceId;
		if (field in stored) return asParam(stored[field]);
		throw new AppError(
			422,
			'NL422',
			`nl.${functionName} wants ${name}, which the workspace cannot fill. Decide this one on its own page.`
		);
	});
}

/** A stored column value as something both drivers can send. */
function asParam(value: unknown): Param {
	if (value === null || value === undefined) return null;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (value instanceof Date) return value.toISOString();
	return JSON.stringify(value);
}
