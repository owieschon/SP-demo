// The projection: nl.open_line_projection, the lead-time helpers and
// nl.available_to_promise.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The world
// comes seeded with two days of all three exports (db/seed.d/40_supply.sql),
// so the tests that want their own numbers empty the three live tables first
// and use their own parts, which the world never touches.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { availableToPromise } from './forecast.ts';

const DANA = 2; // account manager: reads only
const TODAY = '2026-09-17';
const CUSTOMER = 'T-FCAST';
const VENDOR = 'VT-FCAST';

let db: Db;
/** A snapshot row for the live tables to point at (they carry a foreign key). */
let snapshotId: number;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.customers (customer_no, name, price_group, customer_since, owner_id)
		             values (${CUSTOMER}, 'Test Forecast Customer', 'DEALER', '2020-01-01', ${DANA})`;
		await tx.sql`insert into nl.vendors (vendor_no, name, city, state, lead_time)
		             values (${VENDOR}, 'Test Supply Works', 'Sandusky', 'OH', '4W')`;

		// Four test parts: two bought, two made. Lead times differ so the
		// "earliest if ordered today" column has something to say.
		await tx.sql`
			insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
			                      replenishment, work_center, vendor_no, lead_time)
			values ('ZP-1', 'TEST PIPE',    'PIPE', 'pipe', 'PIPE', 10, 40, 'Purchase',    '',          ${VENDOR}, '2W'),
			       ('ZP-2', 'TEST ELBOW',   'ELBOWS', 'elbow', 'PIPE', 10, 40, 'Prod. Order', 'BEND CELL', null, '1W'),
			       ('ZP-3', 'TEST CLAMP',   'CLAMPS', 'clamp', 'ACCESSORY', 2, 8, 'Purchase', '',          ${VENDOR}, ''),
			       ('ZP-4', 'TEST STACK',   'STACKS', 'stack', 'CHROME', 30, 90, 'Purchase', '',          ${VENDOR}, '10D'),
			       ('ZP-5', 'TEST SHIELD',  'ACCESSORY', 'shield', 'ACCESSORY', 5, 20, 'Prod. Order', 'WELD CELL', null, '')`;
		await tx.sql`
			insert into nl.stock (item_no, on_hand, as_of)
			values ('ZP-1', 10, ${TODAY}), ('ZP-2', 0, ${TODAY}), ('ZP-3', 5, ${TODAY}),
			       ('ZP-4', 0, ${TODAY}), ('ZP-5', 0, ${TODAY})`;

		const [snap] = await tx.sql<{ id: number }>`
			insert into nl.export_snapshots (kind, file_name, content_hash, status, row_count, line_count,
			                                 error_count, total_quantity, total_value, staged_by)
			values ('open_sales_lines', 'test.csv', repeat('a', 64), 'staged', 1, 1, 0, 0, 0, 1)
			returning id`;
		snapshotId = snap.id;
	});
});

afterAll(async () => {
	await db?.close();
});

beforeEach(async () => {
	await db.asSystem(async (tx) => {
		await tx.sql`delete from nl.open_order_lines`;
		await tx.sql`delete from nl.open_purchase_lines`;
		await tx.sql`delete from nl.open_production_orders`;
	});
});

interface DemandRow {
	doc: string;
	line?: number;
	item: string;
	ship: string;
	qty: number;
	price?: number;
}

async function demand(rows: DemandRow[]) {
	await db.asSystem(async (tx) => {
		for (const r of rows) {
			await tx.sql`
				insert into nl.open_order_lines (document_no, line_no, customer_no, item_no, description, ship_date,
				                                 quantity, unit_price, first_seen_on, last_snapshot_id)
				values (${r.doc}, ${r.line ?? 10000}, ${CUSTOMER}, ${r.item}, 'TEST PART', ${r.ship},
				        ${r.qty}, ${r.price ?? 100}, ${TODAY}, ${snapshotId})`;
		}
	});
}

async function purchase(rows: { doc: string; line?: number; item: string; due: string; qty: number }[]) {
	await db.asSystem(async (tx) => {
		for (const r of rows) {
			await tx.sql`
				insert into nl.open_purchase_lines (document_no, line_no, vendor_no, item_no, description, due_date,
				                                    promised_date, quantity, first_seen_on, last_snapshot_id)
				values (${r.doc}, ${r.line ?? 10000}, ${VENDOR}, ${r.item}, 'TEST PART', ${r.due}, ${r.due},
				        ${r.qty}, ${TODAY}, ${snapshotId})`;
		}
	});
}

async function production(rows: { order: string; item: string; due: string; qty: number; wc?: string }[]) {
	await db.asSystem(async (tx) => {
		for (const r of rows) {
			await tx.sql`
				insert into nl.open_production_orders (order_no, item_no, work_center, status, due_date, quantity,
				                                       first_seen_on, last_snapshot_id)
				values (${r.order}, ${r.item}, ${r.wc ?? 'BEND CELL'}, 'Released', ${r.due}, ${r.qty},
				        ${TODAY}, ${snapshotId})`;
		}
	});
}

interface ProjectionRow {
	document_no: string;
	status: string;
	availability_date: string | null;
	projected_ship_date: string;
	days_late: number;
	supply_source: string | null;
	supply_document: string | null;
	supply_work_center: string | null;
	covered_now: boolean;
	earliest_if_ordered_today: string;
}

async function projection() {
	return db.asUser(DANA, (tx) =>
		tx.sql<ProjectionRow>`
			select document_no, status, availability_date, projected_ship_date, days_late, supply_source,
			       supply_document, supply_work_center, covered_now, earliest_if_ordered_today
			from nl.open_line_projection
			order by document_no`
	);
}

describe('the projection', () => {
	it('matches a hand-computed example: stock first, then each supply order in date order', async () => {
		// ZP-1: 10 on hand, then 20 due Sep 25, then 30 due Oct 10.
		await purchase([
			{ doc: 'PO-A', item: 'ZP-1', due: '2026-09-25', qty: 20 },
			{ doc: 'PO-B', item: 'ZP-1', due: '2026-10-10', qty: 30 }
		]);
		await demand([
			{ doc: 'D1', item: 'ZP-1', ship: '2026-09-20', qty: 6 }, // through 6: on hand
			{ doc: 'D2', item: 'ZP-1', ship: '2026-09-21', qty: 6 }, // through 12: PO-A
			{ doc: 'D3', item: 'ZP-1', ship: '2026-09-30', qty: 20 }, // through 32: PO-B
			{ doc: 'D4', item: 'ZP-1', ship: '2026-10-15', qty: 40 } // through 72: nothing reaches it
		]);

		expect(
			(await projection()).map((p) => [p.document_no, p.status, p.availability_date, p.projected_ship_date, p.days_late, p.supply_document])
		).toEqual([
			['D1', 'on_time', '2026-09-17', '2026-09-20', 0, null],
			['D2', 'late_waiting_supply', '2026-09-25', '2026-09-25', 4, 'PO-A'],
			['D3', 'late_waiting_supply', '2026-10-10', '2026-10-10', 10, 'PO-B'],
			// Nothing on order covers D4, but its ship date is a month out and the
			// part's lead time is two weeks, so buying it today still makes it.
			['D4', 'no_supply', null, '2026-10-15', 0, null]
		]);

		const [d4] = (await projection()).filter((p) => p.document_no === 'D4');
		expect(d4.earliest_if_ordered_today).toBe('2026-10-01'); // today + 2W from the item card
	});

	it('names a production order, an overdue supply order, and stock that is already there', async () => {
		await production([{ order: 'MO-A', item: 'ZP-2', due: '2026-09-22' }].map((r) => ({ ...r, qty: 15 })));
		// ZP-4's purchase order was due twelve days ago: late but still coming,
		// so it counts three days from today (nl.overdue_supply_days()).
		await purchase([{ doc: 'PO-LATE', item: 'ZP-4', due: '2026-09-05', qty: 20 }]);
		await demand([
			{ doc: 'E1', item: 'ZP-2', ship: '2026-09-19', qty: 15 },
			{ doc: 'E2', item: 'ZP-4', ship: '2026-09-18', qty: 5 },
			{ doc: 'E3', item: 'ZP-3', ship: '2026-09-10', qty: 2 }, // past due, 5 on hand
			{ doc: 'E4', item: 'ZP-5', ship: '2026-09-11', qty: 3 } // past due, nothing anywhere
		]);

		const rows = await projection();
		const by = (doc: string) => rows.find((r) => r.document_no === doc)!;

		expect(by('E1')).toMatchObject({
			status: 'late_waiting_supply',
			supply_source: 'production',
			supply_document: 'MO-A',
			supply_work_center: 'BEND CELL',
			projected_ship_date: '2026-09-22',
			days_late: 3
		});
		expect(by('E2')).toMatchObject({
			status: 'late_supply_overdue',
			supply_document: 'PO-LATE',
			availability_date: '2026-09-20',
			days_late: 2
		});
		// E3 was due a week ago and its parts are on the shelf, so it ships
		// today: past due, seven days late, nothing to chase.
		expect(by('E3')).toMatchObject({
			status: 'past_due',
			covered_now: true,
			projected_ship_date: TODAY,
			days_late: 7
		});
		expect(by('E4')).toMatchObject({ status: 'past_due', covered_now: false });
		// Nothing on order for ZP-5 and it is already late: the earliest is the
		// default lead time for a made part, fourteen days from today.
		expect(by('E4').earliest_if_ordered_today).toBe('2026-10-01');
		expect(by('E4').days_late).toBe(20);
	});

	it('shares one supply order between two customers, oldest ship date first', async () => {
		await purchase([{ doc: 'PO-S', item: 'ZP-4', due: '2026-09-28', qty: 10 }]);
		await demand([
			{ doc: 'F2', item: 'ZP-4', ship: '2026-09-30', qty: 6 },
			{ doc: 'F1', item: 'ZP-4', ship: '2026-09-25', qty: 6 }
		]);
		const rows = await projection();
		// F1 ships first, so it takes the first six of the ten; F2 asks for
		// twelve in total, which the order cannot reach.
		expect(rows.map((r) => [r.document_no, r.status, r.supply_document])).toEqual([
			['F1', 'late_waiting_supply', 'PO-S'],
			['F2', 'no_supply', null]
		]);
	});

	it('gives every line in the world exactly one status, and never a negative delay', async () => {
		// Put the world's own three exports back into the live tables (the
		// beforeEach above emptied them), so this runs on a realistic book
		// rather than on the handful of test parts.
		await db.asSystem(async (tx) => {
			const current = await tx.sql<{ id: number }>`
				select id from nl.export_snapshots where is_current order by id`;
			for (const { id } of current) {
				await tx.sql`select nl_seed.apply_sample_export(${id})`;
			}
		});

		const [check] = await db.asUser(DANA, (tx) =>
			tx.sql<{
				live: number;
				projected: number;
				keys: number;
				unknown: number;
				negative: number;
				disagrees: number;
			}>`
				select (select count(*) from nl.open_order_lines) as live,
				       (select count(*) from nl.open_line_projection) as projected,
				       (select count(distinct (document_no, line_no)) from nl.open_line_projection) as keys,
				       (select count(*) from nl.open_line_projection
				        where status not in ('on_time', 'late_waiting_supply', 'late_supply_overdue',
				                             'no_supply', 'past_due')) as unknown,
				       (select count(*) from nl.open_line_projection where days_late < 0) as negative,
				       (select count(*) from nl.open_line_projection
				        where (status = 'on_time' and (days_late > 0 or availability_date > ship_date))
				           or (status = 'no_supply' and availability_date is not null)
				           or (status in ('late_waiting_supply', 'late_supply_overdue')
				               and (availability_date is null or availability_date <= ship_date))
				           or (status = 'late_supply_overdue' and not supply_overdue)
				           or (status <> 'past_due' and ship_date < today)
				           or projected_ship_date < ship_date) as disagrees`
		);
		expect(check.live).toBeGreaterThan(80);
		expect(check.projected).toBe(check.live);
		expect(check.keys).toBe(check.live);
		expect(check.unknown).toBe(0);
		expect(check.negative).toBe(0);
		expect(check.disagrees).toBe(0);
	});
});

describe('lead times from the ERP date formulas', () => {
	it('reads days, weeks, months and years, and says nothing about free text', async () => {
		const [row] = await db.asUser(DANA, (tx) =>
			tx.sql<Record<string, number | null>>`
				select nl.lead_time_days('10D') as d,
				       nl.lead_time_days('3W') as w,
				       nl.lead_time_days('2M') as m,
				       nl.lead_time_days('1Y') as y,
				       nl.lead_time_days('14') as plain,
				       nl.lead_time_days('3w') as lower,
				       nl.lead_time_days(' 4 W ') as spaced,
				       nl.lead_time_days('') as blank,
				       nl.lead_time_days(null) as missing,
				       nl.lead_time_days('call vendor') as words,
				       nl.item_lead_days('ZP-1') as item_card,
				       nl.item_lead_days('ZP-3') as from_vendor,
				       nl.item_lead_days('ZP-5') as house_default`
		);
		expect(row).toEqual({
			d: 10,
			w: 21,
			m: 60,
			y: 365,
			plain: 14,
			lower: 21,
			spaced: 28,
			blank: null,
			missing: null,
			words: null,
			// ZP-1's own card says 2W; ZP-3's card is blank so its vendor's 4W
			// answers; ZP-5 is made here with no lead time anywhere, so the
			// default for a production part applies.
			item_card: 14,
			from_vendor: 28,
			house_default: 14
		});
	});
});

describe('available to promise', () => {
	beforeEach(async () => {
		await purchase([
			{ doc: 'PO-A', item: 'ZP-1', due: '2026-09-25', qty: 20 },
			{ doc: 'PO-B', item: 'ZP-1', due: '2026-10-10', qty: 30 }
		]);
		await demand([
			{ doc: 'D1', item: 'ZP-1', ship: '2026-09-20', qty: 6 },
			{ doc: 'D2', item: 'ZP-1', ship: '2026-09-21', qty: 6 }
		]);
	});

	it('counts what earlier promises already claim, and answers with a date', async () => {
		const soon = await availableToPromise(db, DANA, { itemNo: 'ZP-1', quantity: 5, neededBy: '2026-09-22' });
		expect(soon).toMatchObject({
			onHand: 10,
			// D1 and D2 ship on or before Sep 22 and have twelve pieces between them.
			promisedEarlier: 12,
			freeNow: 0,
			neededThrough: 17,
			canMeet: false,
			earliestDate: '2026-09-25',
			earliestBasis: 'supply'
		});
		expect(soon?.covering).toMatchObject({ documentNo: 'PO-A', source: 'purchase' });
		expect(soon?.incoming.map((i) => i.documentNo)).toEqual(['PO-A', 'PO-B']);

		const later = await availableToPromise(db, DANA, { itemNo: 'ZP-1', quantity: 5, neededBy: '2026-10-31' });
		expect(later).toMatchObject({ canMeet: true, earliestDate: '2026-09-25' });
	});

	it('answers from stock when the shelf covers it, and from the lead time when nothing does', async () => {
		const shelf = await availableToPromise(db, DANA, { itemNo: 'ZP-3', quantity: 4, neededBy: '2026-09-18' });
		expect(shelf).toMatchObject({ canMeet: true, earliestBasis: 'stock', earliestDate: '2026-09-17' });

		// ZP-5 has nothing on hand and nothing on order: the only answer is the
		// lead time, which for a made part with no figure on the card is the house default.
		const make = await availableToPromise(db, DANA, { itemNo: 'ZP-5', quantity: 2, neededBy: '2026-09-25' });
		expect(make).toMatchObject({
			canMeet: false,
			earliestBasis: 'lead_time',
			earliestDate: '2026-10-01',
			leadDays: 14,
			covering: null
		});

		expect(await availableToPromise(db, DANA, { itemNo: 'NOPE-1', quantity: 1, neededBy: '2026-09-25' })).toBeNull();
	});
});
