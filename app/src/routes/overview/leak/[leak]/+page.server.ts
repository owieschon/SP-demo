/*
  /overview/leak/[leak]: one named leak, its segments, and the evidence.

  Without ?key it is the segment list: the customers or parts behind the
  figure on the overview, biggest first, each linking to its own record.
  With ?key it also loads the rows the figure is a sum over, which is where
  the chain stops because there is nothing under an invoice line.
*/
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { disclosureFor } from '$lib/server/overview/disclosure';
import { links } from '$lib/server/overview/links';
import { isLeak, readLeak } from '$lib/server/overview/money';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	const user = locals.user!;
	if (!isLeak(params.leak)) error(404, 'No such leak.');

	const db = await getDb();
	const key = url.searchParams.get('key');
	if (key !== null && key.length > 100) error(400, 'That key is too long to be one of ours.');

	const disclosure = await disclosureFor(db, user.id);
	return {
		year: new Date().getFullYear(),
		nav: { overview: links.overview() },
		// Not awaited: the segment list is the slowest thing here.
		leak: readLeak(db, user.id, params.leak, key, disclosure)
	};
};
