// The morning import, now over three reports: recognizing which one a file
// is, holding a file that looks wrong (per report), applying it to the right
// live table, and day over day for supply.
//
// One small world for the whole file, "today" pinned to 2026-09-17. Every
// test starts with no snapshots and no live lines, and uses its own parts,
// customer and vendor, so its numbers never depend on the world.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UploadOutcome } from '$lib/components/exports/types';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { toCsv } from '../exports/csv.ts';
import { REPORT_HEADERS } from '../exports/reports.ts';
import { decideExport, getOperationsBoard, getSnapshotReview, uploadExport } from '../exports/snapshots.ts';

const DANA = 2; // account manager
const PRIYA = 5; // operations
const TODAY = '2026-09-17';
const CUSTOMER = 'T-IMP';
const VENDOR = 'VT-IMP';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.customers (customer_no, name, price_group, customer_since)
		             values (${CUSTOMER}, 'Test Import Customer', 'DEALER', '2020-01-01')`;
		await tx.sql`insert into nl.vendors (vendor_no, name, lead_time)
		             values (${VENDOR}, 'Test Import Supply Co.', '3W')`;
		for (const item of ['YI-1', 'YI-2', 'YI-3']) {
			await tx.sql`
				insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price,
				                      replenishment, work_center, vendor_no)
				values (${item}, 'TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Purchase', 'CUT CELL', ${VENDOR})`;
			await tx.sql`insert into nl.stock (item_no, on_hand, as_of) values (${item}, 0, ${TODAY})`;
		}
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
		await tx.sql`delete from nl.export_snapshots`;
	});
});

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

interface PurchaseRow {
	doc: string;
	line?: number;
	vendor?: string;
	item: string;
	due: string;
	promised?: string;
	qty?: number;
}

function purchaseCsv(rows: PurchaseRow[]): string {
	return toCsv([
		REPORT_HEADERS.open_purchase_lines,
		...rows.map((r) => [
			r.doc,
			r.line ?? 10000,
			r.vendor ?? VENDOR,
			r.item,
			'TEST PART',
			r.due,
			r.promised ?? r.due,
			r.qty ?? 25,
			'MAIN'
		])
	]);
}

interface ProductionRow {
	order: string;
	item: string;
	wc?: string;
	status?: string;
	due: string;
	qty?: number;
}

function productionCsv(rows: ProductionRow[]): string {
	return toCsv([
		REPORT_HEADERS.open_production_orders,
		...rows.map((r) => [r.order, r.item, r.wc ?? 'CUT CELL', r.status ?? 'Released', r.due, r.qty ?? 10])
	]);
}

function salesCsv(rows: { doc: string; item: string; ship: string; qty?: number }[]): string {
	return toCsv([
		REPORT_HEADERS.open_sales_lines,
		...rows.map((r) => [r.doc, 10000, CUSTOMER, r.item, 'TEST PART', r.ship, r.qty ?? 5, '40.00', '', 'MAIN'])
	]);
}

async function upload(text: string, name = 'export.csv') {
	return uploadExport(db, PRIYA, { name, text }, randomUUID());
}

function staged(outcome: UploadOutcome) {
	if (outcome.kind !== 'staged') throw new Error(`expected a staged file, got ${JSON.stringify(outcome)}`);
	return outcome;
}

async function apply(snapshotId: number, decision: 'apply' | 'release' = 'apply', note = '') {
	const review = await getSnapshotReview(db, PRIYA, snapshotId);
	return decideExport(db, PRIYA, {
		snapshotId,
		decision,
		note,
		expectedUpdatedAt: review!.updatedAt,
		requestId: randomUUID()
	});
}

/** Stage a file and apply it in one go, as operations would. */
async function load(text: string, name?: string) {
	const s = staged(await upload(text, name));
	expect(s.status).toBe('staged');
	return { ...s, ...(await apply(s.snapshotId)) };
}

describe('which report is this', () => {
	it('recognizes each of the three by its own columns', async () => {
		const sales = staged(await upload(salesCsv([{ doc: 'S1', item: 'YI-1', ship: '09/30/2026' }])));
		expect(sales.report).toBe('open_sales_lines');

		const purchase = staged(await upload(purchaseCsv([{ doc: 'PO-1', item: 'YI-1', due: '10/05/2026' }])));
		expect(purchase.report).toBe('open_purchase_lines');

		const production = staged(await upload(productionCsv([{ order: 'MO-1', item: 'YI-1', due: '10/05/2026' }])));
		expect(production.report).toBe('open_production_orders');

		// One snapshot each, all three waiting, none of them live yet.
		const kinds = await db.asSystem((tx) =>
			tx.sql<{ kind: string; status: string }>`select kind, status from nl.export_snapshots order by kind`
		);
		expect(kinds).toEqual([
			{ kind: 'open_production_orders', status: 'staged' },
			{ kind: 'open_purchase_lines', status: 'staged' },
			{ kind: 'open_sales_lines', status: 'staged' }
		]);
	});

	it('refuses a file that is none of the three and says what it is closest to', async () => {
		const outcome = await upload(
			toCsv([
				['No.', 'Name', 'City', 'Phone No.'],
				['10012', 'Some Shop', 'Toledo', '555-0101']
			]),
			'customer-list.csv'
		);
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.looksLike).toBe('a customer list');
		expect(outcome.refusal.missing.length).toBeGreaterThan(0);
		expect(await db.asSystem((tx) => tx.sql`select 1 from nl.export_snapshots`)).toEqual([]);
	});

	it('does not mistake a purchase file for the sales export, which shares four of its columns', async () => {
		// Both reports have Document No., Line No., No. and Outstanding
		// Quantity; only the purchase file has a vendor and a receipt date.
		const purchase = staged(await upload(purchaseCsv([{ doc: 'PO-2', item: 'YI-2', due: '10/05/2026' }])));
		expect(purchase.report).toBe('open_purchase_lines');
	});
});

describe('purchase lines', () => {
	it('applies, upserts on document and line, keeps first_seen_on, and drops what is gone', async () => {
		const day1 = await load(
			purchaseCsv([
				{ doc: 'PO-10', item: 'YI-1', due: '10/05/2026', qty: 25 },
				{ doc: 'PO-10', line: 20000, item: 'YI-2', due: '10/05/2026', qty: 50 },
				{ doc: 'PO-11', item: 'YI-3', due: '10/20/2026', qty: 100 }
			])
		);
		expect(day1.summary).toEqual({ added: 3, changed: 0, removed: 0 });

		await db.asSystem((tx) => tx.sql`select set_config('nl.today', '2026-09-18', false)`);
		const day2 = await load(
			purchaseCsv([
				// The vendor moved this one out a week; the promised date stays.
				{ doc: 'PO-10', item: 'YI-1', due: '10/12/2026', promised: '10/05/2026', qty: 25 },
				{ doc: 'PO-10', line: 20000, item: 'YI-2', due: '10/05/2026', qty: 50 },
				// PO-11 was received, PO-12 was placed.
				{ doc: 'PO-12', item: 'YI-3', due: '11/02/2026', qty: 40 }
			])
		);
		expect(day2.summary).toEqual({ added: 1, changed: 1, removed: 1 });

		const live = await db.asUser(DANA, (tx) =>
			tx.sql<{
				document_no: string;
				line_no: number;
				due_date: string;
				promised_date: string;
				quantity: number;
				first_seen_on: string;
			}>`
				select document_no, line_no, due_date, promised_date, quantity, first_seen_on
				from nl.open_purchase_lines order by document_no, line_no`
		);
		expect(live).toEqual([
			{
				document_no: 'PO-10',
				line_no: 10000,
				due_date: '2026-10-12',
				promised_date: '2026-10-05',
				quantity: 25,
				first_seen_on: '2026-09-17'
			},
			{
				document_no: 'PO-10',
				line_no: 20000,
				due_date: '2026-10-05',
				promised_date: '2026-10-05',
				quantity: 50,
				first_seen_on: '2026-09-17'
			},
			{
				document_no: 'PO-12',
				line_no: 10000,
				due_date: '2026-11-02',
				promised_date: '2026-11-02',
				quantity: 40,
				first_seen_on: '2026-09-18'
			}
		]);

		// Day over day, from the two applied snapshots of this report.
		const changes = await db.asUser(DANA, (tx) =>
			tx.sql<{ change: string; document_no: string; days_moved: number | null }>`
				select change, document_no, days_moved from nl.supply_changes
				where kind = 'open_purchase_lines' order by document_no`
		);
		expect(changes).toEqual([
			{ change: 'due_later', document_no: 'PO-10', days_moved: 7 },
			{ change: 'received', document_no: 'PO-11', days_moved: null },
			{ change: 'new', document_no: 'PO-12', days_moved: null }
		]);
		await db.asSystem((tx) => tx.sql`select set_config('nl.today', ${TODAY}, false)`);
	});

	it('holds a file whose rows name a vendor or a part that does not exist', async () => {
		const s = staged(
			await upload(
				purchaseCsv([
					{ doc: 'PO-20', item: 'YI-1', due: '10/05/2026' },
					{ doc: 'PO-21', vendor: 'V-NOPE', item: 'YI-1', due: '10/05/2026' },
					{ doc: 'PO-22', item: 'YI-NOPE', due: '10/05/2026' }
				])
			)
		);
		expect(s.status).toBe('held');
		const review = await getSnapshotReview(db, PRIYA, s.snapshotId);
		expect(review).toMatchObject({ kind: 'open_purchase_lines', rowCount: 3, lineCount: 1, errorCount: 2 });
		expect(review!.errors.map((e) => e.reasons.join(' '))).toEqual([
			'Vendor V-NOPE is not in the vendor list.',
			'Item YI-NOPE is not in the item list.'
		]);
		// Released with a note, the one good line goes live.
		const released = await apply(s.snapshotId, 'release', 'V-NOPE is being set up; load the rest.');
		expect(released.summary).toEqual({ added: 1, changed: 0, removed: 0 });
	});

	it('holds a file whose due dates have all passed', async () => {
		const s = staged(
			await upload(
				purchaseCsv([
					{ doc: 'PO-30', item: 'YI-1', due: '08/20/2026' },
					{ doc: 'PO-31', item: 'YI-2', due: '09/16/2026' }
				])
			)
		);
		expect(s.status).toBe('held');
		const review = await getSnapshotReview(db, PRIYA, s.snapshotId);
		expect(review!.holdReasons).toEqual([
			{
				code: 'stale',
				message: 'Every due date is before today (the latest is Sep 16, 2026). This looks like an old export.'
			}
		]);
	});
});

describe('production orders', () => {
	it('applies on the order number and keeps the work center and status', async () => {
		const day1 = await load(
			productionCsv([
				{ order: 'MO-10', item: 'YI-1', due: '09/28/2026', qty: 20 },
				{ order: 'MO-11', item: 'YI-2', wc: 'WELD CELL', status: 'Firm Planned', due: '10/09/2026', qty: 15 }
			])
		);
		expect(day1.summary).toEqual({ added: 2, changed: 0, removed: 0 });

		const day2 = await load(
			productionCsv([
				// Started, so it is Released now, and five pieces are done.
				{ order: 'MO-11', item: 'YI-2', wc: 'WELD CELL', status: 'Released', due: '10/09/2026', qty: 10 }
			])
		);
		expect(day2.summary).toEqual({ added: 0, changed: 1, removed: 1 });

		expect(
			await db.asUser(DANA, (tx) =>
				tx.sql<{ order_no: string; work_center: string; status: string; quantity: number }>`
					select order_no, work_center, status, quantity from nl.open_production_orders order by order_no`
			)
		).toEqual([{ order_no: 'MO-11', work_center: 'WELD CELL', status: 'Released', quantity: 10 }]);
	});
});

describe('the three reports keep their own history', () => {
	it('holds a short file against the live file of its own report, not another', async () => {
		const ten = Array.from({ length: 10 }, (_, i): PurchaseRow => ({
			doc: `PO-4${i}`,
			item: 'YI-1',
			due: '10/30/2026'
		}));
		await load(purchaseCsv(ten));

		// Three purchase lines against ten is under 40%: held.
		const short = staged(await upload(purchaseCsv(ten.slice(0, 3))));
		expect(short.status).toBe('held');
		expect((await getSnapshotReview(db, PRIYA, short.snapshotId))!.holdReasons[0].code).toBe('partial');

		// Three sales lines is the first sales file there has ever been, so the
		// ten purchase lines say nothing about it.
		const sales = staged(
			await upload(
				salesCsv([
					{ doc: 'S1', item: 'YI-1', ship: '10/01/2026' },
					{ doc: 'S2', item: 'YI-2', ship: '10/02/2026' },
					{ doc: 'S3', item: 'YI-3', ship: '10/03/2026' }
				])
			)
		);
		expect(sales.status).toBe('staged');
	});

	it('has one live snapshot per report at the same time, and lists them all', async () => {
		await load(salesCsv([{ doc: 'S9', item: 'YI-1', ship: '10/01/2026' }]));
		await load(purchaseCsv([{ doc: 'PO-50', item: 'YI-1', due: '10/05/2026' }]));
		await load(productionCsv([{ order: 'MO-50', item: 'YI-2', due: '10/05/2026' }]));

		expect(
			await db.asSystem((tx) =>
				tx.sql<{ kind: string }>`select kind from nl.export_snapshots where is_current order by kind`
			)
		).toEqual([
			{ kind: 'open_production_orders' },
			{ kind: 'open_purchase_lines' },
			{ kind: 'open_sales_lines' }
		]);

		// The operations board still reads the sales export for its buckets and
		// day over day, and lists every report in its history.
		const board = await getOperationsBoard(db, DANA);
		expect(board.current?.fileName).toBe('export.csv');
		expect(board.totals.lines).toBe(1);
		expect(board.dayOverDay.counts).toEqual({ new: 1, shipped: 0, newly_short: 0 });
		expect([...new Set(board.history.map((h) => h.kind))].sort()).toEqual([
			'open_production_orders',
			'open_purchase_lines',
			'open_sales_lines'
		]);
	});
});
