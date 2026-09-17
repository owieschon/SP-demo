// Live mode for Ask Northline: may this person use the real model right now?
//
// The key alone turns it on. With ANTHROPIC_API_KEY set, every signed-in
// person gets the real model, bounded by the daily caps in the database
// (nl.claim_assistant_call).
//
// LIVE_AI_PASSPHRASE is optional, for when the site is public and the caps
// alone are not comfort enough: set it and a person must type it once, which
// puts a short-lived signed cookie in their browser. The passphrase is
// compared on the server in constant time and never sent back to the page.
// The cookie holds only the user id and an expiry, signed with the session
// secret, so it cannot be copied to another user or stretched.
//
// With no key at all the scripted model answers, which is what the tests and
// a deployment without a key use.
//
// This is the same shape as the RFQ workflow's live gate, with its own cookie
// name, its own path and its own signature prefix, so unlocking one does not
// unlock the other.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const LIVE_COOKIE = 'nl_live_ask';
export const LIVE_COOKIE_PATH = '/ask';
export const LIVE_MINUTES = 60;

export interface LiveEnv {
	apiKey: string | undefined;
	passphrase: string | undefined;
	model: string | undefined;
}

/** Is live mode possible on this server at all? The key is the only must. */
export function liveConfigured(env: LiveEnv): boolean {
	return Boolean(env.apiKey);
}

/** Does this server also ask for a passphrase before using the key? */
export function passphraseRequired(env: LiveEnv): boolean {
	return Boolean(env.apiKey && env.passphrase);
}

/**
 * Compare a typed passphrase with the configured one without leaking, through
 * timing, how much of it matched. Both sides are hashed first so they are the
 * same length, which timingSafeEqual needs.
 */
export function passphraseMatches(given: string, expected: string | undefined): boolean {
	if (!expected || !given) return false;
	const digest = (value: string) => createHmac('sha256', 'nl-ask-passphrase').update(value).digest();
	return timingSafeEqual(digest(given), digest(expected));
}

function signature(payload: string, secret: string): string {
	// The "ask." prefix keeps this signature from ever matching a session
	// cookie's, or the RFQ page's.
	return createHmac('sha256', secret).update(`ask.${payload}`).digest('base64url');
}

export function signLiveCookie(userId: number, secret: string, now = Date.now()): string {
	const payload = `${userId}.${now + LIVE_MINUTES * 60 * 1000}`;
	return `${payload}.${signature(payload, secret)}`;
}

/** True when the cookie is valid, unexpired and belongs to this user. */
export function verifyLiveCookie(
	value: string | undefined,
	userId: number,
	secret: string,
	now = Date.now()
): boolean {
	if (!value) return false;
	const parts = value.split('.');
	if (parts.length !== 3) return false;
	const [id, expiresAt, given] = parts;
	if (id !== String(userId) || !/^\d{1,15}$/.test(expiresAt)) return false;
	const expected = Buffer.from(signature(`${id}.${expiresAt}`, secret));
	const actual = Buffer.from(given);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
	return Number(expiresAt) > now;
}
