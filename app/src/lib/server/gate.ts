// One password in front of the whole site.
//
// This is not the app's own sign-in (that is the "sign in as" picker, which
// has no passwords on purpose). This is a curtain: with SITE_PASSWORD set,
// nobody sees any page until they type it once, which is what keeps a demo
// with someone's API key on it off the open internet.
//
// The password is never stored by the app. It lives in the environment, is
// compared in constant time, and what the browser keeps afterwards is a
// signed cookie holding only an expiry. So the cookie cannot be turned back
// into the password, and it cannot be stretched.
//
// Endpoints that carry their own secret are exempt, because a bearer token or
// a shared secret is a stronger check than a shared password, and a coding
// agent or a scheduler cannot type one: /api/mcp, the cron runs and the mail
// webhook.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const GATE_COOKIE = 'nl_gate';
export const GATE_DAYS = 30;

/** Paths that answer without the curtain. */
const EXEMPT = [
	'/gate',
	'/robots.txt',
	// The map of the app for an agent. It names routes and query parameters
	// and nothing else, so it is safe to answer before the password, and it
	// is useless behind it.
	'/llms.txt',
	'/api/mcp',
	'/api/cron/automations',
	'/api/mail/poll',
	'/api/mail/webhook'
];

export function gateEnabled(password: string | undefined): boolean {
	return Boolean(password);
}

export function gateExempt(pathname: string): boolean {
	// SvelteKit's own assets and data requests must pass, or a gated page
	// could never load its own JavaScript.
	if (pathname.startsWith('/_app/')) return true;
	return EXEMPT.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/**
 * Compare a typed password with the configured one without leaking, through
 * timing, how much of it matched. Both sides are hashed first so they are the
 * same length, which timingSafeEqual needs.
 */
export function passwordMatches(given: string, expected: string | undefined): boolean {
	if (!expected || !given) return false;
	const digest = (value: string) => createHmac('sha256', 'nl-site-gate').update(value).digest();
	return timingSafeEqual(digest(given), digest(expected));
}

function signature(payload: string, secret: string): string {
	// The "gate." prefix keeps this signature from matching a session cookie's.
	return createHmac('sha256', secret).update(`gate.${payload}`).digest('base64url');
}

export function signGateCookie(secret: string, now = Date.now()): string {
	const expiresAt = now + GATE_DAYS * 24 * 60 * 60 * 1000;
	return `${expiresAt}.${signature(String(expiresAt), secret)}`;
}

export function verifyGateCookie(value: string | undefined, secret: string, now = Date.now()): boolean {
	if (!value) return false;
	const parts = value.split('.');
	if (parts.length !== 2) return false;
	const [expiresAt, given] = parts;
	if (!/^\d{1,15}$/.test(expiresAt)) return false;
	const expected = Buffer.from(signature(expiresAt, secret));
	const actual = Buffer.from(given);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
	return Number(expiresAt) > now;
}
