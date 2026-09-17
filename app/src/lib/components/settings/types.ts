// What the Settings page shows, and the words it uses.
//
// These types are the shape the server hands the browser. A secret is not in
// them: a setting arrives as whether it is set, its last four characters and
// when it changed. That is the whole guarantee, written as a type.

export interface SettingView {
	key: string;
	isSecret: boolean;
	/** Where the value in force came from. */
	source: 'stored' | 'environment' | 'none';
	/** For a secret, its last four characters. For anything else, the value itself. */
	shown: string;
	updatedAt: string | null;
	/** A stored secret this server's session secret cannot decrypt. */
	unreadable: boolean;
	envName: string;
}

export interface HealthCheckView {
	id: string;
	label: string;
	state: 'good' | 'bad' | 'neutral';
	detail: string;
	advice: string;
}

export interface DiagnosticsView {
	version: string;
	ranAt: string;
	/** How long the checks took, so the page can be honest about it. */
	ms: number;
	checks: HealthCheckView[];
	/** Estimates from the planner's own statistics, not counts. */
	counts: { table: string; rows: number }[];
	environment: { name: string; set: boolean; shown: string }[];
}

/** The exact drift checks, which only run when somebody asks for them. */
export interface ExactChecksView {
	ranAt: string;
	ms: number;
	checks: HealthCheckView[];
}

/** Which section each setting belongs to on the page. */
export const KEYS_AND_MODELS = [
	'anthropic_api_key',
	'anthropic_model',
	'live_ai_passphrase',
	'assistant_daily_per_user',
	'assistant_daily_total'
] as const;

export const MAIL_DESKS = ['agentmail_api_key', 'mail_inbox_orders', 'mail_inbox_procurement', 'mail_allowlist'] as const;

export const JOBS = ['cron_secret'] as const;

export const SETTING_LABEL: Record<string, string> = {
	anthropic_api_key: 'Anthropic API key',
	anthropic_model: 'Model',
	live_ai_passphrase: 'Live mode passphrase',
	assistant_daily_per_user: 'Model calls per person per day',
	assistant_daily_total: 'Model calls for the whole server per day',
	agentmail_api_key: 'Mail API key',
	mail_inbox_orders: 'Order desk inbox',
	mail_inbox_procurement: 'Procurement desk inbox',
	mail_allowlist: 'Allowed recipients',
	cron_secret: 'Scheduled run secret'
};

/** One line under each field, in plain English, saying what changes. */
export const SETTING_HELP: Record<string, string> = {
	anthropic_api_key:
		'With a key set, Ask uses the real model for everyone signed in, bounded by the caps below. With no key, Ask answers in scripted demo mode and costs nothing.',
	anthropic_model: 'Which model answers. Lower case letters, digits, dots and dashes.',
	live_ai_passphrase:
		'Optional. Set one and a person has to type it before the real model answers for them, for an hour. Leave it blank and a key alone is enough for anyone signed in.',
	assistant_daily_per_user: 'Counted in the database, so a restart does not forget the day.',
	assistant_daily_total: 'The whole demo, everyone together, per day.',
	agentmail_api_key: 'The key the order and procurement desks send mail with.',
	mail_inbox_orders: 'Where customer mail for the order desk arrives.',
	mail_inbox_procurement: 'Where vendor mail for the procurement desk arrives.',
	mail_allowlist:
		'One address per line. This is the only list the app may ever send to: a draft addressed to anybody else is refused rather than sent.',
	cron_secret:
		'The scheduled run sends this as "Authorization: Bearer <secret>". With nothing set, scheduled runs are off.'
};

/** Fields that are a short number or a one-line value rather than a long one. */
export const NARROW_KEYS = new Set(['assistant_daily_per_user', 'assistant_daily_total']);

/** Fields typed as several lines. */
export const MULTILINE_KEYS = new Set(['mail_allowlist']);

/** Random bytes as text, from the browser's own generator. */
function randomText(bytes: number): string {
	const raw = new Uint8Array(bytes);
	crypto.getRandomValues(raw);
	return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fresh request id for each submit. Every write in this app claims one, so a
 * double click writes once; a new id per attempt means a second try after a
 * refusal is a real second try and not a replay of the first answer.
 */
export function freshRequestId(): string {
	return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : randomText(18);
}

/** A secret for the scheduled run, made here so it is never typed or mailed anywhere. */
export function newSecretInBrowser(): string {
	return randomText(24);
}
