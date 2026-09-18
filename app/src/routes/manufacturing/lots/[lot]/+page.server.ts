import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getLotTrace } from '$lib/server/manufacturing/read';
import type { PageServerLoad } from './$types';

// One lot, traced both ways: down to the heat it came from, and up to the
// customers who received something made from it. The second one is the recall
// question.
export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	// A lot number is letters, digits, dots and dashes, like a part number.
	if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,29}$/.test(params.lot)) {
		error(404, `Lot ${params.lot} does not exist.`);
	}
	const trace = await getLotTrace(await getDb(), user.id, params.lot);
	if (!trace) error(404, `Lot ${params.lot} does not exist.`);
	return { trace, year: new Date().getFullYear() };
};
