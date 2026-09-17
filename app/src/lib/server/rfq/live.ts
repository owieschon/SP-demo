// Live mode: whether this person may use the Claude extractor right now.
//
// Two things must both be true:
//   1. the server has ANTHROPIC_API_KEY and LIVE_AI_PASSPHRASE set, and
//   2. the person typed the passphrase, which put a short-lived signed cookie
//      in their browser.
// The passphrase is compared on the server in constant time and never sent
// back to the page. The cookie holds only the user id and an expiry, signed
// with the session secret, so it cannot be copied to another user or
// stretched. Public visitors without the passphrase always get the rules
// extractor, so nobody can spend the owner's API credit.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const LIVE_COOKIE = 'nl_live_ai';
export const LIVE_MINUTES = 60;

export interface LiveEnv {
	apiKey: string | undefined;
	passphrase: string | undefined;
	model: string | undefined;
}

/** Is live mode possible on this server at all? */
export function liveConfigured(env: LiveEnv): boolean {
	return Boolean(env.apiKey && env.passphrase);
}

/**
 * Compare a typed passphrase with the configured one without leaking, through
 * timing, how much of it matched. Both sides are hashed first so they have
 * the same length (timingSafeEqual needs that).
 */
export function passphraseMatches(given: string, expected: string | undefined): boolean {
	if (!expected || !given) return false;
	const digest = (value: string) => createHmac('sha256', 'nl-live-passphrase').update(value).digest();
	return timingSafeEqual(digest(given), digest(expected));
}

function signature(payload: string, secret: string): string {
	// The "live." prefix keeps this signature from ever matching a session cookie's.
	return createHmac('sha256', secret).update(`live.${payload}`).digest('base64url');
}

export function signLiveCookie(userId: number, secret: string, now = Date.now()): string {
	const payload = `${userId}.${now + LIVE_MINUTES * 60 * 1000}`;
	return `${payload}.${signature(payload, secret)}`;
}

/** True when the cookie is valid, unexpired and belongs to this user. */
export function verifyLiveCookie(value: string | undefined, userId: number, secret: string, now = Date.now()): boolean {
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
