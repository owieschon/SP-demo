// The session cookie: "<user id>.<expires at>.<signature>".
//
// The signature is an HMAC of the first two parts with a server secret, so a
// visitor cannot change the user id or stretch the expiry without the secret.
// There are no passwords: this is a public demo with a "sign in as" picker.
// What the cookie buys is that the server, not the browser, decides who is
// asking, and every database call runs as that person.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'nl_session';
export const SESSION_DAYS = 7;

function signature(payload: string, secret: string): string {
	return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function signSession(userId: number, secret: string, now = Date.now()): string {
	const expiresAt = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
	const payload = `${userId}.${expiresAt}`;
	return `${payload}.${signature(payload, secret)}`;
}

/** The user id in a valid, unexpired cookie, or null. */
export function verifySession(value: string | undefined, secret: string, now = Date.now()): number | null {
	if (!value) return null;
	const parts = value.split('.');
	if (parts.length !== 3) return null;
	const [id, expiresAt, given] = parts;
	if (!/^\d{1,9}$/.test(id) || !/^\d{1,15}$/.test(expiresAt)) return null;

	const expected = Buffer.from(signature(`${id}.${expiresAt}`, secret));
	const actual = Buffer.from(given);
	// Compare in constant time so the check does not leak how much matched.
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
	if (Number(expiresAt) <= now) return null;
	return Number(id);
}

let devSecret: string | undefined;

/**
 * SESSION_SECRET from the environment. Locally, a random one is made up per
 * server start (sign-ins then last until the next restart). A deployment
 * without one refuses to start.
 */
export function sessionSecret(configured: string | undefined, deployed: boolean): string {
	if (configured) return configured;
	if (deployed) throw new Error('SESSION_SECRET is not set.');
	devSecret ??= randomBytes(32).toString('base64url');
	return devSecret;
}
