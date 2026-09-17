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
//
// Two speeds, and the difference is the point (migration 0027):
//
//   readHealth        what the page streams in on every load. Bounded work:
//                     row estimates out of the planner's own statistics, and a
//                     sample for the cost check. Nothing reads a whole table.
//   readExactChecks   the drift checks, which read everything by design. They
//                     run only when somebody follows the link, and they carry
//                     their own statement timeout.
//
// Before this split, /settings counted every row of the full world before it
// answered, which took about fourteen seconds.
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
	/** How long these checks took, in milliseconds. Shown on the page. */
	ms: number;
	checks: HealthCheck[];
	/** Estimates, not counts. See migration 0027. */
	counts: TableCount[];
	/** Environment variables the app reads, and whether they are set. Never their values. */
	environment: EnvFlag[];
}

/** The exact drift checks, run on request. */
export interface ExactChecks {
	ranAt: string;
	/** How long the database spent on them. */
	ms: number;
	checks: HealthCheck[];
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

/** Run one read and turn a failure into null rather than an error page. */
async function attempt<T>(work: () => Promise<T>): Promise<T | null> {
	try {
		return await work();
	} catch {
		return null;
	}
}

interface CostRow {
	result: { sampled: boolean; checked: number; found: number };
}

interface ExactRow {
	result: { delivery: number; warehouse: number | null; cost: number; ms: number };
}

interface NightlyRow {
	result: { source: 'cron' | 'audit' | 'none'; at?: string; status?: string; detail?: string };
}

/** The delivered figures against a fresh count. Exact, and slow on the full world. */
function deliveryCheck(count: number): HealthCheck {
	return {
		id: 'drift_delivery',
		label: 'Delivered figures',
		state: count === 0 ? 'good' : 'bad',
		detail: count === 0 ? 'Every commitment agrees with a fresh count.' : `${count} disagree with a fresh count.`,
		advice:
			count === 0 ? '' : 'Run the nightly job, which repairs delivery drift (nl.repair_delivery), then look again.'
	};
}

/** Bins and the item master against the movement ledger. Null where there is no warehouse. */
function warehouseCheck(count: number | null): HealthCheck {
	return {
		id: 'drift_warehouse',
		label: 'Stock on hand',
		state: count === null ? 'neutral' : count === 0 ? 'good' : 'bad',
		detail:
			count === null
				? 'This database has no warehouse tables, so there is nothing to check.'
				: count === 0
					? 'Bins, the item master and the movement ledger all agree.'
					: `${count} parts or locations disagree with the movement ledger.`,
		advice: !count ? '' : 'Look at nl.warehouse_drift() for the parts it names before trusting a stock figure.'
	};
}

export async function readHealth(db: Db, userId: number, env: SettingsEnv = currentEnv()): Promise<Diagnostics> {
	const started = Date.now();
	const now = new Date();
	const checks: HealthCheck[] = [];
	const record = env.record;
	const deployed = Boolean(record.VERCEL);

	// Every read at once. They do not depend on each other, and waiting for
	// them one after another would add a round trip each.
	const [lock, stored, cost, nightly, bytes, estimates] = await Promise.all([
		attempt(() =>
			db.asUser(userId, (tx) => tx.sql<{ state: { claimed: boolean } }>`select nl.admin_lock_state() as state`)
		),
		attempt(() => loadSettings(db, env)),
		attempt(() => db.asUser(userId, (tx) => tx.sql<CostRow>`select nl.diagnostic_cost_drift() as result`)),
		attempt(() => db.asUser(userId, (tx) => tx.sql<NightlyRow>`select nl.diagnostic_last_nightly() as result`)),
		attempt(() => db.asUser(userId, (tx) => tx.sql<{ size: number }>`select nl.diagnostic_db_size() as size`)),
		attempt(() =>
			db.asUser(
				userId,
				(tx) => tx.sql<{ counts: Record<string, number> }>`select nl.diagnostic_row_estimates() as counts`
			)
		)
	]);

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
	const claimed = lock?.[0]?.state.claimed ?? false;
	checks.push({
		id: 'claimed',
		label: 'Admin passcode',
		state: claimed ? 'good' : 'bad',
		detail: claimed ? 'Set. Changing a setting asks for it.' : 'Not set yet, so nobody owns this instance.',
		advice: claimed ? '' : 'Claim the instance at the top of this page. Until then anyone who finds it can.'
	});

	// --- stored secrets this server can still read --------------------------
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
			detail:
				stored && stored.size > 0 ? `${stored.size} stored, all readable.` : 'None stored; the environment is used.',
			advice: ''
		});
	}

	// --- the model, and what Ask will do ------------------------------------
	const keySet = Boolean((stored?.get('anthropic_api_key')?.value ?? '') || record[ENV_NAME.anthropic_api_key]);
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

	// --- the ledger's cost, on a sample -------------------------------------
	// A restamp that did not run leaves the whole ledger claiming today's
	// cost, so a sample of five hundred lines finds it at once. The exact
	// count is behind the link at the bottom of this section.
	if (!cost) {
		checks.push({
			id: 'drift_cost',
			label: 'Ledger cost',
			state: 'bad',
			detail: 'The cost check could not be run.',
			advice: 'Check that migrations 0025 and 0027 have been applied to this database.'
		});
	} else {
		const result = cost[0].result;
		checks.push({
			id: 'drift_cost',
			label: 'Ledger cost',
			state: result.found === 0 ? 'good' : 'bad',
			detail:
				result.found === 0
					? `A sample of ${result.checked} ledger lines all carry the cost of their own day.`
					: `${result.found} of ${result.checked} sampled ledger lines carry a cost from the wrong day.`,
			advice:
				result.found === 0
					? ''
					: 'Margin history reads the cost on the line, so rebuild the world before quoting a margin.'
		});
	}

	// --- the last nightly run -----------------------------------------------
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
			advice: failed
				? `The last run did not finish: ${run.detail ?? 'no message'}. Run it by hand before the demo.`
				: stale
					? 'That is more than two days ago. The world is dated relative to today, so parts of the app will look wrong.'
					: ''
		});
	}

	// --- how big the database is --------------------------------------------
	checks.push({
		id: 'db_size',
		label: 'Database size',
		state: 'neutral',
		detail: bytes ? size(Number(bytes[0].size)) : 'could not be read',
		advice: ''
	});

	// --- how big the world is, estimated ------------------------------------
	const counts: TableCount[] = estimates
		? Object.entries(estimates[0].counts).map(([table, rows]) => ({ table, rows: Number(rows) }))
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
		'SITE_PASSWORD',
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
		ms: Date.now() - started,
		checks,
		counts,
		environment
	};
}

/**
 * The exact drift checks: every commitment against a fresh count, stock
 * against the movement ledger, every ledger line against the cost timeline.
 *
 * These read whole tables, which is why they are not on the page by default.
 * The SQL function carries a thirty second statement timeout, so a run that
 * cannot finish gives up instead of holding a connection.
 */
export async function readExactChecks(db: Db, userId: number): Promise<ExactChecks> {
	const started = Date.now();
	const rows = await attempt(() =>
		db.asUser(userId, (tx) => tx.sql<ExactRow>`select nl.diagnostic_drift_exact() as result`)
	);
	if (!rows) {
		return {
			ranAt: new Date().toISOString(),
			ms: Date.now() - started,
			checks: [
				{
					id: 'exact',
					label: 'The exact checks',
					state: 'bad',
					detail: 'They did not finish.',
					advice:
						'They stop after thirty seconds. Either the database is busy, or migration 0027 has not been applied here.'
				}
			]
		};
	}
	const result = rows[0].result;
	return {
		ranAt: new Date().toISOString(),
		ms: Number(result.ms),
		checks: [
			deliveryCheck(Number(result.delivery)),
			warehouseCheck(result.warehouse === null ? null : Number(result.warehouse)),
			{
				id: 'drift_cost_exact',
				label: 'Ledger cost, every line',
				state: Number(result.cost) === 0 ? 'good' : 'bad',
				detail:
					Number(result.cost) === 0
						? 'Every line in the ledger carries the cost of its own day.'
						: `${result.cost} lines carry a cost from the wrong day.`,
				advice:
					Number(result.cost) === 0
						? ''
						: 'Margin history reads the cost on the line, so rebuild the world before quoting a margin.'
			}
		]
	};
}
