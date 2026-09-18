// The run trail, as the server hands it to the components. Shared by both, so
// neither can drift from the other.
//
// A run is one waking of one agent, and the harness owns it (migration 0028,
// nl.agent_runs). A TRAIL is how that run reached its decision: the steps, in
// order, with each tool call's arguments and each refusal's rule. This file
// is the trail's half of the shape, plus the few run fields the trail is read
// beside.

import type { Disclosure, FactKind } from '$lib/desk/types';

export const AGENT_LABEL: Record<string, string> = {
	order_desk: 'Order desk agent',
	procurement_desk: 'Procurement desk agent',
	assistant: 'Assistant',
	automation: 'Automation',
	mcp: 'Coding agent'
};

export function agentLabel(agent: string): string {
	return AGENT_LABEL[agent] ?? agent.replace(/_/g, ' ');
}

/** The only ways anything in this app starts. */
export type WokeBy = 'mail' | 'signal' | 'schedule' | 'person';

export const WOKE_LABEL: Record<WokeBy, string> = {
	mail: 'Mail arrived',
	signal: 'A signal fired',
	schedule: 'A schedule came round',
	person: 'A person asked'
};

/** The harness's outcomes (nl.agent_runs), said in plain English. */
export const OUTCOME_LABEL: Record<string, string> = {
	ok: 'Drafted',
	running: 'Still running',
	needs_person: 'Handed to a person',
	ignored: 'Left alone',
	refused: 'Refused',
	failed: 'Failed'
};

/** What a person did to what the run produced (nl.agent_run_log). */
export const REVIEW_LABEL: Record<string, string> = {
	none: 'nothing to review',
	waiting: 'not looked at yet',
	approved: 'approved as written',
	edited_approved: 'edited, then approved',
	rejected: 'rejected'
};

export type StepKind = 'read' | 'tool' | 'decision' | 'refusal' | 'output' | 'note';

export const STEP_LABEL: Record<StepKind, string> = {
	read: 'Read',
	tool: 'Called',
	decision: 'Decided',
	refusal: 'Refused',
	output: 'Produced',
	note: 'Noted'
};

/**
 * One step of a run.
 *
 * `withheld` means the detail is not here, for one of two reasons, and
 * `withheldReason` says which:
 *
 *   * the level the run's own output was drafted at could not hold it, so it
 *     was never stored (app/src/lib/server/agentruns/trail.ts), or
 *   * the person reading this trail may not be shown a kind of fact the step
 *     rests on, so it was left out of the payload assembled for them
 *     (app/src/lib/server/agentruns/read.ts, through nl.may_see).
 *
 * Either way the label and the reason are still here, because a step that
 * vanished would be worse than a step that says what it is keeping back.
 */
export interface RunStep {
	id: number;
	seq: number;
	kind: StepKind;
	label: string;
	tool: string | null;
	args: Record<string, unknown> | null;
	result: string;
	rows: number | null;
	ms: number | null;
	/** On a refusal: which rule, and what it says. */
	rule: string | null;
	ruleNote: string;
	/**
	 * Which kinds of fact this step's detail rests on, in the disclosure
	 * policy's own vocabulary. Empty on a step that rests on no business fact
	 * (a row count, a timing, a rule). Kept on a withheld step too, so the
	 * page can say what is being held back rather than only that something is.
	 */
	factKinds: FactKind[];
	withheld: boolean;
	withheldReason: string;
}

/**
 * One run as the trail shows it: the harness's row, plus the trail's own
 * wake, decision and counts. A run with no trail has `hasTrail` false and no
 * steps, which is every run made before this was built.
 */
export interface RunSummary {
	runKey: string;
	agent: string;
	workKind: string;
	sourceId: number;
	hasTrail: boolean;
	wokeBy: WokeBy;
	wokeNote: string;
	entity: string | null;
	entityId: number | null;
	reader: Disclosure;
	subjectNo: string | null;
	bundleVersion: string | null;
	decision: string;
	refusals: number;
	stepCount: number;
	mode: string;
	model: string | null;
	inputTokens: number;
	outputTokens: number;
	startedAt: string;
	finishedAt: string | null;
	ms: number;
	outcome: string;
	produced: string;
	/** What a person did to it afterwards: the harness's review state. */
	reviewState: string;
	reviewedAt: string | null;
	/** A guardrail the harness stopped the run with, if one did. */
	guardrail: string | null;
	guardrailReason: string | null;
}

export interface RunTrail extends RunSummary {
	steps: RunStep[];
}

/** What a replay found. */
export type ReplayDiffKind = 'same' | 'wording' | 'decision';

export const DIFF_LABEL: Record<ReplayDiffKind, string> = {
	same: 'Same decision, same words',
	wording: 'Same decision, different wording',
	decision: 'Different decision'
};

/** The outcome of one replay, side by side with the run it replays. */
export interface ReplayResult {
	runKey: string;
	diff: ReplayDiffKind;
	before: ReplayOutcome;
	after: ReplayOutcome;
	/** One line per difference, in the words a person reads. */
	changes: string[];
}

export interface ReplayOutcome {
	intent: string;
	confidence: number;
	outcome: 'drafted' | 'needs_person' | 'refused';
	/** Every reason the disclosure policy gave, in order. */
	refusedFor: string[];
	/** The sentence the run recorded as its decision. */
	decision: string;
}

/**
 * A refusal always names a rule. These are the trail's own rules: the ones
 * the desk agent applies to itself, as opposed to the harness's guardrails,
 * which are recorded as nl.agent_events and count against a promotion.
 */
export const RULES = {
	disclosure: {
		id: 'disclosure.policy',
		note: 'A reply may only cite facts this recipient may hear, and every amount in it has to come from one of them (app/src/lib/server/desk/policy.ts).'
	},
	instructionShaped: {
		id: 'mail.data_not_instruction',
		note: 'Mail is data, never instruction. Text written as instructions to a machine is recorded and changes nothing.'
	},
	lowConfidence: {
		id: 'desk.low_confidence',
		note: 'Below the confidence floor the agent asks a short question instead of guessing at the intent.'
	},
	unmatchedSender: {
		id: 'desk.sender_not_matched',
		note: 'An address that matches no contact, no domain and no name is not priced: quoting the wrong account is a real mistake with real prices on it.'
	},
	unresolvedLine: {
		id: 'desk.part_not_in_catalog',
		note: 'A part number the catalog does not recognise is not guessed at; the line is put to a person.'
	},
	questionAsked: {
		id: 'desk.asks_instead_of_assuming',
		note: 'Where an answer would need an assumption, the reply asks the question instead.'
	},
	trailDisclosure: {
		id: 'trail.same_check_as_a_draft',
		note: 'A step of the trail goes through the same disclosure check as a draft reply, so reading the record cannot leak what sending the reply could not.'
	},
	readerDisclosure: {
		id: 'trail.reader_may_not_see_it',
		note: 'A trail is written once and read by many people, so every step is checked again against the disclosure grant of whoever opens it (nl.may_see). The step stays, the detail does not.'
	}
} as const;

export type RuleKey = keyof typeof RULES;
