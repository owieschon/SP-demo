import { getDb } from '$lib/server/db';
import { cleanQuery, searchAll } from '$lib/server/catalog/search';
import type { PageServerLoad } from './$types';

// One results page for the top bar's search box: accounts, parts and
// vendors, ten of each.
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const q = cleanQuery(url.searchParams.get('q'));
	if (!q) return { q, results: null };

	const db = await getDb();
	return {
		q,
		// Not awaited: the page and the box arrive first, the groups stream in.
		results: searchAll(db, user.id, q)
	};
};
