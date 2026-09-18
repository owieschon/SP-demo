import { getDb } from '$lib/server/db';
import { policyFor } from '$lib/server/roles/policy';
import { groupWork, workWaitingFor } from '$lib/server/roles/work';
import type { PageServerLoad } from './$types';

/*
  The home page is what is waiting on you.

  It used to redirect to the commitment board, which is the right page for an
  account manager and the wrong one for a buyer, a planner or anybody on the
  warehouse floor. nl.work_waiting_for answers the question properly: every
  item inside this person's scope that is waiting on an authority they hold.

  An empty answer is a success state, not an error. A morning with nothing
  waiting is the point of the agents doing the work.
*/
export const load: PageServerLoad = async ({ locals }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	const policy = await policyFor(db, user.id);

	return {
		policy,
		// Not awaited: the page shows skeleton rows until it arrives.
		work: workWaitingFor(db, user.id).then((items) => ({
			items,
			groups: groupWork(items)
		}))
	};
};
