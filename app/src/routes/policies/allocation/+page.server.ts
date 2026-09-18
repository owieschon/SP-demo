// /policies/allocation: what the allocation priority policy actually does.
//
// Before this engine, stock went to the oldest ship date, per part, and there
// was nowhere to say otherwise. The priority list is now data
// (fulfilment.allocation_priority), and this page is the proof: the lines
// that get a different quantity than plain ship-date order would have given
// them, with the reason each one moved.
//
// Read only, and it reads nl.allocation_plan rather than
// nl.open_line_allocation, which is left exactly as it was for the nine other
// places that read it.
import { getDb } from '$lib/server/db';
import { allocationMoves, allocationSummary, listPolicies } from '$lib/server/policy/read';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const db = await getDb();

	return {
		// Not awaited: the page arrives first and the tables stream in.
		summary: allocationSummary(db, user.id),
		moves: allocationMoves(db, user.id),
		priorities: listPolicies(db, user.id, 'fulfilment.allocation_priority')
	};
};
