import { getDb } from '$lib/server/db';
import { listBoard } from '$lib/server/commitments';
import { holdsWholeDimension, readWho } from '$lib/server/roles/scope';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();

	// The default comes from the person's own scope now, not from the old role
	// column: somebody who holds every account has no narrower view to offer.
	const holdsAll = await holdsWholeDimension(db, user.id, 'account');
	const who = readWho(url.searchParams, { holdsAll });

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
