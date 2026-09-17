import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { atpInput, availableToPromise, getForecast, readFilters } from '$lib/server/supply/forecast';
import type { Actions, PageServerLoad } from './$types';

// The late-order forecast: which customer orders will ship late, by how many
// days, because of which incoming supply order, and who to call.
//
// The filters live in the query string, so every view has its own URL.
export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const filters = readFilters(url);
	const db = await getDb();

	return {
		filters,
		// Not awaited on purpose: SvelteKit sends the page first and streams the
		// projection when it is ready, so the page shows skeleton rows instead
		// of a blank wait.
		forecast: getForecast(db, user.id, filters, user.id),
		// The year the server thinks it is, so dates in this year drop the year.
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	// "Can we ship it?": a read behind a form. Nothing is written, so there is
	// no request id and no optimistic lock here.
	canWeShip: async ({ locals, request }) => {
		const parsed = atpInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return fail(400, {
				message: 'A part number, a quantity of at least one and a date are needed.',
				answer: null
			});
		}
		try {
			const answer = await availableToPromise(await getDb(), locals.user!.id, parsed.data);
			if (!answer) {
				return fail(404, {
					message: `Part ${parsed.data.itemNo.toUpperCase()} is not in the item list.`,
					answer: null
				});
			}
			return { message: null, answer };
		} catch (err) {
			const refusal = toAppError(err);
			if (!refusal) throw err;
			return fail(refusal.status, { message: refusal.message, answer: null });
		}
	}
};
