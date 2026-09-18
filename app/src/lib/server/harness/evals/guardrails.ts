// The guardrail eval: every named check, one case each, asserting that it
// refuses what it is supposed to AND lets through what it should.
//
// The second half matters as much as the first. A check that refuses
// everything would pass a suite that only ever handed it bad input, and it
// would quietly stop the agent doing its job.
import { parseAllowlist } from '../../desk/send.ts';
import { runCheck, GUARDRAILS, type GuardrailInput } from '../guardrails.ts';
import { emptyTally, type CaseResult, type Tally } from './shared.ts';

export interface GuardrailCase {
	about: string;
	check: string;
	/** Input that must not pass. */
	refuses: GuardrailInput;
	expect: {
		verdict: 'refuse' | 'needs_person';
		/** Part of the reason, so the words a person reads are checked too. */
		reason_contains: string;
	};
	/** Input that must pass, so the check is not simply always refusing. */
	passes: GuardrailInput;
	/** Inputs a JSON file cannot hold: an allowlist is a set, a big payload is big. */
	build?: {
		/** MAIL_ALLOWLIST as a string, parsed the way the server parses it. */
		allowlist?: string;
		/** Rows to invent for the size cap, which needs more than a file should hold. */
		payload_rows?: number;
	};
}

/** Fill in the inputs a case file cannot write down. */
export function prepareCase(body: GuardrailCase): GuardrailCase {
	if (!body.build) return body;
	const refuses: GuardrailInput = { ...body.refuses };
	const passes: GuardrailInput = { ...body.passes };
	if (body.build.allowlist !== undefined) {
		const allowlist = parseAllowlist(body.build.allowlist);
		refuses.allowlist = allowlist;
		passes.allowlist = allowlist;
	}
	if (body.build.payload_rows !== undefined) {
		refuses.payload = {
			rows: Array.from({ length: body.build.payload_rows }, (_unused, index) => ({
				item_no: `EVAL-${index}`,
				description: 'A row long enough that a thousand of them do not fit in sixteen kilobytes',
				amount: index * 1.01
			}))
		};
	}
	return { ...body, refuses, passes };
}

export function scoreGuardrailCase(name: string, body: GuardrailCase): CaseResult {
	const tallies: Record<string, Tally> = { refuses: emptyTally(), passes: emptyTally() };
	const misses: string[] = [];

	let refused: ReturnType<typeof runCheck>;
	try {
		refused = runCheck(body.check, body.refuses);
	} catch (error) {
		tallies.refuses.missed += 1;
		misses.push(`the check raised instead of refusing: ${(error as Error).message}`);
		return { name, passed: false, tallies, misses, note: body.about };
	}

	if (refused.ok) {
		tallies.refuses.missed += 1;
		misses.push('it passed input it should have refused');
	} else if (refused.verdict !== body.expect.verdict) {
		tallies.refuses.wrong += 1;
		misses.push(`verdict: expected ${body.expect.verdict}, got ${refused.verdict}`);
	} else if (!refused.reason.toLowerCase().includes(body.expect.reason_contains.toLowerCase())) {
		tallies.refuses.wrong += 1;
		misses.push(`the reason does not say "${body.expect.reason_contains}": ${refused.reason}`);
	} else {
		tallies.refuses.right += 1;
	}

	try {
		const passed = runCheck(body.check, body.passes);
		if (passed.ok) {
			tallies.passes.right += 1;
		} else {
			tallies.passes.wrong += 1;
			misses.push(`it refused input it should have passed: ${passed.reason}`);
		}
	} catch (error) {
		tallies.passes.missed += 1;
		misses.push(`the check raised on input it should have passed: ${(error as Error).message}`);
	}

	return { name, passed: misses.length === 0, tallies, misses, note: body.about };
}

/** Which named checks have no case at all. A gap in the suite, reported as one. */
export function checksWithoutACase(cases: { body: GuardrailCase }[]): string[] {
	const covered = new Set(cases.map((c) => c.body.check));
	return GUARDRAILS.filter((g) => !covered.has(g.id)).map((g) => g.id);
}
