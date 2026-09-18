import { getDb } from '$lib/server/db';
import { getManufacturingBoard } from '$lib/server/manufacturing/read';
import type { PageServerLoad } from './$types';

// The plant: which cell is the bottleneck in hours, which orders are short
// and what is actually missing underneath them, and which shipments cannot go
// out because their paperwork is incomplete.
export const load: PageServerLoad = async ({ locals }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	return {
		// Not awaited: the page arrives first and the board streams in.
		board: getManufacturingBoard(db, user.id),
		year: new Date().getFullYear()
	};
};
