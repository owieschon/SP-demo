// Turning a pasted key into something safe to store, and back again.
//
// Two separate jobs, both done here so there is one place to read:
//
//   1. A secret setting is encrypted with AES-256-GCM before it goes to the
//      database, under a key derived from the server's session secret. The
//      plaintext and the encryption key never travel to Postgres at all, so
//      they cannot land in a query log, a backup of the table is useless on
//      its own, and the assistant's read-only role has nothing to read even
//      if a grant were added by mistake. GCM also authenticates: a stored
//      value that has been changed by hand fails to decrypt instead of
//      returning nonsense.
//
//   2. The admin passcode is hashed with scrypt and a random salt. Only the
//      hash and the salt are stored, and the comparison happens in the
//      database (nl.constant_time_equal), which walks the whole digest
//      instead of stopping at the first difference.
//
// The cost of rotating the session secret is that every stored secret becomes
// unreadable and has to be pasted again. decryptSecret returns null for that
// case rather than throwing, so the page can say so plainly. docs/settings.md
// spells this out.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** The label that separates this key from any other use of the session secret. */
const KEY_LABEL = 'northline.settings.v1';
/** What a stored secret starts with, so a later format can be told apart from this one. */
const FORMAT = 'v1';

// scryptSync takes tens of milliseconds, and every settings read would pay it
// again. The derived key depends only on the session secret, so keep it.
const keyCache = new Map<string, Buffer>();

function keyFor(sessionSecret: string): Buffer {
	let key = keyCache.get(sessionSecret);
	if (!key) {
		// The "salt" here is a fixed label, not a secret: the session secret is
		// already 32 random bytes, so there is nothing to slow an attacker down
		// about. What scrypt buys is a clean 32 byte key of the right shape.
		key = scryptSync(sessionSecret, KEY_LABEL, 32);
		keyCache.set(sessionSecret, key);
	}
	return key;
}

/** Encrypt one secret for storage. The result is "v1.<base64 of iv, tag and ciphertext>". */
export function encryptSecret(plain: string, sessionSecret: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', keyFor(sessionSecret), iv);
	const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	return `${FORMAT}.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

/**
 * Read one stored secret back, or null when it cannot be read: a different
 * session secret, a value changed by hand, or a format from the future.
 */
export function decryptSecret(stored: string, sessionSecret: string): string | null {
	const [format, payload] = stored.split('.', 2);
	if (format !== FORMAT || !payload) return null;
	try {
		const raw = Buffer.from(payload, 'base64');
		if (raw.length < 12 + 16 + 1) return null;
		const decipher = createDecipheriv('aes-256-gcm', keyFor(sessionSecret), raw.subarray(0, 12));
		decipher.setAuthTag(raw.subarray(12, 28));
		return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
	} catch {
		// GCM refused the authentication tag, which is what a wrong key looks like.
		return null;
	}
}

/** The last four characters, for "ends 4f2a" on screen. Never more than four. */
export function last4(plain: string): string {
	return plain.slice(-4);
}

/** A fresh salt for a passcode. 48 hex characters, which the database's check allows. */
export function newPasscodeSalt(): string {
	return randomBytes(24).toString('hex');
}

/** The hash the database stores and compares. 64 hex characters. */
export function hashPasscode(passcode: string, salt: string): string {
	return scryptSync(passcode, salt, 32).toString('hex');
}

/** The name of the hashing method, stored beside the hash so a later one can be told apart. */
export const PASSCODE_ALGO = 'scrypt';
