// The parts of Settings that need no database: the passcode cookie, the
// hashing, and the encryption a secret is stored under.
import { describe, expect, it } from 'vitest';
import { signLiveCookie } from '../assistant/live.ts';
import { decryptSecret, encryptSecret, hashPasscode, last4, newPasscodeSalt } from './crypto.ts';
import { ADMIN_HOURS, signAdminCookie, verifyAdminCookie } from './admin.ts';

const SECRET = 'a-server-session-secret-for-tests';
const OTHER = 'a-different-session-secret';

describe('the passcode cookie', () => {
	it('is accepted by the person it was signed for', () => {
		const cookie = signAdminCookie(7, SECRET);
		expect(verifyAdminCookie(cookie, 7, SECRET)).toBe(true);
	});

	it('cannot be reused by another person', () => {
		const cookie = signAdminCookie(7, SECRET);
		expect(verifyAdminCookie(cookie, 8, SECRET)).toBe(false);
		// Editing the user id in it breaks the signature.
		const swapped = cookie.replace(/^7\./, '8.');
		expect(verifyAdminCookie(swapped, 8, SECRET)).toBe(false);
	});

	it('cannot be forged without the session secret', () => {
		expect(verifyAdminCookie(signAdminCookie(7, OTHER), 7, SECRET)).toBe(false);
		expect(verifyAdminCookie('7.99999999999999.not-a-signature', 7, SECRET)).toBe(false);
		expect(verifyAdminCookie('nonsense', 7, SECRET)).toBe(false);
		expect(verifyAdminCookie(undefined, 7, SECRET)).toBe(false);
	});

	it('cannot have its expiry stretched, and runs out on its own', () => {
		const now = Date.parse('2026-09-17T12:00:00Z');
		const cookie = signAdminCookie(7, SECRET, now);
		const [id, expiresAt] = cookie.split('.');
		expect(Number(expiresAt) - now).toBe(ADMIN_HOURS * 60 * 60 * 1000);

		// A later expiry with the same signature is refused.
		const stretched = `${id}.${Number(expiresAt) + 1_000_000}.${cookie.split('.')[2]}`;
		expect(verifyAdminCookie(stretched, 7, SECRET, now)).toBe(false);

		expect(verifyAdminCookie(cookie, 7, SECRET, now + ADMIN_HOURS * 60 * 60 * 1000 - 1)).toBe(true);
		expect(verifyAdminCookie(cookie, 7, SECRET, now + ADMIN_HOURS * 60 * 60 * 1000 + 1)).toBe(false);
	});

	it('is not the same signature as another cookie in this app', () => {
		// Each cookie signs with its own prefix (session.ts has none, Ask uses
		// "ask.", this one "settings."), so unlocking one never unlocks another.
		expect(signAdminCookie(7, SECRET, 1000)).not.toBe(signLiveCookie(7, SECRET, 1000));
	});
});

describe('hashing the passcode', () => {
	it('never stores the passcode, and two salts give two hashes', () => {
		const a = newPasscodeSalt();
		const b = newPasscodeSalt();
		expect(a).not.toBe(b);
		const hashA = hashPasscode('a good long passphrase', a);
		const hashB = hashPasscode('a good long passphrase', b);
		expect(hashA).not.toBe(hashB);
		expect(hashA).not.toContain('passphrase');
		// The database's check constraint allows 32 to 256 characters.
		expect(hashA.length).toBe(64);
		expect(a.length).toBe(48);
	});

	it('gives the same hash for the same passcode and salt', () => {
		const salt = newPasscodeSalt();
		expect(hashPasscode('one two three four', salt)).toBe(hashPasscode('one two three four', salt));
		expect(hashPasscode('one two three five', salt)).not.toBe(hashPasscode('one two three four', salt));
	});
});

describe('encrypting a secret', () => {
	const key = 'sk-ant-test-0123456789abcdef';

	it('comes back the same under the same session secret', () => {
		const stored = encryptSecret(key, SECRET);
		expect(stored).not.toContain(key);
		expect(stored.startsWith('v1.')).toBe(true);
		expect(decryptSecret(stored, SECRET)).toBe(key);
	});

	it('cannot be read under a different session secret', () => {
		expect(decryptSecret(encryptSecret(key, SECRET), OTHER)).toBeNull();
	});

	it('refuses a value that was changed by hand', () => {
		const stored = encryptSecret(key, SECRET);
		// Flip one character of the payload: the authentication tag catches it.
		const body = stored.slice(3);
		const changed = `v1.${body[0] === 'A' ? 'B' : 'A'}${body.slice(1)}`;
		expect(decryptSecret(changed, SECRET)).toBeNull();
		expect(decryptSecret('v2.something', SECRET)).toBeNull();
		expect(decryptSecret('nonsense', SECRET)).toBeNull();
	});

	it('gives a different stored value every time, for the same key', () => {
		// A fresh initialization vector per save, so two identical keys do not
		// look identical in the table.
		expect(encryptSecret(key, SECRET)).not.toBe(encryptSecret(key, SECRET));
	});

	it('takes the last four characters for the screen, and nothing more', () => {
		expect(last4(key)).toBe('cdef');
		expect(last4('abc')).toBe('abc');
	});
});
