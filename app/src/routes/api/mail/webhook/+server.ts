// The mail provider's webhook. It answers one question: has something
// arrived? Everything else in the payload is ignored on purpose.
//
// The body is not trusted. A forged POST with a made-up message in it cannot
// put anything in the inbox, because the handler throws the payload away and
// polls the provider instead. What the secret buys is that a stranger cannot
// make this server do work on demand.
//
// AgentMail signs its webhooks with Svix over the raw body. This endpoint
// checks a shared secret, which is weaker, and it is enough here because the
// body is discarded. See docs/desk-agent.md.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { recordPollTrails } from '$lib/server/agentruns/desk';
import { chooseClient, listMailboxes, pollAll } from '$lib/server/desk/poll';
import { accessStatus, checkWebhookAccess } from '$lib/server/desk/webhook';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const access = checkWebhookAccess(
		{
			authorization: request.headers.get('authorization'),
			secret: request.headers.get('x-mail-webhook-secret')
		},
		env.MAIL_WEBHOOK_SECRET
	);
	if (access !== 'ok') {
		return json(
			{
				error:
					access === 'not_configured'
						? 'MAIL_WEBHOOK_SECRET is not set, so the webhook is off.'
						: 'Not allowed.'
			},
			{ status: accessStatus(access) }
		);
	}

	// Read and drop the body. Reading it keeps the connection tidy; dropping
	// it is the security property.
	await request.text().catch(() => '');

	const db = await getDb();
	const mailboxes = await listMailboxes(db);
	if (mailboxes.length === 0) {
		return json({ polled: 0, note: 'No desks are set up on this database.' });
	}
	const client = await chooseClient(db, env, mailboxes, mailboxes[0].reviewerId);
	const summaries = await pollAll(db, { client, mode: 'mock' });
	// The run trail, from the record each run kept of itself.
	await recordPollTrails(db, mailboxes, summaries, (address) => `The provider said mail had arrived at ${address}`);

	return json({
		note: 'The payload was ignored; the provider was polled instead.',
		delivered: summaries.reduce((sum, summary) => sum + summary.delivered, 0),
		duplicates: summaries.reduce((sum, summary) => sum + summary.duplicates, 0),
		worked: summaries.reduce((sum, summary) => sum + summary.runs.length, 0)
	});
};
