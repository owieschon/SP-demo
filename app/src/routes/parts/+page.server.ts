import { getDb } from '$lib/server/db';
import { listFamilies, listParts, readPartListQuery } from '$lib/server/catalog/parts';
import { holdsWholeDimension, readWho } from '$lib/server/roles/scope';
import { scopeValues } from '$lib/server/roles/policy';
import type { PageServerLoad } from './$types';

// The parts list. The filters live in the URL, so a filtered list can be
// shared and the browser's back button works.
export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	const query = readPartListQuery(url.searchParams);

	/*
	  "Mine" on the catalog means the part families this person plans. A
	  planner opens on their own families instead of the whole catalog; anybody
	  with no part_family scope has no narrower view, so they open on all of it
	  and the switch is not drawn.

	  It is done by defaulting the family filter the list already has, rather
	  than by teaching the catalog query about scope: one family at a time is
	  what the filter bar offers, so "mine" picks the first of them and leaves
	  the rest a click away. A planner with several families sees that plainly.
	*/
	const holdsAll = await holdsWholeDimension(db, user.id, 'part_family');
	const mine = holdsAll ? [] : await scopeValues(db, user.id, 'part_family');
	const who = readWho(url.searchParams, { holdsAll: holdsAll || mine.length === 0 });
	const scoped =
		who === 'mine' && query.family === null ? { ...query, family: mine[0] ?? null } : query;

	return {
		query: scoped,
		who: mine.length === 0 ? undefined : who,
		myFamilies: mine,
		// Neither is awaited: the page and its filter bar arrive first, the
		// rows and the family list stream in behind them.
		parts: listParts(db, user.id, scoped),
		families: listFamilies(db, user.id),
		year: new Date().getFullYear()
	};
};
