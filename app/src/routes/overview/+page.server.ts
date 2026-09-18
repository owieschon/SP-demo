/*
  /overview: the four questions a chief executive asks, and nothing else.

  1. Is the money where it should be, and where is it leaking?
  2. Are we keeping our promises?
  3. Are the agents earning trust?
  4. What is at risk right now?

  The page waits for one small query: what this reader may be shown. It
  decides whether cost and margin figures are built at all, so it cannot be
  streamed behind them. Everything else is an un-awaited promise, rendered
  with {#await} behind a skeleton the same shape, which is what /settings does
  with its health checks. A slow section therefore delays itself and nothing
  else, and the four headings are on screen before any of them has answered.
*/
import { getDb } from '$lib/server/db';
import { disclosureFor } from '$lib/server/overview/disclosure';
import { links } from '$lib/server/overview/links';
import { readMoney } from '$lib/server/overview/money';
import { readPromises } from '$lib/server/overview/promises';
import { readAgents } from '$lib/server/overview/agents';
import { readRisk } from '$lib/server/overview/risk';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();

	// One trip, and it gates what the money section is allowed to contain.
	const disclosure = await disclosureFor(db, user.id);

	return {
		firstName: user.fullName.split(' ')[0],
		year: new Date().getFullYear(),
		disclosure,
		/*
		  The page's own links. They come from the server like every other href
		  on this page, because lib/server/overview/links.ts is the one place
		  that knows an address and the markup never concatenates one.
		*/
		nav: {
			revenue: links.revenue(),
			promises: links.promises(),
			runs: links.runs()
		},
		// Not awaited. Four sections, four skeletons, four independent waits.
		money: readMoney(db, user.id, disclosure),
		promises: readPromises(db, user.id),
		agents: readAgents(db, user.id),
		risk: readRisk(db, user.id)
	};
};
