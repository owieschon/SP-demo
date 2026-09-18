// Drafting, editing and approving a purchase request.
//
// Each test drafts against its own vendor, so one test's approval cannot
// change another's draft. The parts are built here rather than taken from the
// seeded world, so the quantities and prices in the assertions are the ones
// worked out above them.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../db/pglite.ts';
import { getProcurementDesk } from './desk.ts';
import { approvePurchaseRequest, draftPurchaseRequests, setRequestLine } from './requests.ts';
import type { Db } from '../db/types.ts';

const TODAY = '2026-09-17';
const ADMIN = 1;
const DANA = 2; // account manager
const OPS = 5; // operations

let db: Db;
let vendorSeq = 0;
let invoiceSeq = 0;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(
		(tx) => tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
		               values ('R-CUST', 'Test Depot', 'DEALER', ${DANA}, '2020-01-01')`
	);
});

afterAll(async () => {
	await db?.close();
});

interface VendorFixture {
	vendorNo: string;
	items: string[];
}

/**
 * A vendor with a contact, and `parts` parts that are all out of stock and
 * all sell 91 in the last 90 days. With family 'kit' the pack size is one, so
 * the suggested quantity is the raw need and the arithmetic in a test is the
 * arithmetic in the assertion.
 */
async function vendorWithShortParts(options: {
	parts?: number;
	unitCost?: number;
	listPrice?: number;
	minOrder?: number | null;
	freightTerms?: string;
	contact?: boolean;
} = {}): Promise<VendorFixture> {
	vendorSeq += 1;
	const vendorNo = `RV-${String(vendorSeq).padStart(4, '0')}`;
	const items: string[] = [];
	const parts = options.parts ?? 2;

	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.vendors (vendor_no, name, city, state, lead_time, terms,
		                                     freight_terms, min_order)
		             values (${vendorNo}, ${`Test Supply ${vendorSeq}`}, 'Lorain', 'OH', '3W', 'Net 30',
		                     ${options.freightTerms ?? 'Prepaid'}, ${options.minOrder ?? null})`;
		if (options.contact !== false) {
			await tx.sql`insert into nl.vendor_contacts (vendor_no, full_name, title, email, is_primary)
			             values (${vendorNo}, 'Avery Sandoval', 'Inside Sales',
			                     ${`orders@testsupply${vendorSeq}.example`}, true)`;
		}
		for (let n = 1; n <= parts; n++) {
			const itemNo = `RP-${String(vendorSeq).padStart(4, '0')}-${n}`;
			items.push(itemNo);
			await tx.sql`
				insert into nl.items (item_no, description, category, family, product_group, unit_cost,
				                      list_price, replenishment, vendor_no, lead_time, reorder_point, safety_stock)
				values (${itemNo}, ${`TEST PART ${n}`}, 'PIPE', 'kit', 'PIPE',
				        ${options.unitCost ?? 10}, ${options.listPrice ?? 40}, 'Purchase',
				        ${vendorNo}, '3W', 20, 5)`;
			await tx.sql`insert into nl.stock (item_no, on_hand, as_of) values (${itemNo}, 0, ${TODAY})`;
			// 91 units in the last 90 days: 1.0111 a day.
			invoiceSeq += 1;
			const invoiceNo = `RI-${invoiceSeq}`;
			await tx.sql`insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
			             values (${invoiceNo}, 'invoice', 'R-CUST', 'R-CUST', '2026-08-01', 3640)`;
			await tx.sql`insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no,
			                                           quantity, unit_price, amount, unit_cost)
			             values (${invoiceNo}, 1, 'R-CUST', '2026-08-01', ${itemNo}, 91, 40, 3640, 10)`;
		}
	});
	return { vendorNo, items };
}

async function draft(vendor: VendorFixture, userId = OPS) {
	const result = await draftPurchaseRequests(db, userId, {
		vendorNo: vendor.vendorNo,
		requestId: randomUUID()
	});
	return result;
}

async function request(id: number) {
	const [row] = await db.asUser(
		OPS,
		(tx) => tx.sql<{
			id: number;
			status: string;
			subtotal: number;
			needed_by: string;
			terms: string;
			freight_note: string;
			meets_minimum: boolean;
			min_order: number | null;
			order_id: number | null;
			updated_at: Date;
		}>`select * from nl.purchase_requests where id = ${id}`
	);
	return { ...row, version: row.updated_at.toISOString() };
}

async function lines(id: number) {
	return db.asUser(
		OPS,
		(tx) => tx.sql<{
			id: number;
			line_no: number;
			item_no: string;
			quantity: number;
			suggested_qty: number;
			unit_cost: number;
			requested_on: string;
			edited: boolean;
			reason: string;
		}>`select * from nl.purchase_request_lines where request_id = ${id} order by line_no`
	);
}

describe('drafting', () => {
	it('makes one draft per vendor, with lines, prices, dates, terms and a freight note', async () => {
		const vendor = await vendorWithShortParts({ parts: 2, unitCost: 12 });
		const result = await draft(vendor);
		expect(result.drafted).toBe(1);
		expect(result.requestIds).toHaveLength(1);

		const head = await request(result.requestIds[0]);
		expect(head.status).toBe('draft');
		expect(head.terms).toBe('Net 30');
		expect(head.freight_note).toBe('Prepaid');
		// Two parts, each needing 57 (5 safety + ceil(1.0111 x 51)) at $12.
		const rows = await lines(head.id);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.quantity)).toEqual([57, 57]);
		expect(rows.map((r) => Number(r.unit_cost))).toEqual([12, 12]);
		expect(Number(head.subtotal)).toBeCloseTo(2 * 57 * 12, 2);
		// Stock is already at zero, so the earliest honest date is the horizon.
		expect(rows[0].requested_on).toBe('2026-10-08');
		expect(head.needed_by).toBe('2026-10-08');
		expect(rows[0].reason).toContain('0 on hand');
		expect(rows[0].edited).toBe(false);
	});

	it('says when a draft does not reach the vendor’s minimum order', async () => {
		const vendor = await vendorWithShortParts({ parts: 1, unitCost: 2, minOrder: 2500 });
		const result = await draft(vendor);
		const head = await request(result.requestIds[0]);
		expect(Number(head.subtotal)).toBeCloseTo(57 * 2, 2);
		expect(head.meets_minimum).toBe(false);
		expect(Number(head.min_order)).toBe(2500);
	});

	it('says how far a draft is under a free-freight threshold, in its own words', async () => {
		const vendor = await vendorWithShortParts({
			parts: 1,
			unitCost: 10,
			freightTerms: 'Prepaid over $1,500'
		});
		const result = await draft(vendor);
		const head = await request(result.requestIds[0]);
		// 57 x $10 = $570, so $930 short of $1,500.
		expect(head.freight_note).toBe(
			'Prepaid over $1,500 (this order is $930.00 under the free-freight threshold)'
		);
	});

	it('leaves out a part with no vendor or no cost, and counts it', async () => {
		await db.asSystem(async (tx) => {
			// A part that needs buying but cannot be ordered.
			await tx.sql`insert into nl.items (item_no, description, category, family, product_group,
			                                   unit_cost, list_price, replenishment, reorder_point, safety_stock)
			             values ('RP-ORPHAN', 'NO VENDOR PART', 'PIPE', 'kit', 'PIPE', 10, 40,
			                     'Purchase', 20, 5)`;
			await tx.sql`insert into nl.stock (item_no, on_hand, as_of) values ('RP-ORPHAN', 0, ${TODAY})`;
		});
		const everyVendor = await draftPurchaseRequests(db, OPS, {
			vendorNo: null,
			requestId: randomUUID()
		});
		expect(everyVendor.skipped).toBeGreaterThan(0);
		const orphaned = await db.asUser(
			OPS,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.purchase_request_lines where item_no = 'RP-ORPHAN'`
		);
		expect(orphaned[0].n).toBe(0);
	});

	it('does not draft a second time for a vendor that already has one open', async () => {
		const vendor = await vendorWithShortParts();
		expect((await draft(vendor)).drafted).toBe(1);
		expect((await draft(vendor)).drafted).toBe(0);
	});

	it('refuses an account manager', async () => {
		const vendor = await vendorWithShortParts();
		await expect(draft(vendor, DANA)).rejects.toMatchObject({ status: 403 });
	});
});

describe('editing a line', () => {
	it('changes the quantity, moves the header total and marks the line edited', async () => {
		const vendor = await vendorWithShortParts({ parts: 1, unitCost: 10 });
		const drafted = await draft(vendor);
		const head = await request(drafted.requestIds[0]);
		const [line] = await lines(head.id);

		const result = await setRequestLine(db, OPS, {
			lineId: line.id,
			quantity: 100,
			requestedOn: '2026-10-20',
			expectedUpdatedAt: head.version,
			requestId: randomUUID()
		});
		expect(Number(result.subtotal)).toBeCloseTo(1000, 2);

		const after = await request(head.id);
		expect(Number(after.subtotal)).toBeCloseTo(1000, 2);
		expect(after.needed_by).toBe('2026-10-20');
		expect(after.version).not.toBe(head.version);

		const [edited] = await lines(head.id);
		expect(edited.quantity).toBe(100);
		expect(edited.suggested_qty).toBe(57); // what the maths said, kept
		expect(edited.edited).toBe(true);
	});

	it('refuses a date in the past', async () => {
		const vendor = await vendorWithShortParts({ parts: 1 });
		const drafted = await draft(vendor);
		const head = await request(drafted.requestIds[0]);
		const [line] = await lines(head.id);
		await expect(
			setRequestLine(db, OPS, {
				lineId: line.id,
				quantity: 10,
				requestedOn: '2026-09-01',
				expectedUpdatedAt: head.version,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });
	});

	it('refuses an edit made from a stale page', async () => {
		const vendor = await vendorWithShortParts({ parts: 1 });
		const drafted = await draft(vendor);
		const head = await request(drafted.requestIds[0]);
		const [line] = await lines(head.id);
		await setRequestLine(db, OPS, {
			lineId: line.id,
			quantity: 60,
			requestedOn: '2026-10-20',
			expectedUpdatedAt: head.version,
			requestId: randomUUID()
		});
		await expect(
			setRequestLine(db, OPS, {
				lineId: line.id,
				quantity: 70,
				requestedOn: '2026-10-20',
				expectedUpdatedAt: head.version, // the version from before the first edit
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 409 });
		expect((await lines(head.id))[0].quantity).toBe(60);
	});

	it('refuses an account manager', async () => {
		const vendor = await vendorWithShortParts({ parts: 1 });
		const drafted = await draft(vendor);
		const head = await request(drafted.requestIds[0]);
		const [line] = await lines(head.id);
		await expect(
			setRequestLine(db, DANA, {
				lineId: line.id,
				quantity: 10,
				requestedOn: '2026-10-20',
				expectedUpdatedAt: head.version,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 403 });
	});
});

describe('approving', () => {
	async function ready(options: Parameters<typeof vendorWithShortParts>[0] = {}) {
		const vendor = await vendorWithShortParts({ parts: 2, ...options });
		const drafted = await draft(vendor);
		return { vendor, head: await request(drafted.requestIds[0]) };
	}

	it('raises the purchase order, its lines, and queues the vendor email', async () => {
		const { vendor, head } = await ready();
		const result = await approvePurchaseRequest(db, OPS, {
			purchaseRequestId: head.id,
			expectedUpdatedAt: head.version,
			requestId: randomUUID()
		});
		expect(result.orderNo).toMatch(/^PD-\d+$/);
		expect(result.lines).toBe(2);
		expect(result.replayed).toBe(false);
		// Migration 0016 is not applied on this branch, so the order lives in
		// this desk's own tables and the mirror did not happen.
		expect(result.mirrored).toBe(false);
		// 0021 is not applied either, so the draft is in the desk's own queue.
		expect(result.queue).toBe('procurement');

		const order = await db.asUser(
			OPS,
			(tx) => tx.sql<{ order_no: string; vendor_no: string; subtotal: number; status: string }>`
				select o.order_no, o.vendor_no, o.subtotal, o.status
				from nl.procurement_orders o
				join nl.purchase_requests pr on pr.order_id = o.id
				where pr.id = ${head.id}`
		);
		expect(order[0].vendor_no).toBe(vendor.vendorNo);
		expect(order[0].status).toBe('open');
		expect(Number(order[0].subtotal)).toBeCloseTo(Number(head.subtotal), 2);

		const orderLines = await db.asUser(
			OPS,
			(tx) => tx.sql<{ item_no: string; quantity: number; promised_on: string; original_promised_on: string }>`
				select l.item_no, l.quantity, l.promised_on, l.original_promised_on
				from nl.procurement_order_lines l
				join nl.procurement_orders o on o.id = l.order_id
				join nl.purchase_requests pr on pr.order_id = o.id
				where pr.id = ${head.id} order by l.line_no`
		);
		expect(orderLines.map((l) => l.item_no)).toEqual(vendor.items);
		expect(orderLines[0].promised_on).toBe(orderLines[0].original_promised_on);

		const drafts = await db.asUser(
			OPS,
			(tx) => tx.sql<{ to_email: string; subject: string; body: string; mail_draft_id: number | null }>`
				select to_email, subject, body, mail_draft_id
				from nl.purchase_request_drafts where request_id = ${head.id}`
		);
		expect(drafts[0].to_email).toContain('@');
		expect(drafts[0].to_email).toContain('.example');
		expect(drafts[0].subject).toContain(result.orderNo);
		expect(drafts[0].body).toContain(vendor.items[0]);
		expect(drafts[0].mail_draft_id).toBeNull();
	});

	it('clears the part off the buying list, because the order is now incoming supply', async () => {
		const { vendor, head } = await ready({ parts: 1 });
		const before = await db.asUser(
			OPS,
			(tx) => tx.sql<{ needs_buying: boolean; on_order_total: number }>`
				select needs_buying, on_order_total from nl.part_replenishment
				where item_no = ${vendor.items[0]}`
		);
		expect(before[0].needs_buying).toBe(true);
		expect(before[0].on_order_total).toBe(0);

		await approvePurchaseRequest(db, OPS, {
			purchaseRequestId: head.id,
			expectedUpdatedAt: head.version,
			requestId: randomUUID()
		});

		const after = await db.asUser(
			OPS,
			(tx) => tx.sql<{ needs_buying: boolean; on_order_total: number; suggested_qty: number }>`
				select needs_buying, on_order_total, suggested_qty from nl.part_replenishment
				where item_no = ${vendor.items[0]}`
		);
		expect(after[0].on_order_total).toBe(57);
		expect(after[0].suggested_qty).toBe(0);
		expect(after[0].needs_buying).toBe(false);
	});

	it('leaves an audit row naming the order it created', async () => {
		const { head } = await ready({ parts: 1 });
		const requestId = randomUUID();
		const result = await approvePurchaseRequest(db, OPS, {
			purchaseRequestId: head.id,
			expectedUpdatedAt: head.version,
			requestId
		});
		const audit = await db.asUser(
			OPS,
			(tx) => tx.sql<{ actor_id: number; via: string; action: string; detail: { order_no: string } }>`
				select actor_id, via, action, detail from nl.audit_log
				where request_id = ${requestId} and action = 'approve_purchase_request'`
		);
		expect(audit).toHaveLength(1);
		expect(audit[0].actor_id).toBe(OPS);
		expect(audit[0].via).toBe('ui');
		expect(audit[0].detail.order_no).toBe(result.orderNo);
	});

	it('refuses an account manager, and nothing is created', async () => {
		const { head } = await ready({ parts: 1 });
		await expect(
			approvePurchaseRequest(db, DANA, {
				purchaseRequestId: head.id,
				expectedUpdatedAt: head.version,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 403 });
		expect((await request(head.id)).status).toBe('draft');
		const orders = await db.asUser(
			OPS,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.procurement_orders where request_id = ${head.id}`
		);
		expect(orders[0].n).toBe(0);
	});

	it('lets an admin', async () => {
		const { head } = await ready({ parts: 1 });
		await expect(
			approvePurchaseRequest(db, ADMIN, {
				purchaseRequestId: head.id,
				expectedUpdatedAt: head.version,
				requestId: randomUUID()
			})
		).resolves.toMatchObject({ lines: 1 });
	});

	it('refuses an approval made from a stale page', async () => {
		const { head } = await ready({ parts: 1 });
		const [line] = await lines(head.id);
		await setRequestLine(db, OPS, {
			lineId: line.id,
			quantity: 60,
			requestedOn: '2026-10-20',
			expectedUpdatedAt: head.version,
			requestId: randomUUID()
		});
		await expect(
			approvePurchaseRequest(db, OPS, {
				purchaseRequestId: head.id,
				expectedUpdatedAt: head.version, // the version from before the edit
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 409 });
		expect((await request(head.id)).status).toBe('draft');
	});

	it('approves once when the same form arrives twice', async () => {
		const { head } = await ready({ parts: 1 });
		const requestId = randomUUID();
		const input = {
			purchaseRequestId: head.id,
			expectedUpdatedAt: head.version,
			requestId
		};
		const first = await approvePurchaseRequest(db, OPS, input);
		const second = await approvePurchaseRequest(db, OPS, input);
		expect(first.replayed).toBe(false);
		expect(second.replayed).toBe(true);
		expect(second.orderNo).toBe(first.orderNo);

		const counted = await db.asUser(
			OPS,
			(tx) => tx.sql<{ orders: number; drafts: number; audit: number }>`
				select
					(select count(*)::int from nl.procurement_orders where request_id = ${head.id}) as orders,
					(select count(*)::int from nl.purchase_request_drafts where request_id = ${head.id}) as drafts,
					(select count(*)::int from nl.audit_log
					 where action = 'approve_purchase_request' and entity_id = ${String(head.id)}) as audit`
		);
		expect(counted[0]).toEqual({ orders: 1, drafts: 1, audit: 1 });
	});

	it('refuses to approve the same draft twice', async () => {
		const { head } = await ready({ parts: 1 });
		await approvePurchaseRequest(db, OPS, {
			purchaseRequestId: head.id,
			expectedUpdatedAt: head.version,
			requestId: randomUUID()
		});
		const after = await request(head.id);
		expect(after.status).toBe('approved');
		await expect(
			approvePurchaseRequest(db, OPS, {
				purchaseRequestId: head.id,
				expectedUpdatedAt: after.version,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });
	});

	it('refuses when the vendor has nobody to email, and raises no order', async () => {
		const { head } = await ready({ parts: 1, contact: false });
		await expect(
			approvePurchaseRequest(db, OPS, {
				purchaseRequestId: head.id,
				expectedUpdatedAt: head.version,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });
		expect((await request(head.id)).status).toBe('draft');
	});

	it('takes the order back down with it when the email would say too much', async () => {
		// The customer behind this part is called "Net 30", which is also this
		// vendor's payment terms, so the email cannot avoid naming it. That is
		// the disclosure policy refusing a real email rather than a contrived
		// one, and the approval has to roll back with it.
		const vendor = await vendorWithShortParts({ parts: 1 });
		await db.asSystem(async (tx) => {
			await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
			             values ('R-NET30', 'Net 30', 'DEALER', ${DANA}, '2020-01-01')`;
			const [c] = await tx.sql<{ id: number }>`
				insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on,
				                            ends_on, created_by)
				values ('Awkwardly named account', 'R-NET30', ${DANA}, 5000, ${TODAY}, '2026-12-31', ${DANA})
				returning id`;
			await tx.sql`insert into nl.commitment_items (commitment_id, item_no)
			             values (${c.id}, ${vendor.items[0]})`;
		});
		const drafted = await draft(vendor);
		const head = await request(drafted.requestIds[0]);

		await expect(
			approvePurchaseRequest(db, OPS, {
				purchaseRequestId: head.id,
				expectedUpdatedAt: head.version,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });

		// Nothing survived: no order, no draft, and the request is still a draft.
		const counted = await db.asUser(
			OPS,
			(tx) => tx.sql<{ orders: number; drafts: number; status: string }>`
				select
					(select count(*)::int from nl.procurement_orders where request_id = ${head.id}) as orders,
					(select count(*)::int from nl.purchase_request_drafts where request_id = ${head.id}) as drafts,
					(select status from nl.purchase_requests where id = ${head.id}) as status`
		);
		expect(counted[0]).toEqual({ orders: 0, drafts: 0, status: 'draft' });
	});
});

describe('the desk the page reads', () => {
	it('groups what needs buying by vendor, worst first, and counts what cannot be ordered', async () => {
		const desk = await getProcurementDesk(db, OPS);
		expect(desk.today).toBe(TODAY);
		expect(desk.coverDays).toBe(30);
		expect(desk.groups.length).toBeGreaterThan(0);
		expect(desk.totals.parts).toBeGreaterThan(0);
		// RP-ORPHAN is bought in with no vendor, so the item card is incomplete.
		expect(desk.totals.itemCardIncomplete).toBeGreaterThan(0);
		expect(desk.groups.some((g) => g.kind === 'orphan')).toBe(true);
		// Parts we make are kept apart from that: a different problem.
		expect(desk.groups.filter((g) => g.kind === 'made').length).toBeLessThanOrEqual(1);

		// Every group's subtotal is the sum of its own lines.
		for (const group of desk.groups) {
			const sum = group.lines.reduce((total, line) => total + line.suggestedCost, 0);
			expect(group.subtotal).toBeCloseTo(sum, 2);
			expect(group.meetsMinimum).toBe(group.minOrder === null || group.subtotal >= group.minOrder);
		}
		// Worst first among the groups that can actually be ordered, and the
		// vendorless ones last whatever their figures.
		const buyable = desk.groups.filter((g) => g.kind === 'vendor');
		for (let i = 1; i < buyable.length; i++) {
			expect(buyable[i - 1].valueAtRisk).toBeGreaterThanOrEqual(buyable[i].valueAtRisk);
		}
		expect(desk.groups.slice(0, buyable.length).every((g) => g.kind === 'vendor')).toBe(true);
		// And the drafts and their lines came through.
		const withLines = desk.requests.filter((r) => r.lines.length > 0);
		expect(withLines.length).toBeGreaterThan(0);
		expect(desk.drafts.length).toBeGreaterThan(0);
		expect(desk.drafts[0].subject).toContain('Purchase order');
		expect(desk.drafts[0].body).toContain('purchase order');
		expect(desk.drafts[0].body).toContain('Order total');
	});

	it('reads the same for an account manager, who simply cannot press anything', async () => {
		const asOps = await getProcurementDesk(db, OPS);
		const asDana = await getProcurementDesk(db, DANA);
		expect(asDana.totals).toEqual(asOps.totals);
		expect(asDana.groups.length).toBe(asOps.groups.length);
	});
});
