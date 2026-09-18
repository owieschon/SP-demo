// Replay: make the same decisions again, from the same recorded inputs, and
// diff the outcome.
//
// This is the part a sceptical engineer asks about, because it is the
// difference between arguing about a change and measuring it. Change the
// classifier, the disclosure policy or the extractor, replay yesterday's
// runs, and the diff says which decisions moved.
//
// What a replay re-runs is what the run recorded enough to re-run: the
// classification, from the message as it arrived, and the disclosure check,
// from the facts the reply cited. Both are deterministic given their inputs
// and both are where a change of policy shows up. What it does NOT re-run is
// the composition of the letter, because that would need every lookup's full
// result and the run deliberately keeps only each lookup's name, arguments,
// row count and time. docs/agent-runs.md says what a real deployment would
// add to close that gap.
//
// No paid API is ever called here. The classifier is a parameter: with none,
// the rules classifier runs, and a test passes a fake one.
import { randomUUID } from 'node:crypto';
import type { Disclosure, Fact } from '$lib/desk/types';
import type { ReplayDiffKind, ReplayOutcome, ReplayResult, RunOutcome } from '$lib/agentruns/types';
import { RULES } from '$lib/agentruns/types';
import type { Db } from '../db/types.ts';
import { classifyWithRules, LOW_CONFIDENCE, type Classification } from '../desk/classify.ts';
import { checkDraft } from '../desk/policy.ts';
import type { PolicyVerdict } from '$lib/desk/types';
import { readRunInputs } from './read.ts';
import { Trail, readTrailCapabilities } from './trail.ts';
import { appendSteps, finishRun, startRun } from './writes.ts';

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
	/** Write the replay as a run of its own. On by default. */
	record?: boolean;
	/** A note for the record: why this replay was run. */
	note?: string;
}

interface DeskInputs {
	kind: 'desk_message';
	message: { id: number; from: string; subject: string; body: string; bodyStripped: string; today: string };
	mailbox: { id: number; address: string; label: string; kind: string; disclosure: Disclosure };
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
 * sides of the diff go through this, so "nothing changed" is a fact about
 * the inputs and not an accident of two code paths agreeing.
 */
function decide(
	classification: { intent: string; confidence: number; reason: string },
	verdict: PolicyVerdict
): ReplayOutcome {
	const unsure = classification.confidence < LOW_CONFIDENCE;
	const outcome: RunOutcome = !verdict.ok ? 'refused' : unsure ? 'needs_person' : 'drafted';
	return {
		intent: unsure ? 'other' : classification.intent,
		confidence: classification.confidence,
		outcome,
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
		changes.push(
			after.refusedFor.length > before.refusedFor.length
				? `The disclosure policy now refuses ${after.refusedFor.length} thing${after.refusedFor.length === 1 ? '' : 's'} it let through before: ${after.refusedFor.join(' ')}`
				: `The disclosure policy no longer refuses ${before.refusedFor.length - after.refusedFor.length} thing${before.refusedFor.length - after.refusedFor.length === 1 ? '' : 's'} it refused before.`
		);
	}
	const decided = changes.length > 0;

	// Wording: the same decision, said differently. Worth seeing, and worth
	// not calling a change of decision.
	if (!decided) {
		if (before.decision !== after.decision) {
			changes.push(`Same decision, different words: "${after.decision}" where it said "${before.decision}".`);
		}
		const beforeReasons = before.refusedFor.join(' | ');
		const afterReasons = after.refusedFor.join(' | ');
		if (beforeReasons !== afterReasons) {
			changes.push('The refusal says the same thing in different words.');
		}
	}

	if (decided) return { diff: 'decision', changes };
	if (changes.length > 0) return { diff: 'wording', changes };
	return { diff: 'same', changes: [] };
}

/**
 * Replay one recorded run.
 *
 * `userId` is the person asking: a replay is always a person asking, and it
 * is recorded as one.
 */
export async function replayRun(
	db: Db,
	userId: number,
	runId: number,
	options: ReplayOptions = {}
): Promise<ReplayResult> {
	const held = await readRunInputs(db, userId, runId);
	if (!held) {
		throw Object.assign(new Error(`Run ${runId} does not exist.`), { code: 'NL404' });
	}
	const inputs = asDeskInputs(held.inputs);
	if (!inputs) {
		throw Object.assign(
			new Error(`Run ${runId} did not record the inputs a replay needs.`),
			{ code: 'NL422' }
		);
	}

	const facts = inputs.draft?.facts ?? [];
	const draftSubject = inputs.draft?.subject ?? '';
	const draftBody = inputs.draft?.body ?? '';

	// Before: the classification the run recorded, judged under the policy
	// the run was judged under.
	const recorded = {
		intent: inputs.decision.intent ?? 'other',
		confidence: inputs.decision.confidence ?? 0,
		reason: inputs.decision.reason || inputs.decision.summary
	};
	const beforeVerdict = checkDraft({
		level: inputs.mailbox.disclosure,
		subject: inputs.subjectNo,
		facts,
		subjectLine: draftSubject,
		body: draftBody
	});
	const before = decide(recorded, beforeVerdict);

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
	const afterVerdict = checkDraft({
		level,
		subject: inputs.subjectNo,
		facts,
		subjectLine: draftSubject,
		body: draftBody
	});
	const after = decide(again, afterVerdict);

	const { diff, changes } = diffOf(before, after);

	let replayRunId: number | null = null;
	if (options.record !== false) {
		replayRunId = await writeReplayRun(db, userId, {
			runId,
			agent: held.run.agent,
			entity: held.run.entity,
			entityId: held.run.entityId,
			subjectNo: held.run.subjectNo,
			level,
			levelChanged: level !== inputs.mailbox.disclosure,
			liveClassifier: Boolean(options.classify),
			note: options.note ?? '',
			before,
			after,
			diff,
			changes
		});
	}

	return { runId, replayRunId, diff, before, after, changes };
}

interface WriteReplay {
	runId: number;
	agent: string;
	entity: string | null;
	entityId: number | null;
	subjectNo: string | null;
	level: Disclosure;
	levelChanged: boolean;
	liveClassifier: boolean;
	note: string;
	before: ReplayOutcome;
	after: ReplayOutcome;
	diff: ReplayDiffKind;
	changes: string[];
}

/** A replay is a run too, with replay_of pointing at the one it replays. */
async function writeReplayRun(db: Db, userId: number, input: WriteReplay): Promise<number> {
	const request = `replay-${input.runId}-${randomUUID()}`;
	const started = new Date();

	return db.asUser(userId, async (tx) => {
		const capabilities = await readTrailCapabilities(tx);
		const { runId } = await startRun(
			tx,
			{
				agent: input.agent,
				wokeBy: 'replay',
				wokeNote: input.note || `A replay of run ${input.runId}`,
				entity: input.entity,
				entityId: input.entityId,
				reader: 'internal',
				subjectNo: input.subjectNo,
				mode: 'mock',
				model: null,
				bundleVersion: capabilities.bundleVersion,
				inputs: { kind: 'replay', of: input.runId, judged_at: input.level },
				replayOf: input.runId,
				sourceKind: null,
				sourceId: null,
				startedAt: started.toISOString()
			},
			`${request}:start`
		);

		const trail = new Trail({ reader: 'internal', subject: input.subjectNo });
		trail.read(
			`The recorded inputs of run ${input.runId}`,
			'The message as it arrived, the desk it came to, and the facts the reply cited. Nothing was looked up again.'
		);
		trail.decide(
			input.liveClassifier ? 'Classified again, with the classifier under test' : 'Classified again, with the rules classifier',
			`Read it as ${input.after.intent}, ${Math.round(input.after.confidence * 100)}% sure. ${input.after.decision}`
		);
		trail.decide(
			`Checked the same reply against the disclosure policy at ${input.level} level`,
			input.levelChanged
				? `The run was judged at a different level. This is the policy change being measured.`
				: 'The same level the run was judged at.'
		);
		for (const reason of input.after.refusedFor) {
			trail.refuse('The policy refuses this reply now', 'disclosure', reason.replace(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g, 'a figure'));
		}
		trail.note(
			`The diff: ${input.diff}`,
			input.changes.length === 0
				? 'Same decision, same words. Nothing moved.'
				: input.changes.join(' ')
		);

		await appendSteps(tx, runId, trail.rows(), `${request}:steps`);
		await finishRun(
			tx,
			{
				runId,
				outcome: 'replayed',
				decision:
					input.diff === 'same'
						? `Replayed run ${input.runId}: the same decision, in the same words.`
						: input.diff === 'wording'
							? `Replayed run ${input.runId}: the same decision, different wording.`
							: `Replayed run ${input.runId}: a different decision. ${input.changes.join(' ')}`,
				durationMs: Math.max(0, Date.now() - started.getTime()),
				inputTokens: 0,
				outputTokens: 0,
				producedKind: null,
				producedId: null,
				produced: { diff: input.diff, changes: input.changes },
				diff: input.diff,
				error: null
			},
			`${request}:finish`
		);
		return runId;
	});
}

/** The rule a replay's refusals are recorded under, for a caller that asks. */
export const REPLAY_REFUSAL_RULE = RULES.disclosure.id;
