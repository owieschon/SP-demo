import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getCommitment } from '$lib/server/commitments';
import { confidenceAction, outcomeAction } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const commitment = await getCommitment(await getDb(), locals.user!.id, Number(params.id));
	if (!commitment) error(404, `Commitment C-${params.id} does not exist.`);
	return {
		commitment,
		// Fresh ids for each form on this page load. Submitting the same form
		// twice sends the same id, so the database writes once.
		requestIds: { outcome: randomUUID(), confidence: randomUUID() },
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	outcome: async ({ locals, request }) => outcomeAction(await getDb(), locals.user!, request),
	confidence: async ({ locals, request }) => confidenceAction(await getDb(), locals.user!, request)
};
