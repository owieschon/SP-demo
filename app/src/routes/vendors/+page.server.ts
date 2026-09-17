import { getDb } from '$lib/server/db';
import { listVendors } from '$lib/server/catalog/vendors';
import type { PageServerLoad } from './$types';

// The vendor list. The vendor master is long and mostly history, so the
// default view is the vendors that actually supply something; ?all=1 shows
// every one.
export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();
	const q = url.searchParams.get('q') ?? '';
	const all = url.searchParams.get('all') === '1';

	return {
		query: { q, all },
		// Not awaited: the page arrives first, the rows stream in.
		vendors: listVendors(db, user.id, { q, all })
	};
};
