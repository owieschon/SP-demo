import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getPartManufacturing } from '$lib/server/manufacturing/read';
import type { PageServerLoad } from './$types';

// One part: what it is made of, what it truly costs, how long it truly takes,
// where it is used, and which lots of it exist. ?qty=25 asks the promise
// question for a quantity, because "can we ship 25 by Friday" is the
// question that actually gets asked.
export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = locals.user!;
	const db = await getDb();

	const asked = Number(url.searchParams.get('qty'));
	const quantity = Number.isFinite(asked) && asked > 0 && asked <= 100000 ? Math.floor(asked) : 1;

	// Awaited, because a part number that does not exist is a 404 and not a
	// broken panel.
	const part = await getPartManufacturing(db, user.id, params.item, quantity);
	if (!part) error(404, `Part ${params.item} does not exist.`);

	return { part, quantity, year: new Date().getFullYear() };
};
