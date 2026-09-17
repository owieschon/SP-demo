// Saving and clearing one setting.
//
// The database holds the rules for everything it can see (migration 0025:
// nl_config.check_setting for a model name, a cap, an address, a recipient
// list). It cannot hold the rules for a secret, because a secret arrives
// encrypted and Postgres never sees the plaintext, so those few checks are
// here instead and raise the same kind of refusal.
//
// Every write claims a request id, needs an active user, needs the instance to
// have been claimed, checks the row version and leaves an audit row. All of
// that is in the SQL function; this file shapes the input and clears the read
// cache afterwards.
import { z } from 'zod';
import { AppError, guarded } from '../errors.ts';
import type { Db } from '../db/types.ts';
import { encryptSecret, last4 as lastFour } from './crypto.ts';
import { isSecretKey, SETTING_KEYS, type SettingKey } from './keys.ts';
import { currentEnv, invalidateSettings, type SettingsEnv } from './read.ts';

export const settingInput = z.object({
	key: z.enum(SETTING_KEYS),
	// Trimmed here so a key pasted with a trailing newline still works.
	value: z.string().max(8000).transform((v) => v.trim()),
	/** The row version the page loaded, or null when nothing was stored then. */
	expectedUpdatedAt: z.string().min(1).max(40).nullable(),
	requestId: z.string().min(8).max(100)
});

export type SettingInput = z.infer<typeof settingInput>;

export const clearInput = z.object({
	key: z.enum(SETTING_KEYS),
	expectedUpdatedAt: z.string().min(1).max(40),
	requestId: z.string().min(8).max(100)
});

export type ClearInput = z.infer<typeof clearInput>;

export interface SettingSaved {
	key: SettingKey;
	last4: string;
	updatedAt: string;
}

/**
 * A secret has to look like something pasted from a dashboard: one line, no
 * spaces, long enough to be a key. The database cannot check this, so it is
 * checked here and refused the same way.
 */
function checkSecret(key: SettingKey, value: string): void {
	if (value === '') {
		throw new AppError(422, 'NL422', 'Paste a value, or use Clear to remove the one that is stored.');
	}
	if (/\s/.test(value)) {
		throw new AppError(422, 'NL422', 'A key or passphrase is one line with no spaces in it.');
	}
	if (value.length < 8) {
		throw new AppError(422, 'NL422', 'That looks too short to be a key. Check what was pasted.');
	}
	if (key === 'anthropic_api_key' && !value.startsWith('sk-')) {
		// Not a hard rule about the provider's format, a check that the right
		// thing was pasted into the right box.
		throw new AppError(422, 'NL422', 'An Anthropic key starts with "sk-". Check what was pasted.');
	}
}

/** Store one setting. Returns what the page needs to keep working: the row version and the last four. */
export async function saveSetting(
	db: Db,
	userId: number,
	input: SettingInput,
	env: SettingsEnv = currentEnv()
): Promise<SettingSaved> {
	const secret = isSecretKey(input.key);
	if (secret) checkSecret(input.key, input.value);

	const stored = secret ? encryptSecret(input.value, env.sessionSecret) : null;
	const four = secret ? lastFour(input.value) : '';

	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { key: string; last4: string; updated_at: string } }>`
				select nl.set_setting(
					${input.key},
					${secret ? null : input.value},
					${stored},
					${four},
					${input.expectedUpdatedAt}::timestamptz,
					${input.requestId}) as result`
		)
	);
	// The next read must see this, so do not wait for the cache to age out.
	invalidateSettings();
	return { key: input.key, last4: row.result.last4, updatedAt: row.result.updated_at };
}

/** Remove one setting, so the app falls back to the environment variable again. */
export async function clearSetting(db: Db, userId: number, input: ClearInput): Promise<{ key: SettingKey }> {
	await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql`select nl.clear_setting(${input.key}, ${input.expectedUpdatedAt}::timestamptz, ${input.requestId}) as result`
		)
	);
	invalidateSettings();
	return { key: input.key };
}
