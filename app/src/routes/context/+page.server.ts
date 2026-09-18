import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/db';
import { buildAction, exploreAction } from '$lib/server/context/forms';
import { readCoverage, readCoveredSubjects, readGaps, readSources } from '$lib/server/context/read';
import { policyEnginePresent } from '$lib/server/context/dictionary';
import type { Actions, PageServerLoad } from './$types';

/**
 * Coverage: what we know, what has gone stale, what is missing.
 *
 * The gap lists are loaded for the worst eight rows only. Loading them for
 * every attribute would be a query per row for detail nobody has opened yet,
 * and the eight at the top are the ones a person will actually press.
 */
export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	const db = await getDb();

	const coverage = readCoverage(db, user.id, 200).then(async (rows) => {
		const gaps: Record<string, import('$lib/context/types').CoverageGap[]> = {};
		for (const row of rows.slice(0, 8)) {
			gaps[`${row.subject_kind}|${row.attribute}`] = await readGaps(
				db,
				user.id,
				row.subject_kind,
				row.attribute,
				8
			);
		}
		return { rows, gaps };
	});

	return {
		// Awaited: the page's own heading counts come from it and it is one query.
		sources: await readSources(db, user.id),
		policyEngine: await db.asUser(user.id, (tx) => policyEnginePresent(tx)),
		// Not awaited: skeleton rows until it arrives.
		coverage,
		covered: readCoveredSubjects(db, user.id, 10),
		requestId: randomUUID()
	};
};

export const actions: Actions = {
	explore: async ({ locals, request }) => exploreAction(await getDb(), locals.user!, request),
	build: async ({ locals, request }) => buildAction(await getDb(), locals.user!, request)
};
