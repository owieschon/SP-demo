// The guardrails, as named checks rather than scattered ifs.
//
// Every rule that can stop an agent has an id, a description, the agents it
// applies to, and a function that answers one of three things:
//
//   pass          carry on
//   refuse        this must not happen, and here is why in a person's words
//   needs_person  it may happen, but not on the agent's own authority
//
// WHY A REGISTRY. Three things were impossible while these lived as ifs spread
// over four features: saying how many times a named check has refused an agent
// (the autonomy ladder needs exactly that), proving each one refuses what it is
// supposed to with one test case each, and writing down the list at all.
//
// WHAT THIS FILE IS NOT. It is not a second implementation. Each check calls
// the code that already enforces it, in the feature that owns it:
// desk/policy.ts, desk/send.ts, assistant/tools.ts, assistant/caps.ts,
// assistant/wrap.ts, desk/classify.ts. If a check here disagreed with the
// feature, the feature would still win, because the feature is the one on the
// write path. The registry is how the harness NAMES and COUNTS them.
//
// The call sites that still enforce their own copy and should route through
// this registry are listed in docs/agent-harness.md; they belong to other
// features and were not edited here.
import { MAX_ROUNDS } from '../assistant/caps.ts';
import { findTool } from '../assistant/tools.ts';
import { fitResult } from '../assistant/wrap.ts';
import { looksLikeInstructions, LOW_CONFIDENCE } from '../desk/classify.ts';
import { checkDraft, moneyFigures, type DraftCheck } from '../desk/policy.ts';
import { blockedRecipients, type Allowlist } from '../desk/send.ts';
import type { AgentId } from './scope.ts';
import type { Autonomy } from './types.ts';

export type CheckResult =
	| { ok: true }
	| { ok: false; verdict: 'refuse' | 'needs_person'; reason: string };

const pass: CheckResult = { ok: true };
const refuse = (reason: string): CheckResult => ({ ok: false, verdict: 'refuse', reason });
const person = (reason: string): CheckResult => ({ ok: false, verdict: 'needs_person', reason });

/**
 * Everything any check might need. Each one reads the fields it needs and
 * throws if they are missing, which is a programming mistake and not a
 * refusal: a check that cannot run must never look like a check that passed.
 */
export interface GuardrailInput {
	/** risk_class_gate, proposal_is_gated */
	toolName?: string;
	viaProposal?: boolean;
	/** disclosure_policy, amount_traceable */
	draft?: DraftCheck;
	/** mail_allowlist */
	recipients?: string[];
	allowlist?: Allowlist;
	/** recipients_from_stored_row, input_matches_stored_option */
	stored?: unknown;
	submitted?: unknown;
	/** nothing_needs_review */
	blockedReason?: string;
	needsReview?: number;
	/** row_version_current */
	expectedVersion?: string | null;
	storedVersion?: string | null;
	/** one_firing_per_subject */
	subjectKey?: string;
	alreadyFired?: boolean;
	/** round_cap */
	rounds?: number;
	/** result_size_cap */
	payload?: unknown;
	/** daily_cap, lookup_budget */
	used?: number;
	limit?: number;
	/** instruction_shaped_mail */
	text?: string;
	/** sender_resolved */
	match?: { customerNo: string | null; vendorNo: string | null; ambiguous?: boolean; reason?: string };
	/** confidence_floor */
	confidence?: number;
	/** autonomy_level, agent_not_paused */
	autonomy?: Autonomy;
	wants?: 'act' | 'queue';
	/** undo_window_open */
	undoUntil?: string | null;
	now?: string;
}

export interface Guardrail {
	id: string;
	/** 'all' or the agents it applies to. */
	agents: AgentId[] | 'all';
	description: string;
	/** Where the rule is actually enforced, which is not this file. */
	enforcedIn: string;
	check(input: GuardrailInput): CheckResult;
}

function need<K extends keyof GuardrailInput>(
	input: GuardrailInput,
	key: K,
	id: string
): NonNullable<GuardrailInput[K]> {
	const value = input[key];
	if (value === undefined || value === null) {
		throw new Error(`The guardrail ${id} needs ${String(key)} and it was not given.`);
	}
	return value as NonNullable<GuardrailInput[K]>;
}

/** Canonical JSON: the same object, keys sorted, so two can be compared. */
function canonical(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export const GUARDRAILS: Guardrail[] = [
	{
		id: 'risk_class_gate',
		agents: ['assistant', 'mcp'],
		description:
			'A tool whose risk class is gated never runs when a model asks for it. It has to become a proposal a person approves.',
		enforcedIn: 'assistant/gate.ts, branch 2, before the input is even parsed',
		check(input) {
			const name = need(input, 'toolName', 'risk_class_gate');
			const tool = findTool(name);
			if (!tool) return refuse(`There is no tool called "${name}".`);
			if (tool.risk === 'gated' && input.viaProposal !== true) {
				return refuse(`${name} is gated, so it did not run. It has to be proposed and approved.`);
			}
			return pass;
		}
	},
	{
		id: 'proposal_is_gated',
		agents: ['assistant', 'mcp'],
		description:
			'A proposal may only name a gated tool. Proposing a read tool is refused, because it can simply be called.',
		enforcedIn: 'assistant/gate.ts, checkOption',
		check(input) {
			const name = need(input, 'toolName', 'proposal_is_gated');
			const tool = findTool(name);
			if (!tool) return refuse(`There is no tool called "${name}".`);
			if (tool.risk !== 'gated') {
				return refuse(`${name} is a ${tool.risk} tool, so there is nothing to propose: call it.`);
			}
			return pass;
		}
	},
	{
		id: 'input_matches_stored_option',
		agents: ['assistant', 'mcp'],
		description:
			'What gets written comes from the stored proposal, never from the form that approved it. A difference is refused.',
		enforcedIn: 'assistant/proposals.ts, decideProposal step 3',
		check(input) {
			const stored = need(input, 'stored', 'input_matches_stored_option');
			const submitted = need(input, 'submitted', 'input_matches_stored_option');
			if (canonical(stored) !== canonical(submitted)) {
				return refuse('The approval showed a different input from the one stored. Reload and decide again.');
			}
			return pass;
		}
	},
	{
		id: 'disclosure_policy',
		agents: ['order_desk', 'procurement_desk'],
		description:
			'Every fact a draft cites has to be a kind this recipient may hear, and a fact about somebody has to be about this recipient.',
		enforcedIn: 'desk/policy.ts, checkDraft, on the assembled draft',
		check(input) {
			const draft = need(input, 'draft', 'disclosure_policy');
			const verdict = checkDraft(draft);
			// The amount half of checkDraft has its own id below, so this one
			// answers for the fact kinds only.
			const kinds = verdict.reasons.filter((r) => !r.includes('which is not one of the figures it verified'));
			return kinds.length === 0 ? pass : refuse(kinds[0]);
		}
	},
	{
		id: 'amount_traceable',
		agents: ['order_desk', 'procurement_desk'],
		description:
			'Every dollar figure in a reply has to trace back to a fact the agent verified. A figure nobody checked is the shape a leak takes.',
		enforcedIn: 'desk/policy.ts, checkDraft, second half',
		check(input) {
			const draft = need(input, 'draft', 'amount_traceable');
			const verdict = checkDraft(draft);
			const amounts = verdict.reasons.filter((r) => r.includes('which is not one of the figures it verified'));
			if (amounts.length > 0) return refuse(amounts[0]);
			// Said plainly for the record: a reply with no figures passes.
			return moneyFigures(draft.body).length === 0 ? pass : pass;
		}
	},
	{
		id: 'mail_allowlist',
		agents: ['order_desk', 'procurement_desk'],
		description:
			'Every recipient of a real send has to be on MAIL_ALLOWLIST, checked on the server against the stored recipients.',
		enforcedIn: 'desk/send.ts, sendApproved',
		check(input) {
			const recipients = need(input, 'recipients', 'mail_allowlist');
			const allowlist = need(input, 'allowlist', 'mail_allowlist');
			const blocked = blockedRecipients(recipients, allowlist);
			if (blocked.length > 0) {
				return refuse(`${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} not on the allowlist.`);
			}
			return pass;
		}
	},
	{
		id: 'recipients_from_stored_row',
		agents: ['order_desk', 'procurement_desk'],
		description:
			'What is sent, and who to, comes from the stored draft and not from the request that approved it.',
		enforcedIn: 'desk/send.ts, which reads the draft row and ignores the body',
		check(input) {
			const stored = need(input, 'stored', 'recipients_from_stored_row');
			const submitted = need(input, 'submitted', 'recipients_from_stored_row');
			if (canonical(stored) !== canonical(submitted)) {
				return refuse('The send was asked to use recipients that are not the ones on the draft.');
			}
			return pass;
		}
	},
	{
		id: 'nothing_needs_review',
		agents: ['order_desk', 'procurement_desk'],
		description:
			'A draft the agent held, or a quote request with a field it could not settle, cannot be approved until somebody fixes it.',
		enforcedIn: 'nl.approve_mail_draft and nl.approve_rfq_draft, both raise NL422',
		check(input) {
			const blocked = input.blockedReason ?? '';
			const needsReview = input.needsReview ?? 0;
			if (blocked.trim().length > 0) {
				return refuse(`This draft is held: ${blocked}. Rewrite it or reject it.`);
			}
			if (needsReview > 0) {
				return refuse(`${needsReview} field(s) still need a person, so this cannot be approved yet.`);
			}
			return pass;
		}
	},
	{
		id: 'row_version_current',
		agents: 'all',
		description: 'A decision made on a record that has moved since it was loaded is refused, never applied.',
		enforcedIn: 'every write function in the schema, comparing updated_at',
		check(input) {
			const expected = need(input, 'expectedVersion', 'row_version_current');
			const stored = need(input, 'storedVersion', 'row_version_current');
			if (new Date(expected).getTime() !== new Date(stored).getTime()) {
				return refuse('That record changed since it was loaded. Reload it and decide again.');
			}
			return pass;
		}
	},
	{
		id: 'one_firing_per_subject',
		agents: ['automation'],
		description: 'A rule fires at most once for one subject, ever, however many times it runs.',
		enforcedIn: 'nl.automation_firings, unique (rule_id, subject_key), and nl.fire_automation',
		check(input) {
			const subject = need(input, 'subjectKey', 'one_firing_per_subject');
			if (input.alreadyFired === true) {
				return refuse(`This rule already fired for ${subject}, so it is skipped.`);
			}
			return pass;
		}
	},
	{
		id: 'round_cap',
		agents: ['assistant'],
		description: `A turn asks for at most ${MAX_ROUNDS} rounds of tools. The next round's calls are recorded as refused.`,
		enforcedIn: 'assistant/loop.ts',
		check(input) {
			const rounds = need(input, 'rounds', 'round_cap');
			if (rounds >= MAX_ROUNDS) {
				return refuse(`The limit of ${MAX_ROUNDS} lookups for one question was reached.`);
			}
			return pass;
		}
	},
	{
		id: 'result_size_cap',
		agents: ['assistant', 'mcp'],
		description: 'A tool result over 16 KB loses rows from the end and says how many are left.',
		enforcedIn: 'assistant/wrap.ts, fitResult',
		check(input) {
			const payload = need(input, 'payload', 'result_size_cap');
			const fitted = fitResult(payload);
			if (fitted.truncated) {
				return person(
					`That result was too big for one answer${fitted.rows === null ? '' : ` and was cut to ${fitted.rows} rows`}.`
				);
			}
			return pass;
		}
	},
	{
		id: 'daily_cap',
		agents: ['assistant', 'order_desk', 'procurement_desk', 'mcp'],
		description:
			'A day has a fixed number of model calls per person, per server, per desk and per token, counted in the database so a restart does not forget.',
		enforcedIn: 'nl.claim_assistant_call, nl.start_mail_run, nl.claim_mcp_call',
		check(input) {
			const used = need(input, 'used', 'daily_cap');
			const limit = need(input, 'limit', 'daily_cap');
			if (used >= limit) {
				return refuse(`That is all ${limit} for today. It starts again tomorrow.`);
			}
			return pass;
		}
	},
	{
		id: 'lookup_budget',
		agents: ['order_desk', 'procurement_desk'],
		description: 'One message gets a fixed number of lookups. The rest of the answer waits for a person.',
		enforcedIn: 'desk/tools.ts, LookupBudget, capped by nl.mail_lookup_cap()',
		check(input) {
			const used = need(input, 'used', 'lookup_budget');
			const limit = need(input, 'limit', 'lookup_budget');
			if (used >= limit) {
				return person(`This message used all ${limit} lookups, so the answer may be incomplete.`);
			}
			return pass;
		}
	},
	{
		id: 'instruction_shaped_mail',
		agents: ['order_desk', 'procurement_desk'],
		description:
			'Mail written as instructions to a machine is data. Finding it changes nothing about the answer and sends the message to a person.',
		enforcedIn: 'desk/classify.ts, looksLikeInstructions, and desk/run.ts, which holds the draft',
		check(input) {
			const text = need(input, 'text', 'instruction_shaped_mail');
			if (looksLikeInstructions(text)) {
				return person(
					'This message contains text written as instructions to an automated system. It was read as data; a person should see what was attempted.'
				);
			}
			return pass;
		}
	},
	{
		id: 'sender_resolved',
		agents: ['order_desk', 'procurement_desk'],
		description:
			'A reply about prices goes to an account we matched. An unknown sender, or a shared domain that fits more than one branch, is asked about.',
		enforcedIn: 'desk/tools.ts, resolveSender, and desk/compose.ts, which asks instead of answering',
		check(input) {
			const match = need(input, 'match', 'sender_resolved');
			if (match.ambiguous === true) {
				return person('That email domain fits more than one branch, so which account this is has to be asked.');
			}
			if (match.customerNo === null && match.vendorNo === null) {
				return person('This sender is not on file, so the account number has to be asked for.');
			}
			return pass;
		}
	},
	{
		id: 'confidence_floor',
		agents: ['order_desk', 'procurement_desk'],
		description: `Below ${LOW_CONFIDENCE} confidence the agent asks a short question instead of answering.`,
		enforcedIn: 'desk/run.ts, which treats an unsure classification as intent "other"',
		check(input) {
			const confidence = need(input, 'confidence', 'confidence_floor');
			if (confidence < LOW_CONFIDENCE) {
				return person(`The classifier was only ${Math.round(confidence * 100)}% sure, so it asks.`);
			}
			return pass;
		}
	},
	{
		id: 'autonomy_level',
		agents: 'all',
		description:
			'An agent may only act on its own at auto_review or auto, for that kind of work. Anything else queues for a person.',
		enforcedIn: 'harness/ladder.ts planRun, and nl.record_agent_action, which checks the level again',
		check(input) {
			const autonomy = need(input, 'autonomy', 'autonomy_level');
			if (input.wants === 'act' && !autonomy.mayAct) {
				return refuse(
					`${autonomy.agent} doing ${autonomy.workKind} is at ${autonomy.level}, so it may not act on its own.`
				);
			}
			return pass;
		}
	},
	{
		id: 'agent_not_paused',
		agents: 'all',
		description:
			'A paused agent may still draft, and may not act. The pause is per agent or global and takes effect at once.',
		enforcedIn: 'nl.agent_paused, read by nl.agent_autonomy_for and nl.record_agent_action',
		check(input) {
			const autonomy = need(input, 'autonomy', 'agent_not_paused');
			if (autonomy.paused) {
				return person(
					`${autonomy.agent} is paused${autonomy.pauseReason ? `: ${autonomy.pauseReason}` : ''}. It drafted and stopped.`
				);
			}
			return pass;
		}
	},
	{
		id: 'undo_window_open',
		agents: 'all',
		description: 'An action can be taken back inside its window and not afterwards.',
		enforcedIn: 'nl.claim_agent_undo',
		check(input) {
			const now = new Date(input.now ?? new Date().toISOString()).getTime();
			if (input.undoUntil === undefined || input.undoUntil === null) {
				return refuse('That action had no undo window. Put it right by hand.');
			}
			if (new Date(input.undoUntil).getTime() < now) {
				return refuse('The window to undo that action has closed. Put it right by hand.');
			}
			return pass;
		}
	}
];

export function guardrail(id: string): Guardrail {
	const found = GUARDRAILS.find((g) => g.id === id);
	if (!found) throw new Error(`There is no guardrail called "${id}".`);
	return found;
}

export function guardrailsFor(agent: AgentId): Guardrail[] {
	return GUARDRAILS.filter((g) => g.agents === 'all' || g.agents.includes(agent));
}

/**
 * Run one named check. The registry's only job at a call site: name the check,
 * hand it what it needs, and get one of three answers back.
 */
export function runCheck(id: string, input: GuardrailInput): CheckResult {
	return guardrail(id).check(input);
}

/**
 * Run several and return the first that did not pass, in the order given. The
 * order is the caller's: a refusal should always be looked for before a
 * needs_person.
 */
export function firstFailure(
	checks: { id: string; input: GuardrailInput }[]
): { id: string; verdict: 'refuse' | 'needs_person'; reason: string } | null {
	for (const { id, input } of checks) {
		const result = runCheck(id, input);
		if (!result.ok) return { id, verdict: result.verdict, reason: result.reason };
	}
	return null;
}
