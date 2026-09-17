// The eval set as a regression test: the rules extractor must not score
// below the baseline recorded in evals/rfq/baseline.json.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import {
	EVAL_TODAY,
	FIELDS,
	evalsDir,
	loadCases,
	loadEvalWorld,
	runEvals,
	scoreCase,
	summarize,
	type Summary
} from './evals.ts';
import { extractWithRules } from './rules.ts';
import { SAMPLES } from './samples.ts';

interface Baseline {
	cases: number;
	passed: number;
	f1: Record<(typeof FIELDS)[number], number>;
	suggestion_hits: number;
	warning_hits: number;
}

let db: Db;
let summary: Summary;
const baseline = JSON.parse(readFileSync(join(evalsDir(), 'baseline.json'), 'utf8')) as Baseline;
const cases = loadCases();

beforeAll(async () => {
	db = await createTestDb({ today: EVAL_TODAY });
	await loadEvalWorld(db);
	const results = await runEvals(db, cases, async (email, today) => ({
		draft: extractWithRules(email, today),
		extractor: 'rules',
		model: null,
		usage: null
	}));
	summary = summarize(results);
});

afterAll(async () => {
	await db?.close();
});

describe('the eval set', () => {
	it('has 24 to 30 cases, each with an expected file and an in-range Date header', () => {
		expect(cases.length).toBeGreaterThanOrEqual(24);
		expect(cases.length).toBeLessThanOrEqual(30);
		for (const c of cases) {
			expect(c.email, c.name).toMatch(/^From: .+\nTo: .+\nSubject: .*\nDate: .+ Sep 2026 /);
			// No em dashes (written as a code so this file has none either).
			expect(c.email, c.name).not.toMatch(/\u2014/);
			const day = Number(c.email.match(/Date: \w+, (\d+) Sep 2026/)?.[1]);
			expect(day, c.name).toBeGreaterThanOrEqual(10);
			expect(day, c.name).toBeLessThanOrEqual(17);
		}
	});

	it('is what the intake page offers as samples', () => {
		expect(SAMPLES.map((s) => s.name)).toEqual(cases.map((c) => c.name));
		expect(SAMPLES[0].text).toBe(cases[0].email);
		expect(SAMPLES[0].label).toBe('Clean table');
	});

	it('does not score the rules extractor below its baseline', () => {
		expect(summary.cases).toBe(baseline.cases);
		expect(summary.passed).toBeGreaterThanOrEqual(baseline.passed);
		for (const field of FIELDS) {
			expect(summary.fields[field].f1, field).toBeGreaterThanOrEqual(baseline.f1[field]);
		}
		expect(summary.suggestionHits.hit).toBeGreaterThanOrEqual(baseline.suggestion_hits);
		expect(summary.warningHits.hit).toBeGreaterThanOrEqual(baseline.warning_hits);
	});
});

describe('grading', () => {
	const expected = {
		sender: 'a@x.example',
		customer_no: '1',
		lines: [
			{ item_no: 'A', quantity: 2 },
			{ item_no: 'B', quantity: 1 }
		],
		needed_by: null,
		needs_review: ['line_item' as const]
	};

	it('counts right, wrong and missing values separately', () => {
		const r = scoreCase('x', expected, {
			sender: 'a@x.example',
			customer_no: '2',
			lines: [
				{ item_no: 'A', quantity: 2 },
				{ item_no: 'B', quantity: 3 }
			],
			needed_by: '2026-10-01',
			needs_review: [],
			suggestions: {},
			warning: false
		});
		expect(r.passed).toBe(false);
		expect(r.tallies.sender).toEqual({ tp: 1, fp: 0, fn: 0 });
		expect(r.tallies.customer).toEqual({ tp: 0, fp: 1, fn: 1 });
		expect(r.tallies.needed_by).toEqual({ tp: 0, fp: 1, fn: 0 });
		expect(r.tallies.lines).toMatchObject({ tp: 1, fp: 1, fn: 1 });
		expect(r.tallies.needs_review).toMatchObject({ tp: 0, fp: 0, fn: 1 });
		expect(r.misses).toContain('lines missing: B x 1');
	});

	it('scores a failed extraction as all missing', () => {
		const r = scoreCase('x', expected, null, 'refused');
		expect(r.passed).toBe(false);
		expect(r.tallies.lines).toEqual({ tp: 0, fp: 0, fn: 2 });
		expect(summarize([r]).fields.lines.recall).toBe(0);
	});
});
