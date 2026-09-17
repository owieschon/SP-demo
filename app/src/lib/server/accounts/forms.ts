// The form actions behind the account page and the buyer picker.
//
// Each action says which form it answered (`from`), so the page shows the
// message next to that form and nowhere else. A refusal from the database
// (NL403, NL409, ...) becomes an HTTP status and its own message.
import { fail, type ActionFailure } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';
import type { Db } from '../db/types.ts';
import { toAppError } from '../errors.ts';
import {
	addContact,
	addContactAsBuyer,
	addContactInput,
	addNextStep,
	addNextStepInput,
	addBuyerInput,
	completeNextStep,
	completeNextStepInput,
	logActivity,
	logActivityInput,
	setBuyerInput,
	setCommitmentBuyer,
	updateContact,
	updateContactInput
} from './writes.ts';

export type AccountFormSource = 'contact' | 'activity' | 'step' | 'buyer';

export interface AccountFormAnswer {
	from: AccountFormSource;
	message: string;
	failed: boolean;
	conflict: boolean;
}

function refuse(
	from: AccountFormSource,
	status: number,
	message: string
): ActionFailure<AccountFormAnswer> {
	return fail(status, { from, message, failed: true, conflict: status === 409 });
}

/** Run a write; turn a database refusal into a message for the form that sent it. */
async function run(
	from: AccountFormSource,
	work: () => Promise<string>
): Promise<AccountFormAnswer | ActionFailure<AccountFormAnswer>> {
	try {
		return { from, message: await work(), failed: false, conflict: false };
	} catch (error) {
		const refusal = toAppError(error);
		if (!refusal) throw error;
		return refuse(from, refusal.status, refusal.message);
	}
}

export async function addContactAction(db: Db, user: SessionUser, request: Request) {
	const parsed = addContactInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return refuse('contact', 400, firstProblem(parsed.error.issues, 'Check the contact details.'));
	}
	const input = parsed.data;
	return run('contact', async () => {
		const result = await addContact(db, user.id, input);
		return `Added ${input.fullName}${result.isPrimary ? ' as the primary contact' : ''}.`;
	});
}

export async function updateContactAction(db: Db, user: SessionUser, request: Request) {
	const parsed = updateContactInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return refuse('contact', 400, firstProblem(parsed.error.issues, 'Check the contact details.'));
	}
	const input = parsed.data;
	return run('contact', async () => {
		await updateContact(db, user.id, input);
		return input.left ? `Marked ${input.fullName} as no longer there.` : `Saved ${input.fullName}.`;
	});
}

export async function logActivityAction(db: Db, user: SessionUser, request: Request) {
	const parsed = logActivityInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return refuse('activity', 400, firstProblem(parsed.error.issues, 'Write a line about it first.'));
	}
	const input = parsed.data;
	return run('activity', async () => {
		await logActivity(db, user.id, input);
		return input.kind === 'call' ? 'Logged the call.' : `Logged the ${input.kind}.`;
	});
}

export async function addNextStepAction(db: Db, user: SessionUser, request: Request) {
	const parsed = addNextStepInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return refuse('step', 400, 'Say what needs doing in 3 to 200 characters, and pick who does it.');
	}
	return run('step', async () => {
		await addNextStep(db, user.id, parsed.data);
		return 'Added the next step.';
	});
}

export async function completeNextStepAction(db: Db, user: SessionUser, request: Request) {
	const parsed = completeNextStepInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return refuse('step', 400, 'That step is out of date. Reload the page and try again.');
	}
	return run('step', async () => {
		await completeNextStep(db, user.id, parsed.data);
		return 'Marked it done.';
	});
}

/** Name an existing contact as a commitment's buyer (or clear the buyer). */
export async function setBuyerAction(db: Db, user: SessionUser, request: Request) {
	const parsed = setBuyerInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return refuse('buyer', 400, 'Pick someone from the list.');
	}
	const input = parsed.data;
	return run('buyer', async () => {
		await setCommitmentBuyer(db, user.id, input);
		return input.contactId === null ? 'Cleared the buyer.' : 'Named the buyer.';
	});
}

/** Add a new person at the account and name them buyer, in one go. */
export async function addBuyerAction(db: Db, user: SessionUser, request: Request) {
	const parsed = addBuyerInput.safeParse(Object.fromEntries(await request.formData()));
	if (!parsed.success) {
		return refuse('buyer', 400, firstProblem(parsed.error.issues, 'Check the contact details.'));
	}
	const input = parsed.data;
	return run('buyer', async () => {
		await addContactAsBuyer(db, user.id, input);
		return `Added ${input.fullName} and named them the buyer.`;
	});
}

// What to say about the field zod objected to. The SQL functions check the
// same rules again, so these messages only have to cover a form the browser
// let through.
const FIELD_PROBLEM: Record<string, string> = {
	fullName: 'A name needs 2 to 100 characters.',
	title: 'A title is at most 80 characters.',
	email: 'That email address is too long.',
	phone: 'That phone number is too long.',
	mobile: 'That mobile number is too long.',
	notes: 'Notes are at most 1,000 characters.',
	body: 'Write 1 to 2,000 characters about it.',
	dueOn: 'A due date looks like 2026-09-30.',
	occurredAt: 'That date and time could not be read.'
};

/** The first thing zod objected to, in plain words, or a fallback. */
function firstProblem(issues: readonly { path: readonly PropertyKey[] }[], fallback: string): string {
	const field = String(issues[0]?.path[0] ?? '');
	return FIELD_PROBLEM[field] ?? fallback;
}
