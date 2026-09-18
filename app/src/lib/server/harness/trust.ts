/*
  What the /agents page reads.

  The harness (migration 0028) already records every run, every guardrail
  refusal, every autonomy decision and the numbers that decide a promotion.
  Nothing in the app showed any of it. This module is the read side of that
  page and nothing else: there are no writes here, because the two writes a
  person makes on that page already exist and are reused as they are.

    the pause switch      harness/ladder.ts setPause  -> nl.set_agent_pause
    raising autonomy      roles/writes.ts grantAuthority -> nl.grant_authority

  THE ONE RULE. Every figure is read from the harness, never counted a second
  way. Where a figure has to be rolled up (five agents out of fifteen kinds of
  work) the rollup happens in SQL over nl.agent_metrics, with the same
  expressions that view uses, so there is exactly one definition of "approval
  rate" in the system. trust.test.ts checks each one against a direct query.

  WHAT IS DELIBERATELY NOT HERE. The run trail. A branch called desk-depth is
  building app/src/lib/components/agentruns/RunTrail.svelte and its read side
  in app/src/lib/server/agentruns/read.ts. The page leaves a marked place for
  it rather than growing a second, poorer version.
*/
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/types.ts';
import { GUARDRAILS } from './guardrails.ts';
import { readBoard, readPauses } from './ladder.ts';
import { listRefusals, listUndoable } from './runs.ts';
import { AGENT_SCOPES, AGENTS, type AgentId } from './scope.ts';
import { agentEvalsDir, EVAL_TODAY, loadJsonCases, loadTextCases, readBaseline } from './evals/shared.ts';
import type {
	AgentSummary,
	EvalSummary,
	RefusalRow,
	SuiteScore,
	TrendWeek,
	TrustTrend,
	UndoableRow,
	WorkKindRow
} from '$lib/agents/types';
import { agentName, LEVEL_RANK } from '$lib/agents/types';

// ---------------------------------------------------------------------------
// One row per agent
// ---------------------------------------------------------------------------

/*
  The rollup, in SQL, over nl.agent_metrics.

  The two rate expressions are copied from nl.agent_metrics itself (migration
  0028, the view's own comments say what each one means):

    approval rate   of the runs somebody decided, the share approved either
                    way, counting an edited-then-approved run as approved
    edit rate       of the approved ones, the share a person had to change
                    first

  They are re-applied to the summed counts rather than averaged across kinds
  of work, because averaging five rates would weight a kind with two runs the
  same as a kind with two hundred and would not equal the figure a direct
  query gives. That equality is what trust.test.ts asserts.
*/
const ROLLUP = `
	select m.agent,
	       sum(m.runs)::int            as runs,
	       sum(m.waiting)::int         as waiting,
	       sum(m.reviewed)::int        as reviewed,
	       sum(m.approved)::int        as approved,
	       sum(m.edited)::int          as edited,
	       sum(m.rejected)::int        as rejected,
	       sum(m.refusals)::int        as refusals,
	       sum(m.degradations)::int    as degradations,
	       round((sum(m.approved) + sum(m.edited))::numeric
	             / nullif(sum(m.approved) + sum(m.edited) + sum(m.rejected), 0), 4) as approval_rate,
	       round(sum(m.edited)::numeric
	             / nullif(sum(m.approved) + sum(m.edited), 0), 4)                   as edit_rate,
	       max(m.last_run_at)          as last_run_at
	from nl.agent_metrics m
	group by m.agent`;

interface RollupRow {
	agent: string;
	runs: number;
	waiting: number;
	reviewed: number;
	approved: number;
	edited: number;
	rejected: number;
	refusals: number;
	degradations: number;
	approval_rate: string | number | null;
	edit_rate: string | number | null;
	last_run_at: string | null;
}

/*
  Which principal in nl.users is which agent.

  There is no column joining the two, and there should not be a third copy of
  the mapping, so this reads it the way the harness's own wake does
  (harness/wake.ts, line 185): an agent principal holds a mailbox in its
  scope, and the mailbox's kind says which desk it is. The three agents that
  are not desks hold no mailbox and so have no principal row, which is the
  honest answer rather than a guess.
*/
const PRINCIPALS = `
	select u.id,
	       u.full_name,
	       mb.kind                                     as mailbox_kind,
	       g.limit_amount                              as grant_limit,
	       g.note                                      as grant_note,
	       g.starts_on                                 as grant_starts_on,
	       g.ends_on                                   as grant_ends_on,
	       ahead.limit_amount                          as ahead_limit,
	       ahead.starts_on                             as ahead_starts_on
	from nl.users u
	join nl.user_scope s
	  on s.user_id = u.id and s.dimension = 'mailbox' and s.value ~ '^[0-9]+$'
	join nl.mailboxes mb on mb.id = s.value::int
	left join lateral (
	  select ag.limit_amount, ag.note, ag.starts_on, ag.ends_on
	  from nl.authority_grants ag
	  where ag.user_id = u.id
	    and ag.authority = 'agent_autonomy'
	    and ag.starts_on <= nl.today()
	    and (ag.ends_on is null or ag.ends_on >= nl.today())
	  order by ag.starts_on desc
	  limit 1
	) g on true
	left join lateral (
	  select ag.limit_amount, ag.starts_on
	  from nl.authority_grants ag
	  where ag.user_id = u.id
	    and ag.authority = 'agent_autonomy'
	    and ag.starts_on > nl.today()
	  order by ag.starts_on
	  limit 1
	) ahead on true
	where u.kind = 'agent'`;

interface PrincipalDbRow {
	id: number;
	full_name: string;
	mailbox_kind: string;
	grant_limit: string | number | null;
	grant_note: string | null;
	grant_starts_on: string | null;
	grant_ends_on: string | null;
	ahead_limit: string | number | null;
	ahead_starts_on: string | null;
}

/** A numeric column from Postgres arrives as a string. One place to undo that. */
function num(value: string | number | null): number | null {
	if (value === null) return null;
	const n = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(n) ? n : null;
}

function isoDay(value: string | null): string | null {
	return value === null ? null : String(value).slice(0, 10);
}

/** The mailbox kind a desk agent's principal holds, per harness/wake.ts. */
function agentForMailboxKind(kind: string): AgentId | null {
	if (kind === 'orders') return 'order_desk';
	if (kind === 'procurement') return 'procurement_desk';
	return null;
}

/**
 * Every agent, separately, with its volume, its approval and edit rates, its
 * refusals, the level in force on each kind of work it does, and whether it
 * is paused.
 *
 * Never a merged "agents" total: one desk may be ready for more autonomy and
 * the other may not be, and a single figure hides exactly that.
 */
export async function agentSummaries(db: Db, userId: number): Promise<AgentSummary[]> {
	const [rollup, principals, board, pauses] = await Promise.all([
		db.asUser(userId, (tx) => tx.query<RollupRow>(ROLLUP)),
		db.asUser(userId, (tx) => tx.query<PrincipalDbRow>(PRINCIPALS)),
		readBoard(db, userId),
		readPauses(db, userId)
	]);

	const byAgent = new Map(rollup.map((r) => [r.agent, r]));
	const pauseFor = new Map(pauses.map((p) => [p.agent, p]));

	const principalFor = new Map<AgentId, PrincipalDbRow>();
	for (const row of principals) {
		const agent = agentForMailboxKind(row.mailbox_kind);
		if (agent) principalFor.set(agent, row);
	}

	return AGENTS.map((agent) => {
		const scope = AGENT_SCOPES.find((s) => s.id === agent)!;
		const m = byAgent.get(agent);
		const kinds: WorkKindRow[] = board
			.filter((row) => row.agent === agent)
			.map((row) => ({
				workKind: row.workKind,
				label: row.label,
				reviewer: row.reviewer,
				description: row.description,
				level: row.level,
				undoWindowMinutes: row.undoWindowMinutes,
				sampleRate: row.sampleRate,
				nextLevel: row.nextLevel,
				qualifies: row.qualifies,
				verdict: row.verdict,
				runs: row.runs,
				reviewed: row.reviewed,
				refusals: row.refusals,
				recentRefusals: row.recentRefusals,
				recentOfRuns: row.recentOfRuns,
				approvalRate: row.approvalRate,
				editRate: row.editRate,
				rule: row.rule
			}));

		// The board already carries acted-alone and undone per kind of work,
		// from nl.agent_sample_scores. Summing counts is not recomputing a
		// rate, so it is safe to do here.
		const rows = board.filter((row) => row.agent === agent);
		const actedAlone = rows.reduce((sum, row) => sum + row.actedAlone, 0);
		const undone = rows.reduce((sum, row) => sum + row.undone, 0);

		const levels = [...new Set(kinds.map((k) => k.level))].sort(
			(a, b) => LEVEL_RANK[a] - LEVEL_RANK[b]
		);
		const pause = pauseFor.get(agent);
		const principalRow = principalFor.get(agent) ?? null;

		return {
			agent,
			name: scope.name,
			purpose: scope.purpose,
			code: scope.code,
			reviewer: scope.reviewer,
			// An agent with no runs reads as "nothing yet", not as a zero that
			// looks like a failure. The two are completely different answers to
			// "can I trust this" and the page must never blur them.
			nothingYet: (m?.runs ?? 0) === 0,
			runs: m?.runs ?? 0,
			waiting: m?.waiting ?? 0,
			reviewed: m?.reviewed ?? 0,
			approved: m?.approved ?? 0,
			edited: m?.edited ?? 0,
			rejected: m?.rejected ?? 0,
			refusals: m?.refusals ?? 0,
			degradations: m?.degradations ?? 0,
			actedAlone,
			undone,
			approvalRate: num(m?.approval_rate ?? null),
			editRate: num(m?.edit_rate ?? null),
			lastRunAt: m?.last_run_at ? new Date(m.last_run_at).toISOString() : null,
			kinds,
			levels,
			undoWindowMinutes: kinds.reduce((most, k) => Math.max(most, k.undoWindowMinutes), 0),
			paused: pause?.paused === true,
			pausedReason: pause?.reason ?? '',
			pausedByName: pause?.byName ?? null,
			principal: principalRow
				? {
						id: Number(principalRow.id),
						fullName: principalRow.full_name,
						grantNumber: num(principalRow.grant_limit),
						grantNote: principalRow.grant_note ?? '',
						grantStartsOn: isoDay(principalRow.grant_starts_on),
						grantEndsOn: isoDay(principalRow.grant_ends_on),
						ahead: principalRow.ahead_starts_on
							? {
									grantNumber: num(principalRow.ahead_limit),
									startsOn: isoDay(principalRow.ahead_starts_on)!
								}
							: null
					}
				: null
		} satisfies AgentSummary;
	});
}

// ---------------------------------------------------------------------------
// What the agents declined to do
// ---------------------------------------------------------------------------

/**
 * The refusals, with the rule that did the refusing and where that rule is
 * really enforced.
 *
 * This is the most persuasive thing on the page and the thing nobody ever
 * shows. The counts come from nl.agent_events through listRefusals; the rule
 * text comes from the guardrail registry, which is the same registry the
 * guardrails eval suite has one case per check for.
 */
export async function refusals(db: Db, userId: number, limit = 20): Promise<RefusalRow[]> {
	const rows = await listRefusals(db, userId, limit);
	return rows.map((row) => {
		const rule = GUARDRAILS.find((g) => g.id === row.checkId) ?? null;
		return {
			agent: row.agent,
			agentName: agentName(row.agent),
			workKind: row.workKind,
			checkId: row.checkId,
			// A refusal by a rule with no registry entry still gets listed. A
			// missing description is a gap worth seeing, not a row to hide.
			rule: rule?.description ?? 'This check is not in the registry yet.',
			enforcedIn: rule?.enforcedIn ?? 'not recorded',
			times: row.times,
			lastAt: row.lastAt,
			lastDetail: row.lastDetail
		} satisfies RefusalRow;
	});
}

/** Every named guardrail, so the page can say what CAN refuse, not only what did. */
export function guardrailRoster(): { checkId: string; agents: string; description: string }[] {
	return GUARDRAILS.map((g) => ({
		checkId: g.id,
		agents: g.agents === 'all' ? 'every agent' : g.agents.map(agentName).join(', '),
		description: g.description
	}));
}

// ---------------------------------------------------------------------------
// The undo window
// ---------------------------------------------------------------------------

/** Actions an agent took on its own that a person can still pull back. */
export async function undoable(db: Db, userId: number, limit = 10): Promise<UndoableRow[]> {
	const rows = await listUndoable(db, userId, limit);
	return rows.map((row) => ({
		id: row.id,
		agent: row.agent,
		agentName: agentName(row.agent),
		workKind: row.workKind,
		action: row.action,
		entity: row.entity,
		entityId: row.entityId,
		atLevel: row.atLevel,
		actedAt: row.actedAt,
		undoUntil: row.undoUntil
	}));
}

// ---------------------------------------------------------------------------
// The trust trend: the one chart on the page
// ---------------------------------------------------------------------------

/*
  Approval rate, edit rate and refusals by week, for one agent.

  It reads nl.agent_run_log, which is the same view nl.agent_metrics is built
  on, with the same two rate expressions. That is a different GRAIN of the
  same figure, not a second definition: the test checks that the weeks add up
  to the agent's own row.

  date_trunc('week') in Postgres starts on Monday, which is also how the rest
  of this app talks about a week.
*/
const TREND = `
	select date_trunc('week', l.started_at)::date                         as week_start,
	       count(*)::int                                                  as runs,
	       count(*) filter (where l.review_state in
	         ('approved', 'edited_approved', 'rejected'))::int             as reviewed,
	       count(*) filter (where l.guardrail is not null)::int            as refusals,
	       round((count(*) filter (where l.review_state in ('approved', 'edited_approved'))::numeric)
	             / nullif(count(*) filter (where l.review_state in
	                 ('approved', 'edited_approved', 'rejected')), 0), 4)  as approval_rate,
	       round((count(*) filter (where l.review_state = 'edited_approved')::numeric)
	             / nullif(count(*) filter (where l.review_state in
	                 ('approved', 'edited_approved')), 0), 4)              as edit_rate
	from nl.agent_run_log l
	where l.agent = $1
	  and l.started_at >= (nl.today()::timestamptz - ($2::int || ' weeks')::interval)
	group by 1
	order by 1`;

interface TrendDbRow {
	week_start: string;
	runs: number;
	reviewed: number;
	refusals: number;
	approval_rate: string | number | null;
	edit_rate: string | number | null;
}

/**
 * One agent's trend, with the promotion rule it is working towards drawn
 * beside it. The threshold comes from the busiest kind of work that agent
 * does, because that is the kind whose numbers will actually carry the
 * promotion.
 *
 * It takes the summary rather than reading the board again: the page load
 * already has it, and these screens run close enough to the request timeout
 * that a repeated read is worth avoiding.
 */
export async function trustTrend(
	db: Db,
	userId: number,
	summary: AgentSummary,
	weeks = 8
): Promise<TrustTrend> {
	const agent = summary.agent;
	const rows = await db.asUser(userId, (tx) =>
		tx.query<TrendDbRow>(TREND, [agent, weeks])
	);

	// The busiest kind of work, by reviewed runs. Ties fall to whichever the
	// board listed first, which is alphabetical and therefore stable.
	const busiest = summary.kinds.reduce<WorkKindRow | null>(
		(best, row) => (best === null || row.reviewed > best.reviewed ? row : best),
		null
	);

	return {
		agent,
		agentName: agentName(agent),
		weeks: rows.map(
			(r) =>
				({
					weekStart: isoDay(r.week_start)!,
					runs: Number(r.runs),
					reviewed: Number(r.reviewed),
					refusals: Number(r.refusals),
					approvalRate: num(r.approval_rate),
					editRate: num(r.edit_rate)
				}) satisfies TrendWeek
		),
		threshold:
			busiest && busiest.rule && busiest.nextLevel
				? {
						approvalRate: busiest.rule.minApprovalRate,
						editRate: busiest.rule.maxEditRate,
						fromLevel: busiest.level,
						toLevel: busiest.nextLevel
					}
				: null
	};
}

// ---------------------------------------------------------------------------
// The eval results
// ---------------------------------------------------------------------------

/*
  The four suites, against the recorded baseline.

  The page does NOT run the suites. Three of the four need a database world
  loaded and the desk suite takes minutes, so a page load may not do it. What
  the page reads instead is exactly what the runner and the baseline test
  read:

    the baseline    evals/agents/baseline.json, through readBaseline(), the
                    same function evals.test.ts holds the suites to
    the cases       the runner's own loaders, loadJsonCases and loadTextCases,
                    so a case added on disk shows up here without anybody
                    editing this file
    the report      the newest file under evals/agents/reports

  A case count on disk that has moved away from the baseline's count is shown
  as a difference rather than smoothed over: it means the baseline needs
  re-recording, and hiding that would be the dishonest option.
*/

/** Which folder a suite's cases live in, and which agents the suite covers. */
const SUITES: { suite: string; folder: string; covers: string; text: boolean }[] = [
	{
		suite: 'guardrails',
		folder: 'guardrails',
		covers: 'Every agent. One case per named check in the registry.',
		text: false
	},
	{
		suite: 'order desk',
		folder: 'desk',
		covers: 'The order desk only. Real message text in, a graded reply out.',
		text: true
	},
	{
		suite: 'assistant',
		folder: 'assistant',
		covers: 'Ask Northline: which tools it reaches for, and what it may not run.',
		text: false
	},
	{
		suite: 'automation',
		folder: 'automation',
		covers: 'The rule runner: what each rule matches, and once per subject.',
		text: false
	}
];

function newestReportDate(): string | null {
	const dir = join(agentEvalsDir(), 'reports');
	if (!existsSync(dir)) return null;
	const dates = readdirSync(dir)
		.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
		.map((f) => f.replace(/\.md$/, ''))
		.sort();
	return dates.length === 0 ? null : dates[dates.length - 1];
}

export function evalSummary(): EvalSummary {
	const baseline = readBaseline();
	const suites: SuiteScore[] = SUITES.map((s) => {
		const names = s.text
			? loadTextCases<unknown>(s.folder).map((c) => c.name)
			: loadJsonCases<unknown>(s.folder).map((c) => c.name);
		const recorded = baseline?.[s.suite] ?? null;
		return {
			suite: s.suite,
			folder: s.folder,
			covers: s.covers,
			cases: names.length,
			passed: recorded?.passed ?? 0,
			baselineCases: recorded?.cases ?? 0,
			fields: Object.entries(recorded?.fields ?? {}).map(([field, f1]) => ({
				field,
				f1: Number(f1)
			})),
			caseNames: names
		} satisfies SuiteScore;
	});

	return {
		gradedAs: EVAL_TODAY,
		reportDate: newestReportDate(),
		suites,
		totalCases: suites.reduce((sum, s) => sum + s.cases, 0),
		totalPassed: suites.reduce((sum, s) => sum + s.passed, 0)
	};
}

/**
 * One case, read off disk for the link into it. The suite folder is checked
 * against the written list and the case name against the runner's own
 * pattern, so a path cannot be built out of whatever arrives in the URL.
 */
export function evalCase(
	folder: string,
	name: string
): { suite: string; folder: string; name: string; body: string; expected: string | null } | null {
	const suite = SUITES.find((s) => s.folder === folder);
	if (!suite) return null;
	if (!/^\d{2}-[a-z0-9-]+$/.test(name)) return null;

	if (suite.text) {
		const found = loadTextCases<unknown>(folder).find((c) => c.name === name);
		if (!found) return null;
		return {
			suite: suite.suite,
			folder,
			name,
			body: found.text,
			expected: JSON.stringify(found.expected, null, 2)
		};
	}
	const found = loadJsonCases<unknown>(folder).find((c) => c.name === name);
	if (!found) return null;
	return {
		suite: suite.suite,
		folder,
		name,
		body: JSON.stringify(found.body, null, 2),
		expected: null
	};
}
