// Apply the schema and the world generator to the Supabase database named by
// DATABASE_URL, over the same connection the app uses.
//
//   node --env-file=.env scripts/db-remote.ts status     what is applied, what is pending
//   node --env-file=.env scripts/db-remote.ts migrate    apply pending migrations, in order
//   node --env-file=.env scripts/db-remote.ts migrate 0011   ... up to and including 0011
//   node --env-file=.env scripts/db-remote.ts seed       load db/seed.sql and db/seed.d (functions only)
//   node --env-file=.env scripts/db-remote.ts rebuild    reset and build the full world, step by step
//
// Each migration runs in its own transaction and is recorded in
// supabase_migrations.schema_migrations, the same table Supabase's own tools
// write, so the dashboard's migration list stays true. Nothing here prints
// the connection string.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { findDbDir, readMigrations, readSeed } from '../src/lib/server/db/files.ts';

const url = process.env.DATABASE_URL;
if (!url) {
	console.error('DATABASE_URL is not set. Run with: node --env-file=.env scripts/db-remote.ts <command>');
	process.exit(1);
}

// Session-level settings are fine here: this script holds its one connection.
const sql = postgres(url, { prepare: false, max: 1, onnotice: () => {}, connection: { statement_timeout: 600000 } });
const dbDir = findDbDir();
const command = process.argv[2] ?? 'status';

/** How a migration file is named in the history: 0012_nightly.supabase.sql -> 0012_nightly_supabase. */
function historyName(fileName: string): string {
	return fileName.replace(/\.sql$/, '').replace(/\./g, '_');
}

function digest(text: string): string {
	return createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 12);
}

/** Every migration file, including the Supabase-only ones PGlite skips. */
function allMigrations() {
	const plain = readMigrations(dbDir);
	const supabaseOnly = readSupabaseOnly();
	return [...plain, ...supabaseOnly].sort((a, b) => a.name.localeCompare(b.name));
}

/** readMigrations() leaves out *.supabase.sql on purpose (PGlite cannot run them); read them here. */
function readSupabaseOnly() {
	const dir = join(dbDir, 'migrations');
	return readdirSync(dir)
		.filter((name) => /^\d{4}_[a-z0-9_]+\.supabase\.sql$/.test(name))
		.map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

async function applied(): Promise<Map<string, string[]>> {
	const rows = await sql<{ name: string; statements: string[] | null }[]>`
		select name, statements from supabase_migrations.schema_migrations order by version`;
	return new Map(rows.map((r) => [r.name, r.statements ?? []]));
}

async function status() {
	const done = await applied();
	for (const file of allMigrations()) {
		const name = historyName(file.name);
		const stored = done.get(name);
		if (!stored) {
			console.log(`pending   ${file.name}`);
		} else {
			const same = digest(stored.join('\n')) === digest(file.sql);
			console.log(`${same ? 'applied  ' : 'DIFFERS  '} ${file.name}`);
		}
	}
}

async function migrate(until: string | undefined) {
	const done = await applied();
	for (const file of allMigrations()) {
		const name = historyName(file.name);
		if (until && file.name.slice(0, 4) > until) break;
		if (done.has(name)) continue;
		const started = Date.now();
		await sql.begin(async (tx) => {
			await tx.unsafe(file.sql);
			await tx`
				insert into supabase_migrations.schema_migrations (version, name, statements)
				values (to_char(clock_timestamp() at time zone 'UTC', 'YYYYMMDDHH24MISS'), ${name}, ${[file.sql]})`;
		});
		console.log(`applied   ${file.name} in ${Date.now() - started} ms`);
		// Versions are timestamps to the second; keep them distinct.
		await new Promise((resolve) => setTimeout(resolve, 1100));
	}
}

async function seed() {
	const started = Date.now();
	await sql.unsafe(readSeed(dbDir).sql);
	console.log(`seed functions loaded in ${Date.now() - started} ms`);
}

async function step(label: string, text: string) {
	const started = Date.now();
	const rows = await sql.unsafe(text);
	const value = rows[0] ? Object.values(rows[0])[0] : '';
	const summary = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
	console.log(`${label.padEnd(22)} ${String(Date.now() - started).padStart(6)} ms  ${summary.slice(0, 160)}`);
}

async function rebuild() {
	await step('reset', 'select nl.reset()');
	await step('begin_build', "select nl_seed.begin_build('full')");
	const [{ first_year, last_year }] = await sql<{ first_year: number; last_year: number }[]>`
		select first_year, last_year from nl_seed.settings`;
	for (let year = first_year; year <= last_year; year++) {
		await step(`build_year ${year}`, `select nl_seed.build_year(${year})`);
	}
	await step('finish_build', 'select nl_seed.finish_build()');
	await step('answer_pushed', 'select nl.answer_pushed_windows()');
	await step('repair_delivery', 'select nl.repair_delivery()');
	await step('analyze', 'analyze');
}

try {
	if (command === 'status') await status();
	else if (command === 'migrate') await migrate(process.argv[3]);
	else if (command === 'seed') await seed();
	else if (command === 'rebuild') await rebuild();
	else throw new Error(`Unknown command ${command}. Use status, migrate, seed or rebuild.`);
} catch (error) {
	// Postgres errors carry no connection details; print the message only.
	console.error(`failed: ${(error as Error).message}`);
	process.exitCode = 1;
} finally {
	await sql.end({ timeout: 5 });
}
