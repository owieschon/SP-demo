// Run the four agent eval suites, in the one order that works: the pure one
// first (it needs no database), then the three that do.
//
// Used by scripts/eval-agents.ts and by evals.test.ts, so the report and the
// baseline test grade exactly the same way.
import { LOW_CONFIDENCE } from '../../desk/classify.ts';
import type { RunResult } from '../../desk/run.ts';
import type { Db } from '../../db/types.ts';
import { loadEvalWorld } from '../../rfq/evals.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	runAssistantCase,
	scoreAssistantCase,
	type AssistantCase
} from './assistant.ts';
import {
	runAutomationCase,
	scoreAutomationCase,
	type AutomationCase
} from './automation.ts';
import {
	loadDeskWorld,
	runDeskCase,
	scoreDeskCase,
	type DeskExpected,
	type DeskWorld
} from './desk.ts';
import { checksWithoutACase, prepareCase, scoreGuardrailCase, type GuardrailCase } from './guardrails.ts';
import {
	loadJsonCases,
	loadTextCases,
	suiteDir,
	summarize,
	type CaseResult,
	type SuiteRun
} from './shared.ts';

/** The person the assistant and automation suites run as: an account manager. */
export const EVAL_USER = 2;

/**
 * The same naming the harness's wake uses, so a case grades the label the
 * ladder counts. Kept here rather than imported from wake.ts because the eval
 * does not wake anything: it works one message at a time.
 */
function guardrailsOf(run: RunResult, blockedReason: string): string[] {
	const out: string[] = [];
	if (run.policyRefusals.length > 0) {
		out.push(
			run.policyRefusals.some((r) => r.includes('which is not one of the figures it verified'))
				? 'amount_traceable'
				: 'disclosure_policy'
		);
	} else if (blockedReason.includes('instructions to an automated system')) {
		out.push('instruction_shaped_mail');
	} else if (run.confidence < LOW_CONFIDENCE) {
		out.push('confidence_floor');
	} else if (blockedReason.length > 0) {
		out.push('nothing_needs_review');
	} else if (run.outcome === 'needs_person') {
		out.push('sender_resolved');
	}
	return out;
}

export function runGuardrailSuite(): SuiteRun {
	const cases = loadJsonCases<GuardrailCase>('guardrails');
	const results: CaseResult[] = cases.map((c) => scoreGuardrailCase(c.name, prepareCase(c.body)));
	// A check with no case is a hole in the suite, so the suite says so itself.
	const uncovered = checksWithoutACase(cases);
	if (uncovered.length > 0) {
		results.push({
			name: 'every-check-has-a-case',
			passed: false,
			tallies: { refuses: { right: 0, wrong: 0, missed: uncovered.length } },
			misses: [`no case for: ${uncovered.join(', ')}`]
		});
	}
	return { summary: summarize('guardrails', results), results };
}

export async function loadDeskEvalWorld(db: Db): Promise<void> {
	await loadEvalWorld(db);
	const world = JSON.parse(
		readFileSync(join(suiteDir('desk'), 'world.json'), 'utf8')
	) as DeskWorld;
	await loadDeskWorld(db, world);
}

export async function runDeskSuite(db: Db, onCase?: (r: CaseResult) => void): Promise<SuiteRun> {
	const cases = loadTextCases<DeskExpected>('desk');
	const results: CaseResult[] = [];
	for (const c of cases) {
		let result: CaseResult;
		try {
			const got = await runDeskCase(db, c.text, guardrailsOf);
			result = scoreDeskCase(c.name, c.expected, got);
		} catch (error) {
			result = {
				name: c.name,
				passed: false,
				tallies: {},
				misses: [`the run failed: ${(error as Error).message}`]
			};
		}
		results.push(result);
		onCase?.(result);
	}
	return { summary: summarize('order desk', results), results };
}

export async function runAssistantSuite(db: Db, onCase?: (r: CaseResult) => void): Promise<SuiteRun> {
	const cases = loadJsonCases<AssistantCase>('assistant');
	const results: CaseResult[] = [];
	for (const c of cases) {
		let result: CaseResult;
		try {
			const got = await runAssistantCase(db, EVAL_USER, c.body);
			result = scoreAssistantCase(c.name, c.body, got);
		} catch (error) {
			result = {
				name: c.name,
				passed: false,
				tallies: {},
				misses: [`the turn failed: ${(error as Error).message}`]
			};
		}
		results.push(result);
		onCase?.(result);
	}
	return { summary: summarize('assistant', results), results };
}

export interface AutomationRunOutcome extends SuiteRun {
	/** What each case actually matched, for --record. */
	observed: Record<string, number | null>;
}

export async function runAutomationSuite(
	db: Db,
	onCase?: (r: CaseResult) => void
): Promise<AutomationRunOutcome> {
	const cases = loadJsonCases<AutomationCase>('automation');
	const results: CaseResult[] = [];
	const observed: Record<string, number | null> = {};
	for (const c of cases) {
		let result: CaseResult;
		try {
			const got = await runAutomationCase(db, EVAL_USER, c.body);
			observed[c.name] = got.matches;
			result = scoreAutomationCase(c.name, c.body, got);
		} catch (error) {
			result = {
				name: c.name,
				passed: false,
				tallies: {},
				misses: [`the rule failed: ${(error as Error).message}`]
			};
		}
		results.push(result);
		onCase?.(result);
	}
	return { summary: summarize('automation', results), results, observed };
}
