import { getDb } from '$lib/server/db';
import { policyFor } from '$lib/server/roles/policy';
import { railFor } from '$lib/roles/rail';
import type { LayoutServerLoad } from './$types';

/*
  Every page gets the signed-in user for the header, and the sections their
  rail should show.

  The rail is derived from what they may decide and what is theirs, so it is
  worked out here rather than being a fixed list in the layout's markup. It
  hides the entry and nothing else: every page stays reachable by its URL and
  by search (see $lib/roles/rail.ts).
*/
export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) return { user: null, rail: [] as string[] };

	const policy = await policyFor(await getDb(), locals.user.id);
	return { user: locals.user, rail: railFor(policy) };
};
