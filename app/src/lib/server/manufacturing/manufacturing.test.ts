// The manufacturing model: does the rolled cost add up, does the critical
// path come out of arithmetic rather than a guess, and do the triggers keep
// both current.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The
// first group reads the world the seed built. The second builds a three
// level tree of its own (everything prefixed MF-) whose rolled cost and
// critical path are worked out by hand in the test, so a mistake in the SQL
// shows up as a number and not as a shrug. The mutation tests each put back
// what they changed and then require nl.rollup_drift() to be empty, which is
// the check that the triggers re-measured exactly what they should have.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { getManufacturingBoard, getPartManufacturing } from './read.ts';

const PRIYA = 5; // operations
const DANA = 2; // account manager

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

/** The pool rates the seed set, read rather than assumed. */
interface Rates {
	loaded: number;
	laborHourPools: number;
	materialValue: number;
}

async function rates(): Promise<Rates> {
	return db.asSystem(async (tx) => {
		const [loaded] = await tx.sql<{ base_wage: number; loaded_rate: number }>`
			select * from nl.labor_rate_on('MFTEST', nl.today())`;
		// Pools that reach the fixture's cell: plant-wide ones only, because
		// its department is its own.
		const [pools] = await tx.sql<{ labor_hours: number; material_value: number }>`
			select
				coalesce(sum(rate) filter (where driver = 'labor hours'), 0)    as labor_hours,
				coalesce(sum(rate) filter (where driver = 'material value'), 0) as material_value
			from nl.overhead_rates_current
			where department = ''`;
		return {
			loaded: Number(loaded?.loaded_rate ?? 0),
			laborHourPools: Number(pools.labor_hours),
			materialValue: Number(pools.material_value)
		};
	});
}

// ---------------------------------------------------------------------------
// What the seed built
// ---------------------------------------------------------------------------

describe('the plant the seed builds', () => {
	it('gives every part a rolled cost and a rolled lead time', async () => {
		const gaps = await db.asSystem((tx) => tx.sql`select * from nl.rollup_gaps()`);
		expect(gaps).toEqual([]);
	});

	it('has no drift between the stored roll-ups and a recount from scratch', async () => {
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.rollup_drift()`);
		expect(drift).toEqual([]);
	});

	it('resolves every work centre the item master names', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ unknown_cells: number; cells: number }>`
				select
				  (select count(distinct i.work_center)::int
				   from nl.items i
				   where i.work_center <> ''
				     and not exists (select 1 from nl.work_centers w where w.code = i.work_center))
				    as unknown_cells,
				  (select count(*)::int from nl.work_centers) as cells`
		);
		expect(row.unknown_cells).toBe(0);
		expect(row.cells).toBeGreaterThanOrEqual(8);
	});

	it('gives every part the plant makes a routing, and every kit a parts list', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ made_without_routing: number; kits_without_bom: number; made: number }>`
				select
				  (select count(*)::int
				   from nl.items i
				   where i.replenishment in ('Prod. Order', 'Assembly')
				     and not exists (select 1 from nl.routing_operations r where r.item_no = i.item_no))
				    as made_without_routing,
				  (select count(*)::int
				   from nl.items i
				   where i.family = 'kit'
				     and not exists (select 1 from nl.bom_lines b where b.parent_item = i.item_no))
				    as kits_without_bom,
				  (select count(*)::int from nl.items where replenishment in ('Prod. Order', 'Assembly')) as made`
		);
		expect(row.made).toBeGreaterThan(50);
		expect(row.made_without_routing).toBe(0);
		expect(row.kits_without_bom).toBe(0);
	});

	it('disagrees with the ERP only in the two ways the seed intends', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ shape: string; replenishment: string; n: number }>`
				select shape, replenishment, count(*)::int as n
				from nl.item_supply_shape
				where not agrees_with_erp
				group by shape, replenishment
				order by shape, replenishment`
		);
		// Two groups, both deliberate (db/seed.d/95_manufacturing.sql):
		//   a chrome part the ERP calls a purchase that we polish and plate
		//   a custom part the ERP calls an assembly that we weld from tube
		expect(rows.map((r) => `${r.shape}/${r.replenishment}`)).toEqual([
			'manufactured/Assembly',
			'processed/Purchase'
		]);
		for (const row of rows) expect(row.n).toBeGreaterThan(0);
	});

	it('writes a sentence about each part that a person can read', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ item_no: string; shape: string; sentence: string }>`
				select item_no, shape, sentence
				from nl.item_supply_shape
				where shape = 'manufactured' and outside_steps > 0
				order by item_no
				limit 1`
		);
		expect(row.sentence).toMatch(/^Manufactured from /);
		expect(row.sentence).toContain('outside step');
		expect(row.sentence).not.toContain('null');
	});

	it('derives a machine hour rate from what the machine cost', async () => {
		const [robot] = await db.asSystem(
			(tx) => tx.sql<{
				acquisition_cost: number;
				salvage_value: number;
				useful_life_years: number;
				expected_annual_hours: number;
				depreciation_per_hour: number;
				machine_rate: number;
				maintenance_per_hour: number;
				energy_per_hour: number;
			}>`
				select a.acquisition_cost, a.salvage_value, a.useful_life_years, a.expected_annual_hours,
				       d.depreciation_per_hour, m.machine_rate, m.maintenance_per_hour, m.energy_per_hour
				from nl.capital_assets a
				join nl.asset_depreciation d on d.asset_no = a.asset_no
				join nl.machine_hour_rate m on m.asset_no = a.asset_no
				where a.asset_no = 'CA-006'`
		);
		// Straight line: (cost - salvage) / life / expected hours.
		const byHand =
			(Number(robot.acquisition_cost) - Number(robot.salvage_value)) /
			robot.useful_life_years /
			Number(robot.expected_annual_hours);
		expect(Number(robot.depreciation_per_hour)).toBeCloseTo(byHand, 4);
		// The rate is more than the depreciation, and depreciation is the
		// biggest single piece of it.
		expect(Number(robot.machine_rate)).toBeGreaterThan(Number(robot.depreciation_per_hour));
		expect(Number(robot.depreciation_per_hour)).toBeGreaterThan(Number(robot.maintenance_per_hour));
	});

	it('costs an hour on the robotic cell more than an hour on a hand booth', async () => {
		const [pair] = await db.asSystem(
			(tx) => tx.sql<{ robot: number; booth: number }>`
				select
				  (select machine_rate from nl.machine_hour_rate where code = 'WELD-ROBOT') as robot,
				  (select machine_rate from nl.machine_hour_rate where code = 'WELD-1') as booth`
		);
		expect(Number(pair.robot)).toBeGreaterThan(Number(pair.booth) * 3);
	});

	it('absorbs overhead through every driver the pools name', async () => {
		const drivers = await db.asSystem(
			(tx) => tx.sql<{ driver: string; pools: number }>`
				select driver, count(*)::int as pools from nl.overhead_rates_current group by driver order by driver`
		);
		expect(drivers.map((d) => d.driver).sort()).toEqual([
			'floor space',
			'labor hours',
			'machine hours',
			'material value'
		]);

		// Every driver actually reaches a cost line somewhere in the world.
		const used = await db.asSystem(
			(tx) => tx.sql<{ driver: string; n: number }>`
				select p.driver, count(*)::int as n
				from nl.item_own_cost_lines l
				join nl.overhead_rates_current p on p.code = l.source
				where l.element = 'overhead'
				group by p.driver
				order by p.driver`
		);
		expect(used.map((u) => u.driver).sort()).toEqual([
			'floor space',
			'labor hours',
			'machine hours',
			'material value'
		]);
	});

	it('shows the wage and the loaded rate apart, and the gap between them', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ labor_class: string; base_wage: number; loaded_rate: number; load_amount: number }>`
				select labor_class, base_wage, loaded_rate, load_amount
				from nl.labor_rate_timeline
				where is_current
				order by labor_class`
		);
		expect(rows.length).toBeGreaterThan(4);
		for (const row of rows) {
			// Benefits, payroll taxes and paid time off add a third or more.
			expect(Number(row.loaded_rate)).toBeGreaterThan(Number(row.base_wage) * 1.3);
			expect(Number(row.load_amount)).toBeCloseTo(Number(row.loaded_rate) - Number(row.base_wage), 3);
		}
	});

	it('adds the breakdown up to the stored rolled cost, to the cent', async () => {
		const parts = await db.asSystem(
			(tx) => tx.sql<{ item_no: string }>`
				select item_no from nl.item_cost_rolled
				where levels > 0
				order by levels desc, rolled_cost desc, item_no
				limit 5`
		);
		expect(parts.length).toBe(5);
		for (const { item_no } of parts) {
			const [row] = await db.asSystem(
				(tx) => tx.sql<{ breakdown: number; stored: number }>`
					select
					  (select round(sum(amount), 2) from nl.item_cost_rollup(${item_no})) as breakdown,
					  (select round(rolled_cost, 2) from nl.item_cost_rolled where item_no = ${item_no}) as stored`
			);
			expect(Number(row.breakdown), item_no).toBeCloseTo(Number(row.stored), 2);
		}
	});

	it('keeps the item card alone and reports the difference instead', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ parts: number; card_matches_timeline: number }>`
				select
				  (select count(*)::int from nl.item_cost_variance) as parts,
				  (select count(*)::int
				   from nl.items i
				   join lateral (
				     select c.unit_cost from nl.item_costs c
				     where c.item_no = i.item_no order by c.effective_from desc limit 1
				   ) newest on true
				   where newest.unit_cost <> i.unit_cost) as card_matches_timeline`
		);
		expect(row.parts).toBeGreaterThan(100);
		// Nothing here rewrote the item card, so the cost timeline from
		// migration 0018 still ends on it for every part.
		expect(row.card_matches_timeline).toBe(0);
	});

	it('lands the rolled cost near the item card for the families it can measure', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ family: string; median: number; parts: number }>`
				select
				  i.family,
				  count(*)::int as parts,
				  round((percentile_cont(0.5) within group (
				    order by c.rolled_cost / nullif(c.card_cost, 0)))::numeric, 3) as median
				from nl.item_cost_rolled c
				join nl.items i on i.item_no = c.item_no
				where c.levels > 0 and c.card_cost > 0
				  and i.family in ('pipe', 'elbow', 'stack', 'shield')
				group by i.family`
		);
		expect(rows.length).toBeGreaterThan(2);
		for (const row of rows) {
			// The metal price is calibrated backwards from the item cards
			// (db/seed.d/95), so these families should sit around one. Wide
			// bounds on purpose: this is a sanity check, not a target.
			expect(Number(row.median), row.family).toBeGreaterThan(0.4);
			expect(Number(row.median), row.family).toBeLessThan(2.5);
		}
	});

	it('answers nl.item_truth for a deep part with everything a reply needs', async () => {
		const [{ item_no }] = await db.asSystem(
			(tx) => tx.sql<{ item_no: string }>`
				select item_no from nl.item_cost_rolled order by levels desc, item_no limit 1`
		);
		const part = await getPartManufacturing(db, DANA, item_no, 25);
		expect(part).not.toBeNull();
		expect(part!.shape.sentence).not.toBe('');
		expect(part!.cost.rolled).toBeGreaterThan(0);
		// The elements add up to the total.
		const sum = Object.values(part!.cost.elements).reduce((a, b) => a + b, 0);
		expect(sum).toBeCloseTo(part!.cost.rolled, 2);
		// The three biggest pieces are in order and are elements that exist.
		expect(part!.cost.top.length).toBeGreaterThan(0);
		expect(part!.cost.top.map((t) => t.amount)).toEqual(
			[...part!.cost.top.map((t) => t.amount)].sort((a, b) => b - a)
		);
		// The lead time is the critical path, and the path names the part
		// itself first and ends at something bought.
		expect(part!.lead.days).toBeGreaterThan(0);
		expect(part!.lead.criticalPath[0]).toContain(item_no);
		/*
		  The last leg is something bought, and since decision records landed
		  it also names the basis the number came from: "buy 42 days (quoted)"
		  rather than a bare figure. A promise that does not say what it rests
		  on is the thing that work exists to stop, so the basis is expected
		  rather than tolerated.
		*/
		expect(part!.lead.criticalPath.at(-1)).toMatch(/buy \d+ days? \((quoted|committed|observed|default)\)$/);
		// The promise date is arithmetic off the same figures.
		expect(part!.promise.earliestDate >= part!.today).toBe(true);
	});

	it('walks up from a raw material to the parts that use it, at any depth', async () => {
		// The tube that feeds the most parts: where-used should find all of
		// them, and more than a handful.
		const [{ item_no }] = await db.asSystem(
			(tx) => tx.sql<{ item_no: string }>`
				select b.child_item as item_no
				from nl.bom_lines b
				join nl.items i on i.item_no = b.child_item
				where i.kind = 'raw material'
				group by b.child_item
				order by count(*) desc, b.child_item
				limit 1`
		);
		const rows = await db.asSystem(
			(tx) => tx.sql<{ parent_item: string; depth: number; open_order_value: number }>`
				select parent_item, depth, open_order_value from nl.item_where_used(${item_no})`
		);
		expect(rows.length).toBeGreaterThan(3);
		// Every parent is reported once, however many branches reach it.
		expect(new Set(rows.map((r) => r.parent_item)).size).toBe(rows.length);

		// And somewhere in the world a material feeds a part that feeds
		// another part, which is what "at any depth" means. The deepest walk
		// in the catalogue goes through a kit.
		const [deepest] = await db.asSystem(
			(tx) => tx.sql<{ item_no: string; max_depth: number }>`
				select b.child_item as item_no, max(w.depth)::int as max_depth
				from nl.bom_lines b
				join nl.items i on i.item_no = b.child_item
				cross join lateral nl.item_where_used(b.child_item) w
				where i.kind = 'raw material'
				group by b.child_item
				order by max(w.depth) desc, b.child_item
				limit 1`
		);
		expect(deepest.max_depth).toBeGreaterThan(1);
	});

	it('builds a load board in hours, and says why the totals exceed the order book', async () => {
		const board = await getManufacturingBoard(db, PRIYA);
		expect(board.load.length).toBeGreaterThan(4);
		for (const cell of board.load) {
			expect(cell.hoursPerWeek).toBeGreaterThan(0);
			expect(['clear', 'tight', 'over', 'no capacity set']).toContain(cell.state);
		}
		// An order routed through four cells is counted in all four, so the
		// hours across cells add up to more than the hours in the orders.
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ cells_per_order: number }>`
				select round(avg(c), 3) as cells_per_order
				from (
				  select o.order_no, count(distinct r.work_center) as c
				  from nl.open_production_orders o
				  join nl.routing_operations r on r.item_no = o.item_no
				  where not r.is_outside
				  group by o.order_no
				) x`
		);
		expect(Number(row.cells_per_order)).toBeGreaterThan(1);
	});
});

// ---------------------------------------------------------------------------
// A three level tree, worked out by hand
// ---------------------------------------------------------------------------

describe('a three level tree', () => {
	// MF-RAW  bought, 10.00 a foot
	// MF-MID  made from 2 feet of MF-RAW with 10% scrap, one hour of setup
	//         over a lot of ten plus six minutes a piece
	// MF-TOP  made from 3 of MF-MID, twelve minutes a piece, no setup
	beforeAll(async () => {
		await db.asSystem(async (tx) => {
			await tx.sql`
				insert into nl.items (item_no, description, category, family, product_group,
				                      unit_cost, list_price, replenishment, work_center, kind)
				values
				  ('MF-RAW', 'TEST TUBE 4 INCH', 'RAW', 'tube', 'RAW', 10.00, 30.00, 'Purchase', '', 'raw material'),
				  ('MF-MID', 'TEST MID ASSEMBLY', 'PIPE', 'pipe', 'PIPE', 40.00, 120.00, 'Prod. Order', 'MFTEST', 'work in progress'),
				  ('MF-TOP', 'TEST TOP ASSEMBLY', 'PIPE', 'pipe', 'PIPE', 150.00, 400.00, 'Prod. Order', 'MFTEST', 'finished good'),
				  ('MF-ALT', 'TEST TUBE, ALTERNATE GRADE', 'RAW', 'tube', 'RAW', 14.00, 40.00, 'Purchase', '', 'raw material')`;
			await tx.sql`
				insert into nl.labor_classes (code, name, description, department)
				values ('MFTEST', 'Test class', 'For the tests only', 'Test')`;
			await tx.sql`
				insert into nl.labor_rates (labor_class, effective_from, base_wage, fringe_pct, payroll_tax_pct, pto_factor)
				values ('MFTEST', date '2020-01-01', 30.00, 0.20, 0.10, 1.00)`;
			// Efficiency exactly 1 and no machine, so the hand arithmetic has
			// nothing hidden in it. The department is its own, so only the
			// plant-wide overhead pools reach it.
			await tx.sql`
				insert into nl.work_centers (code, name, department, shifts, hours_per_day, days_per_week,
				                             efficiency, labor_class)
				values ('MFTEST', 'Test cell', 'Test', 1, 8, 5, 1.000, 'MFTEST')`;
			await tx.sql`
				insert into nl.bom_lines (parent_item, line_no, child_item, quantity_per, uom, scrap_pct)
				values ('MF-MID', 10, 'MF-RAW', 2, 'FT', 0.10),
				       ('MF-TOP', 10, 'MF-MID', 3, 'EA', 0)`;
			await tx.sql`
				insert into nl.routing_operations (item_no, seq, work_center, description, setup_minutes,
				                                  run_minutes_per_piece, standard_lot_size, yield_pct,
				                                  labor_class, crew_size)
				values ('MF-MID', 10, 'MFTEST', 'Cut and fit', 60, 6, 10, 1.000, 'MFTEST', 1),
				       ('MF-TOP', 10, 'MFTEST', 'Weld up', 0, 12, 1, 1.000, 'MFTEST', 1)`;
		});
	});

	async function rolled(itemNo: string) {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{
				own_material: number;
				own_labor: number;
				own_machine: number;
				own_overhead: number;
				own_scrap: number;
				material: number;
				labor: number;
				overhead: number;
				rolled_cost: number;
				levels: number;
			}>`select * from nl.item_cost_rolled where item_no = ${itemNo}`
		);
		return row;
	}

	it('costs the bought part at what it costs to buy, plus materials handling', async () => {
		const r = await rates();
		const raw = await rolled('MF-RAW');
		expect(Number(raw.own_material)).toBeCloseTo(10, 4);
		// Materials handling absorbs on the value of what was bought.
		expect(Number(raw.own_overhead)).toBeCloseTo(10 * r.materialValue, 4);
		expect(Number(raw.rolled_cost)).toBeCloseTo(10 + 10 * r.materialValue, 4);
		expect(raw.levels).toBe(0);
	});

	it('rolls the middle level up by hand', async () => {
		const r = await rates();
		const raw = await rolled('MF-RAW');
		const mid = await rolled('MF-MID');

		// 30.00 an hour, a fifth in benefits, 9.15 percent in payroll tax and
		// no paid-time-off factor: 30 x 1.30 = 39.00 an hour loaded.
		expect(r.loaded).toBeCloseTo(39, 4);

		// An hour of setup over a lot of ten is six minutes a piece, plus six
		// minutes of run: twelve minutes, a fifth of an hour.
		const hours = (60 / 10 + 6) / 60;
		expect(Number(mid.own_labor)).toBeCloseTo(hours * r.loaded, 4);
		expect(Number(mid.own_machine)).toBeCloseTo(0, 6);
		// No machine, so the machine-hour pools absorb nothing and only the
		// plant-wide labour-hour pools do.
		expect(Number(mid.own_overhead)).toBeCloseTo(hours * r.laborHourPools, 4);
		// Yield is 100%, so nothing is thrown away here.
		expect(Number(mid.own_scrap)).toBeCloseTo(0, 6);

		// Two feet plus ten percent scrap is 2.2 feet of tube.
		expect(Number(mid.material)).toBeCloseTo(2.2 * Number(raw.own_material), 4);
		expect(Number(mid.rolled_cost)).toBeCloseTo(
			2.2 * Number(raw.rolled_cost) + hours * r.loaded + hours * r.laborHourPools,
			3
		);
		expect(mid.levels).toBe(1);
	});

	it('rolls the top level up by hand, three levels deep', async () => {
		const r = await rates();
		const mid = await rolled('MF-MID');
		const top = await rolled('MF-TOP');
		const hours = 12 / 60;

		expect(Number(top.own_labor)).toBeCloseTo(hours * r.loaded, 4);
		expect(Number(top.rolled_cost)).toBeCloseTo(
			3 * Number(mid.rolled_cost) + hours * r.loaded + hours * r.laborHourPools,
			3
		);
		expect(top.levels).toBe(2);

		// And the breakdown of the whole tree adds up to that same figure.
		const [check] = await db.asSystem(
			(tx) => tx.sql<{ breakdown: number }>`
				select round(sum(amount), 4) as breakdown from nl.item_cost_rollup('MF-TOP')`
		);
		expect(Number(check.breakdown)).toBeCloseTo(Number(top.rolled_cost), 2);
	});

	it('works the critical path out by arithmetic, not by guessing', async () => {
		const [lead] = await db.asSystem(
			(tx) => tx.sql<{ own_days: number; lead_days: number; basis: string; critical_path: string[]; critical_child: string }>`
				select own_days, lead_days, basis, critical_path, critical_child
				from nl.item_lead_rolled where item_no = 'MF-TOP'`
		);
		// MF-RAW is bought and names no lead time, so it takes the house
		// default for a purchase: 28 days. MF-MID's own work is two hours,
		// which is one day. MF-TOP's is twelve minutes, which is also one
		// day. So 28 + 1 + 1 = 30, down the only chain there is.
		expect(lead.own_days).toBe(1);
		expect(lead.lead_days).toBe(30);
		expect(lead.basis).toBe('make');
		expect(lead.critical_child).toBe('MF-MID');
		// The bought leg names its basis since decision records landed. Nothing
		// has been received against MF-RAW, so there is no observed history to
		// correct it with and the house default stands, and the path says so rather than implying somebody quoted it.
		expect(lead.critical_path).toEqual([
			'MF-TOP: make 1 day',
			'MF-MID: make 1 day',
			'MF-RAW: buy 28 days (default)'
		]);
	});

	it('finds a grandchild s parents, at both depths', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ parent_item: string; depth: number; quantity_per: number }>`
				select parent_item, depth, quantity_per from nl.item_where_used('MF-RAW') order by depth`
		);
		expect(rows.map((r) => [r.parent_item, r.depth])).toEqual([
			['MF-MID', 1],
			['MF-TOP', 2]
		]);
		// Three of the middle part, each taking 2.2 feet: 6.6 feet a top.
		expect(Number(rows[1].quantity_per)).toBeCloseTo(6.6, 4);
	});

	it('raises the material need when the scrap percentage goes up, and puts it back', async () => {
		const before = await rolled('MF-TOP');
		await db.asSystem((tx) => tx.sql`
			update nl.bom_lines set scrap_pct = 0.30 where parent_item = 'MF-MID' and line_no = 10`);
		const during = await rolled('MF-TOP');
		const raw = await rolled('MF-RAW');
		// 2.6 feet instead of 2.2, three times over.
		expect(Number(during.material) - Number(before.material)).toBeCloseTo(
			3 * 0.4 * Number(raw.own_material),
			3
		);
		expect(Number(during.rolled_cost)).toBeGreaterThan(Number(before.rolled_cost));

		await db.asSystem((tx) => tx.sql`
			update nl.bom_lines set scrap_pct = 0.10 where parent_item = 'MF-MID' and line_no = 10`);
		const after = await rolled('MF-TOP');
		expect(Number(after.rolled_cost)).toBeCloseTo(Number(before.rolled_cost), 6);
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.rollup_drift()`);
		expect(drift).toEqual([]);
	});

	it('does not cost a substitute twice', async () => {
		const before = await rolled('MF-MID');
		await db.asSystem((tx) => tx.sql`
			insert into nl.bom_lines (parent_item, line_no, child_item, quantity_per, uom, scrap_pct,
			                          is_substitute, substitute_for)
			values ('MF-MID', 11, 'MF-ALT', 2, 'FT', 0.10, true,
			        (select id from nl.bom_lines where parent_item = 'MF-MID' and line_no = 10))`);
		const after = await rolled('MF-MID');
		// The alternate is dearer than the primary, so counting it would show.
		expect(Number(after.rolled_cost)).toBeCloseTo(Number(before.rolled_cost), 6);
		// And it is in the parts list, marked, because a person wants to see it.
		const part = await getPartManufacturing(db, PRIYA, 'MF-MID');
		expect(part!.bom.filter((n) => n.isSubstitute).map((n) => n.itemNo)).toEqual(['MF-ALT']);
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.rollup_drift()`);
		expect(drift).toEqual([]);
	});

	it('passes a phantom through without losing what is under it', async () => {
		const before = await rolled('MF-TOP');
		await db.asSystem((tx) => tx.sql`update nl.items set phantom = true where item_no = 'MF-MID'`);
		const after = await rolled('MF-TOP');
		// A phantom is a way of organising a parts list, not a cost: the top
		// costs exactly what it did.
		expect(Number(after.rolled_cost)).toBeCloseTo(Number(before.rolled_cost), 6);
		// The tube is still in the breakdown, two levels down.
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ levels: string }>`
				select string_agg(distinct level::text, ',' order by level::text) as levels
				from nl.item_cost_rollup('MF-TOP') where item_no = 'MF-RAW'`
		);
		expect(row.levels).toBe('2');
		await db.asSystem((tx) => tx.sql`update nl.items set phantom = false where item_no = 'MF-MID'`);
	});

	it('refuses a parts list that would contain itself', async () => {
		await expect(
			db.asSystem((tx) => tx.sql`
				insert into nl.bom_lines (parent_item, line_no, child_item, quantity_per, uom)
				values ('MF-RAW', 10, 'MF-TOP', 1, 'EA')`)
		).rejects.toThrow(/already above/);
		// And the walks still terminate, because nothing was written.
		const rows = await db.asSystem((tx) => tx.sql`select * from nl.item_cost_rollup('MF-TOP')`);
		expect(rows.length).toBeGreaterThan(3);
	});

	it('costs a scrap at the last operation more than the same scrap at the first', async () => {
		await db.asSystem(async (tx) => {
			await tx.sql`
				insert into nl.items (item_no, description, category, family, product_group,
				                      unit_cost, list_price, replenishment, work_center, kind)
				values
				  ('MF-EARLY', 'TEST SCRAP EARLY', 'PIPE', 'pipe', 'PIPE', 60, 160, 'Prod. Order', 'MFTEST', 'finished good'),
				  ('MF-LATE', 'TEST SCRAP LATE', 'PIPE', 'pipe', 'PIPE', 60, 160, 'Prod. Order', 'MFTEST', 'finished good')`;
			await tx.sql`
				insert into nl.bom_lines (parent_item, line_no, child_item, quantity_per, uom, scrap_pct)
				values ('MF-EARLY', 10, 'MF-RAW', 1, 'FT', 0),
				       ('MF-LATE', 10, 'MF-RAW', 1, 'FT', 0)`;
			// The same two operations in the same order, costing the same. The
			// only difference is which one loses the piece.
			await tx.sql`
				insert into nl.routing_operations (item_no, seq, work_center, description, setup_minutes,
				                                  run_minutes_per_piece, standard_lot_size, yield_pct,
				                                  labor_class, crew_size)
				values ('MF-EARLY', 10, 'MFTEST', 'Rough cut', 0, 5, 1, 0.900, 'MFTEST', 1),
				       ('MF-EARLY', 20, 'MFTEST', 'Finish and polish', 0, 45, 1, 1.000, 'MFTEST', 1),
				       ('MF-LATE', 10, 'MFTEST', 'Rough cut', 0, 5, 1, 1.000, 'MFTEST', 1),
				       ('MF-LATE', 20, 'MFTEST', 'Finish and polish', 0, 45, 1, 0.900, 'MFTEST', 1)`;
		});

		const early = await rolled('MF-EARLY');
		const late = await rolled('MF-LATE');
		expect(Number(early.own_scrap)).toBeGreaterThan(0);
		// The late scrap throws away three quarters of an hour of finishing as
		// well as the metal, so it costs several times as much.
		expect(Number(late.own_scrap)).toBeGreaterThan(Number(early.own_scrap) * 3);
		expect(Number(late.rolled_cost)).toBeGreaterThan(Number(early.rolled_cost));

		const drift = await db.asSystem((tx) => tx.sql`select * from nl.rollup_drift()`);
		expect(drift).toEqual([]);
	});

	it('re-measures everything above a part when a rate changes', async () => {
		const before = await rolled('MF-TOP');
		await db.asSystem((tx) => tx.sql`
			insert into nl.labor_rates (labor_class, effective_from, base_wage, fringe_pct, payroll_tax_pct, pto_factor)
			values ('MFTEST', nl.today(), 60.00, 0.20, 0.10, 1.00)`);
		const after = await rolled('MF-TOP');
		// Wages doubled at the only cell in the tree, so the labour in the
		// top part doubled too, at both levels.
		expect(Number(after.labor)).toBeCloseTo(Number(before.labor) * 2, 3);
		expect(Number(after.rolled_cost)).toBeGreaterThan(Number(before.rolled_cost));
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.rollup_drift()`);
		expect(drift).toEqual([]);

		await db.asSystem((tx) => tx.sql`
			delete from nl.labor_rates where labor_class = 'MFTEST' and effective_from = nl.today()`);
		const restored = await rolled('MF-TOP');
		expect(Number(restored.rolled_cost)).toBeCloseTo(Number(before.rolled_cost), 4);
	});

	it('re-measures everything above a part when its own cost changes', async () => {
		const before = await rolled('MF-TOP');
		await db.asSystem((tx) => tx.sql`update nl.items set unit_cost = 20.00 where item_no = 'MF-RAW'`);
		const after = await rolled('MF-TOP');
		// 6.6 feet of tube a top, at ten dollars a foot more, plus the
		// materials handling that rides on it.
		expect(Number(after.material) - Number(before.material)).toBeCloseTo(66, 2);
		await db.asSystem((tx) => tx.sql`update nl.items set unit_cost = 10.00 where item_no = 'MF-RAW'`);
		expect(Number((await rolled('MF-TOP')).rolled_cost)).toBeCloseTo(Number(before.rolled_cost), 4);
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.rollup_drift()`);
		expect(drift).toEqual([]);
	});

	it('re-measures when a routing operation is added and taken away again', async () => {
		const before = await rolled('MF-TOP');
		await db.asSystem((tx) => tx.sql`
			insert into nl.routing_operations (item_no, seq, work_center, description, setup_minutes,
			                                   run_minutes_per_piece, standard_lot_size, yield_pct,
			                                   labor_class, crew_size)
			values ('MF-MID', 20, 'MFTEST', 'Extra deburr', 0, 30, 1, 1.000, 'MFTEST', 2)`);
		const after = await rolled('MF-TOP');
		// Half an hour with two people on it, three times over at the level
		// above.
		const r = await rates();
		expect(Number(after.labor) - Number(before.labor)).toBeCloseTo(3 * 0.5 * 2 * r.loaded, 2);
		await db.asSystem((tx) => tx.sql`
			delete from nl.routing_operations where item_no = 'MF-MID' and seq = 20`);
		expect(Number((await rolled('MF-TOP')).rolled_cost)).toBeCloseTo(Number(before.rolled_cost), 4);
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.rollup_drift()`);
		expect(drift).toEqual([]);
	});

	it('explains a shortage down to the part that is actually missing', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ depth: number; item_no: string; required: number; short: number }>`
				select depth, item_no, required, short from nl.item_shortage_explosion('MF-TOP', 10)
				order by depth, item_no`
		);
		expect(rows.map((r) => r.item_no)).toEqual(['MF-TOP', 'MF-MID', 'MF-RAW']);
		// Ten tops need thirty middles and sixty-six feet of tube.
		expect(Number(rows[1].required)).toBeCloseTo(30, 4);
		expect(Number(rows[2].required)).toBeCloseTo(66, 4);
		// None of the test parts are stocked, so all three are short.
		expect(Number(rows[2].short)).toBeCloseTo(66, 4);
	});

	it('lets the read layer put the whole part page together', async () => {
		const part = await getPartManufacturing(db, PRIYA, 'MF-TOP', 10);
		expect(part).not.toBeNull();
		expect(part!.shape.shape).toBe('manufactured');
		expect(part!.shape.erpAgrees).toBe(true);
		expect(part!.bom.map((n) => n.itemNo)).toContain('MF-RAW');
		expect(part!.leadTree.some((n) => n.isCritical && n.itemNo === 'MF-RAW')).toBe(true);
		expect(part!.operations.map((o) => o.seq)).toEqual([10]);
		expect(part!.costLines.length).toBeGreaterThan(3);
		expect(part!.planning).not.toBeNull();
	});
});
