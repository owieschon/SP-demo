import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	getAccountHeader,
	getAccountNumbers,
	getContacts,
	getDeals,
	getNextSteps,
	getOrders,
	getTimeline
} from '$lib/server/accounts/account';
import { getAccountRecord } from '$lib/server/commitments/depth';
import {
	addContactAction,
	addNextStepAction,
	completeNextStepAction,
	logActivityAction,
	updateContactAction
} from '$lib/server/accounts/forms';
import type { Actions, PageServerLoad } from './$types';

// One account. The header is awaited, because the page is about it; every
// other section is handed over as a promise and streams in behind the page
// (see the {#await} blocks in +page.svelte).
export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	const db = await getDb();
	const customerNo = params.customer;

	const account = await getAccountHeader(db, user.id, customerNo);
	if (!account) error(404, `Account ${customerNo} does not exist.`);

	return {
		account,
		numbers: getAccountNumbers(db, user.id, customerNo),
		contacts: getContacts(db, user.id, customerNo),
		timeline: getTimeline(db, user.id, customerNo),
		steps: getNextSteps(db, user.id, customerNo),
		deals: getDeals(db, user.id, customerNo),
		// How their settled windows ended and how their quotes went: the thing
		// to read before agreeing a date with them.
		record: getAccountRecord(db, user.id, customerNo),
		orders: getOrders(db, user.id, customerNo),
		// One fresh id per form on this page load. Sending the same form twice
		// sends the same id, so the database writes once. The per-row forms
		// (edit a contact, complete a step) add the row's id to these.
		requestIds: {
			addContact: randomUUID(),
			editContact: randomUUID(),
			activity: randomUUID(),
			addStep: randomUUID(),
			completeStep: randomUUID()
		},
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	addContact: async ({ locals, request }) => addContactAction(await getDb(), locals.user!, request),
	editContact: async ({ locals, request }) => updateContactAction(await getDb(), locals.user!, request),
	activity: async ({ locals, request }) => logActivityAction(await getDb(), locals.user!, request),
	addStep: async ({ locals, request }) => addNextStepAction(await getDb(), locals.user!, request),
	completeStep: async ({ locals, request }) => completeNextStepAction(await getDb(), locals.user!, request)
};
