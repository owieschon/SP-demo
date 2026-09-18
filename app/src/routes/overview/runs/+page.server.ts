/*
  /overview/runs: the harness run feed, with the three filters the run log
  itself takes.

  ?agent= and ?work= narrow it; ?refused=1 keeps only the runs a guardrail
  stopped; ?acted=1 keeps only the ones that acted on their own authority.
  Every row goes to the run, which is where a person sees what it read, what
  it decided and what it was refused.
*/
import { getDb } from '$lib/server/db';
import { readRunFeed } from '$lib/server/overview/agents';
import { links } from '$lib/server/overview/links';
import type { PageServerLoad } from './$types';

/** An agent or work-kind name, as nl.agent_work_kinds spells them. */
const NAME = /^[a-z_]{2,30}$/;

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();

	// Anything unexpected falls back to no filter, the way the accounts list
	// does, so a hand-edited URL never breaks the page.
	const agent = url.searchParams.get('agent');
	const work = url.searchParams.get('work');
	const filters = {
		agent: agent && NAME.test(agent) ? agent : null,
		workKind: work && NAME.test(work) ? work : null,
		refused: url.searchParams.get('refused') === '1',
		acted: url.searchParams.get('acted') === '1'
	};

	return {
		year: new Date().getFullYear(),
		nav: {
			overview: links.overview(),
			all: links.runs(),
			refused: links.runs({ agent: filters.agent, workKind: filters.workKind, refused: true }),
			acted: links.runs({ agent: filters.agent, workKind: filters.workKind, acted: true })
		},
		feed: readRunFeed(db, user.id, filters)
	};
};
