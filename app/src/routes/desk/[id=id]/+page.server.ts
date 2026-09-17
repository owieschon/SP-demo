// One message: the mail as it arrived, what the agent found, and its draft.
import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { approveAction, rejectAction, retryAction } from '$lib/server/desk/forms';
import { chooseClient, listMailboxes } from '$lib/server/desk/poll';
import { getMessage } from '$lib/server/desk/read';
import { parseAllowlist } from '$lib/server/desk/send';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	const db = await getDb();
	const allowlist = parseAllowlist(env.MAIL_ALLOWLIST);
	const detail = await getMessage(db, user.id, Number(params.id), allowlist);
	if (!detail) {
		error(404, `Message ${params.id} does not exist.`);
	}
	return {
		detail,
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
