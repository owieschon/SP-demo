import { error, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getPart, getPartDemand, getPartSales, getSiblings, resolveItemNo } from '$lib/server/catalog/parts';
import { partHref } from '$lib/components/catalog/types';
import type { PageServerLoad } from './$types';

// One part. The header is awaited (it decides between a page and a 404);
// the sales, the demand and the siblings stream in after it.
export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	const db = await getDb();

	// Item numbers are upper case in the ERP. A link typed in lower case
	// still finds the part, and the browser ends up on the real number.
	const itemNo = await resolveItemNo(db, user.id, params.item);
	if (!itemNo) error(404, `Part ${params.item} is not in the item master.`);
	if (itemNo !== params.item) redirect(308, partHref(itemNo));

	const part = await getPart(db, user.id, itemNo);
	if (!part) error(404, `Part ${itemNo} is not in the item master.`);

	return {
		part,
		sales: getPartSales(db, user.id, itemNo),
		demand: getPartDemand(db, user.id, itemNo),
		siblings: getSiblings(db, user.id, itemNo),
		year: new Date().getFullYear()
	};
};
