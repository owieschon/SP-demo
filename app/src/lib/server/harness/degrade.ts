// Graceful degradation: what each agent does when something it depends on is
// not there.
//
// ONE RULE, EVERYWHERE. Degrade to the cheaper honest path, never to a guess,
// and never silently:
//
//   * cheaper honest path: the scripted classifier instead of the model, stock
//     less open orders instead of the forecast, a queued retry instead of a
//     send, a draft that says what is missing instead of a draft that pretends;
//   * never a guess: a fact the agent could not verify is not stated, and a
//     figure it could not check never reaches a reply;
//   * never silently: the run gets an event row saying it degraded and why,
//     the draft says so where a reader would otherwise be misled, and a
//     degraded run never acts on its own authority, whatever its level.
//
// The last clause is the important one. A thinner answer is fine; a thinner
// answer sent without a person having looked is not.
import type { Tx } from '../db/types.ts';
import { recordEvent } from './record.ts';

/** The reasons, as codes, because they are counted and compared. */
export const DEGRADATIONS = [
	'model_key_missing',
	'model_call_failed',
	'model_answer_unusable',
	'mail_provider_down',
	'mail_provider_refused',
	'database_read_only',
	'tool_timed_out',
	'daily_cap_reached',
	'erp_export_missing',
	'supply_forecast_missing',
	'person_inactive',
	'policy_engine_missing'
] as const;

export type DegradeReason = (typeof DEGRADATIONS)[number];

export interface Degradation {
	reason: DegradeReason;
	/** What the agent does instead. */
	fallback: string;
	/** What a person or a customer is told. */
	saysSo: string;
	/** Whether the agent may still act on its own after this. */
	mayStillAct: boolean;
	/** Which agents this can happen to. */
	agents: string[];
}

export const DEGRADATION_MATRIX: Record<DegradeReason, Degradation> = {
	model_key_missing: {
		reason: 'model_key_missing',
		fallback:
			'The rule-based classifier decides the intent, and the scripted model answers the assistant. Everything else is the real path: the gate, the proposal, the caps and the audit trail.',
		saysSo: 'The badge says scripted demo mode, and the run records mode "mock" with no model.',
		// The scripted path is a first-class path here, not a fallback from a
		// failure, so it does not on its own stop an agent acting.
		mayStillAct: true,
		agents: ['order_desk', 'procurement_desk', 'assistant']
	},
	model_call_failed: {
		reason: 'model_call_failed',
		fallback: 'The rule-based classifier is used for this message instead.',
		saysSo: 'The run records that the live call failed and which classifier decided.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk', 'assistant']
	},
	model_answer_unusable: {
		reason: 'model_answer_unusable',
		fallback:
			'The answer did not fit the schema, so it is thrown away and the rules decide. Nothing half-parsed is used.',
		saysSo: 'The run records the refusal and the reason the answer was not usable.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk', 'assistant']
	},
	mail_provider_down: {
		reason: 'mail_provider_down',
		fallback:
			'The draft stays approved with the error on it, so sending can be tried again. Nothing is marked sent.',
		saysSo: 'The desk shows the failure and the retry; nl.mark_mail_failed keeps it approved.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk']
	},
	mail_provider_refused: {
		reason: 'mail_provider_refused',
		fallback:
			'The draft is marked failed, because sending the same thing again would fail again. A person decides what to do.',
		saysSo: 'The draft says failed with the provider\'s own words.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk']
	},
	database_read_only: {
		reason: 'database_read_only',
		fallback:
			'Nothing is worked at all. Reads still answer, and the wake gives up instead of running an agent whose result cannot be stored.',
		saysSo: 'The wake reports that the database is read only and no run was started.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp']
	},
	tool_timed_out: {
		reason: 'tool_timed_out',
		fallback:
			'That one lookup is dropped and the answer is composed from the facts that did come back. A fact that is missing is not stated.',
		saysSo: 'The run records the lookup that timed out, and the draft leaves out what it could not verify.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk', 'assistant', 'mcp']
	},
	daily_cap_reached: {
		reason: 'daily_cap_reached',
		fallback: 'The wake stops for that desk or that person and says which cap and when it resets.',
		saysSo: 'A 429 with the cap in it, and the run is never started.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk', 'assistant', 'mcp']
	},
	erp_export_missing: {
		reason: 'erp_export_missing',
		fallback:
			'Open orders and stock are answered from the last export that did arrive, and the answer says how old it is.',
		saysSo: 'The reply gives the date the figures are as of, rather than implying they are live.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk']
	},
	supply_forecast_missing: {
		reason: 'supply_forecast_missing',
		fallback:
			'Availability falls back to stock less what open orders already claim, plus the lead time, and every fact it makes is marked estimated.',
		saysSo: 'The reply says the date is an estimate.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk']
	},
	person_inactive: {
		reason: 'person_inactive',
		fallback:
			'Nothing runs as somebody who has left. An automation rule records a failed run and waits for an admin; a desk whose reviewer is gone does not work its inbox.',
		saysSo: 'The run says who is no longer active and that an admin can take it over.',
		mayStillAct: false,
		agents: ['order_desk', 'procurement_desk', 'automation']
	},
	policy_engine_missing: {
		reason: 'policy_engine_missing',
		fallback: 'The harness\'s own tables hold the thresholds, which are the values today.',
		saysSo: 'The page says where the numbers came from.',
		mayStillAct: true,
		agents: ['order_desk', 'procurement_desk', 'assistant', 'automation', 'mcp']
	}
};

/**
 * What a failure means, from the error itself. Deliberately narrow: an error
 * this cannot recognise is a real failure and is rethrown by the caller, not
 * quietly degraded into a thin answer.
 */
export function classifyFailure(error: unknown): DegradeReason | null {
	const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
	const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : '';

	if (code === 'NL429' || message.includes('for today')) return 'daily_cap_reached';
	if (code === '25006' || message.includes('read-only transaction') || message.includes('read only transaction')) {
		return 'database_read_only';
	}
	if (code === '57014' || message.includes('statement timeout') || message.includes('canceling statement')) {
		return 'tool_timed_out';
	}
	if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout')) {
		return 'tool_timed_out';
	}
	if (message.includes('no longer active') || message.includes('inactive')) return 'person_inactive';
	if (message.includes('api key') || message.includes('unauthorized') || message.includes('401')) {
		return 'model_key_missing';
	}
	if (message.includes('does not fit') || message.includes('invalid json') || message.includes('schema')) {
		return 'model_answer_unusable';
	}
	if (message.includes('mail') && (message.includes('refused') || message.includes('rejected'))) {
		return 'mail_provider_refused';
	}
	if (message.includes('mail') || message.includes('provider')) return 'mail_provider_down';
	return null;
}

/** Record that a run degraded, and say so in one sentence. */
export async function recordDegradation(
	tx: Tx,
	input: { agent: string; runKey: string; workKind?: string; reason: DegradeReason; detail?: string; requestId: string }
): Promise<Degradation> {
	const entry = DEGRADATION_MATRIX[input.reason];
	await recordEvent(tx, {
		agent: input.agent,
		runKey: input.runKey,
		workKind: input.workKind,
		kind: 'degraded',
		checkId: input.reason,
		verdict: 'degraded',
		detail: input.detail ?? entry.fallback,
		requestId: input.requestId
	});
	return entry;
}
