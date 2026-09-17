// Who may change a setting: first-run ownership, and the cookie that follows.
//
// The problem. This app is a public demo. Signing in needs no password: the
// sign-in page lists everyone and you pick one, admin included. So "this
// person's role is admin" cannot protect a page that holds API keys, because
// anyone can be that person.
//
// What protects it instead. The first person to open /settings claims the
// instance by choosing a passcode of at least twelve characters. Only a
// salted scrypt hash of it is stored (migration 0025), and the comparison
// happens in the database, which also counts the attempts: five wrong answers
// in fifteen minutes and that person has to wait. A right answer sets a
// signed, httpOnly cookie for twelve hours.
//
// The cookie is the same shape as the one Ask Northline uses for live mode
// (server/assistant/live.ts): "<user id>.<expires at>.<signature>", signed
// with the session secret under its own prefix and set on its own path, so
// unlocking one does not unlock the other, the user id in it cannot be
// changed, the expiry cannot be stretched, and it is no use to anybody else.
//
// The limits of all this are written down plainly in docs/settings.md. In
// short: the passcode is the only thing between a visitor and the keys.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { guarded } from '../errors.ts';
import type { Db } from '../db/types.ts';
import { hashPasscode, newPasscodeSalt, PASSCODE_ALGO } from './crypto.ts';
import { MIN_PASSCODE_LENGTH } from './keys.ts';

export const ADMIN_COOKIE = 'nl_settings_admin';
export const ADMIN_COOKIE_PATH = '/settings';
export const ADMIN_HOURS = 12;

function signature(payload: string, secret: string): string {
	// The "settings." prefix keeps this signature from ever matching a session
	// cookie's, the RFQ page's or Ask's.
	return createHmac('sha256', secret).update(`settings.${payload}`).digest('base64url');
}

export function signAdminCookie(userId: number, secret: string, now = Date.now()): string {
	const payload = `${userId}.${now + ADMIN_HOURS * 60 * 60 * 1000}`;
	return `${payload}.${signature(payload, secret)}`;
}

/** True when the cookie is valid, unexpired and belongs to this user. */
export function verifyAdminCookie(
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
	// Constant time, so the check does not leak how much of the signature matched.
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
	return Number(expiresAt) > now;
}

/** Whether anyone has claimed this instance, and the salt to hash a typed passcode with. */
export interface LockState {
	claimed: boolean;
	salt: string | null;
	claimedBy: number | null;
	claimedAt: string | null;
	updatedAt: string | null;
}

interface LockRow {
	state: { claimed: boolean; salt?: string; claimed_by?: number; claimed_at?: string; updated_at?: string };
}

export async function readLockState(db: Db, userId: number): Promise<LockState> {
	const [row] = await db.asUser(userId, (tx) => tx.sql<LockRow>`select nl.admin_lock_state() as state`);
	const state = row.state;
	return {
		claimed: state.claimed,
		salt: state.salt ?? null,
		claimedBy: state.claimed_by ?? null,
		claimedAt: state.claimed_at ?? null,
		updatedAt: state.updated_at ?? null
	};
}

/** What an attempt at the passcode came back as. */
export interface AttemptResult {
	ok: boolean;
	/** True when this person has guessed too often and has to wait. */
	locked: boolean;
	attemptsLeft: number;
	minutes: number;
	/** A sentence for the page. */
	message: string;
}

interface AttemptRow {
	result: { ok: boolean; locked: boolean; attempts_left?: number; minutes?: number; replayed?: boolean };
}

function attemptMessage(result: AttemptRow['result']): string {
	if (result.ok) return `Settings are unlocked on this browser for ${ADMIN_HOURS} hours.`;
	if (result.locked) {
		return `Too many wrong answers. Try again in ${result.minutes ?? 15} minutes.`;
	}
	const left = result.attempts_left ?? 0;
	if (left <= 0) return 'That is not the passcode. That was the last try for the next fifteen minutes.';
	return `That is not the passcode. ${left} ${left === 1 ? 'try' : 'tries'} left before a fifteen minute pause.`;
}

function toAttempt(result: AttemptRow['result']): AttemptResult {
	return {
		ok: result.ok,
		locked: result.locked,
		attemptsLeft: result.attempts_left ?? 0,
		minutes: result.minutes ?? 0,
		message: attemptMessage(result)
	};
}

export class PasscodeRefused extends Error {}

/** A passcode has to be long enough to be worth having. Checked here: the database only sees a hash. */
export function checkPasscodeLength(passcode: string): void {
	if (passcode.length < MIN_PASSCODE_LENGTH) {
		throw new PasscodeRefused(`A passcode is at least ${MIN_PASSCODE_LENGTH} characters. Use a phrase.`);
	}
}

/** Claim this instance with the first passcode. Refused if someone already has. */
export async function claimInstance(
	db: Db,
	userId: number,
	passcode: string,
	requestId: string
): Promise<{ claimed: true }> {
	checkPasscodeLength(passcode);
	const salt = newPasscodeSalt();
	const hash = hashPasscode(passcode, salt);
	await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql`select nl.claim_instance(${PASSCODE_ALGO}, ${salt}, ${hash}, ${requestId}) as result`
		)
	);
	return { claimed: true };
}

/**
 * Is this the passcode? The hash is built with the stored salt and compared in
 * the database (nl.check_admin_passcode), which records the attempt and
 * enforces the rate limit whatever the app does.
 */
export async function checkPasscode(
	db: Db,
	userId: number,
	passcode: string,
	requestId: string
): Promise<AttemptResult> {
	const lock = await readLockState(db, userId);
	if (!lock.claimed || !lock.salt) {
		throw new PasscodeRefused('Nobody has claimed this instance yet. Choose a passcode first.');
	}
	const hash = hashPasscode(passcode, lock.salt);
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<AttemptRow>`select nl.check_admin_passcode(${hash}, ${requestId}) as result`
		)
	);
	return toAttempt(row.result);
}

/** Change the passcode. Only someone who can type the old one can do it. */
export async function changePasscode(
	db: Db,
	userId: number,
	input: { oldPasscode: string; newPasscode: string; expectedUpdatedAt: string; requestId: string }
): Promise<AttemptResult> {
	checkPasscodeLength(input.newPasscode);
	const lock = await readLockState(db, userId);
	if (!lock.claimed || !lock.salt) {
		throw new PasscodeRefused('Nobody has claimed this instance yet. Choose a passcode first.');
	}
	const oldHash = hashPasscode(input.oldPasscode, lock.salt);
	// "Is this the same passcode again" has to be asked here rather than in the
	// database: the new hash is built with a new salt, so the same phrase does
	// not look the same to the row. Hashing the new phrase under the OLD salt
	// does answer it.
	if (hashPasscode(input.newPasscode, lock.salt) === oldHash) {
		throw new PasscodeRefused('The new passcode is the same as the old one. Choose a different one.');
	}
	// A new salt with every change, so two people who chose the same phrase
	// never end up with the same stored hash.
	const salt = newPasscodeSalt();
	const newHash = hashPasscode(input.newPasscode, salt);
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<AttemptRow>`
				select nl.change_admin_passcode(
					${oldHash}, ${PASSCODE_ALGO}, ${salt}, ${newHash},
					${input.expectedUpdatedAt}::timestamptz, ${input.requestId}) as result`
		)
	);
	const attempt = toAttempt(row.result);
	return attempt.ok
		? { ...attempt, message: 'The passcode is changed. Everyone who unlocked with the old one stays unlocked until their twelve hours run out.' }
		: attempt;
}
