// PGlite: real Postgres 17, compiled to WebAssembly, running inside this Node
// process. The app uses it when DATABASE_URL is not set, so anyone can clone
// the repo and run it with nothing else installed. Every database test runs
// against it too.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { PGlite, types, type Transaction } from '@electric-sql/pglite';
import { findDbDir, fingerprint, readMigrations, readSeed } from './files.ts';
import { fromTemplate, readonlySetup, roleSetup, type Db, type Param, type Row, type Tx } from './types.ts';

export type WorldSize = 'full' | 'demo' | 'small';

// The same JavaScript types the Supabase driver returns (see postgres.ts).
const parsers = {
	[types.DATE]: (raw: string) => raw,
	[types.NUMERIC]: (raw: string) => Number(raw),
	[types.INT8]: (raw: string) => Number(raw)
};

async function start(dataDir: string | undefined, today: string | undefined): Promise<PGlite> {
	// One options object: PGlite.create(undefined, options) would ignore the options.
	const pg = await PGlite.create({ dataDir, parsers });
	// Supabase runs in UTC, so this does too.
	await pg.exec(`set timezone = 'UTC'`);
	// A pinned "today" lasts for the whole session (see nl.today()).
	if (today) await pg.query(`select set_config('nl.today', $1, false)`, [today]);
	return pg;
}

/** Create the schema from db/migrations, then load the world generator from db/seed.sql. */
async function applySchema(pg: PGlite): Promise<void> {
	const dbDir = findDbDir();
	// Each exec() runs one file as a single transaction, so a failed
	// migration leaves nothing half-applied.
	for (const migration of readMigrations(dbDir)) {
		try {
			await pg.exec(migration.sql);
		} catch (error) {
			throw new Error(`Migration ${migration.name} failed: ${(error as Error).message}`, { cause: error });
		}
	}
	await pg.exec(readSeed(dbDir).sql);
}

function makeDb(pg: PGlite, beforeEach?: () => Promise<void>): Db {
	function wrap(tx: Transaction): Tx {
		async function query<T extends object = Row>(text: string, params: readonly Param[] = []) {
			const result = await tx.query<T>(text, [...params]);
			return result.rows;
		}
		return {
			query,
			sql: <T extends object = Row>(strings: TemplateStringsArray, ...values: Param[]) => {
				const q = fromTemplate(strings, values);
				return query<T>(q.text, q.params);
			}
		};
	}

	async function transaction<T>(
		setup: { text: string; params: Param[] }[],
		work: (tx: Tx) => Promise<T>
	): Promise<T> {
		if (beforeEach) await beforeEach();
		// PGlite has one connection. transaction() queues behind any other
		// transaction, commits when work resolves and rolls back if it throws.
		return pg.transaction(async (tx) => {
			for (const step of setup) {
				await tx.query(step.text, step.params);
			}
			return work(wrap(tx));
		});
	}

	return {
		kind: 'pglite',
		asUser: (userId, work) => transaction(roleSetup(userId), work),
		asVisitor: (work) => transaction(roleSetup(null), work),
		asReadonly: (work) => transaction(readonlySetup(), work),
		asSystem: (work) => transaction([], work),
		close: () => pg.close()
	};
}

/**
 * A throwaway in-memory database with the schema and a world, for tests.
 * The nightly job has not run yet, so a test can run it and watch.
 */
export async function createTestDb(
	options: { size?: WorldSize; today?: string } = {}
): Promise<Db & { pg: PGlite }> {
	const pg = await start(undefined, options.today ?? '2026-09-17');
	await applySchema(pg);
	await pg.query('select nl.build($1)', [options.size ?? 'small']);
	return Object.assign(makeDb(pg), { pg });
}

interface BuildInfo {
	fingerprint: string;
	built_on: string;
	today: string;
}

async function readBuildInfo(pg: PGlite): Promise<BuildInfo | null> {
	try {
		const result = await pg.query<BuildInfo>(
			'select fingerprint, built_on, nl.today() as today from public.nl_local_build'
		);
		return result.rows[0] ?? null;
	} catch {
		return null; // no schema yet
	}
}

/** Empty the schema, build today's world, then do what the nightly job does. */
async function rebuildWorld(
	pg: PGlite,
	size: WorldSize,
	stamp: string,
	log: (message: string) => void
): Promise<void> {
	const started = Date.now();
	await pg.query('select nl.reset()');
	const built = await pg.query<{ result: Record<string, unknown> }>('select nl.build($1) as result', [size]);
	await pg.query('select nl.answer_pushed_windows()');
	await pg.exec(`
		create table if not exists public.nl_local_build (fingerprint text not null, built_on date not null);
		delete from public.nl_local_build;
	`);
	await pg.query('insert into public.nl_local_build values ($1, nl.today())', [stamp]);
	const seconds = ((Date.now() - started) / 1000).toFixed(1);
	log(`world built in ${seconds}s: ${JSON.stringify(built.rows[0].result)}`);
}

/**
 * The local database behind `npm run dev` when DATABASE_URL is not set. It
 * lives in a folder so restarts are quick. The world is rebuilt when the
 * date changes (everything in it is dated relative to today), and the whole
 * database is recreated when a migration or the seed changes.
 */
export async function openLocalDb(options: {
	dataDir: string;
	size?: WorldSize;
	log?: (message: string) => void;
}): Promise<Db> {
	const log = options.log ?? ((message: string) => console.log(`[local db] ${message}`));
	const size = options.size ?? 'demo';
	const dbDir = findDbDir();
	const stamp = `${fingerprint([...readMigrations(dbDir), readSeed(dbDir)])}:${size}`;

	let pg: PGlite | null = existsSync(options.dataDir) ? await start(options.dataDir, undefined) : null;
	const info = pg ? await readBuildInfo(pg) : null;

	if (!pg || !info || info.fingerprint !== stamp) {
		if (pg) await pg.close();
		rmSync(options.dataDir, { recursive: true, force: true });
		mkdirSync(options.dataDir, { recursive: true });
		log(`creating ${options.dataDir} (the first run takes a minute or two)`);
		pg = await start(options.dataDir, undefined);
		await applySchema(pg);
		await rebuildWorld(pg, size, stamp, log);
	} else if (info.built_on !== info.today) {
		log('a new day: rebuilding the world');
		await rebuildWorld(pg, size, stamp, log);
	}

	// A dev server can run past midnight, so look at the date again at most once a minute.
	const db = pg;
	let checkedAt = Date.now();
	let rebuilding: Promise<void> | null = null;
	async function keepFresh() {
		if (rebuilding) return rebuilding;
		if (Date.now() - checkedAt < 60_000) return;
		checkedAt = Date.now();
		const current = await readBuildInfo(db);
		if (current && current.built_on !== current.today) {
			rebuilding = rebuildWorld(db, size, stamp, log).finally(() => {
				rebuilding = null;
			});
			return rebuilding;
		}
	}

	return makeDb(db, keepFresh);
}
