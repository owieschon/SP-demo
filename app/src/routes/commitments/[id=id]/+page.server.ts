import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getCommitment } from '$lib/server/commitments';
import { getCommitmentDepth } from '$lib/server/commitments/depth';
import { listBuyerChoices } from '$lib/server/accounts/account';
import { addBuyerAction, setBuyerAction } from '$lib/server/accounts/forms';
import { confidenceAction, outcomeAction } from '$lib/server/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const db = await getDb();
	const commitment = await getCommitment(db, locals.user!.id, Number(params.id));
	if (!commitment) error(404, `Commitment C-${params.id} does not exist.`);
	return {
		commitment,
		// The people at this customer's family, for naming the buyer. One
		// indexed query, so it is awaited with the commitment rather than
		// streamed: the buyer sits in the header, above everything else.
		buyerChoices: await listBuyerChoices(db, locals.user!.id, commitment.id),
		// The history behind it: quote versions, conditions, the outcome trail
		// and the open next steps. Handed over as a promise so the page arrives
		// with its figures and this streams in behind them.
		depth: getCommitmentDepth(db, locals.user!.id, commitment.id),
		// Fresh ids for each form on this page load. Submitting the same form
		// twice sends the same id, so the database writes once.
		requestIds: {
			outcome: randomUUID(),
			confidence: randomUUID(),
			setBuyer: randomUUID(),
			addBuyer: randomUUID()
		},
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	outcome: async ({ locals, request }) => outcomeAction(await getDb(), locals.user!, request),
	confidence: async ({ locals, request }) => confidenceAction(await getDb(), locals.user!, request),
	// Workflow A meets the account book: name the buyer, or add them first.
	buyer: async ({ locals, request }) => setBuyerAction(await getDb(), locals.user!, request),
	addBuyer: async ({ locals, request }) => addBuyerAction(await getDb(), locals.user!, request)
};
