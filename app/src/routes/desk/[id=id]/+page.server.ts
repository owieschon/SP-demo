// One desk item: how it arrived, what the agent read out of it, the trail of
// what it did, and the reply it drafted.
//
// The quote request that was read out of the message is loaded here as
// evidence: the lines, where each one sat in the file it came from, and what
// the deterministic validation could and could not settle. Row-level
// security decides whether this person may see it at all (a quote request
// belongs to whoever it was made for), so it is null rather than an error
// when they may not.
import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { getTrailsOn } from '$lib/server/agentruns/read';
import { readItemSource } from '$lib/server/agentruns/desk';
import { approveAction, rejectAction, retryAction } from '$lib/server/desk/forms';
import { chooseClient, listMailboxes } from '$lib/server/desk/poll';
import { getMessage } from '$lib/server/desk/read';
import { parseAllowlist } from '$lib/server/desk/send';
import { getDraft as getQuoteRequest } from '$lib/server/rfq/drafts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	const db = await getDb();
	const allowlist = parseAllowlist(env.MAIL_ALLOWLIST);
	const id = Number(params.id);
	const detail = await getMessage(db, user.id, id, allowlist);
	if (!detail) {
		error(404, `Desk item ${params.id} does not exist.`);
	}

	const requestId = detail.message.rfqDraftId;
	return {
		detail,
		item: (await readItemSource(db, user.id, id)) ?? { source: 'mail' as const, enteredByName: null },
		// The trail. Awaited: it is the reason a person is on this page.
		trails: await getTrailsOn(db, user.id, { kind: 'mail_message', id }, 3),
		request: requestId === null ? null : await getQuoteRequest(db, user.id, requestId),
		allowlist: { empty: allowlist.empty, describe: allowlist.describe },
		provider: { live: Boolean(env.AGENTMAIL_API_KEY), label: env.AGENTMAIL_API_KEY ? 'AgentMail' : 'scripted demo mailbox' },
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
	approve: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return approveAction(options.db, locals.user!.id, await request.formData(), { ...options, send: true });
	},

	retry: async ({ locals, request }) => {
		const options = await sendOptions(locals.user!.id);
		return retryAction(options.db, locals.user!.id, await request.formData(), options);
	},

	reject: async ({ locals, request }) => {
		return rejectAction(await getDb(), locals.user!.id, await request.formData());
	}
};
