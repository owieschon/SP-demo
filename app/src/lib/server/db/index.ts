// The app's one database handle.
//
// With DATABASE_URL set (Supabase), queries go to Postgres through the
// transaction pooler. Without it, the app runs on a local PGlite database in
// app/.pglite, built from db/migrations and db/seed.sql on first use.
import { env } from '$env/dynamic/private';
import type { Db } from './types.ts';

export type { Db, Tx, Param, Row } from './types.ts';

// Kept on globalThis so the dev server's hot reload reuses the open database
// instead of opening the same PGlite folder twice.
const cache = globalThis as typeof globalThis & { __northlineDb?: Promise<Db> };

export function getDb(): Promise<Db> {
	if (!cache.__northlineDb) {
		cache.__northlineDb = open().catch((error: unknown) => {
			// Do not cache a failure: the next request tries again.
			cache.__northlineDb = undefined;
			throw error;
		});
	}
	return cache.__northlineDb;
}

async function open(): Promise<Db> {
	if (env.DATABASE_URL) {
		const { createPostgresDb } = await import('./postgres.ts');
		return createPostgresDb(env.DATABASE_URL);
	}
	const { openLocalDb } = await import('./pglite.ts');
	return openLocalDb({ dataDir: env.PGLITE_DIR || '.pglite' });
}
