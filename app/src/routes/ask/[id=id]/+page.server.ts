import { getDb } from '$lib/server/db';
import { getConversation } from '$lib/server/assistant/conversation';
import { askAction, askPageData, decideAction, lockAction, unlockAction } from '$lib/server/assistant/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async (event) => {
	const page = await askPageData(event);
	const db = await getDb();
	return {
		...page,
		id: Number(event.params.id),
		// Not awaited: the shell and the question box arrive first, the thread
		// streams in behind them.
		conversation: getConversation(db, event.locals.user!.id, Number(event.params.id))
	};
};

export const actions: Actions = {
	// Another question in this conversation. The page reloads itself, so the
	// new answer simply appears at the bottom.
	ask: async (event) => {
		const result = await askAction(event);
		return 'answered' in result ? { asked: true } : result;
	},
	decide: (event) => decideAction(event),
	unlock: (event) => unlockAction(event),
	lock: (event) => lockAction(event)
};
