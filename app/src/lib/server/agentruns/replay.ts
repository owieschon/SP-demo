// Replay: make the same decisions again, from the same recorded inputs, and
// diff the outcome.
//
// This is the part a sceptical engineer asks about, because it is the
// difference between arguing about a change and measuring it. Change the
// classifier or the disclosure policy, replay yesterday's runs, and the diff
// says which decisions moved.
//
// What a replay re-runs is what the trail recorded enough to re-run: the
// classification, from the message as it arrived, and the disclosure check,
// from the facts the reply cited. Both are deterministic given their inputs,
// and both are where a change of policy shows up. What it does NOT re-run is
// the composition of the letter, because that would need every lookup's full
// result and the run deliberately keeps only each lookup's name, arguments,
// row count and time. docs/agent-runs.md says what a real deployment would
// add to close that gap.
//
// No paid API is ever called here. The classifier is a parameter: with none,
// the rules classifier runs, and a test passes a fake one.
import type { Disclosure, Fact, PolicyVerdict } from '$lib/desk/types';
import type { ReplayDiffKind, ReplayOutcome, ReplayResult } from '$lib/agentruns/types';
import type { Db } from '../db/types.ts';
import { classifyWithRules, LOW_CONFIDENCE, type Classification } from '../desk/classify.ts';
import { checkDraft } from '../desk/policy.ts';
import { readTrailInputs } from './read.ts';

/** A classifier a replay may be given instead of the rules one. */
export interface ReplayClassifier {
	(input: { from: string; subject: string; body: string; today: string }): Promise<Classification>;
}

export interface ReplayOptions {
	/** Instead of the rules classifier. Tests pass a fake; never a paid API. */
	classify?: ReplayClassifier;
	/**
	 * Judge the recorded run under a different disclosure policy: the change
	 * whose effect a replay exists to measure.
	 */
	policy?: { level: Disclosure };
}

interface DeskInputs {
	kind: 'desk_message';
	message: { id: number; from: string; subject: string; body: string; bodyStripped: string; today: string };
	mailbox: { address: string; label: string; kind: string; disclosure: Disclosure };
	subjectNo: string | null;
	decision: {
		intent: string | null;
		confidence: number | null;
		outcome: string;
		summary: string;
		/** The classifier's own reason, which is what a replay compares against. */
		reason?: string;
	};
	draft: { id: number; subject: string | null; body: string | null; facts: Fact[] } | null;
}

/** A run whose inputs this file knows how to replay. */
function asDeskInputs(inputs: Record<string, unknown>): DeskInputs | null {
	return inputs && inputs.kind === 'desk_message' ? (inputs as unknown as DeskInputs) : null;
}

/**
 * The two decisions, from a classification and a disclosure verdict. Both
 * sides of the diff go through this, so "nothing changed" is a fact about the
 * inputs and not an accident of two code paths agreeing.
 */
function decide(
	classification: { intent: string; confidence: number; reason: string },
	verdict: PolicyVerdict
): ReplayOutcome {
	const unsure = classification.confidence < LOW_CONFIDENCE;
	return {
		intent: unsure ? 'other' : classification.intent,
		confidence: classification.confidence,
		outcome: !verdict.ok ? 'refused' : unsure ? 'needs_person' : 'drafted',
		refusedFor: verdict.reasons,
		decision: classification.reason
	};
}

function diffOf(before: ReplayOutcome, after: ReplayOutcome): { diff: ReplayDiffKind; changes: string[] } {
	const changes: string[] = [];

	if (before.outcome !== after.outcome) {
		changes.push(`The outcome moved from ${before.outcome} to ${after.outcome}.`);
	}
	if (before.intent !== after.intent) {
		changes.push(`It read the message as ${after.intent} where it read it as ${before.intent}.`);
	}
	if (before.refusedFor.length !== after.refusedFor.length) {
		const more = after.refusedFor.length - before.refusedFor.length;
		changes.push(
			more > 0
				? `The disclosure policy now refuses ${more} thing${more === 1 ? '' : 's'} it let through before: ${after.refusedFor.join(' ')}`
				: `The disclosure policy no longer refuses ${-more} thing${-more === 1 ? '' : 's'} it refused before.`
		);
	}
	const decided = changes.length > 0;

	// Wording: the same decision, said differently. Worth seeing, and worth
	// not calling a change of decision.
	if (!decided) {
		if (before.decision !== after.decision) {
			changes.push(`Same decision, different words: "${after.decision}" where it said "${before.decision}".`);
		}
		if (before.refusedFor.join(' | ') !== after.refusedFor.join(' | ')) {
			changes.push('The refusal says the same thing in different words.');
		}
	}

	if (decided) return { diff: 'decision', changes };
	if (changes.length > 0) return { diff: 'wording', changes };
	return { diff: 'same', changes: [] };
}

/**
 * Replay one recorded run, by the harness's run key.
 *
 * Nothing is written: a replay is a measurement, and recording every
 * measurement as a run of its own would put a pile of rows nobody asked for
 * in the harness's log. docs/agent-runs.md says what a deployment that wanted
 * a history of replays would add.
 */
export async function replayRun(
	db: Db,
	userId: number,
	runKey: string,
	options: ReplayOptions = {}
): Promise<ReplayResult> {
	const held = await readTrailInputs(db, userId, runKey);
	if (!held) {
		throw Object.assign(new Error(`Run ${runKey} has no trail to replay.`), { code: 'NL404' });
	}
	const inputs = asDeskInputs(held.inputs);
	if (!inputs) {
		throw Object.assign(new Error(`Run ${runKey} did not record the inputs a replay needs.`), {
			code: 'NL422'
		});
	}

	const facts = inputs.draft?.facts ?? [];
	const draftSubject = inputs.draft?.subject ?? '';
	const draftBody = inputs.draft?.body ?? '';

	// Before: the classification the run recorded, judged under the policy the
	// run was judged under.
	const recorded = {
		intent: inputs.decision.intent ?? 'other',
		confidence: inputs.decision.confidence ?? 0,
		reason: inputs.decision.reason || inputs.decision.summary
	};
	const before = decide(
		recorded,
		checkDraft({
			level: inputs.mailbox.disclosure,
			subject: inputs.subjectNo,
			facts,
			subjectLine: draftSubject,
			body: draftBody
		})
	);

	// After: classify again, and judge under the policy being tested.
	const level = options.policy?.level ?? inputs.mailbox.disclosure;
	const again: Classification = options.classify
		? await options.classify({
				from: inputs.message.from,
				subject: inputs.message.subject,
				body: inputs.message.bodyStripped || inputs.message.body,
				today: inputs.message.today
			})
		: classifyWithRules({ subject: inputs.message.subject, body: inputs.message.body });
	const after = decide(
		again,
		checkDraft({
			level,
			subject: inputs.subjectNo,
			facts,
			subjectLine: draftSubject,
			body: draftBody
		})
	);

	const { diff, changes } = diffOf(before, after);
	return { runKey, diff, before, after, changes };
}
