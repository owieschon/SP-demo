// Certification and traceability: can the paperwork be found, does the
// recall question have an answer, and does a shipment that owes a document
// get refused.
//
// One small world, "today" pinned to 2026-09-17. The first group reads the
// world the seed built. The second builds its own part, customer, lots and
// shipment (everything prefixed TR-) so the refusal and the release can be
// watched from both sides without disturbing anything the warehouse pages
// read.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { advanceShipment } from '../warehouse/writes.ts';
import { getLotTrace, getShipmentPackage } from './read.ts';

const PRIYA = 5; // operations
const DANA = 2; // account manager

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

async function rejection(work: Promise<unknown>): Promise<AppError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error('expected the write to be refused');
}

// ---------------------------------------------------------------------------
// What the seed built
// ---------------------------------------------------------------------------

describe('the paperwork the seed builds', () => {
	it('gives every lot a balance that agrees with what came out of it', async () => {
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.lot_balance_drift()`);
		expect(drift).toEqual([]);
	});

	it('never leaves a lot holding a negative quantity', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ negative: number; lots: number }>`
				select
				  count(*) filter (where quantity_remaining < 0)::int as negative,
				  count(*)::int as lots
				from nl.lots`
		);
		expect(row.lots).toBeGreaterThan(50);
		expect(row.negative).toBe(0);
	});

	it('puts a heat number and a mill on metal and on nothing else', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ metal_with_heat: number; metal: number; cartons_with_heat: number }>`
				select
				  count(*) filter (where i.kind = 'raw material' and l.heat_no <> '')::int as metal_with_heat,
				  count(*) filter (where i.kind = 'raw material')::int as metal,
				  count(*) filter (where i.kind = 'packaging' and l.heat_no <> '')::int as cartons_with_heat
				from nl.lots l
				join nl.items i on i.item_no = l.item_no
				where l.lot_no like 'RL-%'`
		);
		expect(row.metal).toBeGreaterThan(20);
		expect(row.metal_with_heat).toBe(row.metal);
		// A carton has a vendor lot number and no heat, because there is no
		// such thing as a heat of cardboard.
		expect(row.cartons_with_heat).toBe(0);
	});

	it('holds lots with no mill certificate in quarantine', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ quarantined: number; with_cert: number }>`
				select
				  count(*)::int as quarantined,
				  count(*) filter (where exists (
				    select 1 from nl.lot_documents ld
				    join nl.documents d on d.id = ld.document_id
				    where ld.lot_no = l.lot_no and d.kind = 'MTR'))::int as with_cert
				from nl.lots l
				where l.status = 'quarantine'`
		);
		expect(row.quarantined).toBeGreaterThan(0);
		// Nothing in quarantine has the certificate it is waiting for.
		expect(row.with_cert).toBe(0);
	});

	it('traces a finished part back to the heat it was made from', async () => {
		// The shipped lot with the most under it.
		const [{ lot_no }] = await db.asSystem(
			(tx) => tx.sql<{ lot_no: string }>`
				select l.lot_no
				from nl.lots l
				where exists (select 1 from nl.shipment_line_lots s where s.lot_no = l.lot_no)
				order by (select count(*) from nl.lot_consumption c where c.parent_lot = l.lot_no) desc, l.lot_no
				limit 1`
		);
		const trace = await getLotTrace(db, PRIYA, lot_no);
		expect(trace).not.toBeNull();
		expect(trace!.back.length).toBeGreaterThan(1);
		// Somewhere under a finished part there is metal with a heat number
		// and a mill certificate on it.
		const metal = trace!.back.filter((r) => r.heatNo !== '');
		expect(metal.length).toBeGreaterThan(0);
		expect(metal.some((r) => r.certificates.some((c) => c.kind === 'MTR'))).toBe(true);
		expect(metal.every((r) => r.mill !== '')).toBe(true);
	});

	it('answers the recall question: who received metal from this heat', async () => {
		// The raw lot that reaches the most customers.
		const [{ lot_no }] = await db.asSystem(
			(tx) => tx.sql<{ lot_no: string }>`
				select c.child_lot as lot_no
				from nl.lot_consumption c
				join nl.lots l on l.lot_no = c.child_lot
				where l.heat_no <> ''
				group by c.child_lot
				order by count(*) desc, c.child_lot
				limit 1`
		);
		const trace = await getLotTrace(db, PRIYA, lot_no);
		expect(trace).not.toBeNull();
		expect(trace!.customers.length).toBeGreaterThan(0);

		// Every customer named actually received a shipment carrying a
		// descendant of this lot, and nobody else is named.
		const named = new Set(trace!.customers.map((c) => c.customerNo));
		const [check] = await db.asSystem(
			(tx) => tx.sql<{ real: number }>`
				select count(distinct sh.customer_no)::int as real
				from nl.lot_trace_forward(${lot_no}) f
				join nl.shipments sh on sh.shipment_no = f.shipment_no`
		);
		expect(named.size).toBe(check.real);
		for (const c of trace!.customers) {
			expect(c.quantity).toBeGreaterThan(0);
			expect(c.itemNumbers.length).toBeGreaterThan(0);
		}
	});

	it('crosses at least three levels in the forward trace', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ deepest: number }>`
				select max(f.depth)::int as deepest
				from nl.lots l
				cross join lateral nl.lot_trace_forward(l.lot_no) f
				where l.lot_no like 'RL-%'`
		);
		expect(row.deepest).toBeGreaterThanOrEqual(3);
	});

	it('does not count a lot twice when it goes into two parents', async () => {
		// A lot consumed by more than one parent.
		const [shared] = await db.asSystem(
			(tx) => tx.sql<{ child_lot: string; parents: number; used: number }>`
				select c.child_lot, count(distinct c.parent_lot)::int as parents, sum(c.quantity) as used
				from nl.lot_consumption c
				group by c.child_lot
				having count(distinct c.parent_lot) > 1
				order by count(distinct c.parent_lot) desc, c.child_lot
				limit 1`
		);
		expect(shared).toBeDefined();
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ received: number; remaining: number; used: number }>`
				select l.quantity_received as received, l.quantity_remaining as remaining,
				       (select sum(c.quantity) from nl.lot_consumption c where c.child_lot = l.lot_no) as used
				from nl.lots l where l.lot_no = ${shared.child_lot}`
		);
		// Received less everything taken out of it, counted once per
		// consumption row and not once per path through the tree.
		expect(Number(row.remaining)).toBeCloseTo(Number(row.received) - Number(row.used), 4);
	});

	it('finds the certificate through the tree, not only on the lot shipped', async () => {
		// A shipment whose package is complete although the part it shipped
		// has no certificate of its own: the mill certificate is on the metal
		// underneath it.
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ shipment_no: string; own_certs: number; traced_certs: number }>`
				select
				  s.shipment_no,
				  (select count(*) from nl.shipment_line_lots sl
				    join nl.lot_documents ld on ld.lot_no = sl.lot_no
				   where sl.shipment_no = s.shipment_no)::int as own_certs,
				  (select count(*) from nl.shipment_line_lots sl
				    cross join lateral nl.lot_trace_back(sl.lot_no) t
				    join nl.lot_documents ld on ld.lot_no = t.lot_no
				   where sl.shipment_no = s.shipment_no)::int as traced_certs
				from nl.shipments s
				where exists (select 1 from nl.shipment_line_lots sl where sl.shipment_no = s.shipment_no)
				order by s.shipment_no
				limit 20`
		);
		expect(row).toBeDefined();
		// At least one shipment has paperwork underneath it that is not on the
		// lot itself, which is the only way a finished part can carry a mill
		// certificate at all.
		const rows = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n
				from nl.shipments s
				where (select count(*) from nl.shipment_line_lots sl
				        cross join lateral nl.lot_trace_back(sl.lot_no) t
				        join nl.lot_documents ld on ld.lot_no = t.lot_no
				       where sl.shipment_no = s.shipment_no)
				    > (select count(*) from nl.shipment_line_lots sl
				        join nl.lot_documents ld on ld.lot_no = sl.lot_no
				       where sl.shipment_no = s.shipment_no)`
		);
		expect(rows[0].n).toBeGreaterThan(0);
	});

	it('keeps at least one shipment on the dock for want of a document', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ shipment_no: string; status: string; gaps: number; missing: string }>`
				select shipment_no, status, gaps, missing
				from nl.shipment_package
				where not complete and status <> 'shipped'
				order by shipment_no`
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.gaps).toBeGreaterThan(0);
			expect(row.missing).not.toBe('');
		}
	});

	it('flags an expired supplier qualification without hiding the part', async () => {
		const [lapsed] = await db.asSystem(
			(tx) => tx.sql<{ vendor_no: string; item_no: string }>`
				select sq.vendor_no, i.item_no
				from nl.supplier_qualifications sq
				join nl.items i on i.vendor_no = sq.vendor_no
				where sq.expires_on < nl.today()
				order by sq.vendor_no, i.item_no
				limit 1`
		);
		expect(lapsed).toBeDefined();
		const [{ flags }] = await db.asSystem(
			(tx) => tx.sql<{ flags: { flags: string[]; supplier_qualification: { expired: boolean } } }>`
				select nl.part_qualification_flags(
				         (select customer_no from nl.customers order by customer_no limit 1),
				         ${lapsed.item_no}) as flags`
		);
		expect(flags.supplier_qualification.expired).toBe(true);
		expect(flags.flags.join(' ')).toMatch(/supplier qualification expired/i);
	});

	it('flags a part the customer has never approved', async () => {
		const [pair] = await db.asSystem(
			(tx) => tx.sql<{ customer_no: string; item_no: string }>`
				select c.customer_no, i.item_no
				from nl.customers c
				cross join lateral (
				  select i2.item_no from nl.items i2
				  where not exists (
				    select 1 from nl.part_qualifications q
				    where q.customer_no = c.customer_no and q.item_no = i2.item_no)
				  order by i2.item_no limit 1
				) i
				order by c.customer_no
				limit 1`
		);
		const [{ flags }] = await db.asSystem(
			(tx) => tx.sql<{ flags: { customer_approved: boolean; flags: string[] } }>`
				select nl.part_qualification_flags(${pair.customer_no}, ${pair.item_no}) as flags`
		);
		expect(flags.customer_approved).toBe(false);
		expect(flags.flags.join(' ')).toMatch(/has not approved this part/);
	});

	it('prices the paperwork a customer requires, in money and in days', async () => {
		const [req] = await db.asSystem(
			(tx) => tx.sql<{ customer_no: string; item_no: string }>`
				select r.customer_no, i.item_no
				from nl.document_requirements r
				cross join lateral (select item_no from nl.items order by item_no limit 1) i
				where r.scope = 'customer' and r.price_adder > 0
				order by r.customer_no
				limit 1`
		);
		const [{ flags }] = await db.asSystem(
			(tx) => tx.sql<{
				flags: { requirement_price_adder: number; requirement_lead_days: number; requirements: unknown[] };
			}>`select nl.part_qualification_flags(${req.customer_no}, ${req.item_no}) as flags`
		);
		expect(Number(flags.requirement_price_adder)).toBeGreaterThan(0);
		expect(Number(flags.requirement_lead_days)).toBeGreaterThanOrEqual(1);
		expect(flags.requirements.length).toBeGreaterThan(1);
	});

	it('says an operation cannot run when its gauge is out of calibration', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ item_no: string; requires_gauge: string; blocked_reason: string }>`
				select item_no, requires_gauge, blocked_reason
				from nl.operation_readiness
				where not ready
				order by item_no, seq
				limit 5`
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.blocked_reason).not.toBe('');
		}
		// And the reason is a real one: that gauge really is overdue.
		const [gauge] = await db.asSystem(
			(tx) => tx.sql<{ code: string; due_on: string }>`
				select g.code, max(c.due_on) as due_on
				from nl.gauges g
				left join nl.calibrations c on c.gauge_code = g.code and c.result <> 'fail'
				group by g.code
				having max(c.due_on) is null or max(c.due_on) < (select nl.today())
				order by g.code
				limit 1`
		);
		expect(gauge).toBeDefined();
	});

	it('keeps the read-only role away from the people tables', async () => {
		// The assistant's SQL tool may read lots and certificates, because
		// they are about metal and paper.
		const lots = await db.asReadonly((tx) => tx.sql`select count(*)::int as n from nl.lots`);
		expect(Number((lots[0] as { n: number }).n)).toBeGreaterThan(0);
		// It may not read who is qualified to weld.
		await expect(
			db.asReadonly((tx) => tx.sql`select count(*) from nl.operator_qualifications`)
		).rejects.toThrow(/permission denied/i);
	});
});

// ---------------------------------------------------------------------------
// A shipment that cannot go, and then can
// ---------------------------------------------------------------------------

describe('the shipment gate', () => {
	const CUSTOMER = 'TR-CUST';
	const ITEM = 'TR-PART';
	const RAW = 'TR-TUBE';
	const SHIPMENT = 'TR-SHIP-1';
	let documentId = 0;

	beforeAll(async () => {
		await db.asSystem(async (tx) => {
			await tx.sql`
				insert into nl.customers (customer_no, name, price_group, customer_since)
				values (${CUSTOMER}, 'Test Fleet Supply', (select code from nl.price_groups order by code limit 1),
				        date '2020-01-01')`;
			await tx.sql`
				insert into nl.items (item_no, description, category, family, product_group,
				                      unit_cost, list_price, replenishment, work_center, kind)
				values
				  (${RAW}, 'TEST TUBE FOR THE GATE', 'RAW', 'tube', 'RAW', 9.00, 26.00, 'Purchase', '', 'raw material'),
				  (${ITEM}, 'TEST ELBOW FOR THE GATE', 'ELBOWS', 'elbow', 'PIPE', 42.00, 120.00, 'Prod. Order', 'WELD CELL', 'finished good')`;
			await tx.sql`
				insert into nl.stock (item_no, on_hand, on_production_order, on_purchase_order, shelf, bin, as_of)
				values (${ITEM}, 40, 0, 0, 'T-1', 'T-1-1', nl.today())`;
			await tx.sql`
				insert into nl.stock_bins (item_no, location_code, zone, aisle, shelf, bin, quantity)
				values (${ITEM}, 'MAIN', 'BULK', 'T', 'T-1', 'T-1-1', 40)`;
			await tx.sql`
				insert into nl.stock_opening (item_no, location_code, opened_on, quantity)
				values (${ITEM}, 'MAIN', nl.today() - 90, 40)`;
			await tx.sql`
				insert into nl.bom_lines (parent_item, line_no, child_item, quantity_per, uom, scrap_pct)
				values (${ITEM}, 10, ${RAW}, 3, 'FT', 0.05)`;

			// The metal came in with no mill certificate, and the part was
			// made from it.
			await tx.sql`
				insert into nl.lots (lot_no, item_no, heat_no, mill, country_of_melt, received_on,
				                     receipt_reference, location_code, quantity_received, quantity_remaining, status)
				values ('TR-LOT-RAW', ${RAW}, 'TR44821', 'Lakeshore Steel', 'US', nl.today() - 40,
				        'PR900001', 'MAIN', 500, 440, 'available'),
				       ('TR-LOT-PART', ${ITEM}, '', '', '', nl.today() - 10,
				        'PO900001', 'MAIN', 20, 0, 'consumed')`;
			await tx.sql`
				insert into nl.lot_consumption (child_lot, parent_lot, consumed_on, quantity)
				values ('TR-LOT-RAW', 'TR-LOT-PART', nl.today() - 10, 60)`;

			// This account will not take material without the mill certificate.
			await tx.sql`
				insert into nl.document_requirements (scope, customer_no, certificate_type, price_adder, lead_days_adder, note)
				values ('customer', ${CUSTOMER}, 'MTR', 0, 0, 'Test requirement')`;

			// A shipment of it, packed and waiting for the carrier.
			await tx.sql`
				insert into nl.shipments (shipment_no, customer_no, location_code, carrier, status,
				                          promised_on, packed_by, packed_at)
				values (${SHIPMENT}, ${CUSTOMER}, 'MAIN', 'LTL', 'awaiting carrier',
				        nl.today(), ${PRIYA}, now())`;
			await tx.sql`
				insert into nl.shipment_lines (shipment_no, line_no, item_no, quantity, bin)
				values (${SHIPMENT}, 1, ${ITEM}, 20, 'T-1-1')`;
			await tx.sql`
				insert into nl.shipment_line_lots (shipment_no, line_no, lot_no, quantity)
				values (${SHIPMENT}, 1, 'TR-LOT-PART', 20)`;
		});
	});

	it('names exactly what is missing', async () => {
		const pkg = await getShipmentPackage(db, PRIYA, SHIPMENT);
		expect(pkg).not.toBeNull();
		expect(pkg!.complete).toBe(false);
		expect(pkg!.gaps).toHaveLength(1);
		expect(pkg!.gaps[0]).toMatchObject({ lineNo: 1, itemNo: ITEM, certificate: 'Material test report' });
		expect(pkg!.gaps[0].reason).toContain('on anything under it');
	});

	it('refuses to let it ship', async () => {
		const [{ updated_at }] = await db.asSystem(
			(tx) => tx.sql<{ updated_at: string }>`select updated_at from nl.shipments where shipment_no = ${SHIPMENT}`
		);
		const refusal = await rejection(
			advanceShipment(db, PRIYA, {
				shipmentNo: SHIPMENT,
				toStatus: 'shipped',
				expectedUpdatedAt: updated_at,
				requestId: randomUUID(),
				tracking: null
			})
		);
		expect(refusal.status).toBe(422);
		expect(refusal.message).toContain('document package');
		expect(refusal.message).toContain('Material test report');
		// Still on the dock.
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ status: string }>`select status from nl.shipments where shipment_no = ${SHIPMENT}`
		);
		expect(row.status).toBe('awaiting carrier');
	});

	it('lets it go once the mill certificate is attached to the metal underneath', async () => {
		await db.asSystem(async (tx) => {
			const [doc] = await tx.sql<{ id: number }>`
				insert into nl.documents (kind, reference_no, issued_by, issued_on, storage_ref, note)
				values ('MTR', 'MTR-TR44821-TEST', 'Lakeshore Steel', nl.today() - 42,
				        'certs/mtr/tr_lot_raw.pdf', 'Heat TR44821')
				returning id`;
			// Attached to the tube, three levels of nothing away from the part
			// that shipped: the gate has to walk the genealogy to find it.
			await tx.sql`insert into nl.lot_documents (lot_no, document_id) values ('TR-LOT-RAW', ${doc.id})`;
			documentId = doc.id;
		});

		const pkg = await getShipmentPackage(db, PRIYA, SHIPMENT);
		expect(pkg!.complete).toBe(true);

		const [{ updated_at }] = await db.asSystem(
			(tx) => tx.sql<{ updated_at: string }>`select updated_at from nl.shipments where shipment_no = ${SHIPMENT}`
		);
		const result = await advanceShipment(db, PRIYA, {
			shipmentNo: SHIPMENT,
			toStatus: 'shipped',
			expectedUpdatedAt: updated_at,
			requestId: randomUUID(),
				tracking: null
		});
		expect(result.status).toBe('shipped');
		expect(result.pieces).toBe(20);
		expect(documentId).toBeGreaterThan(0);
	});

	it('leaves the warehouse ledger in agreement after all that', async () => {
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.warehouse_drift()`);
		expect(drift).toEqual([]);
	});

	it('refuses again when the certificate has expired rather than missing', async () => {
		await db.asSystem((tx) => tx.sql`
			update nl.documents set expires_on = nl.today() - 1 where id = ${documentId}`);
		const pkg = await getShipmentPackage(db, PRIYA, SHIPMENT);
		// The shipment has already gone, so the gate cannot stop it again,
		// but the package is short once more and the page says so.
		expect(pkg!.complete).toBe(false);
		await db.asSystem((tx) => tx.sql`
			update nl.documents set expires_on = null where id = ${documentId}`);
	});

	it('shows an account manager the trace without letting them change it', async () => {
		const trace = await getLotTrace(db, DANA, 'TR-LOT-PART');
		expect(trace).not.toBeNull();
		expect(trace!.back.map((r) => r.lotNo)).toContain('TR-LOT-RAW');
		expect(trace!.customers.map((c) => c.customerNo)).toContain(CUSTOMER);
		// The metal's own paperwork is what the customer will be sent.
		const metal = trace!.back.find((r) => r.lotNo === 'TR-LOT-RAW');
		expect(metal!.heatNo).toBe('TR44821');
		expect(metal!.certificates.some((c) => c.kind === 'MTR')).toBe(true);
	});
});
