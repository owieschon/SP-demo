// The writes: promotion, recompilation, and the decisions only a person makes.
//
// None of the rules live here. Every function is a thin call onto the SQL
// function that owns the rule, so a decision made on the /context screen and
// a decision made by the nightly build go through exactly the same code path
// and leave exactly the same audit row.
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../db/types.ts';
import { recordEvent } from '../harness/record.ts';
import type { SubjectKind, Surface } from '$lib/context/types';

export interface PromotionResult {
	promoted: number;
	conflicts_raised: number;
	unchanged: number;
	held_for_a_person: number;
	replayed?: boolean;
}

/**
 * Run the promotion rule. With no subject it runs over everything, which is
 * what the nightly build does; with one it is what a page does after an
 * exploration.
 */
export async function promoteClaims(
	db: Db,
	userId: number,
	scope: { kind?: SubjectKind | null; id?: string | null; attribute?: string | null } = {},
	requestId = `ctx-promote-${randomUUID()}`
): Promise<PromotionResult> {
	return db.asUser(userId, (tx) => promoteIn(tx, scope, requestId));
}

export async function promoteIn(
	tx: Tx,
	scope: { kind?: SubjectKind | null; id?: string | null; attribute?: string | null } = {},
	requestId = `ctx-promote-${randomUUID()}`
): Promise<PromotionResult> {
	const [row] = await tx.query<{ result: PromotionResult }>(
		'select nl.promote_claims($1, $2, $3, $4) as result',
		[scope.kind ?? null, scope.id ?? null, scope.attribute ?? null, requestId]
	);
	return row.result;
}

export interface CompileResult {
	changed: number;
	unchanged: number;
}

/** Recompile every purpose for one subject. */
export async function compileBundles(
	db: Db,
	userId: number,
	subject: { kind: SubjectKind; id: string }
): Promise<CompileResult> {
	return db.asUser(userId, (tx) => compileIn(tx, subject));
}

export async function compileIn(
	tx: Tx,
	subject: { kind: SubjectKind; id: string }
): Promise<CompileResult> {
	const [row] = await tx.query<{ result: CompileResult }>(
		'select nl.compile_context_bundles($1, $2) as result',
		[subject.kind, subject.id]
	);
	return row.result;
}

/** One purpose, which is what a test uses to watch a version move or not. */
export async function compileBundle(
	db: Db,
	userId: number,
	subject: { kind: SubjectKind; id: string },
	purpose: Surface
): Promise<{ bundle_id: number; version: number; content_hash: string; changed: boolean }> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<{
			result: { bundle_id: number; version: number; content_hash: string; changed: boolean };
		}>('select nl.compile_context_bundle($1, $2, $3) as result', [subject.kind, subject.id, purpose]);
		return row.result;
	});
}

/**
 * A person choosing between two claims. Their decision beats the rule and the
 * rule will not undo it: nl.promote_claims leaves a person-decided fact
 * alone. The row version is held, so a conflict that moved since the page
 * loaded raises a 409 rather than overwriting somebody else's answer.
 */
export async function resolveConflict(
	db: Db,
	userId: number,
	input: { conflictId: number; claimId: number; note: string; rowVersion: string; requestId: string }
): Promise<{ fact_id: number; conflict_id: number; decided_via: string; replayed?: boolean }> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<{
			result: { fact_id: number; conflict_id: number; decided_via: string; replayed?: boolean };
		}>('select nl.resolve_context_conflict($1, $2, $3, $4::timestamptz, $5) as result', [
			input.conflictId,
			input.claimId,
			input.note,
			input.rowVersion,
			input.requestId
		]);
		// Settling a conflict changes what a bundle should say, so recompile
		// straight away rather than leaving the read path a night behind.
		const [fact] = await tx.sql<{ subject_kind: SubjectKind; subject_id: string }>`
			select subject_kind, subject_id from nl.facts where id = ${row.result.fact_id}`;
		if (fact) await compileIn(tx, { kind: fact.subject_kind, id: fact.subject_id });
		return row.result;
	});
}

/** Dismissing or resolving an item in the "could not tell" queue. */
export async function decideReviewItem(
	db: Db,
	userId: number,
	input: {
		itemId: number;
		decision: 'dismissed' | 'resolved';
		note: string;
		rowVersion: string;
		requestId: string;
	}
): Promise<{ item_id: number; decision: string; replayed?: boolean }> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<{ result: { item_id: number; decision: string; replayed?: boolean } }>(
			'select nl.decide_context_review_item($1, $2, $3, $4::timestamptz, $5) as result',
			[input.itemId, input.decision, input.note, input.rowVersion, input.requestId]
		);
		return row.result;
	});
}

/**
 * A person saying which account a raw name or address is. Accepting a link
 * fills in the subject on every claim that was waiting for it, which is how
 * an unresolved claim becomes a promotable one without being rewritten.
 */
export async function decideEntityLink(
	db: Db,
	userId: number,
	input: {
		rawKind: 'name' | 'email' | 'email_domain' | 'phone' | 'part_number';
		rawValue: string;
		targetKind: SubjectKind;
		targetId: string;
		decision: 'accepted' | 'rejected';
		note: string;
		requestId: string;
	}
): Promise<{ link_id: number; decision: string; claims_resolved: number; replayed?: boolean }> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<{
			result: { link_id: number; decision: string; claims_resolved: number; replayed?: boolean };
		}>('select nl.decide_entity_link($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) as result', [
			input.rawKind,
			input.rawValue,
			input.targetKind,
			input.targetId,
			input.decision,
			'person',
			0.99,
			JSON.stringify({ rule: 'person', detail: 'Decided on the context screen.' }),
			input.note,
			input.requestId
		]);
		if (input.decision === 'accepted' && row.result.claims_resolved > 0) {
			await promoteIn(
				tx,
				{ kind: input.targetKind, id: input.targetId },
				`${input.requestId}-promote`
			);
			await compileIn(tx, { kind: input.targetKind, id: input.targetId });
		}
		return row.result;
	});
}

/**
 * Record which bundle version an agent action read. The one-line call every
 * agent's own code should make right after it reads context, which is what
 * makes a reply explainable afterwards and an eval replayable.
 *
 * Two records come out of one call, and they are for two different questions:
 *
 *   * the AGENT HARNESS's run record (migration 0028), when the caller is
 *     inside a run and passes `runKey`. That is the canonical place an agent's
 *     work is accounted for, so the context it read belongs on it as a named
 *     check like any other. A bundle the mill has not refreshed lately is
 *     recorded with the verdict `degraded`, which is the harness's own word
 *     for running on the last good thing and saying so;
 *   * nl.context_reads, which is the per-subject index the context screen
 *     reads: "which actions read which version of THIS account's context".
 *     The harness's event carries that in free text and cannot be queried by
 *     subject, so both exist and the harness one is the record of account.
 */
export async function recordContextRead(
	tx: Tx,
	input: {
		subject: { kind: SubjectKind; id: string };
		purpose: Surface;
		version?: number | null;
		action: string;
		entity?: string;
		entityId?: string;
		via?: 'ui' | 'agent' | 'assistant' | 'nightly' | 'mcp';
		/** The harness run this read belongs to, when there is one. */
		runKey?: string;
		agent?: string;
		workKind?: string;
		/** Needed only when runKey is given. */
		requestId?: string;
	}
): Promise<number> {
	const [row] = await tx.query<{ id: number }>(
		'select nl.record_context_read($1, $2, $3, $4, $5, $6, $7, $8) as id',
		[
			input.subject.kind,
			input.subject.id,
			input.purpose,
			input.version ?? null,
			input.action,
			input.entity ?? '',
			input.entityId ?? '',
			input.via ?? 'agent'
		]
	);

	if (input.runKey && input.agent && input.requestId) {
		const [read] = await tx.sql<{
			bundle_version: number;
			content_hash: string;
			age_hours: number;
		}>`
			select r.bundle_version, r.content_hash,
			       round(extract(epoch from (now() - b.built_at)) / 3600.0, 1) as age_hours
			from nl.context_reads r
			join nl.context_bundles b on b.id = r.bundle_id
			where r.id = ${row.id}`;
		const stale = Number(read.age_hours) > 36;
		await recordEvent(tx, {
			agent: input.agent,
			runKey: input.runKey,
			workKind: input.workKind,
			kind: stale ? 'degraded' : 'guardrail',
			checkId: 'context_bundle',
			verdict: stale ? 'degraded' : 'pass',
			detail:
				`${input.subject.kind} ${input.subject.id} for ${input.purpose}: ` +
				`bundle version ${read.bundle_version}, hash ${read.content_hash.slice(0, 12)}, ` +
				`compiled ${read.age_hours} hours ago`,
			requestId: input.requestId
		});
	}

	return row.id;
}

/** Revoke an extractor version. Admin only, and its claims stop counting. */
export async function revokeExtractor(
	db: Db,
	userId: number,
	input: { name: string; version: string; note: string; requestId: string }
): Promise<{ extractor: string; version: string; claims: number }> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<{
			result: { extractor: string; version: string; claims: number };
		}>('select nl.revoke_extractor($1, $2, $3, $4) as result', [
			input.name,
			input.version,
			input.note,
			input.requestId
		]);
		return row.result;
	});
}
