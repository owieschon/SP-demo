// What the four agent eval suites share: where the cases live, how a score is
// added up, and what a report looks like.
//
// Same shape as the RFQ evals (app/src/lib/server/rfq/evals.ts): cases as
// files, expected results beside them, a dated markdown report, and a baseline
// a test holds us to. See evals/agents/README.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findDbDir } from '../../db/files.ts';

/** The day every agent eval runs as. The same day the test world is pinned to. */
export const EVAL_TODAY = '2026-09-17';

export function agentEvalsDir(): string {
	return resolve(findDbDir(), '..', 'evals', 'agents');
}

export function suiteDir(suite: string): string {
	return join(agentEvalsDir(), suite);
}

/** Every `NN-slug.txt` in a suite's cases folder, with its expected JSON beside it. */
export function loadTextCases<T>(suite: string): { name: string; text: string; expected: T }[] {
	const dir = join(suiteDir(suite), 'cases');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => /^\d{2}-[a-z0-9-]+\.txt$/.test(f))
		.sort()
		.map((file) => {
			const name = file.replace(/\.txt$/, '');
			return {
				name,
				text: readFileSync(join(dir, file), 'utf8'),
				expected: JSON.parse(readFileSync(join(dir, `${name}.expected.json`), 'utf8')) as T
			};
		});
}

/** Every `NN-slug.json` in a suite's cases folder: the case and its expectation in one file. */
export function loadJsonCases<T>(suite: string): { name: string; body: T }[] {
	const dir = join(suiteDir(suite), 'cases');
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => /^\d{2}-[a-z0-9-]+\.json$/.test(f))
		.sort()
		.map((file) => ({
			name: file.replace(/\.json$/, ''),
			body: JSON.parse(readFileSync(join(dir, file), 'utf8')) as T
		}));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface Tally {
	right: number;
	wrong: number;
	missed: number;
}

export const emptyTally = (): Tally => ({ right: 0, wrong: 0, missed: 0 });

/** One value that is either right, wrong or missing. */
export function scoreValue(expected: string | null, got: string | null): Tally {
	if (got === null) return { right: 0, wrong: 0, missed: expected === null ? 0 : 1 };
	if (got === expected) return { right: 1, wrong: 0, missed: 0 };
	return { right: 0, wrong: 1, missed: expected === null ? 0 : 1 };
}

/** Two bags of values: how many match, how many are extra, how many are missing. */
export function scoreBag(
	expected: string[],
	got: string[]
): Tally & { missing: string[]; extra: string[] } {
	const left = [...expected];
	const extra: string[] = [];
	let right = 0;
	for (const value of got) {
		const at = left.indexOf(value);
		if (at === -1) extra.push(value);
		else {
			left.splice(at, 1);
			right += 1;
		}
	}
	return { right, wrong: extra.length, missed: left.length, missing: left, extra };
}

/** Everything expected is present; extras do not count against it. */
export function scoreRequired(required: string[], got: string[]): Tally & { missing: string[] } {
	const missing = required.filter((value) => !got.includes(value));
	return { right: required.length - missing.length, wrong: 0, missed: missing.length, missing };
}

export interface CaseResult {
	name: string;
	passed: boolean;
	tallies: Record<string, Tally>;
	misses: string[];
	/** Anything worth printing beside the case in the report. */
	note?: string;
}

export interface FieldScore extends Tally {
	precision: number;
	recall: number;
	f1: number;
}

export interface SuiteSummary {
	suite: string;
	cases: number;
	passed: number;
	fields: Record<string, FieldScore>;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function summarize(suite: string, results: CaseResult[]): SuiteSummary {
	const keys = [...new Set(results.flatMap((r) => Object.keys(r.tallies)))];
	const fields: Record<string, FieldScore> = {};
	for (const key of keys) {
		const total = results.reduce(
			(sum, r) => ({
				right: sum.right + (r.tallies[key]?.right ?? 0),
				wrong: sum.wrong + (r.tallies[key]?.wrong ?? 0),
				missed: sum.missed + (r.tallies[key]?.missed ?? 0)
			}),
			emptyTally()
		);
		const precision = total.right + total.wrong === 0 ? 1 : total.right / (total.right + total.wrong);
		const recall = total.right + total.missed === 0 ? 1 : total.right / (total.right + total.missed);
		const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
		fields[key] = { ...total, precision: round(precision), recall: round(recall), f1: round(f1) };
	}
	return {
		suite,
		cases: results.length,
		passed: results.filter((r) => r.passed).length,
		fields
	};
}

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

export function summaryTable(summary: SuiteSummary): string {
	const rows = Object.entries(summary.fields).map(
		([field, s]) =>
			`| ${field} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)} | ${s.right} | ${s.wrong} | ${s.missed} |`
	);
	return [
		'| Field | Precision | Recall | F1 | Right | Wrong or extra | Missed |',
		'|---|---:|---:|---:|---:|---:|---:|',
		...rows
	].join('\n');
}

export interface SuiteRun {
	summary: SuiteSummary;
	results: CaseResult[];
}

/** The dated report. One section per suite, then every case with what it missed. */
export function markdownReport(options: { date: string; runs: SuiteRun[]; extractor: string }): string {
	const lines = [
		`# Agent evals, ${options.date}`,
		'',
		`Graded as of ${EVAL_TODAY}, ${options.extractor}. See evals/agents/README.md for what each suite covers and how it is graded.`,
		'',
		'**Read these numbers with care.** The cases, the expected answers and the extractors that read',
		'the agents\' output were written by the same hands as the agents. A case cannot surprise them the',
		'way real mail would. They are a regression floor, not an independent measure of how well any of',
		'this generalizes. A set written by somebody else, and a live model run, are the fair comparison.',
		''
	];
	for (const run of options.runs) {
		lines.push(
			`## ${run.summary.suite}`,
			'',
			`**${run.summary.passed} of ${run.summary.cases} cases fully right.**`,
			'',
			summaryTable(run.summary),
			'',
			'| Case | Result | Misses |',
			'|---|---|---|'
		);
		for (const result of run.results) {
			lines.push(
				`| ${result.name} | ${result.passed ? 'pass' : 'miss'} | ${result.misses.join('; ').replace(/\|/g, '/') || ''} |`
			);
		}
		lines.push('');
	}
	return lines.join('\n');
}

/** The baseline a test holds us to: passed and F1 per field, per suite. */
export interface Baseline {
	[suite: string]: {
		cases: number;
		passed: number;
		fields: Record<string, number>;
	};
}

export function toBaseline(runs: SuiteRun[]): Baseline {
	const out: Baseline = {};
	for (const run of runs) {
		out[run.summary.suite] = {
			cases: run.summary.cases,
			passed: run.summary.passed,
			fields: Object.fromEntries(Object.entries(run.summary.fields).map(([k, v]) => [k, v.f1]))
		};
	}
	return out;
}

export function baselineFile(): string {
	return join(agentEvalsDir(), 'baseline.json');
}

export function readBaseline(): Baseline | null {
	const file = baselineFile();
	return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Baseline) : null;
}
