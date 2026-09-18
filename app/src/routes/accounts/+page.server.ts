import { getDb } from '$lib/server/db';
import { listAccounts, listFilterOptions, readFilters, PAGE_SIZE } from '$lib/server/accounts/list';
import { accountCounts, holdsWholeDimension } from '$lib/server/roles/scope';
import type { PageServerLoad } from './$types';

// The accounts list. Every filter lives in the URL, so a filtered list can be
// bookmarked and the browser's back button works.
export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();

	/*
	  The default used to be "an account manager sees their own, everybody else
	  sees all", read off the role column. It is now read off the person's
	  actual scope: somebody who holds every account has no narrower view to
	  offer, so their list opens on everyone and the switch has nothing to do.
	*/
	const holdsAll = await holdsWholeDimension(db, user.id, 'account');
	const filters = readFilters(url.searchParams, holdsAll ? 'all' : 'mine');

	return {
		filters,
		// The layout's Mine / Everyone switch reads these two.
		who: holdsAll ? ('all' as const) : filters.who,
		whoCounts: holdsAll ? null : await accountCounts(db, user.id),
		whoNoun: 'accounts',
		pageSize: PAGE_SIZE,
		options: await listFilterOptions(db, user.id),
		// Not awaited on purpose: the page and its filters arrive first, the
		// rows stream in behind them.
		accounts: listAccounts(db, user.id, filters),
		year: new Date().getFullYear()
	};
};
