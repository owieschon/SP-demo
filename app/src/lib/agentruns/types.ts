// The run trail, as the server hands it to the components. Shared by both,
// so neither can drift from the other.
//
// A run is one waking of one agent. A step is one thing it did. The whole
// point of the shape is that a sceptical reader can go top to bottom and see
// what was read, what was called, what was decided and what was refused.

import type { Disclosure } from '$lib/desk/types';

/**
 * Which agent. Text, not a union, for the same reason the column is text and
 * not an enum: a new agent needs no migration. The two that exist today are
 * `order_desk` and `procurement_desk`.
 */
export type AgentName = string;

export const AGENT_LABEL: Record<string, string> = {
	order_desk: 'Order desk agent',
	procurement_desk: 'Procurement desk agent'
};

/** The only ways anything in this app starts. */
export type WokeBy = 'mail' | 'signal' | 'schedule' | 'person' | 'replay';

export const WOKE_LABEL: Record<WokeBy, string> = {
	mail: 'Mail arrived',
	signal: 'A signal fired',
	schedule: 'A schedule came round',
	person: 'A person asked',
	replay: 'A replay'
};

export type RunOutcome =
	| 'running'
	| 'drafted'
	| 'needs_person'
	| 'ignored'
	| 'refused'
	| 'failed'
	| 'replayed';

export const OUTCOME_LABEL: Record<RunOutcome, string> = {
	running: 'Still running',
	drafted: 'Drafted a reply',
	needs_person: 'Handed to a person',
	ignored: 'Left alone',
	refused: 'Refused',
	failed: 'Failed',
	replayed: 'Replayed'
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
 * `withheld` means the disclosure policy would not let this trail's reader
 * see the detail, so the detail was never stored. The label and the reason
 * are still here, because a step that vanished would be worse than a step
 * that says what it is keeping back.
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
	withheld: boolean;
	withheldReason: string;
}

/** A run without its steps: the row the run list shows. */
export interface RunSummary {
	id: number;
	agent: AgentName;
	wokeBy: WokeBy;
	wokeNote: string;
	entity: string | null;
	entityId: number | null;
	reader: Disclosure;
	subjectNo: string | null;
	mode: 'mock' | 'live';
	model: string | null;
	/** The version of the context bundle it read, when there is one. */
	bundleVersion: string | null;
	startedAt: string;
	finishedAt: string | null;
	durationMs: number | null;
	inputTokens: number;
	outputTokens: number;
	outcome: RunOutcome;
	decision: string;
	refusals: number;
	stepCount: number;
	producedKind: string | null;
	producedId: number | null;
	replayOf: number | null;
	/** On a replay: what changed. */
	diff: ReplayDiffKind | null;
	replays: number;
	/** What a person did to what it produced, in plain English, or null. */
	humanChange: string | null;
	error: string | null;
}

export interface RunView extends RunSummary {
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
	runId: number;
	/** The run row the replay itself was recorded as, when it was recorded. */
	replayRunId: number | null;
	diff: ReplayDiffKind;
	before: ReplayOutcome;
	after: ReplayOutcome;
	/** One line per difference, in the words a person reads. */
	changes: string[];
}

export interface ReplayOutcome {
	intent: string;
	confidence: number;
	outcome: RunOutcome;
	/** Every reason the disclosure policy gave, in order. */
	refusedFor: string[];
	/** The sentence the run recorded as its decision. */
	decision: string;
}

/** A refusal always names a rule. These are the rules that exist. */
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
	}
} as const;

export type RuleKey = keyof typeof RULES;
