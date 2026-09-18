// Every write the harness makes, and there are only seven of them.
//
// Each one calls the SQL function of the same name in migration 0028, which
// claims the request id, requires an active user, checks its fields and writes
// an audit row. Nothing in this file decides anything: it exists so the rest of
// the harness never writes SQL by hand and never forgets a request id.
import { createHash } from 'node:crypto';
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import type { Level } from './types.ts';

interface WriteRow<T> {
	result: T;
}

export type Verdict = 'pass' | 'refuse' | 'needs_person' | 'degraded' | 'noted';

export interface EventInput {
	agent: string;
	runKey: string;
	workKind?: string;
	kind: 'guardrail' | 'degraded' | 'autonomy';
	checkId: string;
	verdict: Verdict;
	detail?: string;
	requestId: string;
}

/**
 * One event on a run: a guardrail that refused it, a degradation, or an
 * autonomy decision. Takes a Tx, so an agent can record it inside the same
 * transaction as the rest of its run.
 */
export async function recordEvent(tx: Tx, input: EventInput): Promise<{ eventId: number; recorded: boolean }> {
	const [row] = await tx.sql<WriteRow<{ event_id: number; recorded: boolean }>>`
		select nl.record_agent_event(${input.agent}, ${input.runKey}, ${input.workKind ?? ''},
		                             ${input.kind}, ${input.checkId}, ${input.verdict},
		                             ${input.detail ?? ''}, ${input.requestId}) as result`;
	return { eventId: Number(row.result.event_id), recorded: row.result.recorded === true };
}

/** The same thing, in its own transaction, as one person. */
export async function recordEventAs(db: Db, userId: number, input: EventInput) {
	return guarded(() => db.asUser(userId, (tx) => recordEvent(tx, input)));
}

export interface ActionInput {
	agent: string;
	workKind: string;
	runKey: string;
	/** The function it called: approve_mail_draft, send_mail, fire_automation. */
	action: string;
	entity: string;
	entityId: string;
	atLevel: Extract<Level, 'auto_review' | 'auto'>;
	/** Null takes the level's own window. */
	undoMinutes?: number | null;
	detail?: Record<string, unknown>;
	requestId: string;
}

export interface ActionRecorded {
	actionId: number;
	undoUntil: string | null;
	sampled: boolean;
	recorded: boolean;
}

/**
 * Record that an agent acted on its own. The database checks the level and the
 * pause again here, so a caller that got the plan wrong is refused rather than
 * trusted.
 */
export async function recordAction(tx: Tx, input: ActionInput): Promise<ActionRecorded> {
	const [row] = await tx.sql<WriteRow<{ action_id: number; undo_until: string | null; sampled: boolean; recorded: boolean }>>`
		select nl.record_agent_action(${input.agent}, ${input.workKind}, ${input.runKey},
		                              ${input.action}, ${input.entity}, ${input.entityId},
		                              ${input.atLevel}, ${input.undoMinutes ?? null},
		                              ${JSON.stringify(input.detail ?? {})}::jsonb,
		                              ${input.requestId}) as result`;
	return {
		actionId: Number(row.result.action_id),
		undoUntil: row.result.undo_until,
		sampled: row.result.sampled === true,
		recorded: row.result.recorded === true
	};
}

export async function recordActionAs(db: Db, userId: number, input: ActionInput): Promise<ActionRecorded> {
	return guarded(() => db.asUser(userId, (tx) => recordAction(tx, input)));
}

/**
 * The size and hash of what the agent wrote, so an edit by a person can still
 * be measured after the text is overwritten in place.
 */
export async function recordArtifact(
	tx: Tx,
	input: {
		entity: string;
		entityId: string;
		runKey: string;
		agent: string;
		workKind?: string;
		text: string;
		requestId: string;
	}
): Promise<{ chars: number; sha256: string }> {
	const sha256 = createHash('sha256').update(input.text, 'utf8').digest('hex');
	await tx.sql`
		select nl.record_agent_artifact(${input.entity}, ${input.entityId}, ${input.runKey},
		                                ${input.agent}, ${input.workKind ?? ''},
		                                ${input.text.length}, ${sha256}, ${input.requestId})`;
	return { chars: input.text.length, sha256 };
}

export interface UndoClaim {
	actionId: number;
	entity: string;
	entityId: string;
	agent: string;
	workKind: string;
	did: string;
	detail: Record<string, unknown>;
}

/**
 * Ask whether an action may be undone, and what to reverse. Raises a 422 when
 * the window has closed, a 403 when it is not this person's, a 404 when there
 * is no such action.
 */
export async function claimUndo(
	db: Db,
	userId: number,
	input: { actionId: number; reason: string; requestId: string }
): Promise<UndoClaim> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<Record<string, unknown>>>`
				select nl.claim_agent_undo(${input.actionId}, ${input.reason}, ${input.requestId}) as result`
		)
	);
	return {
		actionId: Number(row.result.action_id),
		entity: String(row.result.entity),
		entityId: String(row.result.entity_id),
		agent: String(row.result.agent),
		workKind: String(row.result.work_kind),
		did: String(row.result.did),
		detail: (row.result.detail ?? {}) as Record<string, unknown>
	};
}

/** How the undo went. Called whether it worked or not, so nothing is left 'undoing'. */
export async function finishUndo(
	db: Db,
	userId: number,
	input: { actionId: number; undone: boolean; note?: string; irreversible?: boolean; requestId: string }
): Promise<{ status: string }> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<{ status: string }>>`
				select nl.finish_agent_undo(${input.actionId}, ${input.undone}, ${input.note ?? ''},
				                            ${input.irreversible ?? false}, ${input.requestId}) as result`
		)
	);
	return { status: String(row.result.status) };
}

/** A person's verdict on one sampled action. */
export async function reviewSampled(
	db: Db,
	userId: number,
	input: { actionId: number; verdict: 'good' | 'bad'; note?: string; requestId: string }
): Promise<{ verdict: string }> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow<{ verdict: string }>>`
				select nl.review_sampled_action(${input.actionId}, ${input.verdict},
				                                ${input.note ?? ''}, ${input.requestId}) as result`
		)
	);
	return { verdict: String(row.result.verdict) };
}
