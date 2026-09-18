// Throwaway probe: build a world, then ask the manufacturing model the
// questions the demo asks. Deleted before the branch is pushed.
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
	try {
		await pg.exec(readFileSync(join(dbDir, 'seed.d', f), 'utf8'));
	} catch (e) {
		console.log(`FAIL seed.d/${f}: ${e.message}`);
		process.exit(1);
	}
}
const t0 = Date.now();
await pg.query('select nl.build($1)', [process.env.WORLD ?? 'small']);
console.log(`world built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

async function show(label, sql, params = []) {
	try {
		const r = await pg.query(sql, params);
		console.log(`\n## ${label}`);
		console.log(JSON.stringify(r.rows, null, 1).slice(0, 3000));
	} catch (e) {
		console.log(`\n## ${label}\nERROR ${e.message}`);
	}
}

await show(
	'counts',
	`select
     (select count(*) from nl.items) as items,
     (select count(*) from nl.bom_lines) as bom_lines,
     (select count(*) from nl.routing_operations) as ops,
     (select count(*) from nl.item_cost_rolled) as costed,
     (select count(*) from nl.item_lead_rolled) as leaded,
     (select count(*) from nl.work_centers) as cells,
     (select count(*) from nl.machines) as machines,
     (select count(*) from nl.overhead_pools) as pools,
     (select count(*) from nl.uoms) as uoms,
     (select count(*) from nl.skus) as skus,
     (select count(*) from nl.item_material) as materials,
     (select count(*) from nl.item_sources) as sources,
     (select count(*) from nl.lots) as lots`
);
await show('depth histogram', `select levels, count(*) from nl.item_cost_rolled group by levels order by levels`);
await show('shapes', `select shape, count(*) from nl.item_supply_shape group by shape order by 2 desc`);
await show(
	'disagreements with the ERP word',
	`select shape, replenishment, count(*) from nl.item_supply_shape where not agrees_with_erp group by 1,2`
);
await show('rollup gaps', `select count(*) as gaps from nl.rollup_gaps()`);

// The deepest part, and whether its breakdown ties to its stored total.
const deep = await pg.query(
	`select item_no, levels, rolled_cost from nl.item_cost_rolled order by levels desc, rolled_cost desc limit 5`
);
console.log('\n## deepest parts', JSON.stringify(deep.rows));
for (const row of deep.rows) {
	await show(
		`tie to the cent: ${row.item_no} (levels ${row.levels})`,
		`select round(c.rolled_cost, 2) as stored,
            round((select sum(amount) from nl.item_cost_rollup($1)), 2) as breakdown,
            round(c.rolled_cost, 2) - round((select sum(amount) from nl.item_cost_rollup($1)), 2) as delta
     from nl.item_cost_rolled c where c.item_no = $1`,
		[row.item_no]
	);
	await show(
		`lead time: ${row.item_no}`,
		`select own_days, lead_days, basis, critical_child, critical_path from nl.item_lead_rolled where item_no = $1`,
		[row.item_no]
	);
}
await show(
	'worst cent deltas across the catalogue',
	`select c.item_no, c.levels, round(c.rolled_cost,2) as stored,
          round(b.total,2) as breakdown, round(c.rolled_cost,2) - round(b.total,2) as delta
   from nl.item_cost_rolled c
   cross join lateral (select sum(amount) as total from nl.item_cost_rollup(c.item_no)) b
   where c.levels > 0
   order by abs(round(c.rolled_cost,2) - round(coalesce(b.total,0),2)) desc, c.item_no
   limit 8`
);
await show('drift', `select count(*) as drifted from nl.rollup_drift()`);
await show(
	'lead basis spread',
	`select basis, count(*), min(lead_days), round(avg(lead_days),1) as avg, max(lead_days) from nl.item_lead_rolled group by basis order by 2 desc`
);
await pg.close();
