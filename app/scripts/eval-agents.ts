// Run the agent eval suites and write a dated report.
//
//   npm run eval:agents                 all four suites (free, no key needed)
//   npm run eval:agents -- --suite=desk one suite: desk, assistant, automation, guardrails
//   npm run eval:agents -- --record     write the observed automation counts
//                                       back into the case files
//   npm run eval:agents -- --baseline   write evals/agents/baseline.json
//
// Nothing here calls a paid API. The desk's classifier is the rule-based one,
// the assistant's model is a script in a case file, and the mail provider
// never appears: the messages are put straight into the inbox.
//
// Reports go to evals/agents/reports/YYYY-MM-DD.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTestDb } from '../src/lib/server/db/pglite.ts';
import {
	loadDeskEvalWorld,
	runAssistantSuite,
	runAutomationSuite,
	runDeskSuite,
	runGuardrailSuite
} from '../src/lib/server/harness/evals/index.ts';
import {
	agentEvalsDir,
	baselineFile,
	EVAL_TODAY,
	markdownReport,
	summaryTable,
	toBaseline,
	type SuiteRun
} from '../src/lib/server/harness/evals/shared.ts';

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith('--suite='))?.split('=')[1] ?? null;
const record = args.includes('--record');
const writeBaseline = args.includes('--baseline');
const wants = (suite: string) => only === null || only === suite;

const runs: SuiteRun[] = [];
const say = (result: { passed: boolean; name: string; misses: string[] }) =>
	console.log(`${result.passed ? 'pass' : 'MISS'}  ${result.name}${result.misses.length ? `  (${result.misses.join('; ')})` : ''}`);

if (wants('guardrails')) {
	console.log('\nGuardrails (no database needed)');
	const run = runGuardrailSuite();
	for (const result of run.results) say(result);
	runs.push(run);
}

if (wants('desk') || wants('assistant') || wants('automation')) {
	console.log(`\nBuilding the eval world (small test world as of ${EVAL_TODAY})...`);
	const db = await createTestDb({ today: EVAL_TODAY });
	try {
		// Always loaded, whichever suites are running. The automation counts are
		// recorded against one particular world, so a suite run on its own must
		// not see a different world from the same suite in a full run.
		await loadDeskEvalWorld(db);
		if (wants('desk')) {
			console.log('\nOrder desk');
			runs.push(await runDeskSuite(db, say));
		}
		if (wants('assistant')) {
			console.log('\nAssistant');
			runs.push(await runAssistantSuite(db, say));
		}
		if (wants('automation')) {
			console.log('\nAutomation');
			const run = await runAutomationSuite(db, say);
			runs.push(run);
			if (record) {
				// The small world is deterministic, so a match count can be
				// recorded rather than guessed. See evals/agents/README.md on why
				// that makes these a floor and not an expectation.
				for (const [name, matches] of Object.entries(run.observed)) {
					if (matches === null) continue;
					const file = join(agentEvalsDir(), 'automation', 'cases', `${name}.json`);
					const body = JSON.parse(readFileSync(file, 'utf8')) as {
						expected: { matches: number; recorded: boolean };
					};
					body.expected.matches = matches;
					body.expected.recorded = true;
					writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
					console.log(`recorded ${name}: ${matches} matches`);
				}
			}
		}
	} finally {
		await db.close();
	}
}

console.log('');
let allPassed = 0;
let allCases = 0;
for (const run of runs) {
	allPassed += run.summary.passed;
	allCases += run.summary.cases;
	console.log(`${run.summary.suite}: ${run.summary.passed} of ${run.summary.cases} cases fully right`);
	console.log(summaryTable(run.summary));
	console.log('');
}
console.log(`${allPassed} of ${allCases} cases fully right, across ${runs.length} suite(s).`);

const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const dir = join(agentEvalsDir(), 'reports');
mkdirSync(dir, { recursive: true });
const file = join(dir, `${date}.md`);
writeFileSync(
	file,
	markdownReport({
		date,
		runs,
		extractor: 'the rule-based classifier and a scripted model, no paid API'
	})
);
console.log(`\nReport: ${file}`);

if (writeBaseline) {
	if (only !== null) {
		console.error('A baseline is written from a whole run. Drop --suite= and try again.');
		process.exit(1);
	}
	writeFileSync(baselineFile(), `${JSON.stringify(toBaseline(runs), null, 2)}\n`);
	console.log(`Baseline: ${baselineFile()}`);
}
