// What the run trail hands to the pages. Queries only, every one of them as
// the signed-in person, so row-level security decides what comes back.
//
// Three questions get asked of this file:
//
//   getRunFor(...)      the run that produced this draft, for a desk item
//   listRuns(agent)     one agent's runs, newest first, for the run list
//   getRun(id)          one run and its steps
//
// The `inputs` column is never selected here. It is the recorded material a
// replay needs, not something a page shows, and it is the one place on the
// run that can hold more than a summary.
import type { Disclosure } from '$lib/desk/types';
import type {
	ReplayDiffKind,
	RunOutcome,
	RunStep,
	RunSummary,
	RunView,
	StepKind,
	WokeBy
} from '$lib/agentruns/types';
import type { Db, Tx } from '../db/types.ts';

interface RunRow {
	id: number;
	agent: string;
	woke_by: WokeBy;
	woke_note: string;
	entity: string | null;
	entity_id: number | null;
	reader: Disclosure;
	subject_no: string | null;
	mode: 'mock' | 'live';
	model: string | null;
	bundle_version: string | null;
	started_at: Date;
	finished_at: Date | null;
	duration_ms: number | null;
	input_tokens: number;
	output_tokens: number;
	outcome: RunOutcome;
	decision: string;
	refusals: number;
	step_count: number;
	produced_kind: string | null;
	produced_id: number | null;
	replay_of: number | null;
	diff: ReplayDiffKind | null;
	replays: number;
	human_change: string | null;
	error: string | null;
}

const RUN_COLUMNS = `
	r.id, r.agent, r.woke_by, r.woke_note, r.entity, r.entity_id, r.reader, r.subject_no,
	r.mode, r.model, r.bundle_version, r.started_at, r.finished_at, r.duration_ms,
	r.input_tokens, r.output_tokens, r.outcome, r.decision, r.refusals, r.step_count,
	r.produced_kind, r.produced_id, r.replay_of, r.diff, r.replays, r.human_change, r.error`;

function toRun(row: RunRow): RunSummary {
	return {
		id: row.id,
		agent: row.agent,
		wokeBy: row.woke_by,
		wokeNote: row.woke_note,
		entity: row.entity,
		entityId: row.entity_id,
		reader: row.reader,
		subjectNo: row.subject_no,
		mode: row.mode,
		model: row.model,
		bundleVersion: row.bundle_version,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
		durationMs: row.duration_ms,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		outcome: row.outcome,
		decision: row.decision,
		refusals: row.refusals,
		stepCount: row.step_count,
		producedKind: row.produced_kind,
		producedId: row.produced_id,
		replayOf: row.replay_of,
		diff: row.diff,
		replays: row.replays,
		humanChange: row.human_change,
		error: row.error
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

async function readSteps(tx: Tx, runId: number): Promise<RunStep[]> {
	const rows = await tx.sql<StepRow>`
		select id, seq, kind, label, tool, args, result, row_count, ms, rule, rule_note,
		       withheld, withheld_reason
		from nl.agent_run_steps
		where run_id = ${runId}
		order by seq`;
	return rows.map(toStep);
}

/** One agent's runs, newest first. */
export async function listRuns(
	db: Db,
	userId: number,
	options: { agent?: string | null; limit?: number; includeReplays?: boolean } = {}
): Promise<RunSummary[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<RunRow>(
			`select ${RUN_COLUMNS}
			 from nl.agent_run_list r
			 where ($1::text is null or r.agent = $1::text)
			   and ($2::boolean or r.replay_of is null)
			 order by r.started_at desc, r.id desc
			 limit $3`,
			[options.agent ?? null, options.includeReplays ?? false, options.limit ?? 50]
		)
	);
	return rows.map(toRun);
}

/** Which agents have runs, and how many, for the run list's own filter. */
export async function listAgents(
	db: Db,
	userId: number
): Promise<{ agent: string; runs: number; refusals: number; lastAt: string }[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{ agent: string; runs: number; refusals: number; last_at: Date }>`
			select agent, count(*)::int as runs, sum(refusals)::int as refusals, max(started_at) as last_at
			from nl.agent_runs
			where replay_of is null
			group by agent
			order by agent`
	);
	return rows.map((r) => ({
		agent: r.agent,
		runs: r.runs,
		refusals: r.refusals ?? 0,
		lastAt: r.last_at.toISOString()
	}));
}

/** One run, with its steps in order. */
export async function getRun(db: Db, userId: number, id: number): Promise<RunView | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<RunRow>(`select ${RUN_COLUMNS} from nl.agent_run_list r where r.id = $1`, [id]);
		if (!row) return null;
		return { ...toRun(row), steps: await readSteps(tx, id) };
	});
}

/**
 * The run that produced one thing, with its steps: the trail a person reads
 * on the desk item before approving the draft it made.
 */
export async function getRunFor(
	db: Db,
	userId: number,
	produced: { kind: string; id: number }
): Promise<RunView | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<RunRow>(
			`select ${RUN_COLUMNS} from nl.agent_run_list r
			 where r.produced_kind = $1 and r.produced_id = $2
			 order by r.id desc limit 1`,
			[produced.kind, produced.id]
		);
		if (!row) return null;
		return { ...toRun(row), steps: await readSteps(tx, row.id) };
	});
}

/**
 * The run behind one quote request, with its steps.
 *
 * Two runs can produce one: a hand-entered request, where the quote request
 * IS what the run produced, and an emailed one, where the run produced a
 * reply and the quote request alongside it. Both are found here, so the
 * request's own page never has to know which kind it is.
 */
export async function getRunForQuoteRequest(
	db: Db,
	userId: number,
	draftId: number
): Promise<RunView | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<RunRow>(
			`select ${RUN_COLUMNS} from nl.agent_run_list r
			 where (r.produced_kind = 'quote_request' and r.produced_id = $1)
			    or (select a.produced ->> 'quote_request_id' from nl.agent_runs a where a.id = r.id) = $1::text
			 order by r.id desc limit 1`,
			[draftId]
		);
		if (!row) return null;
		return { ...toRun(row), steps: await readSteps(tx, row.id) };
	});
}

/** Every run on one thing (a desk message, say), newest first, with steps. */
export async function getRunsOn(
	db: Db,
	userId: number,
	entity: { kind: string; id: number },
	limit = 5
): Promise<RunView[]> {
	return db.asUser(userId, async (tx) => {
		const rows = await tx.query<RunRow>(
			`select ${RUN_COLUMNS} from nl.agent_run_list r
			 where r.entity = $1 and r.entity_id = $2
			 order by r.id desc limit $3`,
			[entity.kind, entity.id, limit]
		);
		const runs: RunView[] = [];
		for (const row of rows) {
			runs.push({ ...toRun(row), steps: await readSteps(tx, row.id) });
		}
		return runs;
	});
}

/** The recorded inputs of one run. Only the replay reads this. */
export async function readRunInputs(
	db: Db,
	userId: number,
	id: number
): Promise<{ run: RunSummary; inputs: Record<string, unknown> } | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<RunRow & { inputs: Record<string, unknown> }>(
			`select ${RUN_COLUMNS}, (select a.inputs from nl.agent_runs a where a.id = r.id) as inputs
			 from nl.agent_run_list r where r.id = $1`,
			[id]
		);
		if (!row) return null;
		return { run: toRun(row), inputs: row.inputs ?? {} };
	});
}
