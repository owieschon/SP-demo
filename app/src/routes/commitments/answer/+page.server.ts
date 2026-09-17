import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/db';
import { listBoard } from '$lib/server/commitments';
import { outcomeAction } from '$lib/server/forms';
import { seesEveryoneByDefault } from '$lib/server/users';
import type { Actions, PageServerLoad } from './$types';

// One question at a time: every window that closed short and still needs an answer.
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const requested = url.searchParams.get('who');
	const who = requested === 'mine' || requested === 'all' ? requested : seesEveryoneByDefault(user) ? 'all' : 'mine';

	const waiting = (await listBoard(await getDb(), user.id, who === 'mine' ? user.id : null)).cards
		.filter((c) => c.needsOutcome)
		// Oldest closed first: those have waited longest.
		.sort((a, b) => (b.daysSinceClose ?? 0) - (a.daysSinceClose ?? 0));

	return {
		who,
		waiting,
		mayAnswerAll: user.role === 'admin',
		requestId: randomUUID(),
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	default: async ({ locals, request }) => outcomeAction(await getDb(), locals.user!, request)
};
