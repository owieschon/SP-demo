// The daily automation run, called by Vercel Cron (see app/vercel.json).
// It runs every switched-on rule as its owner and answers with a summary.
// Nobody is signed in here: the shared CRON_SECRET is the only way in.
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { checkCronAccess } from '$lib/server/automation/cron';
import { runScheduled } from '$lib/server/automation/rules';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	const access = checkCronAccess(request.headers.get('authorization'), env.CRON_SECRET);
	if (access === 'not_configured') {
		return json({ error: 'CRON_SECRET is not set, so scheduled runs are off.' }, { status: 503 });
	}
	if (access === 'denied') {
		return json({ error: 'Not allowed.' }, { status: 401 });
	}

	const summary = await runScheduled(await getDb());
	return json(summary);
};
