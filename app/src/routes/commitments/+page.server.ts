import { getDb } from '$lib/server/db';
import { listBoard } from '$lib/server/commitments';
import { seesEveryoneByDefault } from '$lib/server/users';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const requested = url.searchParams.get('who');
	const who = requested === 'mine' || requested === 'all' ? requested : seesEveryoneByDefault(user) ? 'all' : 'mine';

	const cards = await listBoard(await getDb(), user.id, who === 'mine' ? user.id : null);
	return {
		who,
		cards,
		needsOutcome: cards.filter((c) => c.needsOutcome).length,
		// The year the server thinks it is, so dates in this year drop the year.
		year: new Date().getFullYear()
	};
};
