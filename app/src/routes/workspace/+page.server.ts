import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/db';
import { decideAction } from '$lib/server/workspace/forms';
import { listDecisions, listQueue, queueSources } from '$lib/server/workspace/queue';
import { QUEUE_SOURCES, type QueueSource } from '$lib/workspace/types';
import type { Actions, PageServerLoad } from './$types';

/** A source name from the address bar, or null for every source. */
function sourceParam(value: string | null): QueueSource | null {
	return QUEUE_SOURCES.includes(value as QueueSource) ? (value as QueueSource) : null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();
	const source = sourceParam(url.searchParams.get('source'));
	const account = url.searchParams.get('account');

	return {
		// Which of the four sources this database has. Awaited, because the
		// page's filter bar is drawn from it.
		sources: await queueSources(db, user.id),
		// Not awaited: the page shows skeleton rows until these arrive.
		items: listQueue(db, user, { source, subjectNo: account }),
		decisions: listDecisions(db, user.id),
		filters: { source, account },
		// One id per page load. Each row makes its own id from it, so sending
		// the same row's form twice sends the same id and the database writes
		// once.
		requestId: randomUUID()
	};
};

export const actions: Actions = {
	decide: async ({ locals, request }) => decideAction(await getDb(), locals.user!, request)
};
