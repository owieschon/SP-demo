import { getDb } from '$lib/server/db';
import { listRules } from '$lib/server/automation/rules';
import type { PageServerLoad } from './$types';

// Every rule the team has set up, as a sentence each.
export const load: PageServerLoad = async ({ locals }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	return {
		// Not awaited on purpose: the page arrives first and the list streams
		// in, with skeleton rows meanwhile.
		rules: listRules(await getDb(), user.id)
	};
};
