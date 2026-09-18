// The form actions behind /agents. Four things a person can do here, and
// every one of them is a policy decision rather than a piece of work:
//
//   promote or demote a kind of work
//   pause an agent, or start it again
//   undo something an agent did on its own
//   say whether a sampled action was good or bad
//
// Each one checks the form's shape with zod, calls the write, and turns a
// refusal from the database into a sentence the page can show.
import { fail, type ActionFailure } from '@sveltejs/kit';
import { z } from 'zod';
import type { Db } from '../db/types.ts';
import { toAppError } from '../errors.ts';
import { demoteOnSample, pauseInput, setLevel, setLevelInput, setPause } from './ladder.ts';
import { reviewSampled } from './record.ts';
import { undoAction } from './wake.ts';

export type HarnessFormFailure = { from: string; message: string; conflict?: boolean };
export interface HarnessFormResult {
	from: string;
	message: string;
}

function refuse(from: string, error: unknown): ActionFailure<HarnessFormFailure> {
	const refusal = toAppError(error);
	if (!refusal) throw error;
	return fail(refusal.status, {
		from,
		message: refusal.message,
		conflict: refusal.status === 409
	});
}

export async function levelAction(
	db: Db,
	userId: number,
	form: FormData
): Promise<HarnessFormResult | ActionFailure<HarnessFormFailure>> {
	const parsed = setLevelInput.safeParse(Object.fromEntries(form));
	if (!parsed.success) {
		return fail(400, { from: 'level', message: 'That was missing something. Reload and try again.' });
	}
	try {
		const result = await setLevel(db, userId, parsed.data);
		return {
			from: 'level',
			message: result.changed
				? `${parsed.data.agent} doing ${parsed.data.workKind} is now at ${result.level}, from ${result.fromLevel}. Your name and the numbers behind it are on the record.`
				: `It was already at ${result.level}.`
		};
	} catch (error) {
		return refuse('level', error);
	}
}

export async function pauseAction(
	db: Db,
	userId: number,
	form: FormData
): Promise<HarnessFormResult | ActionFailure<HarnessFormFailure>> {
	const parsed = pauseInput.safeParse(Object.fromEntries(form));
	if (!parsed.success) {
		return fail(400, { from: 'pause', message: 'That was missing something. Reload and try again.' });
	}
	try {
		const result = await setPause(db, userId, parsed.data);
		const which = parsed.data.agent === 'all' ? 'Every agent' : parsed.data.agent;
		return {
			from: 'pause',
			message: result.paused
				? `${which} is paused. It will still draft, and it will not act.`
				: `${which} is running again.`
		};
	} catch (error) {
		return refuse('pause', error);
	}
}

const undoFormInput = z.object({
	actionId: z.coerce.number().int().positive(),
	reason: z.string().trim().max(500).default(''),
	requestId: z.string().min(8).max(100)
});

export async function undoFormAction(
	db: Db,
	userId: number,
	form: FormData
): Promise<HarnessFormResult | ActionFailure<HarnessFormFailure>> {
	const parsed = undoFormInput.safeParse(Object.fromEntries(form));
	if (!parsed.success) {
		return fail(400, { from: 'undo', message: 'That was missing something. Reload and try again.' });
	}
	try {
		const result = await undoAction(db, userId, parsed.data);
		return { from: 'undo', message: `Taken back. ${result.what}` };
	} catch (error) {
		return refuse('undo', error);
	}
}

const sampleFormInput = z.object({
	actionId: z.coerce.number().int().positive(),
	verdict: z.enum(['good', 'bad']),
	note: z.string().trim().max(500).default(''),
	requestId: z.string().min(8).max(100)
});

export async function sampleAction(
	db: Db,
	userId: number,
	form: FormData
): Promise<HarnessFormResult | ActionFailure<HarnessFormFailure>> {
	const parsed = sampleFormInput.safeParse(Object.fromEntries(form));
	if (!parsed.success) {
		return fail(400, { from: 'sample', message: 'That was missing something. Reload and try again.' });
	}
	try {
		await reviewSampled(db, userId, parsed.data);
		// A bad verdict may be the one that takes the agent off auto, so the rule
		// runs here rather than waiting for the nightly job.
		const dropped = await demoteOnSample(db, userId, {
			requestId: `${parsed.data.requestId}-demote`
		});
		const names = dropped.demoted.map((d) => `${d.agent} doing ${d.work_kind}`);
		return {
			from: 'sample',
			message:
				names.length > 0
					? `Recorded. ${names.join(' and ')} dropped back to auto with an undo window, because the sample went bad.`
					: 'Recorded.'
		};
	} catch (error) {
		return refuse('sample', error);
	}
}
