import { PGlite, types } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const dbDir = 'C:/Users/OSchoeniger/Downloads/grcrm-mfg/db';
const parsers = { [types.DATE]: (r) => r, [types.NUMERIC]: Number, [types.INT8]: Number };
const pg = await PGlite.create({ parsers });
await pg.exec(`set timezone = 'UTC'`);
await pg.query(`select set_config('nl.today', $1, false)`, ['2026-09-17']);
for (const f of readdirSync(join(dbDir, 'migrations')).filter((f) => f.endsWith('.sql') && !f.endsWith('.supabase.sql')).sort())
	await pg.exec(readFileSync(join(dbDir, 'migrations', f), 'utf8'));
await pg.exec(readFileSync(join(dbDir, 'seed.sql'), 'utf8'));
for (const f of readdirSync(join(dbDir, 'seed.d')).filter((f) => /^\d{2}_[a-z0-9_]+\.sql$/.test(f)).sort())
	await pg.exec(readFileSync(join(dbDir, 'seed.d', f), 'utf8'));
await pg.query('select nl.build($1)', ['small']);
async function show(l, s, p = []) { try { const r = await pg.query(s, p); console.log(`\n## ${l}\n` + JSON.stringify(r.rows, null, 1).slice(0, 2500)); } catch (e) { console.log(`\n## ${l}\nERROR ${e.message}`); } }
let t = Date.now();
await show('one part lead_time_for', `select * from nl.lead_time_for('RM-TU-0500-14-AL', nl.today())`);
console.log('single call ms', Date.now() - t);
t = Date.now();
const r = await pg.query(`select count(*) as n, count(*) filter (where basis='observed') as observed,
  count(*) filter (where basis='quoted') as quoted, count(*) filter (where basis='item card') as card,
  count(*) filter (where basis='vendor default') as vdef, count(*) filter (where basis='default') as def,
  count(*) filter (where basis='exception') as exc
  from nl.items i cross join lateral nl.lead_time_for(i.item_no, nl.today()) l`);
console.log('all parts lead_time_for ms', Date.now() - t, JSON.stringify(r.rows[0]));
await show('receipts', `select count(*) as receipts, count(distinct (vendor_no, item_no)) as pairs from nl.purchase_receipts`);
await show('min receipts / percentile', `select nl.promise_min_receipts() as min_receipts, nl.promise_percentile() as pct`);
await show('leaves only', `select count(*) as leaves from nl.items i where not exists (select 1 from nl.bom_lines b where b.parent_item=i.item_no and not b.is_substitute)`);
t = Date.now();
await pg.query(`select count(*) from nl.items i where not exists (select 1 from nl.bom_lines b where b.parent_item=i.item_no and not b.is_substitute) and (select days from nl.lead_time_for(i.item_no, nl.today())) > 0`);
console.log('leaves only lead_time_for ms', Date.now() - t);
await pg.close();
