import { randomUUID } from 'node:crypto';
import type { Rule } from '$lib/automation/catalog';
import { getDb } from '$lib/server/db';
import { saveAction, testAction } from '$lib/server/automation/actions';
import { listPeople } from '$lib/server/automation/rules';
import type { Actions, PageServerLoad } from './$types';

// A starting point that already reads well: most people begin by editing
// an example rather than a blank form.
const STARTER: Rule = {
	name: '',
	description: '',
	trigger: 'window_closed_short',
	conditions: [
		{ field: 'committed_value', op: 'gte', value: 10000 },
		{ field: 'days_since_close', op: 'gte', value: 3 }
	],
	action: {
		kind: 'next_step',
		title: 'Ask {customer} what happened to {commitment} ({shortfall} short)',
		dueInDays: 2,
		assignTo: 'record_owner'
	},
	enabled: false
};

export const load: PageServerLoad = async ({ locals }) => {
	const user = locals.user!;
	return {
		rule: STARTER,
		people: await listPeople(await getDb(), user.id),
		// Fresh for each page load: sending the same form twice saves once.
		requestId: randomUUID()
	};
};

export const actions: Actions = {
	test: async ({ locals, request }) => testAction(await getDb(), locals.user!, request),
	save: async ({ locals, request }) => saveAction(await getDb(), locals.user!, request)
};
