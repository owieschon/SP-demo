import { getDb } from '$lib/server/db';
import { getToday } from '$lib/server/today';
import type { PageServerLoad } from './$types';

/*
  The home page used to redirect to the commitment board, which made a board
  of records the first thing a person saw. It is now the exception queue: the
  decisions only a person can make, and nothing else.
*/
export const load: PageServerLoad = async ({ locals }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();

	return {
		// Not awaited: the page and its heading arrive first, the counts stream
		// in behind a skeleton the same shape.
		queue: getToday(db, user.id),
		firstName: user.fullName.split(' ')[0],
		year: new Date().getFullYear()
	};
};
