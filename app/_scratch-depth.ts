// Scratch: apply the migrations (and optionally build a world) to check SQL.
// Not part of the project. Delete before committing.
import { PGlite, types } from '@electric-sql/pglite';
import { findDbDir, readMigrations, readSeed } from './src/lib/server/db/files.ts';

const size = process.argv[2] ?? 'none';
const parsers = {
	[types.DATE]: (r: string) => r,
	[types.NUMERIC]: (r: string) => Number(r),
	[types.INT8]: (r: string) => Number(r)
};
const pg = await PGlite.create({ parsers });
await pg.exec(`set timezone = 'UTC'`);
await pg.query(`select set_config('nl.today', '2026-09-17', false)`);
const dbDir = findDbDir();
for (const m of readMigrations(dbDir)) {
	try {
		await pg.exec(m.sql);
	} catch (e) {
		console.error(`FAILED ${m.name}: ${(e as Error).message}`);
		process.exit(1);
	}
}
await pg.exec(readSeed(dbDir).sql);
console.log('schema + seed helpers applied');

if (size !== 'none') {
	const started = Date.now();
	const built = await pg.query<{ result: unknown }>('select nl.build($1) as result', [size]);
	console.log(`built ${size} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
	console.log(JSON.stringify(built.rows[0].result, null, 1));
	const extra = await pg.query(`
		select
		  (select count(*) from nl.quote_revisions) as revisions,
		  (select count(*) from nl.quote_revision_lines) as revision_lines,
		  (select count(*) from nl.requirements) as requirements,
		  (select count(*) from nl.next_steps) as steps,
		  (select count(*) from nl.next_steps where source = 'agent') as agent_steps,
		  (select count(*) from nl.commitment_outcomes) as outcomes,
		  (select count(*) from nl.activities where commitment_id is not null) as commitment_activity`);
	console.log(extra.rows[0]);
}
await pg.close();
