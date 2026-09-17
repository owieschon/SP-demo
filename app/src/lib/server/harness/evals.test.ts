// The agent evals, re-run on every `npm test`, held to the baseline.
//
// The baseline is evals/agents/baseline.json, written by
// `npm run eval:agents -- --baseline`. A change that makes any suite's pass
// count or any field's F1 worse fails here. Raising the baseline is a
// deliberate act: run the evals again with --baseline and commit the file with
// the change that earned it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import {
	loadDeskEvalWorld,
	runAssistantSuite,
	runAutomationSuite,
	runDeskSuite,
	runGuardrailSuite
} from './evals/index.ts';
import { EVAL_TODAY, readBaseline, type SuiteRun } from './evals/shared.ts';

let db: Db;
const baseline = readBaseline();

beforeAll(async () => {
	db = await createTestDb({ today: EVAL_TODAY });
	await loadDeskEvalWorld(db);
}, 240_000);

afterAll(async () => {
	await db?.close();
});

/** No suite may get worse than it was when the baseline was written. */
function holdToBaseline(run: SuiteRun) {
	const was = baseline?.[run.summary.suite];
	expect(was, `no baseline for ${run.summary.suite}`).toBeDefined();
	expect(run.summary.cases).toBeGreaterThanOrEqual(was!.cases);
	expect(
		run.summary.passed,
		`${run.summary.suite}: ${run.summary.passed} cases pass and the baseline is ${was!.passed}`
	).toBeGreaterThanOrEqual(was!.passed);
	for (const [field, f1] of Object.entries(was!.fields)) {
		expect(
			run.summary.fields[field]?.f1 ?? 0,
			`${run.summary.suite}, ${field}: F1 ${run.summary.fields[field]?.f1} against a baseline of ${f1}`
		).toBeGreaterThanOrEqual(f1);
	}
}

describe('the agent evals', () => {
	it('has a baseline on file', () => {
		expect(baseline).not.toBeNull();
		expect(Object.keys(baseline ?? {}).sort()).toEqual(
			['assistant', 'automation', 'guardrails', 'order desk'].sort()
		);
	});

	it('holds the guardrail suite: every named check refuses what it should', () => {
		const run = runGuardrailSuite();
		// This one is not a floor, it is a requirement: a guardrail that stops
		// refusing is a hole in the fence, not a regression in a score.
		expect(run.summary.passed).toBe(run.summary.cases);
		holdToBaseline(run);
	});

	it('holds the order desk suite', async () => {
		holdToBaseline(await runDeskSuite(db));
	}, 300_000);

	it('holds the assistant suite, and no gated tool ever ran', async () => {
		const run = await runAssistantSuite(db);
		holdToBaseline(run);
		// The claim the whole gate exists for, as a query over what happened
		// rather than as a reading of the cases.
		const [row] = await db.asUser(1, (tx) =>
			tx.sql<{ count: number }>`
				select count(*)::int as count from nl.assistant_tool_calls
				where risk = 'gated' and outcome = 'ran'`
		);
		expect(row.count).toBe(0);
	}, 300_000);

	it('holds the automation suite, including once per subject', async () => {
		holdToBaseline(await runAutomationSuite(db));
	}, 300_000);
});
