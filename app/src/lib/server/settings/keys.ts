// The settings this app has, in one list, with the environment variable each
// one falls back to.
//
// The same list is in the database (nl.setting_keys(), migration 0025) and a
// test compares the two, so they cannot drift apart. A key that is not here
// cannot be saved.

export const SETTING_KEYS = [
	'anthropic_api_key',
	'anthropic_model',
	'live_ai_passphrase',
	'assistant_daily_per_user',
	'assistant_daily_total',
	'agentmail_api_key',
	'mail_inbox_orders',
	'mail_inbox_procurement',
	'mail_allowlist',
	'cron_secret'
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/** Secrets are never sent back to the browser: only "set", the last four characters and when. */
export const SECRET_KEYS: readonly SettingKey[] = [
	'anthropic_api_key',
	'live_ai_passphrase',
	'agentmail_api_key',
	'cron_secret'
];

export function isSecretKey(key: SettingKey): boolean {
	return SECRET_KEYS.includes(key);
}

export function isSettingKey(value: string): value is SettingKey {
	return (SETTING_KEYS as readonly string[]).includes(value);
}

/**
 * The environment variable each setting falls back to when nothing is stored.
 * These are the names the rest of the app already reads, which is what makes
 * a deployment that has never opened Settings behave exactly as it does today.
 */
export const ENV_NAME: Record<SettingKey, string> = {
	anthropic_api_key: 'ANTHROPIC_API_KEY',
	anthropic_model: 'ANTHROPIC_MODEL',
	live_ai_passphrase: 'LIVE_AI_PASSPHRASE',
	assistant_daily_per_user: 'ASSISTANT_DAILY_PER_USER',
	assistant_daily_total: 'ASSISTANT_DAILY_TOTAL',
	agentmail_api_key: 'AGENTMAIL_API_KEY',
	mail_inbox_orders: 'MAIL_INBOX_ORDERS',
	mail_inbox_procurement: 'MAIL_INBOX_PROCUREMENT',
	mail_allowlist: 'MAIL_ALLOWLIST',
	cron_secret: 'CRON_SECRET'
};

// What each setting is called on screen lives with the components that show
// it (lib/components/settings/types.ts), so the browser never imports this
// server-only file.

/** A passcode shorter than this is refused. The database only ever sees a hash, so this is checked here. */
export const MIN_PASSCODE_LENGTH = 12;
