// The scheduled mail check, called by Vercel Cron (see app/vercel.json).
// Nobody is signed in here: the shared CRON_SECRET is the only way in, and
// each desk's work runs as its own reviewer.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { recordPollTrails } from '$lib/server/agentruns/desk';
import { chooseClient, listMailboxes, pollAll } from '$lib/server/desk/poll';
import { accessStatus, checkMailCronAccess } from '$lib/server/desk/webhook';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	const access = checkMailCronAccess(request.headers.get('authorization'), env.CRON_SECRET);
	if (access !== 'ok') {
		return json(
			{
				error:
					access === 'not_configured'
						? 'CRON_SECRET is not set, so the scheduled mail check is off.'
						: 'Not allowed.'
			},
			{ status: accessStatus(access) }
		);
	}

	const db = await getDb();
	const mailboxes = await listMailboxes(db);
	if (mailboxes.length === 0) {
		return json({ mailboxes: 0, note: 'No desks are set up on this database.' });
	}
	// The scripted mailbox without a key, so a cron on a server with no mail
	// key still exercises the whole path instead of failing.
	const client = await chooseClient(db, env, mailboxes, mailboxes[0].reviewerId);

	const summaries = await pollAll(db, { client, mode: 'mock' });
	// The run trail, from the record each run kept of itself.
	await recordPollTrails(db, mailboxes, summaries, (address) => `The scheduled poll of ${address}`);

	return json({
		provider: client.kind,
		desks: summaries.map((summary) => ({
			mailbox: summary.mailbox,
			delivered: summary.delivered,
			duplicates: summary.duplicates,
			drafted: summary.runs.filter((run) => run.outcome === 'drafted').length,
			needsPerson: summary.runs.filter((run) => run.outcome === 'needs_person').length,
			failed: summary.runs.filter((run) => run.outcome === 'failed').length,
			error: summary.error
		}))
	});
};
