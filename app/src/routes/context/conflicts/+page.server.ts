import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/db';
import { decideLinkAction, decideReviewAction, resolveConflictAction } from '$lib/server/context/forms';
import { readConflicts, readReviewItems } from '$lib/server/context/read';
import { readUnresolved } from '$lib/server/context/resolve';
import type { Actions, PageServerLoad } from './$types';

/**
 * The queue where a person decides. Three kinds of decision, all here because
 * they are the same job: the engine could not settle something and needs a
 * human answer.
 *
 *   conflicts   two claims disagree and no source outranks the other
 *   queries     "I could not tell what this means", and failed validations
 *   subjects    a claim nothing can be attached to an account yet
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();
	const tab = url.searchParams.get('tab') === 'queries' ? 'queries' : 'conflicts';

	return {
		tab,
		// Awaited: the counts on the tabs come from these and they are small.
		conflicts: await readConflicts(db, user.id, 50),
		reviewItems: await readReviewItems(db, user.id, 50),
		unresolved: await db.asUser(user.id, (tx) => readUnresolved(tx, 20)),
		requestId: randomUUID()
	};
};

export const actions: Actions = {
	resolve: async ({ locals, request }) => resolveConflictAction(await getDb(), locals.user!, request),
	review: async ({ locals, request }) => decideReviewAction(await getDb(), locals.user!, request),
	link: async ({ locals, request }) => decideLinkAction(await getDb(), locals.user!, request)
};
