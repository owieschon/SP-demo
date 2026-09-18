/*
  /overview/risk/[topic]: the one risk figure with no screen of its own.

  Three of the four risk figures link to a list that already exists, filtered:
  the open order forecast for coverage gaps, the approval queue for unanswered
  proposals, the accounts list for accounts gone quiet. Late purchase and
  production orders had nowhere to land, so they land here.
*/
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { links, RISK_TOPICS, type RiskTopic } from '$lib/server/overview/links';
import { readLateSupply } from '$lib/server/overview/risk';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	if (!RISK_TOPICS.includes(params.topic as RiskTopic)) error(404, 'No such risk topic.');

	const db = await getDb();
	return {
		year: new Date().getFullYear(),
		nav: { overview: links.overview(), forecast: links.lateSupply() },
		lateSupply: readLateSupply(db, user.id)
	};
};
