import { getDb } from '$lib/server/db';
import type { PageServerLoad } from './$types';

// Temporary home page: proves the app reaches the database. Replaced by the
// commitments board in the next milestone.
export const load: PageServerLoad = async () => {
	const db = await getDb();
	const statuses = await db.asVisitor((tx) =>
		tx.sql<{ status: string; commitments: number; needs_outcome: number }>`
			select status,
			       count(*)::int as commitments,
			       count(*) filter (where needs_outcome)::int as needs_outcome
			from nl.commitment_progress
			group by status
			order by array_position(array['promised', 'quoted', 'delivering', 'kept', 'pushed', 'broken'], status)`
	);
	return { database: db.kind, statuses };
};
