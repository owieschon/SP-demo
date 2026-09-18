/*
  Question three: are the agents earning trust?

  Every figure here is read from the harness, not counted a second way.
  nl.agent_autonomy_board already holds volume, approval rate, edit rate,
  refusals and the current level per agent and kind of work, and
  app/src/lib/server/harness/ladder.ts is the one reader of it. This file
  calls that reader and adds nothing of its own to the per-agent numbers, so
  the overview and the harness cannot disagree about whether an agent is at
  90% approval. Where a figure is a total across agents it is arithmetic on
  the board's own counts, and it says that it is blended.

  The value ledger is the one thing the board cannot answer, because the board
  counts for all time and the ledger is about this week. It is counted from
  nl.agent_actions and nl.agent_run_log, which are the same tables the board
  is built from, and every line links to the rows it counted.

  What the ledger deliberately does not do is put money on any of it. This
  database can say that the desk drafted a reply and a person sent it as
  written; it cannot say what that was worth, because nothing anywhere records
  what the alternative cost. An invented figure would be the most impressive
  thing on this page and the only dishonest one.
*/
import type { Db } from '../db/types.ts';
import { readBoard, readPauses } from '../harness/ladder.ts';
import { listRefusals, listRuns, runSources, getRun } from '../harness/runs.ts';
import { LEVEL_LABEL, LEVEL_MEANING, type RunRow } from '../harness/types.ts';
import { links } from './links.ts';
import type { AgentRow, AgentSection, DeskRow, Figure, ValueLine } from './types.ts';

/*
  What each agent is for, in one line, and the order they belong in. The two
  desks come first because they are the ones that talk to somebody outside the
  company, so their trust is the trust that matters most, and they are never
  added together: they do different work for different counterparties.
*/
const AGENT_LABEL: Record<string, { label: string; responsibility: string }> = {
	order_desk: {
		label: 'Order desk',
		responsibility: 'Reads customer email and drafts the reply, the quote or the order status.'
	},
	procurement_desk: {
		label: 'Procurement desk',
		responsibility: 'Reads vendor email and works out what to buy, how much and by when.'
	},
	assistant: {
		label: 'Assistant',
		responsibility: 'Answers a question about the database, and proposes a change a person decides.'
	},
	automation: {
		label: 'Automation rules',
		responsibility: 'Runs the rules somebody set up, every night.'
	},
	mcp: {
		label: 'Outside agents',
		responsibility: 'An agent connected over the MCP server, working under a scoped token.'
	}
};

const AGENT_ORDER = ['order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp'];

interface WeekRow {
	acted: number;
	undone: number;
	approved: number;
	edited: number;
	rejected: number;
	refused: number;
	runs: number;
}

/*
  The week, from the same tables the board is built from. Seven days back from
  now() rather than from nl.today(), because these are timestamps rather than
  business dates.
*/
const WEEK_SQL = `
	select
		(select count(*) from nl.agent_actions a
		  where a.acted_at > now() - interval '7 days')::int                        as acted,
		(select count(*) from nl.agent_actions a
		  where a.acted_at > now() - interval '7 days' and a.status = 'undone')::int as undone,
		(select count(*) from nl.agent_run_log l
		  where l.reviewed_at > now() - interval '7 days'
		    and l.review_state = 'approved')::int                                   as approved,
		(select count(*) from nl.agent_run_log l
		  where l.reviewed_at > now() - interval '7 days'
		    and l.review_state = 'edited_approved')::int                            as edited,
		(select count(*) from nl.agent_run_log l
		  where l.reviewed_at > now() - interval '7 days'
		    and l.review_state = 'rejected')::int                                   as rejected,
		(select count(*) from nl.agent_events e
		  where e.at > now() - interval '7 days'
		    and e.kind = 'guardrail' and e.verdict <> 'pass')::int                   as refused,
		(select count(*) from nl.agent_run_log l
		  where l.started_at > now() - interval '7 days')::int                       as runs`;

export async function readAgents(db: Db, userId: number): Promise<AgentSection> {
	// The harness's own readers. Four trips, all small.
	const [board, pauses, sources, week] = await Promise.all([
		readBoard(db, userId),
		readPauses(db, userId),
		runSources(db, userId),
		db.asUser(userId, (tx) => tx.query<WeekRow>(WEEK_SQL))
	]);
	const w = week[0];

	const rows: AgentRow[] = board.map((b) => ({
		agent: b.agent,
		workKind: b.workKind,
		label: b.label,
		level: b.level,
		levelLabel: LEVEL_LABEL[b.level],
		levelMeaning: LEVEL_MEANING[b.level],
		reviewer: b.reviewer,
		paused: b.paused,
		pausedReason: b.pausedReason,
		runs: b.runs,
		waiting: b.waiting,
		reviewed: b.reviewed,
		approvalRate: b.approvalRate,
		editRate: b.editRate,
		refusals: b.refusals,
		actedAlone: b.actedAlone,
		undone: b.undone,
		lastRunAt: b.lastRunAt,
		verdict: b.verdict,
		href: links.runs({ agent: b.agent, workKind: b.workKind }),
		refusalsHref: links.runs({ agent: b.agent, workKind: b.workKind, refused: true }),
		actedHref: links.runs({ agent: b.agent, workKind: b.workKind, acted: true })
	}));

	/*
	  One card per agent. Every number on a card is a sum of that agent's own
	  board rows, so no card is mixed with another and nothing is recomputed
	  from the run log a second time. A rate is arithmetic on those counts and
	  the card says it is blended across that agent's kinds of work.
	*/
	// The two desks first, then the rest, then anything this file has not been
	// told about, alphabetically, so a new agent appears rather than vanishes.
	const rank = (agent: string) => {
		const at = AGENT_ORDER.indexOf(agent);
		return at === -1 ? AGENT_ORDER.length : at;
	};
	const agents = [...new Set(board.map((b) => b.agent))].sort(
		(a, b) => rank(a) - rank(b) || a.localeCompare(b)
	);
	const desks: DeskRow[] = agents.map((agent) => {
		const mine = board.filter((b) => b.agent === agent);
		const sum = (pick: (row: (typeof mine)[number]) => number) =>
			mine.reduce((total, row) => total + pick(row), 0);
		const reviewedHere = sum((r) => r.reviewed);
		const approvedHere = sum((r) => r.approved);
		const editedHere = sum((r) => r.edited);
		const named = AGENT_LABEL[agent];
		// The kind furthest from its next step is the one worth naming: a card
		// that says "ready" has to mean every kind of work it does.
		const blocking = mine.find((r) => r.nextLevel !== null && !r.qualifies) ?? mine[0];
		return {
			agent,
			label: named?.label ?? agent,
			responsibility: named?.responsibility ?? '',
			kinds: mine.length,
			levels: [...new Set(mine.map((r) => LEVEL_LABEL[r.level]))],
			runs: sum((r) => r.runs),
			waiting: sum((r) => r.waiting),
			reviewed: reviewedHere,
			approved: approvedHere,
			edited: editedHere,
			rejected: sum((r) => r.rejected),
			approvalRate: reviewedHere === 0 ? null : (approvedHere + editedHere) / reviewedHere,
			editRate: approvedHere + editedHere === 0 ? null : editedHere / (approvedHere + editedHere),
			refusals: sum((r) => r.refusals),
			actedAlone: sum((r) => r.actedAlone),
			undone: sum((r) => r.undone),
			paused: mine.some((r) => r.paused),
			pausedReason: mine.find((r) => r.paused)?.pausedReason ?? null,
			readyForMore: mine.every((r) => r.nextLevel === null || r.qualifies),
			verdict: blocking?.verdict ?? 'No work of this kind is set up.',
			lastRunAt: mine.reduce<string | null>(
				(latest, r) => (r.lastRunAt && (!latest || r.lastRunAt > latest) ? r.lastRunAt : latest),
				null
			),
			href: links.runs({ agent }),
			refusalsHref: links.runs({ agent, refused: true }),
			actedHref: links.runs({ agent, acted: true })
		};
	});

	/*
	  Only the figures that are genuinely about all of them at once. There is
	  deliberately no blended approval rate and no blended edit rate: those are
	  the two numbers that decide whether an agent gets more rope, and a single
	  figure across two desks hides the case where one is ready and one is not.
	*/
	const runsAll = rows.reduce((sum, r) => sum + r.runs, 0);
	const waiting = rows.reduce((sum, r) => sum + r.waiting, 0);
	const refusals = rows.reduce((sum, r) => sum + r.refusals, 0);
	const actedAlone = rows.reduce((sum, r) => sum + r.actedAlone, 0);
	const undone = rows.reduce((sum, r) => sum + r.undone, 0);
	const pausedAgents = pauses.filter((p) => p.paused);
	const atAuto = rows.filter((r) => r.level === 'auto' || r.level === 'auto_review').length;
	const ready = desks.filter((d) => d.readyForMore && d.reviewed > 0).length;

	const figures: Figure[] = [
		{
			id: 'agent-runs',
			label: 'Runs the agents have handled',
			value: runsAll,
			unit: 'count',
			compare:
				runsAll === 0
					? 'no agent has run yet in this database, so there is nothing to judge'
					: `${waiting} waiting on a person now, ${refusals} stopped by a guardrail, across ` +
						`${desks.length} agents counted separately`,
			source: 'the harness run log',
			href: links.runs(),
			hrefLabel: 'The feed',
			tone: 'plain'
		},
		{
			id: 'agent-ready',
			label: 'Agents whose numbers clear the rule',
			value: ready,
			unit: 'count',
			compare:
				desks.length === 0
					? 'no agent is set up in this database'
					: `of ${desks.length}. The rule is the promotion rule in the harness, and a person still has ` +
						`to sign the step off`,
			source: 'the autonomy ladder',
			href: links.autonomy(),
			hrefLabel: 'The controls',
			tone: 'plain'
		},
		{
			id: 'agent-acted',
			label: 'Acted without being asked',
			value: actedAlone,
			unit: 'count',
			compare:
				actedAlone === 0
					? `nothing has acted on its own: ${atAuto} of ${rows.length} kinds of work are allowed to`
					: `${undone} of them were undone afterwards, and ${atAuto} of ${rows.length} kinds of work are ` +
						`allowed to act at all`,
			source: 'the autonomy ladder',
			href: links.runs({ acted: true }),
			hrefLabel: 'What they did',
			tone: undone > 0 ? 'warn' : 'plain',
			toneWord: undone > 0 ? 'some undone' : undefined
		},
		{
			id: 'agent-paused',
			label: 'Agents paused',
			value: pausedAgents.length,
			unit: 'count',
			compare:
				pausedAgents.length === 0
					? `none: the brake is off for all ${pauses.length} switches`
					: `${pausedAgents.map((p) => p.agent).join(', ')}. A paused agent still drafts and stops`,
			source: 'the pause switch',
			href: links.autonomy(),
			hrefLabel: 'The controls',
			tone: pausedAgents.length > 0 ? 'danger' : 'plain',
			toneWord: pausedAgents.length > 0 ? 'stopped' : undefined
		}
	];

	return {
		desks,
		rows,
		figures,
		value: valueLedger(w),
		valueCaveat:
			'Counted, not valued. Each line is a number of rows you can open, over the last seven days. Nothing ' +
			'here is a saving or an hour recovered: this database records what the agents did, and nothing anywhere ' +
			'records what the same work would have cost otherwise, so a money figure would be made up.',
		sources
	};
}

/*
  Every line is a count of rows that exist, with the link that shows them. A
  line whose count is zero stays in: "nothing was undone this week" is worth
  reading, and a ledger that hides its zeros is a ledger you cannot trust.
*/
function valueLedger(w: WeekRow | undefined): ValueLine[] {
	if (!w) return [];
	return [
		{
			id: 'week-runs',
			what: 'Runs the agents started',
			count: Number(w.runs),
			basis: 'one row per run in the harness log',
			href: links.runs()
		},
		{
			id: 'week-approved',
			what: 'Drafts a person sent as written',
			count: Number(w.approved),
			basis: 'runs a person approved without changing anything',
			href: links.queue()
		},
		{
			id: 'week-edited',
			what: 'Drafts a person corrected first',
			count: Number(w.edited),
			basis: 'runs approved after an edit, with the size of the edit on the run',
			href: links.queue()
		},
		{
			id: 'week-rejected',
			what: 'Drafts a person rejected',
			count: Number(w.rejected),
			basis: 'runs a person turned down',
			href: links.queue()
		},
		{
			id: 'week-acted',
			what: 'Actions an agent took on its own authority',
			count: Number(w.acted),
			basis: 'one row per action in nl.agent_actions, at the level in force at the time',
			href: links.runs({ acted: true })
		},
		{
			id: 'week-undone',
			what: 'Actions a person undid',
			count: Number(w.undone),
			basis: 'actions undone inside their window',
			href: links.runs({ acted: true })
		},
		{
			id: 'week-refused',
			what: 'Times a guardrail stopped one',
			count: Number(w.refused),
			basis: 'guardrail events with a verdict other than pass',
			href: links.runs({ refused: true })
		}
	];
}

// ---------------------------------------------------------------------------
// The run feed and one run
// ---------------------------------------------------------------------------

export interface RunListRow {
	runKey: string;
	agent: string;
	workKind: string;
	wokeBy: string;
	wakeDetail: string;
	subjectKind: string | null;
	subjectNo: string | null;
	subjectHref: string | null;
	produced: string;
	outcome: string;
	reviewState: string;
	reviewedByName: string | null;
	guardrail: string | null;
	guardrailReason: string | null;
	degraded: boolean;
	toolCallCount: number;
	ms: number;
	startedAt: string;
	actedAlone: boolean;
	href: string;
}

export interface RunFeed {
	rows: RunListRow[];
	/** What the list is, including the filters in force. */
	note: string;
	filters: { agent: string | null; workKind: string | null; refused: boolean; acted: boolean };
	/** The most common refusals, so the feed is not the only way in. */
	refusals: { agent: string; workKind: string; checkId: string; times: number; lastDetail: string; href: string }[];
}

/** The subject a run was about, when it has a page of its own. */
function subjectHref(kind: string | null, no: string | null): string | null {
	if (!no) return null;
	if (kind === 'account') return links.account(no);
	if (kind === 'vendor') return links.vendor(no);
	return null;
}

function toListRow(run: RunRow): RunListRow {
	return {
		runKey: run.runKey,
		agent: run.agent,
		workKind: run.workKind,
		wokeBy: run.wokeBy,
		wakeDetail: run.wakeDetail,
		subjectKind: run.subjectKind,
		subjectNo: run.subjectNo,
		subjectHref: subjectHref(run.subjectKind, run.subjectNo),
		produced: run.produced,
		outcome: run.outcome,
		reviewState: run.reviewState,
		reviewedByName: run.reviewedByName,
		guardrail: run.guardrail,
		guardrailReason: run.guardrailReason,
		degraded: run.degraded,
		toolCallCount: run.toolCallCount,
		ms: run.ms,
		startedAt: run.startedAt,
		actedAlone: run.action !== null,
		href: links.run(run.runKey)
	};
}

export async function readRunFeed(
	db: Db,
	userId: number,
	filters: { agent: string | null; workKind: string | null; refused: boolean; acted: boolean }
): Promise<RunFeed> {
	const [runs, refusals] = await Promise.all([
		listRuns(db, userId, {
			agent: filters.agent,
			workKind: filters.workKind,
			refusedOnly: filters.refused,
			actedOnly: filters.acted,
			limit: 100
		}),
		listRefusals(db, userId, 10)
	]);

	const what = [
		filters.refused ? 'runs a guardrail stopped' : null,
		filters.acted ? 'runs that acted on their own' : null
	].filter(Boolean);

	return {
		rows: runs.map(toListRow),
		filters,
		note:
			(what.length ? `${what.join(' and ')}` : 'Every run') +
			(filters.agent ? `, ${filters.agent}` : ', all agents') +
			(filters.workKind ? `, ${filters.workKind}` : '') +
			', newest first, from the harness run log.',
		refusals: refusals.map((r) => ({
			agent: r.agent,
			workKind: r.workKind,
			checkId: r.checkId,
			times: r.times,
			lastDetail: r.lastDetail,
			href: links.runs({ agent: r.agent, workKind: r.workKind, refused: true })
		}))
	};
}

export interface RunDetail {
	run: RunRow;
	/** The record the run was about, when it has a page. */
	subjectHref: string | null;
	/** Back to the feed for this agent. */
	agentHref: string;
	/** Where the level that decided this run is set. */
	levelHref: string;
	levelLabel: string | null;
	levelMeaning: string | null;
}

export async function readRun(db: Db, userId: number, runKey: string): Promise<RunDetail | null> {
	const run = await getRun(db, userId, runKey);
	if (!run) return null;
	return {
		run,
		subjectHref: subjectHref(run.subjectKind, run.subjectNo),
		agentHref: links.runs({ agent: run.agent }),
		levelHref: links.autonomy(),
		levelLabel: run.levelAtRead ? LEVEL_LABEL[run.levelAtRead] : null,
		levelMeaning: run.levelAtRead ? LEVEL_MEANING[run.levelAtRead] : null
	};
}
