// Runs on every request before any page or endpoint.
//
// 1. Reads the signed session cookie and loads the user it names (only if
//    that user is still active).
// 2. Sends anyone who is not signed in to the sign-in page.
import { redirect, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { SESSION_COOKIE, sessionSecret, verifySession } from '$lib/server/session';
import { findActiveUser } from '$lib/server/users';

const PUBLIC_PATHS = new Set(['/signin', '/robots.txt']);

export const handle: Handle = async ({ event, resolve }) => {
	const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
	const userId = verifySession(event.cookies.get(SESSION_COOKIE), secret);
	event.locals.user = userId === null ? null : await findActiveUser(await getDb(), userId);

	const path = event.url.pathname;
	if (!event.locals.user && !PUBLIC_PATHS.has(path) && !path.startsWith('/_app/')) {
		const next = path + event.url.search;
		redirect(303, `/signin?next=${encodeURIComponent(next)}`);
	}

	return resolve(event);
};
