// Finds the repo's db/ folder and reads the migrations and the seed from it.
// Only the local PGlite database and the tests use this: on Supabase the
// migrations are applied once, ahead of time.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface SqlFile {
	name: string;
	sql: string;
}

/** db/ sits next to app/. NL_DB_DIR overrides the search. */
export function findDbDir(): string {
	const candidates = [
		process.env.NL_DB_DIR,
		resolve(process.cwd(), '..', 'db'),
		resolve(process.cwd(), 'db')
	];
	for (const dir of candidates) {
		if (dir && existsSync(join(dir, 'migrations'))) return dir;
	}
	throw new Error(`Could not find the db/ folder (looked in ${candidates.filter(Boolean).join(', ')}).`);
}

/**
 * Migrations in order. A file named NNNN_name.supabase.sql uses something
 * only Supabase has (pg_cron, for one), so PGlite and the tests skip it.
 */
export function readMigrations(dbDir: string): SqlFile[] {
	const dir = join(dbDir, 'migrations');
	return readdirSync(dir)
		.filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
		.sort()
		.map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

export function readSeed(dbDir: string): SqlFile {
	return { name: 'seed.sql', sql: readFileSync(join(dbDir, 'seed.sql'), 'utf8') };
}

/** Changes whenever a migration or the seed changes, so a stale local database gets rebuilt. */
export function fingerprint(files: SqlFile[]): string {
	const hash = createHash('sha256');
	for (const file of files) {
		hash.update(file.name).update('\0').update(file.sql).update('\0');
	}
	return hash.digest('hex').slice(0, 16);
}
