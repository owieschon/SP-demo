// The workspace's one form action: decide an item in the queue.
//
// Same pattern as the other features' forms.ts: check the form's shape, call
// the write, and turn a refusal from the database into a message the page can
// show. A tampered form gets nowhere, because every value a decision uses
// beyond the id, the row version and the request id comes out of the stored
// record inside the source's own write function.
import { fail, type ActionFailure } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';
import type { Db } from '../db/types.ts';
import { toAppError } from '../errors.ts';
import { decideQueueItem, type QueueDecisionResult } from './decide.ts';

export type WorkspaceFormFailure = { message: string; conflict?: boolean };

export type WorkspaceFormResult =
	| ({ message: string } & Omit<QueueDecisionResult, 'message'>)
	| ActionFailure<WorkspaceFormFailure>;

function formObject(data: FormData): Record<string, string> {
	// The workspace's forms carry no files; text fields only.
	const out: Record<string, string> = {};
	for (const [key, value] of data) {
		if (typeof value === 'string') out[key] = value;
	}
	return out;
}

export async function decideAction(
	db: Db,
	user: SessionUser,
	request: Request
): Promise<WorkspaceFormResult> {
	const raw = formObject(await request.formData());
	try {
		const { message, ...rest } = await decideQueueItem(db, user, raw);
		return { message, ...rest };
	} catch (error) {
		const refusal = toAppError(error);
		if (!refusal) throw error;
		return fail(refusal.status, {
			message: refusal.message,
			conflict: refusal.status === 409
		} satisfies WorkspaceFormFailure);
	}
}
