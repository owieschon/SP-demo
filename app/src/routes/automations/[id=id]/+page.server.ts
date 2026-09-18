import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { runAction, saveAction, testAction } from '$lib/server/automation/actions';
import { getRule, listPeople } from '$lib/server/automation/rules';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = locals.user!;
	const db = await getDb();
	const [detail, people] = await Promise.all([getRule(db, user.id, Number(params.id)), listPeople(db, user.id)]);
	if (!detail) error(404, `Rule ${params.id} does not exist.`);
	return {
		detail,
		people,
		// Fresh for each page load: sending the same form twice saves once.
		requestId: randomUUID(),
		// Set when the rule was just created (see actions.ts).
		justSaved: url.searchParams.has('saved'),
		// So a due date in another year says which one.
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	test: async ({ locals, request }) => testAction(await getDb(), locals.user!, request),
	save: async ({ locals, request }) => saveAction(await getDb(), locals.user!, request),
	run: async ({ locals, request }) => runAction(await getDb(), locals.user!, request)
};
