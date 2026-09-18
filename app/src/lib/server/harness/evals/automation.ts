// The automation eval: does a rule match what it should on the small world,
// and does it fire once per subject however often it runs?
//
// The match counts in the case files were RECORDED from the small world, which
// is deterministic, rather than worked out by hand. That makes them a
// regression floor and not an independent expectation: if the seed changes,
// they have to be recorded again, and evals/agents/README.md says so. What is
// an independent expectation is the once-per-subject case, which is a property
// of the schema and would be wrong at any count.
import { randomUUID } from 'node:crypto';
import { runRule, testRule } from '../../automation/rules.ts';
import type { Db } from '../../db/types.ts';
import { emptyTally, type CaseResult, type Tally } from './shared.ts';

export interface AutomationCase {
	about: string;
	/** The rule, in the shape the catalog validates. */
	rule: Record<string, unknown>;
	expected: {
		/** What a dry run should match now. */
		matches: number;
		/** Recorded from the small world rather than reasoned out. */
		recorded: boolean;
		/** Run it twice and the second run must fire for nobody. */
		fires_once_per_subject?: boolean;
		/** The rule is not valid and the catalog has to refuse it. */
		refused?: boolean;
	};
}

export interface AutomationPredicted {
	matches: number | null;
	refusal: string | null;
	firstRunFired: number | null;
	secondRunFired: number | null;
}

export async function runAutomationCase(
	db: Db,
	userId: number,
	body: AutomationCase
): Promise<AutomationPredicted> {
	const out: AutomationPredicted = {
		matches: null,
		refusal: null,
		firstRunFired: null,
		secondRunFired: null
	};

	try {
		const test = await testRule(db, userId, body.rule, null);
		out.matches = test.total;
	} catch (error) {
		out.refusal = error instanceof Error ? error.message : String(error);
		return out;
	}

	if (body.expected.fires_once_per_subject) {
		// Save it, run it twice, and read what each run fired. Saving is the same
		// write the rule builder uses, and the rule is left switched off.
		const [saved] = await db.asUser(userId, (tx) =>
			tx.sql<{ result: { rule_id: number } }>`
				select nl.save_automation_rule(
				  null::bigint, ${String(body.rule.name).slice(0, 80)} || ' (eval)',
				  'An eval fixture.', ${String(body.rule.trigger)},
				  ${JSON.stringify(body.rule.conditions ?? [])}::jsonb,
				  ${JSON.stringify(body.rule.action ?? {})}::jsonb,
				  false, null::timestamptz, ${`eval-rule-${randomUUID()}`}) as result`
		);
		const ruleId = Number(saved.result.rule_id);
		const first = await runRule(db, userId, ruleId, 'ui');
		const second = await runRule(db, userId, ruleId, 'ui');
		out.firstRunFired = first.fired;
		out.secondRunFired = second.fired;
	}

	return out;
}

export function scoreAutomationCase(
	name: string,
	body: AutomationCase,
	got: AutomationPredicted
): CaseResult {
	const tallies: Record<string, Tally> = { matches: emptyTally(), once_per_subject: emptyTally() };
	const misses: string[] = [];

	if (body.expected.refused) {
		if (got.refusal === null) {
			tallies.matches.wrong += 1;
			misses.push('the catalog accepted a rule it should have refused');
		} else {
			tallies.matches.right += 1;
		}
		return { name, passed: misses.length === 0, tallies, misses, note: body.about };
	}

	if (got.refusal !== null) {
		tallies.matches.missed += 1;
		misses.push(`refused: ${got.refusal}`);
		return { name, passed: false, tallies, misses, note: body.about };
	}

	if (got.matches === body.expected.matches) {
		tallies.matches.right += 1;
	} else {
		tallies.matches.wrong += 1;
		misses.push(`matches: expected ${body.expected.matches}, got ${got.matches}`);
	}

	if (body.expected.fires_once_per_subject) {
		if (got.secondRunFired === 0) {
			tallies.once_per_subject.right += 1;
		} else {
			tallies.once_per_subject.wrong += 1;
			misses.push(`the second run fired ${got.secondRunFired} more time(s), and it must fire none`);
		}
		if ((got.firstRunFired ?? 0) !== (got.matches ?? 0)) {
			misses.push(`the first run fired ${got.firstRunFired} of ${got.matches} matches`);
		}
	}

	return { name, passed: misses.length === 0, tallies, misses, note: body.about };
}
