import { getDb } from '$lib/server/db';
import { listFamilies, listParts, readPartListQuery } from '$lib/server/catalog/parts';
import type { PageServerLoad } from './$types';

// The parts list. The filters live in the URL, so a filtered list can be
// shared and the browser's back button works.
export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	const query = readPartListQuery(url.searchParams);

	return {
		query,
		// Neither is awaited: the page and its filter bar arrive first, the
		// rows and the family list stream in behind them.
		parts: listParts(db, user.id, query),
		families: listFamilies(db, user.id),
		year: new Date().getFullYear()
	};
};
