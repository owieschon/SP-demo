/*
  The shapes the /agents trust page passes from its server load into its
  markup, and the words that go with them.

  This file is client-safe on purpose. Everything that reads the database
  lives in $lib/server/harness/**, and a .svelte file may not import from
  there, so the types and the labels sit here where both sides can see them.

  One rule runs through the whole page and therefore through this file: a
  figure is read from the harness, never counted a second way. Two different
  numbers for the same thing is worse than no number, so every field below
  arrives from nl.agent_metrics, nl.agent_autonomy_board or nl.agent_events
  and nothing here recomputes one.
*/

/*
  The four levels, mirrored here rather than imported from
  $lib/server/harness/types.ts, because a .svelte file may not import from
  $lib/server. The mirror is the same pattern $lib/roles/types.ts uses for the
  authority list, and trust.test.ts compares the two so they cannot drift.
*/
export type Level = 'shadow' | 'suggest' | 'auto_review' | 'auto';

export const AGENT_IDS = [
	'order_desk',
	'procurement_desk',
	'assistant',
	'automation',
	'mcp'
] as const;
export type AgentId = (typeof AGENT_IDS)[number];

/*
  The two desks are named separately everywhere on this page. A single merged
  "agents" figure hides exactly the thing a person came here to find out,
  which is that one desk may be ready for more rope and the other is not.
*/
export const DESK_AGENTS: AgentId[] = ['order_desk', 'procurement_desk'];

/** The four levels, as words, in ladder order. Mirrors harness/types.ts. */
export const LEVEL_WORDS: Record<Level, string> = {
	shadow: 'Shadow',
	suggest: 'Suggest',
	auto_review: 'Auto, with undo',
	auto: 'Auto, sampled'
};

export const LEVEL_SENTENCE: Record<Level, string> = {
	shadow: 'It drafts and nobody is asked to look.',
	suggest: 'It drafts and a person decides every one.',
	auto_review: 'It acts, and a person can undo it inside a window.',
	auto: 'It acts, and a sampled share is reviewed afterwards.'
};

/** Ladder order, so "one step up" and "this is a demotion" are checkable. */
export const LEVEL_RANK: Record<Level, number> = {
	shadow: 1,
	suggest: 2,
	auto_review: 3,
	auto: 4
};

export const LEVELS_IN_ORDER: Level[] = ['shadow', 'suggest', 'auto_review', 'auto'];

/*
  The bridge between the two places a level is written down, in ONE function
  so nobody writes it twice.

    the harness   nl.agent_autonomy.level, text, per agent AND per kind of
                  work. This is what the code reads before it acts
                  (nl.agent_autonomy_for, harness/ladder.ts planRun).
    the roles     nl.authority_grants, authority 'agent_autonomy', a number
                  0 to 3 against the agent's own principal row. This is the
                  audited human decision, made with the same call that raises
                  a person's approval limit.

  Migration 0031's header numbers the levels 0 to 3 and 0028's ordinal runs
  1 to 4 over the same four names, so the grant number is the ordinal less
  one. They are not two measures of one thing: one is the decision on the
  record, the other is the setting in force per kind of work. The page says
  which is which rather than averaging them into a single misleading figure.
*/
export function grantNumberFor(level: Level): number {
	return LEVEL_RANK[level] - 1;
}

export function levelForGrantNumber(grant: number | null): Level | null {
	if (grant === null || !Number.isInteger(grant) || grant < 0 || grant > 3) return null;
	return LEVELS_IN_ORDER[grant];
}

/** One kind of work an agent does, with its level and its numbers. */
export interface WorkKindRow {
	workKind: string;
	label: string;
	reviewer: string;
	description: string;
	level: Level;
	undoWindowMinutes: number;
	sampleRate: number;
	nextLevel: Level | null;
	/** True when the harness says the numbers clear the rule for the next step. */
	qualifies: boolean;
	/** Why not, or "the numbers clear the rule", in the harness's own words. */
	verdict: string;
	runs: number;
	reviewed: number;
	refusals: number;
	recentRefusals: number;
	recentOfRuns: number;
	approvalRate: number | null;
	editRate: number | null;
	rule: {
		minReviewed: number;
		minApprovalRate: number;
		maxEditRate: number;
		refusalWindow: number;
		maxRefusals: number;
		requiresSignoff: boolean;
	} | null;
}

/**
 * One agent, rolled up from nl.agent_metrics in SQL. The rollup is done in
 * the database, over the harness's own view, so the page never adds figures
 * up itself.
 */
export interface AgentSummary {
	agent: AgentId;
	name: string;
	purpose: string;
	/** Where the code is, from harness/scope.ts. */
	code: string;
	/** Who reviews its work, in plain words. */
	reviewer: string;

	/** True when this agent has never run. Not the same as a zero. */
	nothingYet: boolean;
	runs: number;
	waiting: number;
	reviewed: number;
	approved: number;
	edited: number;
	rejected: number;
	refusals: number;
	degradations: number;
	/** Runs it carried out on its own authority, at auto or auto with undo. */
	actedAlone: number;
	/** Of those, the ones a person pulled back inside the window. */
	undone: number;
	approvalRate: number | null;
	editRate: number | null;
	lastRunAt: string | null;

	/** Every kind of work it does, each with its own level. */
	kinds: WorkKindRow[];
	/** The levels in force across its kinds of work, lowest first, no repeats. */
	levels: Level[];
	/** The longest undo window any of its kinds of work carries, in minutes. */
	undoWindowMinutes: number;

	paused: boolean;
	pausedReason: string;
	pausedByName: string | null;

	/**
	 * Its principal row in nl.users, when it has one. Only the two desk agents
	 * are principals today, which is why only they can be promoted through
	 * nl.grant_authority.
	 */
	principal: {
		id: number;
		fullName: string;
		/** The granted level, 0 to 3, or null when nothing is granted. */
		grantNumber: number | null;
		grantNote: string;
		grantStartsOn: string | null;
		grantEndsOn: string | null;
		/** A grant that starts later, so a raise dated ahead is visible. */
		ahead: { grantNumber: number | null; startsOn: string } | null;
	} | null;
}

/** One guardrail refusal, grouped by the rule that did the refusing. */
export interface RefusalRow {
	agent: AgentId | string;
	agentName: string;
	workKind: string;
	checkId: string;
	/** What the rule is, from the guardrail registry. */
	rule: string;
	/** Where the rule is really enforced, which is not the registry. */
	enforcedIn: string;
	times: number;
	lastAt: string;
	/** The last refusal's own words. */
	lastDetail: string;
}

/** One suite's score, against the recorded baseline. */
export interface SuiteScore {
	/** The suite's name as the eval runner names it: 'order desk', 'guardrails'. */
	suite: string;
	/** The folder the cases live in, which is not always the suite name. */
	folder: string;
	/** What the agents this suite covers are, in words. */
	covers: string;
	/** Cases on disk right now, counted by the runner's own case loader. */
	cases: number;
	/** Cases the baseline records as fully right. */
	passed: number;
	/** The baseline's own case count, so a case added since shows up. */
	baselineCases: number;
	/** F1 per graded field, from the baseline. */
	fields: { field: string; f1: number }[];
	/** Every case name, for the link into one. */
	caseNames: string[];
}

export interface EvalSummary {
	/** The day the cases are graded as, pinned in the suites. */
	gradedAs: string;
	/** The newest dated report under evals/agents/reports, or null. */
	reportDate: string | null;
	suites: SuiteScore[];
	totalCases: number;
	totalPassed: number;
}

/** One week of the trust trend. The one chart on the page. */
export interface TrendWeek {
	/** The Monday the week starts, ISO. */
	weekStart: string;
	reviewed: number;
	approvalRate: number | null;
	editRate: number | null;
	refusals: number;
	runs: number;
}

export interface TrustTrend {
	agent: AgentId;
	agentName: string;
	weeks: TrendWeek[];
	/**
	 * The promotion rule in force for this agent's busiest kind of work, drawn
	 * on the chart as the reference line. A trend with no threshold beside it
	 * is a trend nobody can act on.
	 */
	threshold: { approvalRate: number; editRate: number; fromLevel: Level; toLevel: Level } | null;
}

/** An action still inside its undo window: the brake that has not expired. */
export interface UndoableRow {
	id: number;
	agent: string;
	agentName: string;
	workKind: string;
	action: string;
	entity: string;
	entityId: string;
	atLevel: Level;
	actedAt: string;
	undoUntil: string | null;
}

export function agentName(agent: string): string {
	const names: Record<string, string> = {
		order_desk: 'Order desk',
		procurement_desk: 'Procurement desk',
		assistant: 'Ask Northline',
		automation: 'Automation runner',
		mcp: 'MCP surface',
		all: 'Every agent'
	};
	return names[agent] ?? agent;
}

/**
 * A figure and what it is measured against, as one sentence. The house rule
 * is that no tile shows a number with nothing to compare it with, and that
 * the comparison is in words rather than a coloured arrow.
 */
export function shareWords(part: number, whole: number, noun: string): string {
	if (whole === 0) return `nothing to compare yet, no ${noun}`;
	const pct = Math.round((part / whole) * 100);
	return `${pct}% of ${whole} ${noun}`;
}
