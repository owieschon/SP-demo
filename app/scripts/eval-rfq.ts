// Run the RFQ eval set and write a dated report.
//
//   npm run eval:rfq                  the rules extractor (free, no key needed)
//   npm run eval:rfq -- --live        prints what a live run would cost, then stops
//   npm run eval:rfq -- --live --yes  runs the Claude extractor (needs ANTHROPIC_API_KEY)
//
// A live run spends real money. It needs the owner's sign-off on the inputs,
// the grading and the cost first (see evals/rfq/README.md).
//
// Reports go to evals/rfq/reports/YYYY-MM-DD-<extractor>.md.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { createTestDb } from '../src/lib/server/db/pglite.ts';
import { extractWithClaude, messagesApi, SYSTEM_PROMPT, userMessage, DEFAULT_MODEL } from '../src/lib/server/rfq/claude.ts';
import {
	EVAL_TODAY,
	evalsDir,
	loadCases,
	loadEvalWorld,
	markdownReport,
	runEvals,
	summarize,
	summaryTable,
	type Extractor
} from '../src/lib/server/rfq/evals.ts';
import { extractWithRules } from '../src/lib/server/rfq/rules.ts';
import { rfqDraftSchema } from '../src/lib/server/rfq/schema.ts';

const args = new Set(process.argv.slice(2));
const live = args.has('--live');
const confirmed = args.has('--yes');

const cases = loadCases();
if (cases.length === 0) {
	console.error('No eval cases found in evals/rfq/cases.');
	process.exit(1);
}

// Dollars per million tokens (input, output). Cache reads cost a tenth of input.
const PRICES: Record<string, [number, number]> = {
	'claude-opus-5': [5, 25],
	'claude-opus-4-8': [5, 25],
	'claude-sonnet-5': [2, 10],
	'claude-haiku-4-5': [1, 5],
	'claude-fable-5-1': [10, 50]
};

let extractor: Extractor;
let extractorName = 'rules';
let model: string | null = null;

if (live) {
	// The key can live in app/.env; only a live run reads it.
	if (!process.env.ANTHROPIC_API_KEY && existsSync('.env')) process.loadEnvFile('.env');
	model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
	extractorName = 'claude';

	// A rough estimate: about four characters per token. The schema travels
	// with every request as part of the input.
	const schemaChars = JSON.stringify(z.toJSONSchema(rfqDraftSchema)).length;
	const inputTokens = cases.reduce(
		(sum, c) => sum + Math.ceil((SYSTEM_PROMPT.length + schemaChars + userMessage(c.email, EVAL_TODAY).length) / 4) + 50,
		0
	);
	// The answer is a few hundred tokens of JSON; thinking can add a lot more.
	const outputLow = cases.length * 500;
	const outputHigh = cases.length * 4000;
	const price = PRICES[model];
	console.log(`Live eval with ${model}`);
	console.log(`  cases:                    ${cases.length}`);
	console.log(`  estimated input tokens:   ${inputTokens.toLocaleString('en-US')}`);
	console.log(`  estimated output tokens:  ${outputLow.toLocaleString('en-US')} to ${outputHigh.toLocaleString('en-US')} (includes thinking)`);
	if (price) {
		const low = (inputTokens * price[0] + outputLow * price[1]) / 1e6;
		const high = (inputTokens * price[0] + outputHigh * price[1]) / 1e6;
		console.log(`  estimated cost:           $${low.toFixed(2)} to $${high.toFixed(2)} (at $${price[0]} / $${price[1]} per million tokens)`);
	} else {
		console.log(`  estimated cost:           unknown (no price on file for ${model})`);
	}
	if (!confirmed) {
		console.log('\nNot running. Get the owner\'s sign-off on inputs, grading and cost, then add --yes.');
		process.exit(0);
	}
	if (!process.env.ANTHROPIC_API_KEY) {
		console.error('\nANTHROPIC_API_KEY is not set. Refusing to run.');
		process.exit(1);
	}
	const api = messagesApi(new Anthropic());
	const liveModel = model;
	extractor = (email, today) => extractWithClaude(email, today, { api, model: liveModel });
} else {
	extractor = async (email, today) => ({
		draft: extractWithRules(email, today),
		extractor: 'rules',
		model: null,
		usage: null
	});
}

console.log(`Building the eval world (small test world as of ${EVAL_TODAY})...`);
const db = await createTestDb({ today: EVAL_TODAY });
try {
	await loadEvalWorld(db);
	const results = await runEvals(db, cases, extractor, (r) => {
		console.log(`${r.passed ? 'pass' : 'MISS'}  ${r.name}${r.misses.length ? `  (${r.misses.join('; ')})` : ''}`);
	});
	const summary = summarize(results);

	console.log(`\n${summary.passed} of ${summary.cases} cases fully right.`);
	console.log(summaryTable(summary));

	const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
	const dir = join(evalsDir(), 'reports');
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${date}-${extractorName}.md`);
	writeFileSync(file, markdownReport({ extractor: extractorName, model, date, results, summary }));
	console.log(`\nReport: ${file}`);
} finally {
	await db.close();
}
