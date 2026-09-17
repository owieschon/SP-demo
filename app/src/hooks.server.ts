// Runs on every request before any page or endpoint.
//
// 1. With SITE_PASSWORD set, holds a curtain in front of the whole site
//    (lib/server/gate.ts): no page answers until someone has typed it once.
// 2. Reads the signed session cookie and loads the user it names (only if
//    that user is still active).
// 3. Sends anyone who is not signed in to the sign-in page.
// 4. Fills in the color theme on the page (see below).
import { redirect, type Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { SESSION_COOKIE, sessionSecret, verifySession } from '$lib/server/session';
import { GATE_COOKIE, gateEnabled, gateExempt, verifyGateCookie } from '$lib/server/gate';
import { findActiveUser } from '$lib/server/users';
import { readTheme, THEME_COOKIE } from '$lib/components/theme';

// The daily automation run checks its own secret (routes/api/cron/automations).
// The MCP server and the cron runs carry their own secrets (a bearer token
// and a shared secret), so they must not be bounced to the sign-in page.
const PUBLIC_PATHS = new Set([
	'/signin',
	'/gate',
	'/robots.txt',
	'/llms.txt',
	'/api/cron/automations',
	'/api/mcp',
	'/api/mail/poll',
	'/api/mail/webhook'
]);

export const handle: Handle = async ({ event, resolve }) => {
	const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
	const path = event.url.pathname;

	// 1. The curtain. Endpoints that carry their own secret are exempt.
	if (gateEnabled(env.SITE_PASSWORD) && !gateExempt(path)) {
		if (!verifyGateCookie(event.cookies.get(GATE_COOKIE), secret)) {
			const next = path + event.url.search;
			redirect(303, `/gate?next=${encodeURIComponent(next)}`);
		}
	}

	const userId = verifySession(event.cookies.get(SESSION_COOKIE), secret);
	event.locals.user = userId === null ? null : await findActiveUser(await getDb(), userId);

	if (!event.locals.user && !PUBLIC_PATHS.has(path) && !path.startsWith('/_app/')) {
		const next = path + event.url.search;
		redirect(303, `/signin?next=${encodeURIComponent(next)}`);
	}

	// 3. Writes the visitor's color theme into <html data-theme="%theme%">
	//    (see app.html), so the first paint has the right colors.
	const theme = readTheme(event.cookies.get(THEME_COOKIE));
	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%theme%', theme)
	});
};
