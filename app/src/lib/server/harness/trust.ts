// The reads behind /agents, the trust page.
//
// One rule runs through this file: every figure on that page comes out of the
// harness's own views (nl.agent_run_log, nl.agent_autonomy_board,
// nl.agent_events, nl.authority_grants), never out of a second count of the
// same thing. Two different numbers for one fact is worse than no number, and
// this app already has three places that could each plausibly tell you how
// many runs the order desk has had.
//
// So:
//
//   * the per-work-kind numbers are nl.agent_autonomy_board, untouched
//     (ladder.ts readBoard);
//   * the agent-wide numbers are ONE query over nl.agent_run_log, which is
//     the same view nl.agent_metrics reads, grouped by agent instead of by
//     agent and kind of work. trust.test.ts asserts it equals the board rows
//     summed, so the two cannot drift apart quietly;
//   * the weekly trend is the SAME query with a week bucket added, so the
//     latest week and the all-time figure are made the same way.
//
// Nothing here writes. The one write the page makes is a person raising or
// lowering an agent's autonomy, and that goes through nl.grant_authority in
// $lib/server/roles/writes, exactly as raising a person's approval limit
// does. See promotion.ts.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/types.ts';
import { readBoard, readPauses } from './ladder.ts';
import { agentEvalsDir, readBaseline, type Baseline } from './evals/shared.ts';
import { AGENT_SCOPES, type AgentId } from './scope.ts';
import type { BoardRow, Level, PauseRow } from './types.ts';

// ---------------------------------------------------------------------------
// The counts, and the two rates derived from them
// ---------------------------------------------------------------------------

/**
 * The decision counts for a slice of runs. These column names are
 * nl.agent_metrics's own, so the SQL below and the board agree on what each
 * word means.
 */
export interface RunCounts {
	runs: number;
	waiting: number;
	reviewed: number;
	approved: number;
	edited: number;
	rejected: number;
	refusals: number;
	degradations: number;
	failures: number;
}

/**
 * The two rates the promotion rule is written in, from counts.
 *
 * Both definitions are nl.agent_metrics's, repeated here in one place rather
 * than in each query:
 *
 *   approval rate  of the runs somebody DECIDED, the share they let through,
 *                  whether or not they edited it first
 *   edit rate      of the ones they let through, the share they had to change
 *
 * Null means "nothing to divide by yet", which reads as "nothing yet" on the
 * page and must never be shown as a zero: an agent nobody has reviewed is not
 * an agent with a 0% approval rate.
 */
export function ratesFor(c: Pick<RunCounts, 'approved' | 'edited' | 'rejected'>): {
	approvalRate: number | null;
	editRate: number | null;
} {
	const decided = c.approved + c.edited + c.rejected;
	const letThrough = c.approved + c.edited;
	return {
		approvalRate: decided === 0 ? null : round4(letThrough / decided),
		editRate: letThrough === 0 ? null : round4(c.edited / letThrough)
	};
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

// The counting half of the one query. Shared by the agent roll-up and the
// weekly trend so a week and an all-time total cannot be counted differently.
const COUNT_COLUMNS = `
	count(*)::int                                                       as runs,
	count(*) filter (where l.review_state = 'waiting')::int             as waiting,
	count(*) filter (where l.review_state in ('approved', 'edited_approved', 'rejected'))::int
	                                                                    as reviewed,
	count(*) filter (where l.review_state = 'approved')::int            as approved,
	count(*) filter (where l.review_state = 'edited_approved')::int     as edited,
	count(*) filter (where l.review_state = 'rejected')::int            as rejected,
	count(*) filter (where l.guardrail is not null)::int                as refusals,
	count(*) filter (where l.degraded)::int                             as degradations,
	count(*) filter (where l.outcome = 'failed')::int                   as failures`;

interface CountDbRow extends RunCounts {
	agent: string;
	last_run_at: string | null;
	acted_alone: number;
	undone: number;
}

function toCounts(r: CountDbRow): RunCounts {
	return {
		runs: Number(r.runs),
		waiting: Number(r.waiting),
		reviewed: Number(r.reviewed),
		approved: Number(r.approved),
		edited: Number(r.edited),
		rejected: Number(r.rejected),
		refusals: Number(r.refusals),
		degradations: Number(r.degradations),
		failures: Number(r.failures)
	};
}

// ---------------------------------------------------------------------------
// One row per agent
// ---------------------------------------------------------------------------

/** How many kinds of work sit at each level, so one badge can say it. */
export interface LevelTally {
	level: Level;
	workKinds: number;
}

/** The autonomy an agent has been GRANTED, in the roles model's own terms. */
export interface GrantedAutonomy {
	/** The agent's row in nl.users, when it is a principal there. */
	principalId: number;
	/** 0 to 3, or null when the grant carries no number. */
	level: number | null;
	startsOn: string;
	endsOn: string | null;
	/** A raise already dated forward, so it is not a surprise on the day. */
	ahead: { level: number | null; startsOn: string }[];
}

export interface AgentTrustRow extends RunCounts {
	agent: AgentId;
	name: string;
	purpose: string;
	reviewer: string;
	approvalRate: number | null;
	editRate: number | null;
	lastRunAt: string | null;
	/** Runs that acted on the agent's own authority, and how many were undone. */
	actedAlone: number;
	undone: number;
	/** The levels its kinds of work sit at, commonest first. */
	levels: LevelTally[];
	paused: boolean;
	pausedReason: string;
	pausedByName: string | null;
	/** The roles-model grant, when this agent is a principal in nl.users. */
	granted: GrantedAutonomy | null;
	/** Its kinds of work, straight off nl.agent_autonomy_board. */
	kinds: BoardRow[];
}

/** An agent's key as the harness writes it, against its row in nl.users. */
export const AGENT_PRINCIPAL_EMAIL: Partial<Record<AgentId, string>> = {
	order_desk: 'order-desk-agent@northline.example',
	procurement_desk: 'procurement-desk-agent@northline.example'
};

interface GrantDbRow {
	email: string;
	user_id: number;
	limit_amount: number | null;
	starts_on: string;
	ends_on: string | null;
}

/**
 * Every agent, with what a sceptical person asks first: how much it handled,
 * how much of that a person let through, how often they had to change it,
 * what it was refused, where its autonomy sits and whether it is stopped.
 */
export async function readAgentTrust(db: Db, userId: number): Promise<AgentTrustRow[]> {
	const [board, pauses, counts, grants] = await Promise.all([
		readBoard(db, userId),
		readPauses(db, userId),
		agentCounts(db, userId),
		grantedAutonomy(db, userId)
	]);
	const pauseOf = new Map<string, PauseRow>(pauses.map((p) => [p.agent, p]));

	return AGENT_SCOPES.map((scope) => {
		const kinds = board.filter((b) => b.agent === scope.id);
		const c = counts.get(scope.id) ?? {
			counts: emptyCounts(),
			lastRunAt: null,
			actedAlone: 0,
			undone: 0
		};
		const pause = pauseOf.get(scope.id);
		return {
			agent: scope.id,
			name: scope.name,
			purpose: scope.purpose,
			reviewer: scope.reviewer,
			...c.counts,
			...ratesFor(c.counts),
			lastRunAt: c.lastRunAt,
			actedAlone: c.actedAlone,
			undone: c.undone,
			levels: tallyLevels(kinds),
			paused: pause?.paused === true,
			pausedReason: pause?.reason ?? '',
			pausedByName: pause?.byName ?? null,
			granted: grants.get(scope.id) ?? null,
			kinds
		};
	});
}

export const emptyCounts = (): RunCounts => ({
	runs: 0,
	waiting: 0,
	reviewed: 0,
	approved: 0,
	edited: 0,
	rejected: 0,
	refusals: 0,
	degradations: 0,
	failures: 0
});

/** The levels an agent's kinds of work sit at, most kinds of work first. */
export function tallyLevels(kinds: BoardRow[]): LevelTally[] {
	const by = new Map<Level, number>();
	for (const k of kinds) by.set(k.level, (by.get(k.level) ?? 0) + 1);
	return [...by.entries()]
		.map(([level, workKinds]) => ({ level, workKinds }))
		.sort((a, b) => b.workKinds - a.workKinds || a.level.localeCompare(b.level));
}

/** The one agent-wide count, over the same view nl.agent_metrics reads. */
async function agentCounts(
	db: Db,
	userId: number
): Promise<Map<string, { counts: RunCounts; lastRunAt: string | null; actedAlone: number; undone: number }>> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<CountDbRow>(`
			select l.agent,
			       ${COUNT_COLUMNS},
			       max(l.started_at)                                              as last_run_at,
			       count(a.id)::int                                               as acted_alone,
			       count(a.id) filter (where a.status = 'undone')::int            as undone
			from nl.agent_run_log l
			left join nl.agent_actions a on a.run_key = l.run_key
			group by l.agent`)
	);
	return new Map(
		rows.map((r) => [
			r.agent,
			{
				counts: toCounts(r),
				lastRunAt: r.last_run_at === null ? null : new Date(r.last_run_at).toISOString(),
				actedAlone: Number(r.acted_alone),
				undone: Number(r.undone)
			}
		])
	);
}

/**
 * What each agent has been GRANTED, read from nl.authority_grants.
 *
 * This is the roles model's answer to "how far may this agent go", and it is
 * the same table and the same rows a person's approval ceiling lives in
 * (migration 0031). It is not the same fact as a kind of work's level on the
 * board: the grant is the ceiling a person signed off, the board level is
 * where each desk is set today. The page shows both and says which is which.
 */
async function grantedAutonomy(db: Db, userId: number): Promise<Map<AgentId, GrantedAutonomy>> {
	const emails = Object.values(AGENT_PRINCIPAL_EMAIL) as string[];
	if (emails.length === 0) return new Map();
	const rows = await db.asUser(userId, (tx) =>
		tx.query<GrantDbRow>(
			`select u.email, u.id as user_id, g.limit_amount, g.starts_on, g.ends_on
			   from nl.users u
			   left join nl.authority_grants g
			     on g.user_id = u.id
			    and g.authority = 'agent_autonomy'
			    and g.starts_on <= nl.today()
			    and (g.ends_on is null or g.ends_on >= nl.today())
			  where u.email = any (
			    select v from jsonb_array_elements_text($1::jsonb) as v)`,
			[JSON.stringify(emails)]
		)
	);
	const ahead = await db.asUser(userId, (tx) =>
		tx.query<GrantDbRow>(
			`select u.email, u.id as user_id, g.limit_amount, g.starts_on, g.ends_on
			   from nl.authority_grants g
			   join nl.users u on u.id = g.user_id
			  where g.authority = 'agent_autonomy'
			    and g.starts_on > nl.today()
			    and u.email = any (
			      select v from jsonb_array_elements_text($1::jsonb) as v)
			  order by g.starts_on`,
			[JSON.stringify(emails)]
		)
	);

	const byEmail = new Map<string, AgentId>();
	for (const [agent, email] of Object.entries(AGENT_PRINCIPAL_EMAIL)) {
		if (email) byEmail.set(email, agent as AgentId);
	}

	const out = new Map<AgentId, GrantedAutonomy>();
	for (const r of rows) {
		const agent = byEmail.get(r.email);
		if (!agent) continue;
		out.set(agent, {
			principalId: Number(r.user_id),
			level: r.limit_amount === null ? null : Number(r.limit_amount),
			startsOn: r.starts_on,
			endsOn: r.ends_on,
			ahead: []
		});
	}
	for (const r of ahead) {
		const agent = byEmail.get(r.email);
		const found = agent ? out.get(agent) : undefined;
		if (!found) continue;
		found.ahead.push({
			level: r.limit_amount === null ? null : Number(r.limit_amount),
			startsOn: r.starts_on
		});
	}
	return out;
}

// ---------------------------------------------------------------------------
// The trust trend: the one chart on the page
// ---------------------------------------------------------------------------

export interface TrustWeek extends RunCounts {
	/** The Monday the week starts on. */
	weekOf: string;
	approvalRate: number | null;
	editRate: number | null;
}

export interface TrustTrend {
	weeks: TrustWeek[];
	/** The promotion rule's approval-rate floor, as a reference line. Null when there is no next step. */
	threshold: number | null;
	/** What the threshold is a threshold FOR, in words, so the line is not mute. */
	thresholdWords: string;
	/** Whose trend this is: one agent, or every agent together. */
	agent: AgentId | null;
}

/**
 * Approval rate, edit rate and refusals week by week, with the promotion
 * threshold as a reference line.
 *
 * The week bucket is Monday, in the database's own time zone, and the last
 * bucket is the week in progress: it is labelled as such on the page rather
 * than left to look like a collapse.
 */
export async function readTrustTrend(
	db: Db,
	userId: number,
	options: { agent?: AgentId | null; weeks?: number } = {}
): Promise<TrustTrend> {
	const agent = options.agent ?? null;
	const weeks = Math.min(Math.max(options.weeks ?? 8, 1), 52);

	const rows = await db.asUser(userId, (tx) =>
		tx.query<CountDbRow & { week_of: string }>(
			`select date_trunc('week', l.started_at)::date as week_of,
			        ''::text as agent,
			        ${COUNT_COLUMNS}
			   from nl.agent_run_log l
			  where l.started_at >= date_trunc('week', nl.today()::timestamptz)
			                        - make_interval(weeks => $1::int - 1)
			    and ($2::text is null or l.agent = $2::text)
			  group by 1
			  order by 1`,
			[weeks, agent]
		)
	);

	const board = await readBoard(db, userId);
	const mine = agent ? board.filter((b) => b.agent === agent) : board;
	// The floor a promotion asks for. Several kinds of work can be at
	// different levels with different rules, so the page shows the strictest
	// one that applies: clearing the easiest rule is not the claim to make.
	const floors = mine.map((b) => b.rule?.minApprovalRate).filter((r): r is number => typeof r === 'number');
	const threshold = floors.length === 0 ? null : Math.max(...floors);

	return {
		weeks: rows.map((r) => {
			const counts = toCounts(r);
			return {
				weekOf: typeof r.week_of === 'string' ? r.week_of : new Date(r.week_of).toISOString().slice(0, 10),
				...counts,
				...ratesFor(counts)
			};
		}),
		threshold,
		thresholdWords:
			threshold === null
				? 'Nothing here has a next step up, so there is no threshold to draw.'
				: `${Math.round(threshold * 1000) / 10}% is the approval rate the promotion rule asks for before ${
						agent ? 'this agent' : 'an agent'
					} may go up a level.`,
		agent
	};
}

// ---------------------------------------------------------------------------
// The eval results
// ---------------------------------------------------------------------------

/** One suite, as the eval runner itself last reported it. */
export interface EvalSuite {
	suite: string;
	cases: number;
	passed: number;
	fields: Record<string, number>;
	/** The same three, as they were when the baseline was written. */
	baselineCases: number | null;
	baselinePassed: number | null;
	baselineFields: Record<string, number>;
	/** True when the last run is at least as good as the baseline on every field. */
	beatBaseline: boolean;
	/** Which fields went backwards, for the page to name. */
	worse: string[];
}

export interface EvalSummary {
	/** The date on the last run's own report, or null when nothing has run. */
	ranOn: string | null;
	/** The report file a person can open. */
	reportPath: string | null;
	suites: EvalSuite[];
	cases: number;
	passed: number;
	/** What the numbers are worth. The eval report says this too, and it matters more here. */
	caveat: string;
}

/** What `npm run eval:agents` writes beside its markdown report. */
export interface EvalRunArtifact {
	ranOn: string;
	suites: { suite: string; cases: number; passed: number; fields: Record<string, number> }[];
}

export function evalArtifactFile(): string {
	return join(agentEvalsDir(), 'reports', 'latest.json');
}

function readArtifact(): EvalRunArtifact | null {
	const file = evalArtifactFile();
	if (!existsSync(file)) return null;
	try {
		const body = JSON.parse(readFileSync(file, 'utf8')) as EvalRunArtifact;
		return Array.isArray(body?.suites) ? body : null;
	} catch {
		return null;
	}
}

/** The newest dated report on file, so the page can link to something a person reads. */
function newestReport(): string | null {
	const dir = join(agentEvalsDir(), 'reports');
	if (!existsSync(dir)) return null;
	const files = readdirSync(dir)
		.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
		.sort();
	return files.length === 0 ? null : `evals/agents/reports/${files[files.length - 1]}`;
}

/**
 * The eval results per suite, the baseline, and whether the last run beat it.
 *
 * The comparison is the SAME one evals.test.ts makes (holdToBaseline): no
 * suite may have fewer cases, fewer passes, or a lower F1 on any field the
 * baseline recorded. Keeping one definition means the page cannot say an
 * agent is fine while `npm test` says it is not.
 */
export function readEvalSummary(baseline: Baseline | null = readBaseline()): EvalSummary {
	const artifact = readArtifact();
	const names = [...new Set([...(artifact?.suites ?? []).map((s) => s.suite), ...Object.keys(baseline ?? {})])].sort();

	const suites: EvalSuite[] = names.map((name) => {
		const run = artifact?.suites.find((s) => s.suite === name) ?? null;
		const was = baseline?.[name] ?? null;
		const worse: string[] = [];
		if (run && was) {
			if (run.cases < was.cases) worse.push('the number of cases');
			if (run.passed < was.passed) worse.push('cases fully right');
			for (const [field, f1] of Object.entries(was.fields)) {
				if ((run.fields?.[field] ?? 0) < f1) worse.push(field);
			}
		}
		return {
			suite: name,
			cases: run?.cases ?? 0,
			passed: run?.passed ?? 0,
			fields: run?.fields ?? {},
			baselineCases: was?.cases ?? null,
			baselinePassed: was?.passed ?? null,
			baselineFields: was?.fields ?? {},
			beatBaseline: run !== null && was !== null && worse.length === 0,
			worse
		};
	});

	return {
		ranOn: artifact?.ranOn ?? null,
		reportPath: newestReport(),
		suites,
		cases: suites.reduce((sum, s) => sum + s.cases, 0),
		passed: suites.reduce((sum, s) => sum + s.passed, 0),
		caveat:
			'The cases, the expected answers and the extractors that read the output were written by the same hands as the agents, so these are a regression floor and not an independent measure. A set written by somebody else is the fair comparison.'
	};
}

/** Where a case file lives, so the page can point at the thing itself. */
export function caseFilePath(suite: string, name: string): string {
	const folder = suite === 'order desk' ? 'desk' : suite;
	const ext = folder === 'desk' ? 'txt' : 'json';
	return `evals/agents/${folder}/cases/${name}.${ext}`;
}

/** The case names in a suite, newest listing first, so a link is never a guess. */
export function caseNames(suite: string): string[] {
	const folder = suite === 'order desk' ? 'desk' : suite;
	const dir = join(agentEvalsDir(), folder, 'cases');
	if (!existsSync(dir)) return [];
	return [
		...new Set(
			readdirSync(dir)
				.filter((f) => /^\d{2}-[a-z0-9-]+\.(json|txt)$/.test(f))
				.map((f) => f.replace(/\.(expected\.)?(json|txt)$/, ''))
				.filter((n) => !n.endsWith('.expected'))
		)
	].sort();
}
