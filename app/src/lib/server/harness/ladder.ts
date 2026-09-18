// The autonomy ladder: what an agent may do on its own, read before it does
// anything, and the one write that moves it.
//
// The level is per agent AND per kind of work, because a quote reply and a
// stock question are not the same risk. Four levels:
//
//   shadow       it drafts, nobody is asked to look
//   suggest      a person decides every one (where most of this app is today)
//   auto_review  it acts, and a person can undo it inside a window
//   auto         it acts, and a sampled share is reviewed afterwards
//
// planRun() is the whole decision, in one place, so "the code honours the
// level" is a function call and not a habit. Two things can override the
// level downwards and nothing can override it upwards:
//
//   * the pause switch, which is immediate and per agent or global;
//   * a guardrail that refused or asked for a person, which always wins.
import { z } from 'zod';
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import type { Autonomy, BoardRow, Level, PauseRow, Plan } from './types.ts';

export const LEVEL_ORDER: Record<Level, number> = {
	shadow: 1,
	suggest: 2,
	auto_review: 3,
	auto: 4
};

export function nextLevel(level: Level): Level | null {
	if (level === 'shadow') return 'suggest';
	if (level === 'suggest') return 'auto_review';
	if (level === 'auto_review') return 'auto';
	return null;
}

interface AutonomyJson {
	agent: string;
	work_kind: string;
	level: Level;
	undo_window_minutes: number;
	sample_rate: number;
	paused: boolean;
	pause: { paused: boolean; reason?: string; paused_by_name?: string };
	may_act: boolean;
	needs_review: boolean;
	hidden: boolean;
}

/**
 * What this agent may do with this kind of work, right now. Read inside the
 * agent's own transaction, so a pause pulled a second ago is already in force.
 */
export async function readAutonomy(tx: Tx, agent: string, workKind: string): Promise<Autonomy> {
	const [row] = await tx.sql<{ result: AutonomyJson | null }>`
		select nl.agent_autonomy_for(${agent}, ${workKind}) as result`;
	if (!row?.result) {
		// An unknown kind of work is treated as the most careful level there is.
		// A new intent must never act on its own just because nobody has written
		// a row for it yet.
		return {
			agent,
			workKind,
			level: 'suggest',
			undoWindowMinutes: 0,
			sampleRate: 0,
			paused: false,
			pauseReason: '',
			pausedByName: null,
			mayAct: false,
			needsReview: true,
			hidden: false
		};
	}
	const r = row.result;
	return {
		agent: r.agent,
		workKind: r.work_kind,
		level: r.level,
		undoWindowMinutes: r.undo_window_minutes,
		sampleRate: Number(r.sample_rate),
		paused: r.paused === true,
		pauseReason: r.pause?.reason ?? '',
		pausedByName: r.pause?.paused_by_name ?? null,
		mayAct: r.may_act === true,
		needsReview: r.needs_review === true,
		hidden: r.hidden === true
	};
}

export interface PlanInput {
	autonomy: Autonomy;
	/** A guardrail refused the output, or asked for a person. Always wins. */
	guardrail?: { checkId: string; verdict: 'refuse' | 'needs_person'; reason: string } | null;
	/** The agent itself was not sure enough to answer. Always wins. */
	unsure?: boolean;
	/** The run degraded to a cheaper path, so its answer is thinner than usual. */
	degraded?: boolean;
}

/**
 * What to do with one finished piece of work. The order of these branches is
 * the safety model: anything that refuses comes before anything that acts.
 */
export function planRun(input: PlanInput): Plan {
	const { autonomy } = input;

	if (input.guardrail) {
		return {
			do: 'queue',
			why: `${input.guardrail.checkId} says a person has to look: ${input.guardrail.reason}`
		};
	}
	if (input.unsure) {
		return { do: 'queue', why: 'The agent was not sure enough to answer, so it asks.' };
	}
	if (autonomy.paused) {
		return {
			do: 'queue',
			why: `${autonomy.agent} is paused${autonomy.pauseReason ? `: ${autonomy.pauseReason}` : ''}. It drafted and stopped.`
		};
	}
	// A run that fell back to a thinner answer does not act on its own. Degrade
	// to the cheaper honest path, never to a cheaper decision.
	if (input.degraded && autonomy.level !== 'shadow') {
		return { do: 'queue', why: 'This run degraded to a cheaper path, so a person decides it.' };
	}
	if (autonomy.level === 'shadow') {
		return { do: 'hold', why: 'Shadow: it drafted for the record and nobody is asked to look.' };
	}
	if (autonomy.level === 'suggest') {
		return { do: 'queue', why: 'Suggest: a person decides every one of these.' };
	}
	if (autonomy.level === 'auto_review') {
		return {
			do: 'act',
			undoMinutes: autonomy.undoWindowMinutes,
			why: `Auto with undo: it acts, and there are ${autonomy.undoWindowMinutes} minutes to undo it.`
		};
	}
	return {
		do: 'act_now',
		sampled: false,
		why: `Auto: it acts. About ${Math.round(autonomy.sampleRate * 100)}% of these are reviewed afterwards.`
	};
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

interface BoardDbRow {
	agent: string;
	work_kind: string;
	label: string;
	reviewer: string;
	description: string;
	level: Level;
	undo_window_minutes: number;
	sample_rate: number;
	set_by_name: string | null;
	set_at: string;
	note: string;
	next_level: Level | null;
	min_reviewed: number | null;
	min_approval_rate: number | null;
	max_edit_rate: number | null;
	refusal_window: number | null;
	max_refusals: number | null;
	requires_signoff: boolean | null;
	runs: number;
	waiting: number;
	reviewed: number;
	approved: number;
	edited: number;
	rejected: number;
	refusals: number;
	degradations: number;
	failures: number;
	approval_rate: number | null;
	edit_rate: number | null;
	rejection_rate: number | null;
	avg_review_minutes: number | null;
	median_review_minutes: number | null;
	edits_measured: number;
	avg_edit_chars: number | null;
	max_edit_chars: number | null;
	last_run_at: string | null;
	recent_refusals: number;
	recent_of_runs: number;
	acted_alone: number;
	undone: number;
	sampled: number;
	sample_reviewed: number;
	sample_pass_rate: number | null;
	paused: boolean;
	paused_reason: string | null;
	paused_by_name: string | null;
	qualifies: boolean;
	verdict: string;
}

function toBoardRow(r: BoardDbRow): BoardRow {
	return {
		agent: r.agent,
		workKind: r.work_kind,
		label: r.label,
		reviewer: r.reviewer,
		description: r.description,
		level: r.level,
		undoWindowMinutes: r.undo_window_minutes,
		sampleRate: Number(r.sample_rate),
		setByName: r.set_by_name,
		setAt: new Date(r.set_at).toISOString(),
		note: r.note,
		nextLevel: r.next_level,
		rule:
			r.next_level === null
				? null
				: {
						minReviewed: Number(r.min_reviewed ?? 0),
						minApprovalRate: Number(r.min_approval_rate ?? 0),
						maxEditRate: Number(r.max_edit_rate ?? 0),
						refusalWindow: Number(r.refusal_window ?? 0),
						maxRefusals: Number(r.max_refusals ?? 0),
						requiresSignoff: r.requires_signoff === true
					},
		runs: Number(r.runs),
		waiting: Number(r.waiting),
		reviewed: Number(r.reviewed),
		approved: Number(r.approved),
		edited: Number(r.edited),
		rejected: Number(r.rejected),
		refusals: Number(r.refusals),
		degradations: Number(r.degradations),
		failures: Number(r.failures),
		approvalRate: r.approval_rate === null ? null : Number(r.approval_rate),
		editRate: r.edit_rate === null ? null : Number(r.edit_rate),
		rejectionRate: r.rejection_rate === null ? null : Number(r.rejection_rate),
		avgReviewMinutes: r.avg_review_minutes === null ? null : Number(r.avg_review_minutes),
		medianReviewMinutes: r.median_review_minutes === null ? null : Number(r.median_review_minutes),
		editsMeasured: Number(r.edits_measured),
		avgEditChars: r.avg_edit_chars === null ? null : Number(r.avg_edit_chars),
		maxEditChars: r.max_edit_chars === null ? null : Number(r.max_edit_chars),
		lastRunAt: r.last_run_at === null ? null : new Date(r.last_run_at).toISOString(),
		recentRefusals: Number(r.recent_refusals),
		recentOfRuns: Number(r.recent_of_runs),
		actedAlone: Number(r.acted_alone),
		undone: Number(r.undone),
		sampled: Number(r.sampled),
		sampleReviewed: Number(r.sample_reviewed),
		samplePassRate: r.sample_pass_rate === null ? null : Number(r.sample_pass_rate),
		paused: r.paused === true,
		pausedReason: r.paused_reason,
		pausedByName: r.paused_by_name,
		qualifies: r.qualifies === true,
		verdict: r.verdict
	};
}

/** Every agent and kind of work, with its level, its numbers and its verdict. */
export async function readBoard(db: Db, userId: number): Promise<BoardRow[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<BoardDbRow>`select * from nl.agent_autonomy_board order by agent, work_kind`
	);
	return rows.map(toBoardRow);
}

/** The live pauses, and the agents that are running. */
export async function readPauses(db: Db, userId: number): Promise<PauseRow[]> {
	const agents = ['all', 'order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp'];
	return db.asUser(userId, async (tx) => {
		const out: PauseRow[] = [];
		for (const agent of agents) {
			const [row] = await tx.sql<{ result: { paused: boolean; reason?: string; paused_by_name?: string; paused_at?: string } }>`
				select nl.agent_paused(${agent}) as result`;
			out.push({
				agent,
				paused: row.result.paused === true,
				reason: row.result.reason ?? '',
				byName: row.result.paused_by_name ?? null,
				at: row.result.paused_at ? new Date(row.result.paused_at).toISOString() : null
			});
		}
		return out;
	});
}

// ---------------------------------------------------------------------------
// The two writes a person makes
// ---------------------------------------------------------------------------

export const setLevelInput = z.object({
	agent: z.string().trim().min(3).max(30),
	workKind: z.string().trim().min(2).max(30),
	level: z.enum(['shadow', 'suggest', 'auto_review', 'auto']),
	reason: z.string().trim().max(500).default(''),
	requestId: z.string().min(8).max(100)
});
export type SetLevelInput = z.infer<typeof setLevelInput>;

/**
 * Move a level. Admin only, one step at a time upwards, and only when the
 * numbers clear the rule; downwards always, immediately. All of that is
 * checked in nl.set_agent_autonomy, not here, so the page and a test and an
 * eval all get the same answer.
 */
export async function setLevel(
	db: Db,
	userId: number,
	input: SetLevelInput
): Promise<{ level: Level; changed: boolean; fromLevel?: Level }> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { level: Level; changed: boolean; from_level?: Level } }>`
				select nl.set_agent_autonomy(${input.agent}, ${input.workKind}, ${input.level},
				                             ${input.reason}, ${input.requestId}) as result`
		)
	);
	return {
		level: row.result.level,
		changed: row.result.changed === true,
		fromLevel: row.result.from_level
	};
}

export const pauseInput = z.object({
	agent: z.enum(['all', 'order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp']),
	paused: z.coerce.boolean(),
	reason: z.string().trim().max(500).default(''),
	requestId: z.string().min(8).max(100)
});
export type PauseInput = z.infer<typeof pauseInput>;

/** Pull the brake, or let it go. Anybody may pull it; an admin lets it go. */
export async function setPause(
	db: Db,
	userId: number,
	input: PauseInput
): Promise<{ paused: boolean; changed: boolean }> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { paused: boolean; changed: boolean } }>`
				select nl.set_agent_pause(${input.agent}, ${input.paused}, ${input.reason},
				                          ${input.requestId}) as result`
		)
	);
	return { paused: row.result.paused === true, changed: row.result.changed === true };
}

/**
 * The automatic demotion: anything at 'auto' whose sampled reviews have gone
 * bad drops back to auto_review. Nobody decides it, which is why it is a rule
 * with its numbers written down.
 */
export async function demoteOnSample(
	db: Db,
	userId: number,
	input: { minReviewed?: number; minPassRate?: number; requestId: string }
): Promise<{ demoted: { agent: string; work_kind: string; sample_pass_rate: number | null }[] }> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { demoted: { agent: string; work_kind: string; sample_pass_rate: number | null }[] } }>`
				select nl.demote_agents_on_sample(${input.minReviewed ?? 20}, ${input.minPassRate ?? 0.9},
				                                  ${input.requestId}) as result`
		)
	);
	return { demoted: row.result.demoted ?? [] };
}
