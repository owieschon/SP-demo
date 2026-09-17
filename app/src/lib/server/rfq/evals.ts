// The RFQ eval set: load it, run it, score it.
//
// Used by `npm run eval:rfq` (scripts/eval-rfq.ts) and by the baseline test
// (evals.test.ts), so both grade exactly the same way. See evals/rfq/README.md
// for what the cases cover and how grading works.
//
// A case is graded on what the whole pipeline produces (extraction, then
// validation against the eval world), because that is what a person sees:
//   sender        the sender email the extractor found
//   customer      the account validation resolved (null when it needs review)
//   lines         (item number, quantity) pairs for lines whose part resolved;
//                 quantities are whole pieces after unit conversion
//   needed_by     the needed-by date
//   needs_review  which fields ended as needs_review (a multiset of flags)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Db } from '../db/types.ts';
import { findDbDir } from '../db/files.ts';
import { reviewFlags, type Extraction, type ReviewFlag, type Validation } from './schema.ts';
import { validateDraft } from './validate.ts';

/** The day every eval runs as, and the Date headers are written around. */
export const EVAL_TODAY = '2026-09-17';
/** The user the evals validate as (an account manager in the test world). */
export const EVAL_USER = 2;

export function evalsDir(): string {
	return resolve(findDbDir(), '..', 'evals', 'rfq');
}

// ---------------------------------------------------------------------------
// The eval world
// ---------------------------------------------------------------------------

interface World {
	items: { item_no: string; description: string; family: string; category: string; list_price: number }[];
	customers: {
		customer_no: string;
		name: string;
		city: string;
		state: string;
		email_domain: string | null;
		bill_to_no: string | null;
		price_group: string;
	}[];
	contacts: { customer_no: string; full_name: string; email: string }[];
}

/**
 * Put the eval customers, contacts and parts into a test database (on top of
 * the small world). Any small-world account that happens to share one of
 * their email domains loses its domain, so resolution is decided by the eval
 * world alone.
 */
export async function loadEvalWorld(db: Db): Promise<void> {
	const world = JSON.parse(readFileSync(join(evalsDir(), 'world.json'), 'utf8')) as World;
	await db.asSystem(async (tx) => {
		for (const item of world.items) {
			await tx.sql`
				insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price, replenishment)
				values (${item.item_no}, ${item.description}, ${item.category}, ${item.family}, ${item.category},
				        ${Math.round(item.list_price * 40) / 100}, ${item.list_price}, 'Prod. Order')
				on conflict (item_no) do update
				  set description = excluded.description, list_price = excluded.list_price, blocked = false`;
		}
		const domains = [...new Set(world.customers.map((c) => c.email_domain).filter((d): d is string => d !== null))];
		const numbers = world.customers.map((c) => c.customer_no);
		await tx.query(
			`update nl.customers set email_domain = null
			 where lower(email_domain) in (select value from jsonb_array_elements_text($1::jsonb))
			   and customer_no not in (select value from jsonb_array_elements_text($2::jsonb))`,
			[JSON.stringify(domains), JSON.stringify(numbers)]
		);
		// Head offices first, so branches can point at them.
		const ordered = [...world.customers].sort((a, b) => Number(a.bill_to_no !== null) - Number(b.bill_to_no !== null));
		for (const c of ordered) {
			await tx.sql`
				insert into nl.customers (customer_no, name, bill_to_no, city, state, email_domain, price_group, owner_id, customer_since)
				values (${c.customer_no}, ${c.name}, ${c.bill_to_no}, ${c.city}, ${c.state}, ${c.email_domain},
				        ${c.price_group}, ${EVAL_USER}, '2019-01-01')
				on conflict (customer_no) do nothing`;
		}
		for (const contact of world.contacts) {
			await tx.sql`delete from nl.contacts where lower(email) = ${contact.email.toLowerCase()}`;
			await tx.sql`
				insert into nl.contacts (customer_no, full_name, email, is_primary)
				values (${contact.customer_no}, ${contact.full_name}, ${contact.email}, true)`;
		}
	});
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export interface ExpectedCase {
	sender: string | null;
	customer_no: string | null;
	lines: { item_no: string; quantity: number | null }[];
	needed_by: string | null;
	needs_review: ReviewFlag[];
	/** Nonexistent part number -> the part that should be among its top three suggestions. */
	suggestions?: Record<string, string>;
	/** The validator should warn about instructions inside the email. */
	warning?: boolean;
}

export interface EvalCase {
	name: string;
	email: string;
	expected: ExpectedCase;
}

export function loadCases(dir = join(evalsDir(), 'cases')): EvalCase[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => /^\d{2}-[a-z0-9-]+\.txt$/.test(f))
		.sort()
		.map((file) => {
			const name = file.replace(/\.txt$/, '');
			return {
				name,
				email: readFileSync(join(dir, file), 'utf8'),
				expected: JSON.parse(readFileSync(join(dir, `${name}.expected.json`), 'utf8')) as ExpectedCase
			};
		});
}

// ---------------------------------------------------------------------------
// Running and scoring
// ---------------------------------------------------------------------------

export interface Predicted {
	sender: string | null;
	customer_no: string | null;
	lines: { item_no: string; quantity: number | null }[];
	needed_by: string | null;
	needs_review: ReviewFlag[];
	suggestions: Record<string, string[]>;
	warning: boolean;
}

export function predictedFrom(extraction: Extraction, validation: Validation): Predicted {
	const suggestions: Record<string, string[]> = {};
	for (const line of validation.lines) {
		if (line.item_as_written && line.suggestions.length > 0) {
			suggestions[line.item_as_written] = line.suggestions.map((s) => s.item_no);
		}
	}
	return {
		sender: extraction.draft.sender_email.value?.toLowerCase() ?? null,
		// A customer that still needs review has not been resolved.
		customer_no: validation.customer.check.status === 'needs_review' ? null : validation.customer.customer_no,
		lines: validation.lines
			.filter((l) => !l.removed && l.item_no !== null)
			.map((l) => ({ item_no: l.item_no!, quantity: l.quantity })),
		needed_by: validation.needed_by.date,
		needs_review: reviewFlags(validation),
		suggestions,
		warning: validation.warnings.length > 0
	};
}

export const FIELDS = ['sender', 'customer', 'lines', 'needed_by', 'needs_review'] as const;
export type Field = (typeof FIELDS)[number];

export interface Tally {
	tp: number;
	fp: number;
	fn: number;
}

export interface CaseResult {
	name: string;
	expected: ExpectedCase;
	predicted: Predicted | null;
	/** Set when the extractor failed outright (a live call refused, say). */
	error: string | null;
	tallies: Record<Field, Tally>;
	passed: boolean;
	misses: string[];
	usage: Extraction['usage'];
}

const empty = (): Tally => ({ tp: 0, fp: 0, fn: 0 });

/** One value that is either right, wrong or missing. */
function scoreValue(expected: string | null, predicted: string | null): Tally {
	if (predicted === null) return { tp: 0, fp: 0, fn: expected === null ? 0 : 1 };
	if (predicted === expected) return { tp: 1, fp: 0, fn: 0 };
	return { tp: 0, fp: 1, fn: expected === null ? 0 : 1 };
}

/** Two bags of values: how many match, how many are extra, how many are missing. */
function scoreBag(expected: string[], predicted: string[]): Tally & { missing: string[]; extra: string[] } {
	const left = [...expected];
	const extra: string[] = [];
	let tp = 0;
	for (const value of predicted) {
		const i = left.indexOf(value);
		if (i === -1) extra.push(value);
		else {
			left.splice(i, 1);
			tp += 1;
		}
	}
	return { tp, fp: extra.length, fn: left.length, missing: left, extra };
}

const lineKey = (l: { item_no: string; quantity: number | null }) => `${l.item_no} x ${l.quantity ?? '?'}`;

export function scoreCase(name: string, expected: ExpectedCase, predicted: Predicted | null, error: string | null = null, usage: Extraction['usage'] = null): CaseResult {
	const tallies = Object.fromEntries(FIELDS.map((f) => [f, empty()])) as Record<Field, Tally>;
	const misses: string[] = [];
	if (!predicted) {
		// Everything expected is missing.
		tallies.sender = scoreValue(expected.sender, null);
		tallies.customer = scoreValue(expected.customer_no, null);
		tallies.needed_by = scoreValue(expected.needed_by, null);
		tallies.lines = { tp: 0, fp: 0, fn: expected.lines.length };
		tallies.needs_review = { tp: 0, fp: 0, fn: expected.needs_review.length };
		misses.push(`extractor failed: ${error}`);
		return { name, expected, predicted, error, tallies, passed: false, misses, usage };
	}

	tallies.sender = scoreValue(expected.sender, predicted.sender);
	if (predicted.sender !== expected.sender) misses.push(`sender: expected ${expected.sender}, got ${predicted.sender}`);

	tallies.customer = scoreValue(expected.customer_no, predicted.customer_no);
	if (predicted.customer_no !== expected.customer_no) {
		misses.push(`customer: expected ${expected.customer_no ?? '(needs review)'}, got ${predicted.customer_no ?? '(needs review)'}`);
	}

	tallies.needed_by = scoreValue(expected.needed_by, predicted.needed_by);
	if (predicted.needed_by !== expected.needed_by) {
		misses.push(`needed_by: expected ${expected.needed_by ?? 'none'}, got ${predicted.needed_by ?? 'none'}`);
	}

	const lines = scoreBag(expected.lines.map(lineKey), predicted.lines.map(lineKey));
	tallies.lines = lines;
	if (lines.missing.length) misses.push(`lines missing: ${lines.missing.join(', ')}`);
	if (lines.extra.length) misses.push(`lines extra: ${lines.extra.join(', ')}`);

	const flags = scoreBag([...expected.needs_review], [...predicted.needs_review]);
	tallies.needs_review = flags;
	if (flags.missing.length) misses.push(`needs_review missing: ${flags.missing.join(', ')}`);
	if (flags.extra.length) misses.push(`needs_review extra: ${flags.extra.join(', ')}`);

	for (const [asked, wanted] of Object.entries(expected.suggestions ?? {})) {
		if (!(predicted.suggestions[asked] ?? []).includes(wanted)) {
			misses.push(`suggestions for ${asked}: expected ${wanted} in the top three, got ${(predicted.suggestions[asked] ?? []).join(', ') || 'none'}`);
		}
	}
	if (Boolean(expected.warning) !== predicted.warning) {
		misses.push(`warning: expected ${expected.warning ? 'a' : 'no'} prompt-injection warning`);
	}

	return { name, expected, predicted, error, tallies, passed: misses.length === 0, misses, usage };
}

export interface FieldScore {
	precision: number;
	recall: number;
	f1: number;
	tp: number;
	fp: number;
	fn: number;
}

export interface Summary {
	cases: number;
	passed: number;
	fields: Record<Field, FieldScore>;
	suggestionHits: { hit: number; of: number };
	warningHits: { hit: number; of: number };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function summarize(results: CaseResult[]): Summary {
	const fields = {} as Record<Field, FieldScore>;
	for (const field of FIELDS) {
		const t = results.reduce((sum, r) => ({
			tp: sum.tp + r.tallies[field].tp,
			fp: sum.fp + r.tallies[field].fp,
			fn: sum.fn + r.tallies[field].fn
		}), empty());
		const precision = t.tp + t.fp === 0 ? 1 : t.tp / (t.tp + t.fp);
		const recall = t.tp + t.fn === 0 ? 1 : t.tp / (t.tp + t.fn);
		const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
		fields[field] = { precision: round(precision), recall: round(recall), f1: round(f1), ...t };
	}
	let suggestionOf = 0;
	let suggestionHit = 0;
	let warningOf = 0;
	let warningHit = 0;
	for (const r of results) {
		for (const [asked, wanted] of Object.entries(r.expected.suggestions ?? {})) {
			suggestionOf += 1;
			if (r.predicted?.suggestions[asked]?.includes(wanted)) suggestionHit += 1;
		}
		if (r.expected.warning) {
			warningOf += 1;
			if (r.predicted?.warning) warningHit += 1;
		}
	}
	return {
		cases: results.length,
		passed: results.filter((r) => r.passed).length,
		fields,
		suggestionHits: { hit: suggestionHit, of: suggestionOf },
		warningHits: { hit: warningHit, of: warningOf }
	};
}

export type Extractor = (email: string, today: string) => Promise<Extraction>;

/** Run every case through an extractor and the validator, one at a time. */
export async function runEvals(
	db: Db,
	cases: EvalCase[],
	extractor: Extractor,
	onCase?: (result: CaseResult) => void
): Promise<CaseResult[]> {
	const results: CaseResult[] = [];
	for (const c of cases) {
		let result: CaseResult;
		try {
			const extraction = await extractor(c.email, EVAL_TODAY);
			const validation = await db.asUser(EVAL_USER, (tx) =>
				validateDraft(tx, { draft: extraction.draft, overrides: {}, source: c.email })
			);
			result = scoreCase(c.name, c.expected, predictedFrom(extraction, validation), null, extraction.usage);
		} catch (error) {
			result = scoreCase(c.name, c.expected, null, (error as Error).message);
		}
		results.push(result);
		onCase?.(result);
	}
	return results;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const pct = (value: number) => `${Math.round(value * 1000) / 10}%`;

export function summaryTable(summary: Summary): string {
	const rows = FIELDS.map((f) => {
		const s = summary.fields[f];
		return `| ${f} | ${pct(s.precision)} | ${pct(s.recall)} | ${pct(s.f1)} | ${s.tp} | ${s.fp} | ${s.fn} |`;
	});
	return [
		'| Field | Precision | Recall | F1 | Right | Wrong or extra | Missed |',
		'|---|---:|---:|---:|---:|---:|---:|',
		...rows
	].join('\n');
}

export function markdownReport(options: {
	extractor: string;
	model: string | null;
	date: string;
	results: CaseResult[];
	summary: Summary;
}): string {
	const { summary, results } = options;
	const usage = results.reduce(
		(sum, r) => ({
			input: sum.input + (r.usage?.input_tokens ?? 0),
			output: sum.output + (r.usage?.output_tokens ?? 0),
			cacheRead: sum.cacheRead + (r.usage?.cache_read_input_tokens ?? 0)
		}),
		{ input: 0, output: 0, cacheRead: 0 }
	);
	const lines = [
		`# RFQ eval: ${options.extractor}${options.model ? ` (${options.model})` : ''}, ${options.date}`,
		'',
		`Graded as of ${EVAL_TODAY} against the eval world (evals/rfq/world.json on the small test world). ` +
			'See evals/rfq/README.md for how grading works.',
		'',
		`**${summary.passed} of ${summary.cases} cases fully right.** ` +
			`Sibling suggestions: ${summary.suggestionHits.hit} of ${summary.suggestionHits.of}. ` +
			`Prompt-injection warnings: ${summary.warningHits.hit} of ${summary.warningHits.of}.`,
		'',
		summaryTable(summary),
		''
	];
	if (options.extractor === 'rules') {
		lines.push(
			'Read this score with care: the rules extractor and these cases were written together, by the same author, ' +
				'so the set cannot surprise it the way new emails would. It is a regression floor, not a measure of how ' +
				'well rules generalize. A held-out set written by someone else would be the fair test.',
			''
		);
	}
	if (usage.input > 0) {
		lines.push(`Tokens: ${usage.input} input, ${usage.output} output, ${usage.cacheRead} read from cache.`, '');
	}
	lines.push('## Cases', '', '| Case | Result | Misses |', '|---|---|---|');
	for (const r of results) {
		lines.push(`| ${r.name} | ${r.passed ? 'pass' : 'miss'} | ${r.misses.join('; ').replace(/\|/g, '/') || ''} |`);
	}
	lines.push('');
	return lines.join('\n');
}
