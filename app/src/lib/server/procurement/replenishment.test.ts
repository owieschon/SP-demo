// The replenishment maths, against examples worked out by hand.
//
// Each test builds its own part, with its own stock, its own sales history and
// its own open orders, so no test's numbers reach another's. "Today" is pinned
// to 2026-09-17, which is what makes a 90 day window and a 30 day cover the
// same numbers on every run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';

const TODAY = '2026-09-17';
const OPS = 5; // operations
const ADMIN = 1;

let db: Db;
let partSeq = 0;
let invoiceSeq = 0;
let snapshotId: number;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		// One customer to hang the test invoices and open orders on.
		await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
		             values ('P-CUST', 'Test Yard', 'DEALER', 2, '2020-01-01')`;
		// Open order lines point at the snapshot they came from, so the tests
		// need one (0010). It is not applied, so it changes nothing else.
		const [snap] = await tx.sql<{ id: number }>`
			insert into nl.export_snapshots (file_name, content_hash, status, row_count, line_count,
			                                 error_count, total_quantity, total_value, staged_by)
			values ('test.csv', repeat('a', 64), 'staged', 1, 1, 0, 0, 0, ${OPS})
			returning id`;
		snapshotId = snap.id;
	});
});

afterAll(async () => {
	await db?.close();
});

interface PartOptions {
	/** The family decides the pack size (nl.pack_size). */
	family?: string;
	unitCost?: number;
	listPrice?: number;
	leadTime?: string;
	vendorLeadTime?: string;
	vendor?: boolean;
	onHand?: number;
	onPurchaseOrder?: number;
	onProductionOrder?: number;
	reorderPoint?: number | null;
	safetyStock?: number | null;
	replenishment?: string;
	blocked?: boolean;
}

/** A part with a vendor, stock and a reorder policy, and nothing else. */
async function part(options: PartOptions = {}): Promise<string> {
	partSeq += 1;
	const itemNo = `PT-${String(partSeq).padStart(4, '0')}`;
	const vendorNo = `PV-${String(partSeq).padStart(4, '0')}`;
	await db.asSystem(async (tx) => {
		if (options.vendor !== false) {
			await tx.sql`insert into nl.vendors (vendor_no, name, city, state, lead_time, terms, freight_terms)
			             values (${vendorNo}, ${'Test Vendor ' + partSeq}, 'Lorain', 'OH',
			                     ${options.vendorLeadTime ?? ''}, 'Net 30', 'Prepaid')`;
			await tx.sql`insert into nl.vendor_contacts (vendor_no, full_name, title, email, is_primary)
			             values (${vendorNo}, 'Jesse Okafor', 'Inside Sales',
			                     ${`sales@testvendor${partSeq}.example`}, true)`;
		}
		await tx.sql`
			insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
			                      replenishment, vendor_no, lead_time, reorder_point, safety_stock, blocked)
			values (${itemNo}, 'TEST PART', 'PIPE', ${options.family ?? 'kit'}, 'PIPE',
			        ${options.unitCost ?? 10}, ${options.listPrice ?? 40},
			        ${options.replenishment ?? 'Purchase'},
			        ${options.vendor === false ? null : vendorNo},
			        ${options.leadTime ?? '3W'},
			        ${options.reorderPoint === undefined ? 20 : options.reorderPoint},
			        ${options.safetyStock === undefined ? 5 : options.safetyStock},
			        ${options.blocked ?? false})`;
		await tx.sql`insert into nl.stock (item_no, on_hand, on_purchase_order, on_production_order, as_of)
		             values (${itemNo}, ${options.onHand ?? 18}, ${options.onPurchaseOrder ?? 0},
		                     ${options.onProductionOrder ?? 0}, ${TODAY})`;
	});
	return itemNo;
}

/** Sell `quantity` of a part on a day, so the usage windows see it. */
async function sold(itemNo: string, postedOn: string, quantity: number, unitPrice = 40) {
	invoiceSeq += 1;
	const invoiceNo = `PI-${invoiceSeq}`;
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
		             values (${invoiceNo}, ${quantity < 0 ? 'credit_memo' : 'invoice'}, 'P-CUST', 'P-CUST',
		                     ${postedOn}, ${quantity * unitPrice})`;
		await tx.sql`insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no,
		                                           quantity, unit_price, amount, unit_cost)
		             values (${invoiceNo}, 1, 'P-CUST', ${postedOn}, ${itemNo},
		                     ${quantity}, ${unitPrice}, ${quantity * unitPrice}, 10)`;
	});
}

/**
 * Which neighbouring migrations are applied. The tests that turn on this are
 * the ones about where supply comes from, and they have to give the same
 * answer on a branch with the supply forecast and on one without.
 */
async function sources() {
	const [row] = await db.asUser(
		OPS,
		(tx) => tx.sql<{ s: Record<string, boolean> }>`select nl.procurement_sources() as s`
	);
	return row.s;
}

/**
 * A purchase order this desk raised, promising a quantity by a date. Unlike
 * the item master's on-order figure, this is counted as incoming supply
 * whatever else is applied.
 */
async function onDeskOrder(itemNo: string, quantity: number, promisedOn: string) {
	await db.asSystem(async (tx) => {
		const [order] = await tx.sql<{ id: number }>`
			insert into nl.procurement_orders (vendor_no, created_by, ordered_on)
			select i.vendor_no, ${OPS}, ${TODAY} from nl.items i where i.item_no = ${itemNo}
			returning id`;
		await tx.sql`insert into nl.procurement_order_lines (order_id, line_no, item_no, quantity,
		                                                     unit_cost, original_promised_on, promised_on)
		             values (${order.id}, 1, ${itemNo}, ${quantity}, 10, ${promisedOn}, ${promisedOn})`;
	});
}

/** An open sales line: we have promised this quantity by this date. */
async function promised(itemNo: string, shipDate: string, quantity: number) {
	await db.asSystem(
		(tx) => tx.sql`
			insert into nl.open_order_lines (document_no, line_no, customer_no, item_no, ship_date,
			                                 quantity, unit_price, first_seen_on, last_snapshot_id)
			values (${'SO-' + itemNo}, ${quantity}, 'P-CUST', ${itemNo}, ${shipDate},
			        ${quantity}, 40, ${TODAY}, ${snapshotId})`
	);
}

async function look(itemNo: string) {
	const [row] = await db.asUser(
		OPS,
		(tx) => tx.sql<{
			lead_time_days: number;
			horizon_on: string;
			per_day: number;
			per_week: number;
			units_90d: number;
			units_365d: number;
			demand_shape: string;
			on_hand: number;
			promised_before_horizon: number;
			promised_total: number;
			incoming_before_horizon: number;
			on_order_total: number;
			on_order_later: number;
			projected_available: number;
			target_qty: number;
			raw_need: number;
			suggested_qty: number;
			suggested_cost: number;
			pack: number;
			days_of_cover: number | null;
			runs_out_on: string | null;
			order_by_on: string | null;
			requested_on: string;
			below_policy: boolean;
			oversold: boolean;
			needs_buying: boolean;
			trigger_reason: string;
			reason: string;
		}>`select * from nl.part_replenishment where item_no = ${itemNo}`
	);
	return row;
}

describe('nl.lead_time_days reads an ERP date formula', () => {
	async function days(formula: string | null) {
		const [row] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ d: number | null }>`select nl.lead_time_days(${formula}) as d`
		);
		return row.d;
	}

	it('reads each unit as calendar days', async () => {
		expect(await days('1D')).toBe(1);
		expect(await days('10D')).toBe(10);
		expect(await days('3W')).toBe(21);
		expect(await days('12W')).toBe(84);
		expect(await days('2M')).toBe(60);
		expect(await days('1Y')).toBe(365);
	});

	it('does not mind case or spaces', async () => {
		expect(await days('3w')).toBe(21);
		expect(await days(' 3 W ')).toBe(21);
	});

	it('reads a bare number as days', async () => {
		expect(await days('14')).toBe(14);
		expect(await days('0')).toBe(0);
	});

	it('says nothing rather than guessing at rubbish', async () => {
		for (const rubbish of [
			null,
			'',
			'   ',
			'W',
			'soon',
			'3X',
			'-2W',
			'+3W', // a signed formula is not a lead time
			'1W+3D', // one term only
			'3.5W',
			'W3',
			'3 weeks'
		]) {
			expect(await days(rubbish)).toBeNull();
		}
	});

	it('falls back from the item to the vendor to the default for how it is made', async () => {
		const own = await part({ leadTime: '4W', vendorLeadTime: '8W' });
		const fromVendor = await part({ leadTime: '', vendorLeadTime: '8W' });
		const neither = await part({ leadTime: '', vendorLeadTime: '' });
		expect((await look(own)).lead_time_days).toBe(28);
		expect((await look(fromVendor)).lead_time_days).toBe(56);
		// nl.default_lead_days('Purchase'): a bought part takes longest.
		expect((await look(neither)).lead_time_days).toBe(28);

		// The standalone function answers the same three steps.
		const [row] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ d: number }>`select nl.item_lead_time_days(${fromVendor}) as d`
		);
		expect(row.d).toBe(56);
	});
});

describe('usage is measured over two windows', () => {
	it('takes the higher of the 90 day and the 365 day rate', async () => {
		// 900 units a year ago, nothing lately: the year's rate wins.
		const seasonal = await part();
		await sold(seasonal, '2026-01-15', 900);
		const s = await look(seasonal);
		expect(s.units_365d).toBe(900);
		expect(s.units_90d).toBe(0);
		// 900 / 365 = 2.4658
		expect(Number(s.per_day)).toBeCloseTo(2.4658, 4);

		// 900 units inside the last 90 days: the recent rate wins.
		const ramping = await part();
		await sold(ramping, '2026-08-15', 900);
		const r = await look(ramping);
		expect(r.units_90d).toBe(900);
		expect(r.units_365d).toBe(900);
		// 900 / 90 = 10 a day, and 10 > 2.4658
		expect(Number(r.per_day)).toBeCloseTo(10, 4);
		expect(Number(r.per_week)).toBeCloseTo(70, 2);
	});

	it('counts a return back off the usage', async () => {
		const itemNo = await part();
		await sold(itemNo, '2026-08-01', 100);
		await sold(itemNo, '2026-08-20', -40);
		expect((await look(itemNo)).units_90d).toBe(60);
	});

	it('calls demand steady, lumpy or erratic, and says so when there is none', async () => {
		const nothing = await part();
		expect((await look(nothing)).demand_shape).toBe('none');

		// The same amount every month for a year: steady.
		const steady = await part();
		for (let month = 0; month < 12; month++) {
			const date = new Date(Date.UTC(2025, 9 + month, 10)).toISOString().slice(0, 10);
			await sold(steady, date, 30);
		}
		expect((await look(steady)).demand_shape).toBe('steady');

		// The whole year in one month: erratic, because eleven months are zero.
		const spiky = await part();
		await sold(spiky, '2026-06-10', 360);
		expect((await look(spiky)).demand_shape).toBe('erratic');
	});
});

describe('the projection', () => {
	it('is stock, minus what is promised inside the lead time, plus what is due inside it', async () => {
		// 18 on hand, three week lead time, so the horizon is 2026-10-08.
		const itemNo = await part({ onHand: 18, leadTime: '3W' });
		await promised(itemNo, '2026-09-30', 9); // inside the horizon
		await promised(itemNo, '2026-11-30', 40); // after it
		const r = await look(itemNo);
		expect(r.horizon_on).toBe('2026-10-08');
		expect(r.promised_before_horizon).toBe(9);
		expect(r.promised_total).toBe(49);
		expect(r.projected_available).toBe(9); // 18 - 9
	});

	it('counts what is already on order, with no date, as arriving inside the horizon', async () => {
		// The item master carries an on-order quantity with no date on it. That
		// is the only dateless supply there is, and it is only the live source
		// until the supply forecast (0016) lands with dated purchase and
		// production orders; after that the item master's figure is the same
		// fact in a rougher form and is deliberately ignored. This test
		// therefore has to know which of the two worlds it is in, and asserts
		// the contract for both (see nl.incoming_supply).
		const itemNo = await part({ onHand: 4, onPurchaseOrder: 50, onProductionOrder: 10 });
		const r = await look(itemNo);

		if (!(await sources()).open_purchase_lines) {
			expect(r.on_order_total).toBe(60);
			expect(r.incoming_before_horizon).toBe(60);
			expect(r.on_order_later).toBe(0);
			expect(r.projected_available).toBe(64);
		} else {
			// 0016 is the source now, and it has nothing for this part.
			expect(r.on_order_total).toBe(0);
			expect(r.projected_available).toBe(4);
		}
	});

	it('says how many days of cover are left and when the shelf empties', async () => {
		// 30 on hand, 210 sold in the last 90 days: 2.3333 a day.
		const itemNo = await part({ onHand: 30, reorderPoint: 10 });
		await sold(itemNo, '2026-08-01', 210);
		const r = await look(itemNo);
		expect(Number(r.per_day)).toBeCloseTo(2.3333, 4);
		// 30 / 2.3333 = 12.9 days
		expect(Number(r.days_of_cover)).toBeCloseTo(12.9, 1);
		// floor(12.9) = 12 days from 2026-09-17
		expect(r.runs_out_on).toBe('2026-09-29');
	});
});

describe('the suggestion', () => {
	it('covers the lead time plus the target cover, keeps safety stock, and rounds to the pack', async () => {
		// Worked by hand:
		//   1 a day (91 units in the last 90 days is 1.0111, and 91/365 is less)
		//   lead time 3W = 21 days, cover 30 days, safety stock 5
		//   target   = 5 + ceil(1.0111 x 51) = 5 + 52 = 57
		//   on hand 18, nothing promised, nothing on order
		//   raw need = 57 - 18 - 0 = 39
		//   pack     = 5 (family 'pipe'), so 39 rounds up to 40
		const itemNo = await part({ family: 'pipe', onHand: 18, leadTime: '3W', safetyStock: 5, unitCost: 12 });
		await sold(itemNo, '2026-08-01', 91);
		const r = await look(itemNo);
		expect(Number(r.per_day)).toBeCloseTo(1.0111, 4);
		expect(r.lead_time_days).toBe(21);
		expect(r.target_qty).toBe(57);
		expect(r.raw_need).toBe(39);
		expect(r.pack).toBe(5);
		expect(r.suggested_qty).toBe(40);
		expect(Number(r.suggested_cost)).toBeCloseTo(480, 2);
		expect(r.needs_buying).toBe(true);
	});

	it('never counts what is already on order twice', async () => {
		// Two parts with the same demand, the same policy and the same stock.
		// One has 30 already on order, arriving inside the horizon; its
		// suggestion is exactly 30 smaller (before rounding), never 60
		// smaller, and never unchanged.
		//
		// The 30 sits on a purchase order this desk raised, rather than on the
		// item master's on-order figure, because that one is counted whatever
		// other migrations are applied (see nl.incoming_supply).
		const clean = await part({ family: 'kit', onHand: 10, leadTime: '3W', safetyStock: 5 });
		const onOrder = await part({ family: 'kit', onHand: 10, leadTime: '3W', safetyStock: 5 });
		await sold(clean, '2026-08-01', 91);
		await sold(onOrder, '2026-08-01', 91);
		// The horizon is 2026-10-08, so this lands inside it.
		await onDeskOrder(onOrder, 30, '2026-09-30');

		const a = await look(clean);
		const b = await look(onOrder);
		expect(a.pack).toBe(1); // family 'kit', so no rounding in the way
		expect(a.target_qty).toBe(b.target_qty);
		expect(a.projected_available).toBe(10);
		expect(b.projected_available).toBe(40); // the 30 counted once, here
		expect(b.on_order_later).toBe(0); // and not again here
		expect(a.suggested_qty - b.suggested_qty).toBe(30);
	});

	it('does not count supply arriving after the horizon as cover for it', async () => {
		// The desk's own purchase order, dated after the part's lead time.
		const itemNo = await part({ family: 'kit', onHand: 10, leadTime: '3W', safetyStock: 5 });
		await sold(itemNo, '2026-08-01', 91);
		const before = await look(itemNo);

		// Well past the 2026-10-08 horizon.
		await onDeskOrder(itemNo, 30, '2026-12-01');

		const after = await look(itemNo);
		// It is on order, but it does not arrive in time to cover the horizon.
		expect(after.on_order_total).toBe(30);
		expect(after.incoming_before_horizon).toBe(0);
		expect(after.on_order_later).toBe(30);
		expect(after.projected_available).toBe(before.projected_available);
		// So it comes off the suggestion, without pretending stock is there.
		expect(before.suggested_qty - after.suggested_qty).toBe(30);
	});

	it('writes the reason out in words', async () => {
		const itemNo = await part({ family: 'kit', onHand: 18, leadTime: '3W', safetyStock: 5 });
		await sold(itemNo, '2026-08-01', 27); // 0.3 a day, 2.1 a week
		await promised(itemNo, '2026-09-25', 9);
		const r = await look(itemNo);
		expect(r.reason).toBe('18 on hand, 2.1 a week, 21 day lead time, 9 already promised, 30 day cover');
	});

	it('says so plainly when a part has not sold in a year', async () => {
		const itemNo = await part({ onHand: 0, safetyStock: 3, reorderPoint: 5 });
		const r = await look(itemNo);
		expect(r.reason).toContain('no sales in a year');
		// No usage to cover, so the target is the level the item card asks
		// for: five, not the three of safety stock.
		expect(r.target_qty).toBe(5);
		expect(r.suggested_qty).toBe(5);
	});
});

describe('what puts a part on the list', () => {
	it('is the projection falling under the reorder point', async () => {
		const itemNo = await part({ onHand: 19, reorderPoint: 20, safetyStock: 5 });
		const r = await look(itemNo);
		expect(r.below_policy).toBe(true);
		expect(r.trigger_reason).toBe('below reorder point');
		expect(r.needs_buying).toBe(true);
		// Nothing has sold, so the only thing to cover is the level the item
		// card asks for: twenty, and there are nineteen.
		expect(r.target_qty).toBe(20);
		expect(r.suggested_qty).toBe(1);
	});

	it('is safety stock when the item card has no reorder point', async () => {
		const itemNo = await part({ onHand: 2, reorderPoint: null, safetyStock: 5 });
		const r = await look(itemNo);
		expect(r.trigger_reason).toBe('below safety stock');
		expect(r.needs_buying).toBe(true);
	});

	it('is being promised more than we will have, whatever the policy says', async () => {
		const itemNo = await part({ onHand: 10, reorderPoint: null, safetyStock: null });
		await promised(itemNo, '2026-09-20', 40);
		const r = await look(itemNo);
		expect(r.projected_available).toBe(-30);
		expect(r.oversold).toBe(true);
		expect(r.below_policy).toBe(false); // there is no policy to be below
		expect(r.trigger_reason).toBe('promised more than we will have');
		expect(r.needs_buying).toBe(true);
	});

	it('is not a part that is comfortably covered', async () => {
		const itemNo = await part({ onHand: 400, reorderPoint: 20, safetyStock: 5 });
		const r = await look(itemNo);
		expect(r.needs_buying).toBe(false);
		expect(r.trigger_reason).toBe('on pace');
		expect(r.suggested_qty).toBe(0);
	});

	it('is never a blocked part', async () => {
		const itemNo = await part({ onHand: 0, reorderPoint: 20, blocked: true });
		const r = await look(itemNo);
		expect(r.below_policy).toBe(true);
		expect(r.needs_buying).toBe(false);
	});
});

describe('the delivery date asked for', () => {
	it('is when the stock runs out, but never sooner than the lead time allows', async () => {
		// Runs out in 12 days, lead time 21: the earliest honest date is the
		// horizon, not the day we wanted it.
		const soon = await part({ onHand: 30, leadTime: '3W', reorderPoint: 40 });
		await sold(soon, '2026-08-01', 210); // 2.3333 a day
		const s = await look(soon);
		expect(s.runs_out_on).toBe('2026-09-29');
		expect(s.requested_on).toBe('2026-10-08'); // today + 21
		// And the desk is told the order is already late.
		expect(s.order_by_on).toBe('2026-09-08');

		// Runs out in 90 days (210 on hand at 2.3333 a day), lead time 21.
		const later = await part({ onHand: 210, leadTime: '3W', reorderPoint: 400 });
		await sold(later, '2026-08-01', 210);
		const l = await look(later);
		expect(l.runs_out_on).toBe('2026-12-16');
		expect(l.order_by_on).toBe('2026-11-25'); // 21 days before that
		// But the date asked for stops one cover period past the horizon:
		// 2026-10-08 + 30. There is no point paying to have a month of cover
		// delivered after the month it was meant to cover.
		expect(l.requested_on).toBe('2026-11-07');
	});

	it('never asks a vendor for a date a year out', async () => {
		// A part with a reorder point of 2, one on the shelf and almost no
		// sales runs out in years. It is still below its policy, so it is
		// still on the list, but the order asks for a normal date.
		const slow = await part({ onHand: 1, leadTime: '3W', reorderPoint: 2, safetyStock: 1 });
		await sold(slow, '2026-02-01', 1);
		const s = await look(slow);
		expect(s.needs_buying).toBe(true);
		expect(s.runs_out_on!.slice(0, 4)).not.toBe('2026');
		expect(s.requested_on).toBe('2026-11-07'); // the horizon plus the cover
	});
});

describe('pack sizes', () => {
	it('come from the family, and go to one for anything expensive', async () => {
		const packs = await db.asUser(
			OPS,
			(tx) => tx.sql<{ family: string; pack: number }>`
				select f.family, nl.pack_size(f.family, 10) as pack
				from (values ('clamp'), ('bracket'), ('raw'), ('pipe'), ('flex'), ('elbow'), ('kit'),
				             ('custom')) as f(family)`
		);
		expect(Object.fromEntries(packs.map((p) => [p.family, p.pack]))).toEqual({
			clamp: 25,
			bracket: 10,
			raw: 10,
			pipe: 5,
			flex: 5,
			elbow: 2,
			kit: 1,
			custom: 1
		});
		const [expensive] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ pack: number }>`select nl.pack_size('clamp', 251) as pack`
		);
		expect(expensive.pack).toBe(1);
	});

	it('round a need up and never down', async () => {
		const rounded = await db.asUser(
			OPS,
			(tx) => tx.sql<{ q: number; pack: number; r: number }>`
				select x.q, x.pack, nl.round_to_pack(x.q, x.pack) as r
				from (values (1, 25), (25, 25), (26, 25), (0, 25), (-5, 25), (39, 5), (40, 5))
				  as x(q, pack)`
		);
		expect(rounded.map((r) => r.r)).toEqual([25, 25, 50, 0, 0, 40, 40]);
	});
});

describe('the free-freight threshold on a vendor card', () => {
	it('is read out of the vendor’s own words, and is null when there is no number in them', async () => {
		const read = await db.asUser(
			OPS,
			(tx) => tx.sql<{ terms: string; at: number | null }>`
				select t.terms, nl.free_freight_threshold(t.terms) as at
				from (values ('Prepaid over $1,500'), ('Prepaid over $900.50'), ('Prepaid'),
				             ('FOB origin'), (''), ('Prepaid and add')) as t(terms)`
		);
		expect(read.map((r) => r.at)).toEqual([1500, 900.5, null, null, null, null]);
	});
});

describe('which neighbouring migrations the desk found', () => {
	it('names them, so a page can say which numbers it is working from', async () => {
		const found = await sources();
		expect(Object.keys(found).sort()).toEqual([
			'available_to_promise',
			'mail_drafts',
			'open_purchase_lines',
			'production_orders'
		]);
		for (const [name, value] of Object.entries(found)) {
			expect(typeof value, name).toBe('boolean');
		}

		// And each answer matches whether the object is really there, so this
		// test says the same thing on a branch with the supply forecast and on
		// one without.
		const [live] = await db.asUser(
			ADMIN,
			(tx) => tx.sql<{ purchase: boolean; production: boolean; mail: boolean; atp: boolean }>`
				select to_regclass('nl.open_purchase_lines') is not null as purchase,
				       to_regclass('nl.open_production_orders') is not null as production,
				       to_regclass('nl.mail_drafts') is not null as mail,
				       to_regprocedure('nl.available_to_promise(text,int,date)') is not null as atp`
		);
		expect(found.open_purchase_lines).toBe(live.purchase);
		expect(found.production_orders).toBe(live.production);
		expect(found.mail_drafts).toBe(live.mail);
		expect(found.available_to_promise).toBe(live.atp);
	});
});
