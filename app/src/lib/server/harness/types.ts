// The shapes the harness hands to its page and its tests. One file, so the
// server and the components cannot drift.

// The ladder's four names and their sentences live in $lib/harness/levels,
// so a page component can import the labels as values without importing out
// of $lib/server. They are re-exported here because everything on the server
// already asks this file for them.
export { LEVELS, LEVEL_LABEL, LEVEL_MEANING, LEVEL_ORDER, type Level } from '$lib/harness/levels';
import type { Level } from '$lib/harness/levels';

/** What the harness decided to do with one run, before it did it. */
export type Plan =
	| { do: 'hold'; why: string }
	| { do: 'queue'; why: string }
	| { do: 'act'; undoMinutes: number; why: string }
	| { do: 'act_now'; sampled: boolean; why: string };

export interface Autonomy {
	agent: string;
	workKind: string;
	level: Level;
	undoWindowMinutes: number;
	sampleRate: number;
	paused: boolean;
	pauseReason: string;
	pausedByName: string | null;
	mayAct: boolean;
	needsReview: boolean;
	hidden: boolean;
}

export interface BoardRow {
	agent: string;
	workKind: string;
	label: string;
	reviewer: string;
	description: string;
	level: Level;
	undoWindowMinutes: number;
	sampleRate: number;
	setByName: string | null;
	setAt: string;
	note: string;
	nextLevel: Level | null;
	rule: {
		minReviewed: number;
		minApprovalRate: number;
		maxEditRate: number;
		refusalWindow: number;
		maxRefusals: number;
		requiresSignoff: boolean;
	} | null;
	runs: number;
	waiting: number;
	reviewed: number;
	approved: number;
	edited: number;
	rejected: number;
	refusals: number;
	degradations: number;
	failures: number;
	approvalRate: number | null;
	editRate: number | null;
	rejectionRate: number | null;
	avgReviewMinutes: number | null;
	medianReviewMinutes: number | null;
	editsMeasured: number;
	avgEditChars: number | null;
	maxEditChars: number | null;
	lastRunAt: string | null;
	recentRefusals: number;
	recentOfRuns: number;
	actedAlone: number;
	undone: number;
	sampled: number;
	sampleReviewed: number;
	samplePassRate: number | null;
	paused: boolean;
	pausedReason: string | null;
	pausedByName: string | null;
	qualifies: boolean;
	verdict: string;
}

export interface RunRow {
	agent: string;
	workKind: string;
	runKey: string;
	sourceId: number;
	wokeBy: string;
	wakeDetail: string;
	subjectKind: string | null;
	subjectNo: string | null;
	inputIds: Record<string, unknown>;
	toolCalls: { name: string | null; risk?: string; outcome?: string; ms?: number | null; rows?: number | null }[];
	toolCallCount: number;
	mode: string;
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	produced: string;
	producedRef: Record<string, unknown>;
	actedAs: number | null;
	actedAsName: string | null;
	reviewState: 'none' | 'waiting' | 'approved' | 'edited_approved' | 'rejected';
	reviewedByName: string | null;
	reviewedAt: string | null;
	outcome: string;
	startedAt: string;
	finishedAt: string | null;
	ms: number;
	guardrail: string | null;
	guardrailReason: string | null;
	degraded: boolean;
	degradedReason: string | null;
	/** Every guardrail, degradation and autonomy note on this run, oldest first. */
	events: { kind: string; check_id: string; verdict: string; detail: string; at: string }[];
	levelAtRead: Level | null;
	/** The autonomous action this run took, when it took one. */
	action: ActionRow | null;
	editDeltaChars: number | null;
}

export interface ActionRow {
	id: number;
	agent: string;
	workKind: string;
	runKey: string;
	action: string;
	entity: string;
	entityId: string;
	atLevel: Level;
	actedByName: string;
	actedAt: string;
	undoUntil: string | null;
	/** True while the window is still open and nothing has undone it. */
	undoable: boolean;
	sampled: boolean;
	sampleVerdict: 'good' | 'bad' | null;
	status: 'done' | 'undoing' | 'undone' | 'irreversible';
	undoneByName: string | null;
	undoneAt: string | null;
	undoReason: string;
	detail: Record<string, unknown>;
}

export interface PauseRow {
	agent: string;
	paused: boolean;
	reason: string;
	byName: string | null;
	at: string | null;
}
