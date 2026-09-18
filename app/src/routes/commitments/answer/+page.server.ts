import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/db';
import { listBoard } from '$lib/server/commitments';
import { outcomeAction } from '$lib/server/forms';
import { holdsWholeDimension, readWho } from '$lib/server/roles/scope';
import type { Actions, PageServerLoad } from './$types';

// One question at a time: every window that closed short and still needs an answer.
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();

	// Same default as the board: read off scope, not off a role name.
	const holdsAll = await holdsWholeDimension(db, user.id, 'account');
	const who = readWho(url.searchParams, { holdsAll });

	const waiting = (await listBoard(db, user.id, who === 'mine' ? user.id : null)).cards
		.filter((c) => c.needsOutcome)
		// Oldest closed first: those have waited longest.
		.sort((a, b) => (b.daysSinceClose ?? 0) - (a.daysSinceClose ?? 0));

	return {
		who,
		waiting,
		mayAnswerAll: holdsAll,
		requestId: randomUUID(),
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	default: async ({ locals, request }) => outcomeAction(await getDb(), locals.user!, request)
};
