/*
  /overview/revenue: the second and third links in the money chain.

  No parameters: every month, with the same month a year earlier beside it.
  ?month=YYYY-MM: that month's accounts, biggest first.
  &customer=NNNN: that account's invoice lines in that month, which is the
  evidence the revenue figure is a sum over.

  One route rather than three, because the three are the same question at
  three depths and a person moves between them without meaning to navigate.
*/
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { disclosureFor } from '$lib/server/overview/disclosure';
import { links } from '$lib/server/overview/links';
import { readRevenue } from '$lib/server/overview/money';
import type { PageServerLoad } from './$types';

/** YYYY-MM and nothing else, so nothing unparsed reaches a date cast. */
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();

	const month = url.searchParams.get('month');
	if (month !== null && !MONTH.test(month)) {
		error(400, 'A month looks like 2026-08.');
	}
	const customer = url.searchParams.get('customer');
	// An account only makes sense inside a month.
	if (customer !== null && month === null) {
		error(400, 'Ask for an account inside a month.');
	}

	const disclosure = await disclosureFor(db, user.id);
	return {
		year: new Date().getFullYear(),
		nav: { overview: links.overview() },
		// Not awaited: the heading and the breadcrumb arrive first.
		revenue: readRevenue(db, user.id, { month, customer }, disclosure)
	};
};
