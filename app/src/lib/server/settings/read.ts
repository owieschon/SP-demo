// Reading settings: the stored value first, the environment variable second.
//
// Nothing else in the app has to know that settings exist. A caller asks for
// one name and gets a string or undefined, exactly as it would from the
// environment, and a deployment where nobody has ever opened /settings behaves
// as it did before this module was written.
//
// Two shapes, because not every caller can await:
//
//   settingOrEnv(db, key)   the normal one. Reads the database (cached for a
//                           few seconds) and falls back to the environment.
//   settingOrEnvSync(key)   the same answer out of that cache, for code that
//                           is synchronous. primeSettings(db) fills the cache
//                           where a database call is already being made. With
//                           an empty cache it returns the environment
//                           variable, which is the old behavior, never a
//                           wrong one.
//
// The cache is short on purpose: a key pasted into Settings should take effect
// within a few seconds everywhere, and a write clears the cache at once
// anyway (write.ts calls invalidateSettings).
import { env as privateEnv } from '$env/dynamic/private';
import type { Db } from '../db/types.ts';
import { sessionSecret } from '../session.ts';
import { decryptSecret } from './crypto.ts';
import { ENV_NAME, isSecretKey, SETTING_KEYS, type SettingKey } from './keys.ts';

/** How long a loaded set of settings is reused for. */
export const CACHE_MS = 5_000;

/** Everything this module needs from the outside world, so tests can hand it their own. */
export interface SettingsEnv {
	/** The process environment, for the fallbacks. */
	record: Record<string, string | undefined>;
	/** The server secret the stored secrets were encrypted with. */
	sessionSecret: string;
}

/** The real one: the environment this server was started with. */
export function currentEnv(): SettingsEnv {
	return {
		record: privateEnv,
		sessionSecret: sessionSecret(privateEnv.SESSION_SECRET, Boolean(privateEnv.VERCEL))
	};
}

/** One stored setting, as the server sees it. */
export interface StoredSetting {
	key: SettingKey;
	isSecret: boolean;
	/** The plaintext, decrypted for a secret. Undefined when a secret cannot be read. */
	value: string | undefined;
	last4: string;
	updatedAt: Date;
	/** True when a secret is stored but this server's session secret cannot read it. */
	unreadable: boolean;
}

interface Row {
	key: string;
	is_secret: boolean;
	value: string | null;
	secret: string | null;
	last4: string;
	updated_at: Date;
}

interface Cached {
	at: number;
	rows: Map<SettingKey, StoredSetting>;
}

// One cache per server process. The dev server reloads modules, so it is kept
// on globalThis the same way the database handle is (see server/db/index.ts).
// `loading` holds the read that is in flight, so several callers at once share
// one query instead of each making their own. They also share its decryption,
// which is right: one server has one session secret.
const store = globalThis as typeof globalThis & {
	__northlineSettings?: Cached;
	__northlineSettingsLoading?: Promise<Map<SettingKey, StoredSetting>>;
	/** Bumped by every write, so a read that started before it cannot be stored after it. */
	__northlineSettingsGeneration?: number;
};

/** Forget what was loaded, so the next read goes to the database. */
export function invalidateSettings(): void {
	store.__northlineSettings = undefined;
	store.__northlineSettingsLoading = undefined;
	store.__northlineSettingsGeneration = (store.__northlineSettingsGeneration ?? 0) + 1;
}

/** What is in the cache right now, or an empty map. Never waits. */
function cached(): Map<SettingKey, StoredSetting> {
	const held = store.__northlineSettings;
	if (!held || Date.now() - held.at > CACHE_MS) return new Map();
	return held.rows;
}

/**
 * Load every stored setting. Secrets are decrypted here; one that cannot be
 * read is marked unreadable instead of failing the whole load, so a rotated
 * session secret does not take the page down with it.
 *
 * Read as a visitor (role nl_app, nobody signed in): the function it calls is
 * granted to that role and is the same answer for everyone, which is what
 * lets the scheduled-run endpoint, where nobody is signed in, read its secret.
 */
export function loadSettings(db: Db, env: SettingsEnv = currentEnv()): Promise<Map<SettingKey, StoredSetting>> {
	const held = store.__northlineSettings;
	if (held && Date.now() - held.at <= CACHE_MS) return Promise.resolve(held.rows);
	// Somebody else is already asking. Wait for their answer rather than
	// sending the same query again: the Settings page reads this three times
	// at once.
	if (store.__northlineSettingsLoading) return store.__northlineSettingsLoading;

	store.__northlineSettingsLoading = load(db, env).finally(() => {
		store.__northlineSettingsLoading = undefined;
	});
	return store.__northlineSettingsLoading;
}

async function load(db: Db, env: SettingsEnv): Promise<Map<SettingKey, StoredSetting>> {
	// If a write lands while this read is in the air, the answer is already old
	// news by the time it arrives, so it is returned but not cached.
	const generation = store.__northlineSettingsGeneration ?? 0;
	const rows = await db.asVisitor((tx) => tx.sql<Row>`select * from nl.settings_with_secrets()`);
	const loaded = new Map<SettingKey, StoredSetting>();
	for (const row of rows) {
		if (!(SETTING_KEYS as readonly string[]).includes(row.key)) continue; // a key from a newer version
		const key = row.key as SettingKey;
		const plain = row.is_secret ? (row.secret ? decryptSecret(row.secret, env.sessionSecret) : null) : row.value;
		loaded.set(key, {
			key,
			isSecret: row.is_secret,
			value: plain ?? undefined,
			last4: row.last4,
			updatedAt: row.updated_at,
			unreadable: row.is_secret && plain === null
		});
	}
	if ((store.__northlineSettingsGeneration ?? 0) === generation) {
		store.__northlineSettings = { at: Date.now(), rows: loaded };
	}
	return loaded;
}

/** Fill the cache so settingOrEnvSync has something to read. */
export async function primeSettings(db: Db, env: SettingsEnv = currentEnv()): Promise<void> {
	await loadSettings(db, env);
}

function fromStored(rows: Map<SettingKey, StoredSetting>, key: SettingKey): string | undefined {
	const row = rows.get(key);
	// A stored value that is blank counts as "not set", so clearing a field in
	// the page and saving it falls back to the environment rather than
	// overriding it with nothing.
	if (!row || row.value === undefined || row.value === '') return undefined;
	return row.value;
}

/** One setting: what is stored, or the environment variable, or undefined. */
export async function settingOrEnv(
	db: Db,
	key: SettingKey,
	env: SettingsEnv = currentEnv()
): Promise<string | undefined> {
	const stored = fromStored(await loadSettings(db, env), key);
	return stored ?? env.record[ENV_NAME[key]];
}

/** The same answer without waiting, for synchronous callers. See the file header. */
export function settingOrEnvSync(key: SettingKey, env: SettingsEnv = currentEnv()): string | undefined {
	return fromStored(cached(), key) ?? env.record[ENV_NAME[key]];
}

/**
 * The environment record with the stored settings written over it, for code
 * that reads several names at once out of one object (the assistant's
 * readLimits, for example).
 */
export function settingsOverEnv(env: SettingsEnv = currentEnv()): Record<string, string | undefined> {
	const merged: Record<string, string | undefined> = { ...env.record };
	const rows = cached();
	for (const key of SETTING_KEYS) {
		const stored = fromStored(rows, key);
		if (stored !== undefined) merged[ENV_NAME[key]] = stored;
	}
	return merged;
}

/** Whether each setting is set, where the value came from, and what the page may show. */
export interface SettingStatus {
	key: SettingKey;
	isSecret: boolean;
	/** Stored in the database, from the environment, or nowhere. */
	source: 'stored' | 'environment' | 'none';
	/** For a secret: only its last four characters. For anything else: the value. */
	shown: string;
	updatedAt: string | null;
	unreadable: boolean;
	/** The environment variable name, so the page can say where a fallback came from. */
	envName: string;
}

/**
 * The status of every setting, safe to hand to the browser. A secret's value
 * is never in here: only whether it is set and its last four characters.
 */
export async function readSettingStatus(db: Db, env: SettingsEnv = currentEnv()): Promise<SettingStatus[]> {
	const rows = await loadSettings(db, env);
	return SETTING_KEYS.map((key) => {
		const row = rows.get(key);
		const fromEnv = env.record[ENV_NAME[key]];
		const secret = isSecretKey(key);
		const storedSomething = Boolean(row && (row.unreadable || (row.value !== undefined && row.value !== '')));
		const source = storedSomething ? 'stored' : fromEnv ? 'environment' : 'none';
		let shown = '';
		if (secret) {
			// Never the value, whichever place it came from.
			shown = storedSomething ? row!.last4 : fromEnv ? fromEnv.slice(-4) : '';
		} else {
			shown = storedSomething ? (row!.value ?? '') : (fromEnv ?? '');
		}
		return {
			key,
			isSecret: secret,
			source,
			shown,
			updatedAt: row ? row.updatedAt.toISOString() : null,
			unreadable: row?.unreadable ?? false,
			envName: ENV_NAME[key]
		};
	});
}

/** The row version the page sends back when it saves, so a stale page is refused. */
export async function rowVersions(db: Db, env: SettingsEnv = currentEnv()): Promise<Record<string, string>> {
	const rows = await loadSettings(db, env);
	const versions: Record<string, string> = {};
	for (const [key, row] of rows) versions[key] = row.updatedAt.toISOString();
	return versions;
}
