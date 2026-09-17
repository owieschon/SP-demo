import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listConversations } from '$lib/server/assistant/conversation';
import { askAction, askPageData, lockAction, unlockAction } from '$lib/server/assistant/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const page = await askPageData(event);
	return {
		...page,
		// Not awaited: the page arrives now and the list streams in behind it.
		conversations: listConversations(await getDb(), event.locals.user!.id)
	};
};

export const actions: Actions = {
	// A question with no conversation starts one, then opens it.
	ask: async (event) => {
		const result = await askAction(event);
		if ('answered' in result) redirect(303, `/ask/${result.conversationId}`);
		return result;
	},
	unlock: (event) => unlockAction(event),
	lock: (event) => lockAction(event)
};
