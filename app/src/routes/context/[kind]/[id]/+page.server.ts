import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { SUBJECT_KINDS, SURFACES, type SubjectKind, type Surface } from '$lib/context/types';
import { exploreAction } from '$lib/server/context/forms';
import { contextFor, readEntityContext } from '$lib/server/context/read';
import type { Actions, PageServerLoad } from './$types';

/**
 * One entity's context: every fact with its source, its date, its confidence
 * and the exact words it came from.
 *
 * There is no param matcher for these two segments. The check is here
 * instead, because "is this one of four subject kinds" and "is this actually
 * in the book" are the same question asked twice, and the second one needs
 * the database anyway.
 */
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = locals.user!;
	if (!(SUBJECT_KINDS as readonly string[]).includes(params.kind)) {
		error(404, 'Context is held about a customer, a contact, a vendor or an item.');
	}
	const kind = params.kind as SubjectKind;
	const db = await getDb();

	const context = await readEntityContext(db, user.id, { kind, id: params.id });
	if (!context) error(404, 'Nothing in the book with that number.');

	const asked = url.searchParams.get('purpose');
	const purpose: Surface = (SURFACES as readonly string[]).includes(asked ?? '')
		? (asked as Surface)
		: 'internal_review';

	return {
		context,
		purpose,
		// The bundle exactly as an agent would read it, so the page shows what
		// the agent sees rather than a second rendering of the same facts. This
		// is the one place a person can check that the disclosure rules do what
		// they say: switch the purpose and watch a fact leave the list.
		bundle: await contextFor(db, user.id, { kind, id: params.id }, purpose),
		requestId: randomUUID()
	};
};

export const actions: Actions = {
	explore: async ({ locals, request }) => exploreAction(await getDb(), locals.user!, request)
};
