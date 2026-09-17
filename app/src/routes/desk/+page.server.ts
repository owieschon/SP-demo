// The order desk: the inbox on one side, the review queue on the other.
//
// Reading is streamed (the lists come back as promises the page awaits), and
// every action is a form post: check mail, approve, edit and approve, reject,
// try sending again.
import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { approveAction, rejectAction, retryAction } from '$lib/server/desk/forms';
import { chooseClient, listMailboxes, pollAll } from '$lib/server/desk/poll';
import { listMailboxViews, listMessages, listQueue } from '$lib/server/desk/read';
import { parseAllowlist } from '$lib/server/desk/send';
import type { Actions, PageServerLoad } from './$types';

/** The mailbox filter in the query string, when it names one this person can see. */
function mailboxFilter(url: URL): number | null {
	const value = Number(url.searchParams.get('desk'));
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();
	const allowlist = parseAllowlist(env.MAIL_ALLOWLIST);
	const only = mailboxFilter(url);

	// The counts are awaited: the page's header is about them, and a header
	// that arrives after the lists reads as a glitch.
	const mailboxes = await listMailboxViews(db, user.id);

	return {
		mailboxes,
		only,
		// Not awaited: the page shows skeleton rows until these arrive.
		messages: listMessages(db, user.id, { mailboxId: only, limit: 40 }),
		queue: listQueue(db, user.id, allowlist, { mailboxId: only, status: 'open', limit: 40 }),
		provider: {
			live: Boolean(env.AGENTMAIL_API_KEY),
			label: env.AGENTMAIL_API_KEY ? 'AgentMail' : 'scripted demo mailbox'
		},
		allowlist: { empty: allowlist.empty, describe: allowlist.describe },
		requestId: randomUUID()
	};
};

async function sendOptions(userId: number) {
	const db = await getDb();
	const mailboxes = await listMailboxes(db);
	return {
		db,
		client: await chooseClient(db, env, mailboxes, userId),
		allowlist: parseAllowlist(env.MAIL_ALLOWLIST)
	};
}

export const actions: Actions = {
	// Fetch what has arrived and let the agent work anything nobody has worked.
	check: async ({ locals, url }) => {
		const user = locals.user!;
		const db = await getDb();
		const mailboxes = await listMailboxes(db);
		if (mailboxes.length === 0) {
			return fail(422, { message: 'No desks are set up on this database.' });
		}
		const client = await chooseClient(db, env, mailboxes, user.id);
		const summaries = await pollAll(db, { client, mode: 'mock', only: mailboxFilter(url) ?? undefined });

		const delivered = summaries.reduce((sum, s) => sum + s.delivered, 0);
		const worked = summaries.reduce((sum, s) => sum + s.runs.length, 0);
		const held = summaries.reduce(
			(sum, s) => sum + s.runs.filter((run) => run.outcome === 'needs_person').length,
			0
		);
		const problem = summaries.find((s) => s.error !== null);
		if (problem) {
			return fail(502, { message: `${problem.label}: ${problem.error}` });
		}
		return {
			message:
				worked === 0
					? delivered === 0
						? 'Nothing new, and nothing left unworked.'
						: `${delivered} new, nothing to work.`
					: `${delivered} new. The agent worked ${worked} ${worked === 1 ? 'message' : 'messages'}` +
						`${held > 0 ? `, ${held} of which need you` : ''}. Nothing has been sent.`
		};
	},

	approve: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return approveAction(options.db, locals.user!.id, await request.formData(), { ...options, send: true });
	},

	// Record the decision and stop, for a desk that would rather send in a batch.
	approveOnly: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return approveAction(options.db, locals.user!.id, await request.formData(), { ...options, send: false });
	},

	retry: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return retryAction(options.db, locals.user!.id, await request.formData(), options);
	},

	reject: async ({ locals, request }) => {
		return rejectAction(await getDb(), locals.user!.id, await request.formData());
	}
};
