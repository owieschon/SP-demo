/*
  /overview/coverage: what nobody is answerable for.

  Without ?kind it is the three counts and the authority gap. With
  ?kind=account|part_family|mailbox it is the list, biggest first, each row
  reaching the record where somebody would be assigned.

  The whole page is feature detected: nl.responsibility_gaps reads the roles
  model, and on a database without it the reader returns null and this page
  404s rather than showing four zeros, which would read as good news.
*/
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { links } from '$lib/server/overview/links';
import { readCoverage } from '$lib/server/overview/risk';
import type { PageServerLoad } from './$types';

const KINDS = ['account', 'part_family', 'mailbox'] as const;
type Kind = (typeof KINDS)[number];

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();

	const asked = url.searchParams.get('kind');
	if (asked !== null && !KINDS.includes(asked as Kind)) {
		error(400, 'A kind is account, part_family or mailbox.');
	}

	// Awaited, because whether this page exists at all depends on the answer.
	const coverage = await readCoverage(db, user.id, (asked as Kind | null) ?? null);
	if (!coverage) error(404, 'This database has no role model, so it cannot say who is answerable.');

	return {
		year: new Date().getFullYear(),
		nav: { overview: links.overview(), all: links.coverage() },
		coverage
	};
};
