import { getDb } from '$lib/server/db';
import { listAccounts, listFilterOptions, readFilters, PAGE_SIZE } from '$lib/server/accounts/list';
import { seesEveryoneByDefault } from '$lib/server/users';
import type { PageServerLoad } from './$types';

// The accounts list. Every filter lives in the URL, so a filtered list can be
// bookmarked and the browser's back button works.
export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	const filters = readFilters(url.searchParams, seesEveryoneByDefault(user) ? 'all' : 'mine');

	return {
		filters,
		// The layout's Mine / Everyone switch reads this.
		who: filters.who,
		pageSize: PAGE_SIZE,
		options: await listFilterOptions(db, user.id),
		// Not awaited on purpose: the page and its filters arrive first, the
		// rows stream in behind them.
		accounts: listAccounts(db, user.id, filters),
		year: new Date().getFullYear()
	};
};
