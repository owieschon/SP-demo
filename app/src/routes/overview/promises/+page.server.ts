/*
  /overview/promises: the windows behind the kept, pushed and broken figures.

  ?outcome=kept|pushed|broken narrows the list; ?customer=NNNN narrows it to
  one account, which is the "whose last three windows slipped" question. Each
  row links to the commitment, whose own page lists the invoice lines that
  counted towards it, so the chain ends on the ledger as it should.
*/
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { links } from '$lib/server/overview/links';
import { readPromiseDetail } from '$lib/server/overview/promises';
import type { PageServerLoad } from './$types';

const OUTCOMES = ['kept', 'pushed', 'broken'] as const;
type Outcome = (typeof OUTCOMES)[number];

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();

	const asked = url.searchParams.get('outcome');
	if (asked !== null && !OUTCOMES.includes(asked as Outcome)) {
		error(400, 'An outcome is kept, pushed or broken.');
	}
	const customer = url.searchParams.get('customer');
	if (customer !== null && customer.length > 40) error(400, 'That is not an account number.');

	return {
		year: new Date().getFullYear(),
		nav: {
			overview: links.overview(),
			all: links.promises(),
			kept: links.promises({ outcome: 'kept' }),
			pushed: links.promises({ outcome: 'pushed' }),
			broken: links.promises({ outcome: 'broken' })
		},
		promises: readPromiseDetail(db, user.id, {
			outcome: (asked as Outcome | null) ?? null,
			customer
		})
	};
};
