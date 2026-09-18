import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/db';
import {
	levelAction,
	pauseAction,
	sampleAction,
	undoFormAction
} from '$lib/server/harness/forms';
import { readBoard, readPauses } from '$lib/server/harness/ladder';
import { policyStatus, POLICY_MAP } from '$lib/server/harness/policy';
import {
	listDegradations,
	listLevelChanges,
	listRefusals,
	listRuns,
	listSampleQueue,
	listUndoable,
	runSources
} from '$lib/server/harness/runs';
import { AGENT_SCOPES } from '$lib/server/harness/scope';
import type { Actions, PageServerLoad } from './$types';

/** Which agent's runs to show, from the address bar. */
function agentParam(value: string | null): string | null {
	return AGENT_SCOPES.some((s) => s.id === value) ? value : null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();
	const agent = agentParam(url.searchParams.get('agent'));
	const view = url.searchParams.get('view') === 'scope' ? 'scope' : 'trust';

	return {
		// Awaited: the page's three questions are the page.
		board: await readBoard(db, user.id),
		pauses: await readPauses(db, user.id),
		sources: await runSources(db, user.id),
		policy: await policyStatus(db, user.id),
		policyMap: POLICY_MAP,
		scopes: AGENT_SCOPES,
		isAdmin: user.role === 'admin',
		filters: { agent, view },
		// Not awaited: the feed and the lists stream in behind skeletons.
		runs: listRuns(db, user.id, { agent, limit: 40 }),
		refusals: listRefusals(db, user.id, 12),
		degradations: listDegradations(db, user.id, 8),
		undoable: listUndoable(db, user.id, 10),
		sampleQueue: listSampleQueue(db, user.id, 10),
		changes: listLevelChanges(db, user.id, 10),
		// One id per page load. Each form makes its own from it, so sending the
		// same form twice writes once.
		requestId: randomUUID()
	};
};

export const actions: Actions = {
	level: async ({ locals, request }) => levelAction(await getDb(), locals.user!.id, await request.formData()),
	pause: async ({ locals, request }) => pauseAction(await getDb(), locals.user!.id, await request.formData()),
	undo: async ({ locals, request }) => undoFormAction(await getDb(), locals.user!.id, await request.formData()),
	sample: async ({ locals, request }) => sampleAction(await getDb(), locals.user!.id, await request.formData())
};
