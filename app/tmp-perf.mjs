// Throwaway: time the roll-up and print explain output for the measure pass.
import { PGlite, types } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dbDir = 'C:/Users/OSchoeniger/Downloads/grcrm-mfg/db';
const parsers = {
	[types.DATE]: (raw) => raw,
	[types.NUMERIC]: (raw) => Number(raw),
	[types.INT8]: (raw) => Number(raw)
};
const pg = await PGlite.create({ parsers });
await pg.exec(`set timezone = 'UTC'`);
await pg.query(`select set_config('nl.today', $1, false)`, ['2026-09-17']);
for (const f of readdirSync(join(dbDir, 'migrations'))
	.filter((f) => f.endsWith('.sql') && !f.endsWith('.supabase.sql'))
	.sort()) {
	await pg.exec(readFileSync(join(dbDir, 'migrations', f), 'utf8'));
}
await pg.exec(readFileSync(join(dbDir, 'seed.sql'), 'utf8'));
for (const f of readdirSync(join(dbDir, 'seed.d'))
	.filter((f) => /^\d{2}_[a-z0-9_]+\.sql$/.test(f))
	.sort()) {
	await pg.exec(readFileSync(join(dbDir, 'seed.d', f), 'utf8'));
}
let t = Date.now();
await pg.query('select nl.build($1)', [process.env.WORLD ?? 'small']);
console.log(`build ${((Date.now() - t) / 1000).toFixed(1)}s`);

for (let i = 0; i < 2; i++) {
	t = Date.now();
	const r = await pg.query('select nl.measure_all_items() as n');
	console.log(`measure_all_items #${i + 1}: ${Date.now() - t}ms  rows ${r.rows[0].n}`);
}
t = Date.now();
await pg.query('select count(*) from nl.rollup_drift()');
console.log(`rollup_drift: ${Date.now() - t}ms`);

t = Date.now();
await pg.query(`select nl.item_truth('K-2408', 4)`);
console.log(`item_truth: ${Date.now() - t}ms`);

async function explain(label, sql) {
	const r = await pg.query(`explain (analyze, buffers) ${sql}`);
	console.log(`\n--- ${label}`);
	console.log(r.rows.map((x) => x['QUERY PLAN']).join('\n'));
}
await explain('item_cost_rollup on the deepest part', `select * from nl.item_cost_rollup('K-2408')`);
await explain('item_lead_time_rollup', `select * from nl.item_lead_time_rollup('K-2408')`);
await explain('item_own_cost_lines whole catalogue', `select count(*) from nl.item_own_cost_lines`);
await explain('item_where_used from a raw tube', `select * from nl.item_where_used('RM-TU-0500-14-AL')`);
await explain('item_cost_variance', `select count(*) from nl.item_cost_variance`);
await explain('work_center_load_now', `select * from nl.work_center_load_now`);
await pg.close();
