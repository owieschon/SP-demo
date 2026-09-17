// Form actions shared by the pages that record outcomes or change confidence.
// Each one checks the form's shape with zod, calls the write, and turns a
// refusal from the database into a message the page can show.
import { fail, type ActionFailure } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';
import type { Db } from './db/types.ts';
import {
	recordOutcome,
	recordOutcomeInput,
	setConfidence,
	setConfidenceInput,
	type WriteResult
} from './commitments.ts';
import { toAppError } from './errors.ts';

export type FormFailure = { message: string; conflict?: boolean };

async function run(
	work: () => Promise<WriteResult>,
	done: (result: WriteResult) => string
): Promise<{ message: string; replayed: boolean } | ActionFailure<FormFailure>> {
	try {
		const result = await work();
		return { message: done(result), replayed: result.replayed };
	} catch (error) {
		const refusal = toAppError(error);
		if (!refusal) throw error;
		return fail(refusal.status, { message: refusal.message, conflict: refusal.status === 409 });
	}
}

export async function outcomeAction(db: Db, user: SessionUser, request: Request) {
	const parsed = recordOutcomeInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Pick one of the three answers.' } satisfies FormFailure);
	}
	const input = parsed.data;
	return run(
		() => recordOutcome(db, user.id, input),
		() => `Recorded "${input.outcome}" for C-${input.commitmentId}.`
	);
}

export async function confidenceAction(db: Db, user: SessionUser, request: Request) {
	const parsed = setConfidenceInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Confidence is a whole number from 0 to 100.' } satisfies FormFailure);
	}
	const input = parsed.data;
	return run(
		() => setConfidence(db, user.id, input),
		() => `Confidence is now ${input.confidence}%.`
	);
}
