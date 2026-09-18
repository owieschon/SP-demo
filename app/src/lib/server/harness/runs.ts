// Reading the run log: what the agents did, what they were refused, and what
// they did on their own authority.
//
// All of it comes out of nl.agent_run_log, which is a view over the tables the
// features already write. Row-level security is each feature's own, so a
// person sees the desk's runs (the team's) and only their own conversations
// with the assistant. An admin sees everything.
import type { Db } from '../db/types.ts';
import type { ActionRow, Level, RunRow } from './types.ts';

interface RunDbRow {
	agent: string;
	work_kind: string;
	run_key: string;
	source_id: number;
	woke_by: string;
	wake_detail: string;
	subject_kind: string | null;
	subject_no: string | null;
	input_ids: Record<string, unknown>;
	tool_calls: RunRow['toolCalls'];
	tool_call_count: number;
	mode: string;
	model: string | null;
	input_tokens: number;
	output_tokens: number;
	produced: string;
	produced_ref: Record<string, unknown>;
	acted_as: number | null;
	acted_as_name: string | null;
	review_state: RunRow['reviewState'];
	reviewed_by_name: string | null;
	reviewed_at: string | null;
	outcome: string;
	started_at: string;
	finished_at: string | null;
	ms: number;
	guardrail: string | null;
	guardrail_reason: string | null;
	degraded: boolean;
	degraded_reason: string | null;
	events: RunRow['events'];
	level_at_read: Level | null;
	edit_delta_chars: number | null;
	action: ActionDbRow | null;
}

interface ActionDbRow {
	id: number;
	agent: string;
	work_kind: string;
	run_key: string;
	action: string;
	entity: string;
	entity_id: string;
	at_level: Level;
	acted_by_name: string;
	acted_at: string;
	undo_until: string | null;
	sampled: boolean;
	sample_verdict: 'good' | 'bad' | null;
	status: ActionRow['status'];
	undone_by_name: string | null;
	undone_at: string | null;
	undo_reason: string;
	detail: Record<string, unknown>;
}

function toAction(r: ActionDbRow | null, now = Date.now()): ActionRow | null {
	if (!r) return null;
	return {
		id: Number(r.id),
		agent: r.agent,
		workKind: r.work_kind,
		runKey: r.run_key,
		action: r.action,
		entity: r.entity,
		entityId: r.entity_id,
		atLevel: r.at_level,
		actedByName: r.acted_by_name,
		actedAt: new Date(r.acted_at).toISOString(),
		undoUntil: r.undo_until ? new Date(r.undo_until).toISOString() : null,
		undoable: r.status === 'done' && r.undo_until !== null && new Date(r.undo_until).getTime() > now,
		sampled: r.sampled === true,
		sampleVerdict: r.sample_verdict,
		status: r.status,
		undoneByName: r.undone_by_name,
		undoneAt: r.undone_at ? new Date(r.undone_at).toISOString() : null,
		undoReason: r.undo_reason ?? '',
		detail: r.detail ?? {}
	};
}

function toRun(r: RunDbRow): RunRow {
	return {
		agent: r.agent,
		workKind: r.work_kind,
		runKey: r.run_key,
		sourceId: Number(r.source_id),
		wokeBy: r.woke_by,
		wakeDetail: r.wake_detail ?? '',
		subjectKind: r.subject_kind,
		subjectNo: r.subject_no,
		inputIds: r.input_ids ?? {},
		toolCalls: Array.isArray(r.tool_calls) ? r.tool_calls : [],
		toolCallCount: Number(r.tool_call_count ?? 0),
		mode: r.mode,
		model: r.model,
		inputTokens: Number(r.input_tokens ?? 0),
		outputTokens: Number(r.output_tokens ?? 0),
		produced: r.produced,
		producedRef: r.produced_ref ?? {},
		actedAs: r.acted_as === null ? null : Number(r.acted_as),
		actedAsName: r.acted_as_name,
		reviewState: r.review_state,
		reviewedByName: r.reviewed_by_name,
		reviewedAt: r.reviewed_at ? new Date(r.reviewed_at).toISOString() : null,
		outcome: r.outcome,
		startedAt: new Date(r.started_at).toISOString(),
		finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
		ms: Number(r.ms ?? 0),
		guardrail: r.guardrail,
		guardrailReason: r.guardrail_reason,
		degraded: r.degraded === true,
		degradedReason: r.degraded_reason,
		events: Array.isArray(r.events) ? r.events : [],
		levelAtRead: r.level_at_read,
		action: toAction(r.action),
		editDeltaChars: r.edit_delta_chars === null ? null : Number(r.edit_delta_chars)
	};
}

// The one query behind every list on the page. The joins that are not in the
// view are the ones that name people and the action, which the view leaves out
// so that it stays the shape the features write.
const RUN_QUERY = `
	select l.*,
	       au.full_name as acted_as_name,
	       ru.full_name as reviewed_by_name,
	       es.delta_chars as edit_delta_chars,
	       act.action as action
	from nl.agent_run_log l
	left join nl.users au on au.id = l.acted_as
	left join nl.users ru on ru.id = l.reviewed_by
	left join nl.agent_edit_sizes es on es.run_key = l.run_key
	left join lateral (
	  select to_jsonb(a) - 'acted_by' - 'undone_by' - 'sample_reviewed_by'
	         || jsonb_build_object('acted_by_name', ab.full_name,
	                               'undone_by_name', ub.full_name) as action
	  from nl.agent_actions a
	  join nl.users ab on ab.id = a.acted_by
	  left join nl.users ub on ub.id = a.undone_by
	  where a.run_key = l.run_key
	  order by a.id desc
	  limit 1
	) act on true`;

export interface RunFilter {
	agent?: string | null;
	workKind?: string | null;
	/** Only runs a guardrail stopped. */
	refusedOnly?: boolean;
	/** Only runs that acted on their own. */
	actedOnly?: boolean;
	limit?: number;
}

/** The feed: recent runs, newest first. */
export async function listRuns(db: Db, userId: number, filter: RunFilter = {}): Promise<RunRow[]> {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (filter.agent) {
		params.push(filter.agent);
		where.push(`l.agent = $${params.length}`);
	}
	if (filter.workKind) {
		params.push(filter.workKind);
		where.push(`l.work_kind = $${params.length}`);
	}
	if (filter.refusedOnly) where.push('l.guardrail is not null');
	if (filter.actedOnly) where.push('act.action is not null');
	params.push(Math.min(Math.max(filter.limit ?? 50, 1), 200));

	const text = `${RUN_QUERY}
		${where.length ? `where ${where.join(' and ')}` : ''}
		order by l.started_at desc, l.source_id desc
		limit $${params.length}`;

	const rows = await db.asUser(userId, (tx) => tx.query<RunDbRow>(text, params));
	return rows.map(toRun);
}

/** One run, by its key. */
export async function getRun(db: Db, userId: number, runKey: string): Promise<RunRow | null> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<RunDbRow>(`${RUN_QUERY} where l.run_key = $1 limit 1`, [runKey])
	);
	return rows.length === 0 ? null : toRun(rows[0]);
}

/** Every action still inside its undo window, soonest to close first. */
export async function listUndoable(db: Db, userId: number, limit = 20): Promise<ActionRow[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<ActionDbRow>(
			`select a.id, a.agent, a.work_kind, a.run_key, a.action, a.entity, a.entity_id, a.at_level,
			        ab.full_name as acted_by_name, a.acted_at, a.undo_until, a.sampled, a.sample_verdict,
			        a.status, ub.full_name as undone_by_name, a.undone_at, a.undo_reason, a.detail
			 from nl.agent_actions a
			 join nl.users ab on ab.id = a.acted_by
			 left join nl.users ub on ub.id = a.undone_by
			 where a.status = 'done' and a.undo_until is not null and a.undo_until > now()
			 order by a.undo_until
			 limit $1`,
			[limit]
		)
	);
	const now = Date.now();
	return rows.map((r) => toAction(r, now)!).filter((a): a is ActionRow => a !== null);
}

/** Sampled actions nobody has looked at yet: the only review at level auto. */
export async function listSampleQueue(db: Db, userId: number, limit = 20): Promise<ActionRow[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<ActionDbRow>(
			`select a.id, a.agent, a.work_kind, a.run_key, a.action, a.entity, a.entity_id, a.at_level,
			        ab.full_name as acted_by_name, a.acted_at, a.undo_until, a.sampled, a.sample_verdict,
			        a.status, ub.full_name as undone_by_name, a.undone_at, a.undo_reason, a.detail
			 from nl.agent_actions a
			 join nl.users ab on ab.id = a.acted_by
			 left join nl.users ub on ub.id = a.undone_by
			 where a.sampled and a.sample_verdict is null
			 order by a.acted_at desc
			 limit $1`,
			[limit]
		)
	);
	const now = Date.now();
	return rows.map((r) => toAction(r, now)!).filter((a): a is ActionRow => a !== null);
}

export interface RefusalCount {
	agent: string;
	workKind: string;
	checkId: string;
	times: number;
	lastAt: string;
	lastDetail: string;
}

/** What the agents were refused, most often first. The second question the page answers. */
export async function listRefusals(db: Db, userId: number, limit = 20): Promise<RefusalCount[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{ agent: string; work_kind: string; check_id: string; times: number; last_at: string; last_detail: string }>(
			`select e.agent, e.work_kind, e.check_id, count(*)::int as times,
			        max(e.at) as last_at,
			        (array_agg(e.detail order by e.at desc))[1] as last_detail
			 from nl.agent_events e
			 where e.kind = 'guardrail' and e.verdict <> 'pass'
			 group by e.agent, e.work_kind, e.check_id
			 order by times desc, last_at desc
			 limit $1`,
			[limit]
		)
	);
	return rows.map((r) => ({
		agent: r.agent,
		workKind: r.work_kind,
		checkId: r.check_id,
		times: Number(r.times),
		lastAt: new Date(r.last_at).toISOString(),
		lastDetail: r.last_detail ?? ''
	}));
}

export interface DegradationCount {
	agent: string;
	reason: string;
	times: number;
	lastAt: string;
	lastDetail: string;
}

export async function listDegradations(db: Db, userId: number, limit = 20): Promise<DegradationCount[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{ agent: string; check_id: string; times: number; last_at: string; last_detail: string }>(
			`select e.agent, e.check_id, count(*)::int as times, max(e.at) as last_at,
			        (array_agg(e.detail order by e.at desc))[1] as last_detail
			 from nl.agent_events e
			 where e.kind = 'degraded'
			 group by e.agent, e.check_id
			 order by times desc, last_at desc
			 limit $1`,
			[limit]
		)
	);
	return rows.map((r) => ({
		agent: r.agent,
		reason: r.check_id,
		times: Number(r.times),
		lastAt: new Date(r.last_at).toISOString(),
		lastDetail: r.last_detail ?? ''
	}));
}

export interface LevelChange {
	agent: string;
	workKind: string;
	fromLevel: string;
	toLevel: string;
	via: 'person' | 'rule';
	byName: string | null;
	at: string;
	reason: string;
	metrics: Record<string, unknown>;
}

/** Who moved what, and why. The record behind every level on the board. */
export async function listLevelChanges(db: Db, userId: number, limit = 20): Promise<LevelChange[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			agent: string;
			work_kind: string;
			from_level: string;
			to_level: string;
			changed_via: 'person' | 'rule';
			by_name: string | null;
			changed_at: string;
			reason: string;
			metrics: Record<string, unknown>;
		}>(
			`select c.agent, c.work_kind, c.from_level, c.to_level, c.changed_via,
			        u.full_name as by_name, c.changed_at, c.reason, c.metrics
			 from nl.agent_autonomy_changes c
			 left join nl.users u on u.id = c.changed_by
			 order by c.changed_at desc, c.id desc
			 limit $1`,
			[limit]
		)
	);
	return rows.map((r) => ({
		agent: r.agent,
		workKind: r.work_kind,
		fromLevel: r.from_level,
		toLevel: r.to_level,
		via: r.changed_via,
		byName: r.by_name,
		at: new Date(r.changed_at).toISOString(),
		reason: r.reason ?? '',
		metrics: r.metrics ?? {}
	}));
}

/** Which sources the run log is built from in this database. */
export async function runSources(db: Db, userId: number): Promise<Record<string, boolean>> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ result: Record<string, boolean> }>`select nl.agent_runs_sources() as result`
	);
	return row?.result ?? {};
}
