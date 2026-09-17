import { getDb } from '$lib/server/db';
import { listBoard } from '$lib/server/commitments';
import { seesEveryoneByDefault } from '$lib/server/users';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const requested = url.searchParams.get('who');
	const who: 'mine' | 'all' = requested === 'mine' || requested === 'all' ? requested : seesEveryoneByDefault(user) ? 'all' : 'mine';

	const db = await getDb();
	return {
		who,
		// Not awaited on purpose: SvelteKit sends the page first and streams
		// the rows when they are ready, so the board shows skeleton rows
		// instead of a blank wait.
		board: listBoard(db, user.id, who === 'mine' ? user.id : null),
		// The year the server thinks it is, so dates in this year drop the year.
		year: new Date().getFullYear()
	};
};
