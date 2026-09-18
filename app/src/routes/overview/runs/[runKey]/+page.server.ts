/*
  /overview/runs/[runKey]: one run, and everything it did.

  This is the last link in the agent chain: what woke it, what it read, what
  it decided, what a guardrail refused, which autonomy level was in force when
  it read it, and whether it acted on its own. All of it comes from
  nl.agent_run_log through the harness's own reader, so this page cannot show
  a different story from the board that summarised it.

  The run key is a source name and an id joined by a colon
  ("order_desk:1204"), so it arrives percent-encoded and SvelteKit hands it
  back decoded.
*/
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { readRun } from '$lib/server/overview/agents';
import { links } from '$lib/server/overview/links';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	if (params.runKey.length > 120) error(404, 'No run with that key.');

	const db = await getDb();
	// Awaited: there is one small query and the whole page is about its answer.
	const detail = await readRun(db, user.id, params.runKey);
	if (!detail) error(404, 'No run with that key, or not one you may see.');

	return {
		year: new Date().getFullYear(),
		nav: { overview: links.overview(), runs: links.runs() },
		detail
	};
};
