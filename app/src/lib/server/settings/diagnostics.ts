// Health: is this deployment actually working, and what is wrong if not.
//
// Everything here is read only and none of it contains a secret. Whether a key
// is set is news; the key itself never leaves the server. That is worth being
// careful about, because the Health section is the one part of /settings a
// person without the passcode can still see.
//
// Each check comes back with a state and, when it is not good, one sentence
// saying what to do. Every read is guarded on its own: a database that cannot
// answer one question still answers the others.
import type { Db } from '../db/types.ts';
import { ENV_NAME, SETTING_KEYS } from './keys.ts';
import { currentEnv, loadSettings, type SettingsEnv } from './read.ts';

export interface HealthCheck {
	id: string;
	label: string;
	/** good: nothing to do. bad: read the advice. neutral: a figure, not a verdict. */
	state: 'good' | 'bad' | 'neutral';
	detail: string;
	/** What to do when the state is bad. Empty otherwise. */
	advice: string;
}

export interface TableCount {
	table: string;
	rows: number;
}

export interface EnvFlag {
	name: string;
	set: boolean;
	/** Only for values that are safe to show (a model name, a flag, a commit). */
	shown: string;
}

export interface Diagnostics {
	/** The git commit this deployment was built from, or "local". */
	version: string;
	ranAt: string;
	checks: HealthCheck[];
	counts: TableCount[];
	/** Environment variables the app reads, and whether they are set. Never their values. */
	environment: EnvFlag[];
}

/** Bytes as something readable. */
function size(bytes: number): string {
	if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
	return `${Math.round(bytes / 1_000_000)} MB`;
}

/** How long ago, in plain English. */
function ago(at: Date, now: Date): string {
	const hours = (now.getTime() - at.getTime()) / 3_600_000;
	if (hours < 1) return 'less than an hour ago';
	if (hours < 48) return `${Math.round(hours)} hours ago`;
	return `${Math.round(hours / 24)} days ago`;
}

/** Run one read and turn a failure into a check rather than an error page. */
async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
	try {
		return await work();
	} catch {
		return null;
	}
}

interface DriftRow {
	result: { delivery: number; warehouse: number | null; cost: number; cost_days: number };
}

interface NightlyRow {
	result: { source: 'cron' | 'audit' | 'none'; at?: string; status?: string; detail?: string };
}

export async function readDiagnostics(
	db: Db,
	userId: number,
	env: SettingsEnv = currentEnv()
): Promise<Diagnostics> {
	const now = new Date();
	const checks: HealthCheck[] = [];
	const record = env.record;
	const deployed = Boolean(record.VERCEL);

	// --- the session secret, which everything encrypted depends on ----------
	const hasSessionSecret = Boolean(record.SESSION_SECRET);
	checks.push({
		id: 'session_secret',
		label: 'Session secret',
		state: hasSessionSecret ? 'good' : 'bad',
		detail: hasSessionSecret
			? 'Set, so sign-ins and stored secrets survive a restart.'
			: 'Not set, so this server made one up when it started.',
		advice: hasSessionSecret
			? ''
			: deployed
				? 'Set SESSION_SECRET on the deployment. Until then every restart signs people out and makes stored secrets unreadable.'
				: 'Put SESSION_SECRET in app/.env. Without it, a key saved here stops being readable when the dev server restarts.'
	});

	// --- has anyone claimed this instance -----------------------------------
	const lock = await attempt(() =>
		db.asUser(userId, (tx) => tx.sql<{ state: { claimed: boolean } }>`select nl.admin_lock_state() as state`)
	);
	const claimed = lock?.[0]?.state.claimed ?? false;
	checks.push({
		id: 'claimed',
		label: 'Admin passcode',
		state: claimed ? 'good' : 'bad',
		detail: claimed ? 'Set. Changing a setting asks for it.' : 'Not set yet, so nobody owns this instance.',
		advice: claimed ? '' : 'Claim the instance at the top of this page. Until then anyone who finds it can.'
	});

	// --- stored secrets this server can still read --------------------------
	const stored = await attempt(() => loadSettings(db, env));
	const unreadable = stored ? [...stored.values()].filter((row) => row.unreadable).map((row) => row.key) : [];
	if (unreadable.length > 0) {
		checks.push({
			id: 'unreadable',
			label: 'Stored secrets',
			state: 'bad',
			detail: `${unreadable.length} cannot be read: ${unreadable.join(', ')}.`,
			advice: 'The session secret changed since they were saved. Paste each one again to replace it.'
		});
	} else {
		checks.push({
			id: 'unreadable',
			label: 'Stored secrets',
			state: 'good',
			detail: stored && stored.size > 0 ? `${stored.size} stored, all readable.` : 'None stored; the environment is used.',
			advice: ''
		});
	}

	// --- the model, and what Ask will do ------------------------------------
	const keySet = Boolean(
		(stored?.get('anthropic_api_key')?.value ?? '') || record[ENV_NAME.anthropic_api_key]
	);
	const mocked = record.ASSISTANT_MOCK === '1';
	checks.push({
		id: 'assistant',
		label: 'Ask Northline',
		state: 'neutral',
		detail: mocked
			? 'Scripted demo mode, forced by ASSISTANT_MOCK.'
			: keySet
				? 'A key is set, so Ask can use the real model.'
				: 'No key, so Ask answers in scripted demo mode.',
		advice: ''
	});

	// --- the three drift checks ---------------------------------------------
	const drift = await attempt(() =>
		db.asUser(userId, (tx) => tx.sql<DriftRow>`select nl.diagnostic_drift() as result`)
	);
	if (!drift) {
		checks.push({
			id: 'drift',
			label: 'Stored figures',
			state: 'bad',
			detail: 'The drift checks could not be run.',
			advice: 'Check that migration 0025 has been applied to this database.'
		});
	} else {
		const result = drift[0].result;
		checks.push({
			id: 'drift_delivery',
			label: 'Delivered figures',
			state: result.delivery === 0 ? 'good' : 'bad',
			detail:
				result.delivery === 0
					? 'Every commitment agrees with a fresh count.'
					: `${result.delivery} disagree with a fresh count.`,
			advice:
				result.delivery === 0
					? ''
					: 'Run the nightly job, which repairs delivery drift (nl.repair_delivery), then look again.'
		});
		checks.push({
			id: 'drift_warehouse',
			label: 'Stock on hand',
			state: result.warehouse === null ? 'neutral' : result.warehouse === 0 ? 'good' : 'bad',
			detail:
				result.warehouse === null
					? 'This database has no warehouse tables, so there is nothing to check.'
					: result.warehouse === 0
						? 'Bins, the item master and the movement ledger all agree.'
						: `${result.warehouse} parts or locations disagree with the movement ledger.`,
			advice: !result.warehouse ? '' : 'Look at nl.warehouse_drift() for the parts it names before trusting a stock figure.'
		});
		checks.push({
			id: 'drift_cost',
			label: 'Ledger cost',
			state: result.cost === 0 ? 'good' : 'bad',
			detail:
				result.cost === 0
					? `Every ledger line in the last ${result.cost_days} days carries the cost of its own day.`
					: `${result.cost} ledger lines in the last ${result.cost_days} days carry a cost from the wrong day.`,
			advice: result.cost === 0 ? '' : 'Margin history reads the cost on the line, so rebuild the world before quoting a margin.'
		});
	}

	// --- the last nightly run -----------------------------------------------
	const nightly = await attempt(() =>
		db.asUser(userId, (tx) => tx.sql<NightlyRow>`select nl.diagnostic_last_nightly() as result`)
	);
	const run = nightly?.[0]?.result;
	if (!run || run.source === 'none' || !run.at) {
		checks.push({
			id: 'nightly',
			label: 'Nightly rebuild',
			state: 'bad',
			detail: 'No run on the record.',
			advice:
				'On Supabase the pg_cron job in db/migrations/0012_nightly.supabase.sql does this. Locally the world rebuilds itself when the date changes, and nothing is recorded, which is expected.'
		});
	} else {
		const at = new Date(run.at);
		const stale = now.getTime() - at.getTime() > 48 * 3_600_000;
		const failed = run.status !== undefined && !['succeeded', 'recorded'].includes(run.status);
		checks.push({
			id: 'nightly',
			label: 'Nightly rebuild',
			state: stale || failed ? 'bad' : 'good',
			detail: `${run.source === 'cron' ? 'pg_cron' : 'the audit log'} says ${ago(at, now)}, ${run.status ?? 'unknown'}.`,
			advice:
				failed
					? `The last run did not finish: ${run.detail ?? 'no message'}. Run it by hand before the demo.`
					: stale
						? 'That is more than two days ago. The world is dated relative to today, so parts of the app will look wrong.'
						: ''
		});
	}

	// --- how big the database is --------------------------------------------
	const bytes = await attempt(() =>
		db.asUser(userId, (tx) => tx.sql<{ size: number }>`select nl.diagnostic_db_size() as size`)
	);
	checks.push({
		id: 'db_size',
		label: 'Database size',
		state: 'neutral',
		detail: bytes ? size(Number(bytes[0].size)) : 'could not be read',
		advice: ''
	});

	// --- row counts ----------------------------------------------------------
	const counted = await attempt(() =>
		db.asUser(userId, (tx) => tx.sql<{ counts: Record<string, number> }>`select nl.diagnostic_counts() as counts`)
	);
	const counts: TableCount[] = counted
		? Object.entries(counted[0].counts).map(([table, rows]) => ({ table, rows: Number(rows) }))
		: [];
	counts.sort((a, b) => b.rows - a.rows);

	// --- which environment variables are set --------------------------------
	// The names the settings fall back to, plus the few the app reads directly.
	// Only names and a set-or-not, except for values that are safe to show.
	// PGLITE_DIR is not a secret but it is a path on somebody's machine, so it
	// is reported as set or not set like the rest.
	const SHOWN = new Set(['ASSISTANT_MOCK', 'VERCEL_GIT_COMMIT_SHA', 'ANTHROPIC_MODEL']);
	const names = [
		...SETTING_KEYS.map((key) => ENV_NAME[key]),
		'DATABASE_URL',
		'SESSION_SECRET',
		'ASSISTANT_MOCK',
		'PGLITE_DIR',
		'VERCEL',
		'VERCEL_GIT_COMMIT_SHA'
	];
	const environment: EnvFlag[] = names.map((name) => ({
		name,
		set: Boolean(record[name]),
		shown: SHOWN.has(name) ? (record[name] ?? '') : ''
	}));

	return {
		version: record.VERCEL_GIT_COMMIT_SHA ? record.VERCEL_GIT_COMMIT_SHA.slice(0, 7) : 'local',
		ranAt: now.toISOString(),
		checks,
		counts,
		environment
	};
}
