// What the trail hands to the pages. Queries only, every one of them as the
// signed-in person, so row-level security decides what comes back.
//
// Everything about the run itself comes from nl.agent_run_trail_log, which is
// the harness's own run log (migration 0028) with the trail joined on. This
// file adds no second run model; it reads theirs and the steps beside it.
//
// The `inputs` column is never selected here. It is the recorded material a
// replay needs, not something a page shows.
import type { Disclosure } from '$lib/desk/types';
import type { RunStep, RunSummary, RunTrail, StepKind, WokeBy } from '$lib/agentruns/types';
import type { Db, Tx } from '../db/types.ts';

interface RunRow {
	run_key: string;
	agent: string;
	work_kind: string;
	source_id: number;
	woke_by: string;
	wake_detail: string;
	subject_no: string | null;
	mode: string;
	model: string | null;
	input_tokens: number;
	output_tokens: number;
	started_at: Date;
	finished_at: Date | null;
	ms: number;
	outcome: string;
	produced: string;
	review_state: string;
	reviewed_at: Date | null;
	guardrail: string | null;
	guardrail_reason: string | null;
	trail_woke_by: WokeBy | null;
	trail_woke_note: string | null;
	trail_entity: string | null;
	trail_entity_id: number | null;
	trail_reader: Disclosure | null;
	trail_subject_no: string | null;
	trail_bundle_version: string | null;
	trail_decision: string | null;
	trail_steps: number;
	trail_refusals: number;
	trail_recorded_at: Date | null;
}

const RUN_COLUMNS = `
	l.run_key, l.agent, l.work_kind, l.source_id, l.woke_by, l.wake_detail, l.subject_no,
	l.mode, l.model, l.input_tokens, l.output_tokens, l.started_at, l.finished_at, l.ms,
	l.outcome, l.produced, l.review_state, l.reviewed_at, l.guardrail, l.guardrail_reason,
	l.trail_woke_by, l.trail_woke_note, l.trail_entity, l.trail_entity_id, l.trail_reader,
	l.trail_subject_no, l.trail_bundle_version, l.trail_decision, l.trail_steps,
	l.trail_refusals, l.trail_recorded_at`;

/**
 * The wake, as honestly as the two records together can say it. The harness
 * reads it off the source table, which cannot tell a message somebody typed
 * from one that was delivered; the trail was written by the code that knows,
 * so it wins where it has an answer.
 */
function wokeBy(row: RunRow): WokeBy {
	if (row.trail_woke_by) return row.trail_woke_by;
	const theirs = row.woke_by;
	return theirs === 'mail' || theirs === 'signal' || theirs === 'schedule' || theirs === 'person'
		? theirs
		: 'schedule';
}

function toRun(row: RunRow): RunSummary {
	return {
		runKey: row.run_key,
		agent: row.agent,
		workKind: row.work_kind,
		sourceId: Number(row.source_id),
		hasTrail: row.trail_recorded_at !== null,
		wokeBy: wokeBy(row),
		wokeNote: row.trail_woke_note || row.wake_detail || '',
		entity: row.trail_entity,
		entityId: row.trail_entity_id === null ? null : Number(row.trail_entity_id),
		reader: row.trail_reader ?? 'internal',
		subjectNo: row.trail_subject_no ?? row.subject_no,
		bundleVersion: row.trail_bundle_version,
		decision: row.trail_decision ?? '',
		refusals: Number(row.trail_refusals ?? 0),
		stepCount: Number(row.trail_steps ?? 0),
		mode: row.mode,
		model: row.model,
		inputTokens: Number(row.input_tokens ?? 0),
		outputTokens: Number(row.output_tokens ?? 0),
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		ms: Number(row.ms ?? 0),
		outcome: row.outcome,
		produced: row.produced,
		reviewState: row.review_state,
		reviewedAt: row.reviewed_at?.toISOString() ?? null,
		guardrail: row.guardrail,
		guardrailReason: row.guardrail_reason
	};
}

interface StepRow {
	id: number;
	seq: number;
	kind: StepKind;
	label: string;
	tool: string | null;
	args: Record<string, unknown> | null;
	result: string;
	row_count: number | null;
	ms: number | null;
	rule: string | null;
	rule_note: string;
	withheld: boolean;
	withheld_reason: string;
}

function toStep(row: StepRow): RunStep {
	return {
		id: row.id,
		seq: row.seq,
		kind: row.kind,
		label: row.label,
		tool: row.tool,
		args: row.args,
		result: row.result,
		rows: row.row_count,
		ms: row.ms,
		rule: row.rule,
		ruleNote: row.rule_note,
		withheld: row.withheld,
		withheldReason: row.withheld_reason
	};
}

async function readSteps(tx: Tx, runKey: string): Promise<RunStep[]> {
	const rows = await tx.sql<StepRow>`
		select id, seq, kind, label, tool, args, result, row_count, ms, rule, rule_note,
		       withheld, withheld_reason
		from nl.agent_run_steps
		where run_key = ${runKey}
		order by seq`;
	return rows.map(toStep);
}

/**
 * One agent's runs, newest first, with the trail's counts on them.
 *
 * This is the list a trust page shows. The harness has its own richer reader
 * for the same view (app/src/lib/server/harness/runs.ts); this one exists
 * because its rows are a shape a component may import, and because it carries
 * the trail.
 */
export async function listRuns(
	db: Db,
	userId: number,
	options: { agent?: string | null; withTrailOnly?: boolean; limit?: number } = {}
): Promise<RunSummary[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<RunRow>(
			`select ${RUN_COLUMNS}
			 from nl.agent_run_trail_log l
			 where ($1::text is null or l.agent = $1::text)
			   and ($2::boolean is not true or l.trail_recorded_at is not null)
			 order by l.started_at desc, l.source_id desc
			 limit $3`,
			[options.agent ?? null, options.withTrailOnly ?? false, options.limit ?? 50]
		)
	);
	return rows.map(toRun);
}

/** One run and its steps, by the harness's run key. */
export async function getTrail(db: Db, userId: number, runKey: string): Promise<RunTrail | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<RunRow>(
			`select ${RUN_COLUMNS} from nl.agent_run_trail_log l where l.run_key = $1 limit 1`,
			[runKey]
		);
		if (!row) return null;
		return { ...toRun(row), steps: await readSteps(tx, runKey) };
	});
}

/** Every trail on one thing (a desk item, say), newest first, with its steps. */
export async function getTrailsOn(
	db: Db,
	userId: number,
	entity: { kind: string; id: number },
	limit = 3
): Promise<RunTrail[]> {
	return db.asUser(userId, async (tx) => {
		const rows = await tx.query<RunRow>(
			`select ${RUN_COLUMNS} from nl.agent_run_trail_log l
			 where l.trail_entity = $1 and l.trail_entity_id = $2
			 order by l.started_at desc, l.source_id desc
			 limit $3`,
			[entity.kind, entity.id, limit]
		);
		const trails: RunTrail[] = [];
		for (const row of rows) {
			trails.push({ ...toRun(row), steps: await readSteps(tx, row.run_key) });
		}
		return trails;
	});
}

/**
 * The trail behind one quote request.
 *
 * Two runs can produce one: a hand-entered request, where the quote request
 * is what the run produced, and an emailed one, where the run produced a
 * reply and the quote request alongside it. The harness's row carries both
 * ids in produced_ref, so both are found here.
 */
export async function getTrailForQuoteRequest(
	db: Db,
	userId: number,
	draftId: number
): Promise<RunTrail | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<RunRow>(
			`select ${RUN_COLUMNS} from nl.agent_run_trail_log l
			 where l.produced_ref ->> 'rfq_draft_id' = $1::text
			 order by l.started_at desc, l.source_id desc
			 limit 1`,
			[draftId]
		);
		if (!row) return null;
		return { ...toRun(row), steps: await readSteps(tx, row.run_key) };
	});
}

/** The recorded inputs of one run. Only the replay reads this. */
export async function readTrailInputs(
	db: Db,
	userId: number,
	runKey: string
): Promise<{ agent: string; reader: Disclosure; inputs: Record<string, unknown> } | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ agent: string; reader: Disclosure; inputs: Record<string, unknown> }>`
			select agent, reader, inputs from nl.agent_run_trails where run_key = ${runKey}`
	);
	return row ?? null;
}
