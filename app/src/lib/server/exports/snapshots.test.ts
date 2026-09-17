// Workflow D, the database side: staging, holding, applying, allocating.
//
// One small world for the whole file. Every test starts with no snapshots
// and no live lines, and "today" pinned to 2026-09-17. Tests that allocate
// stock use their own test items, so their numbers never depend on the world.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { toCsv } from './csv.ts';
import { OPEN_LINES_HEADERS } from './openLines.ts';
import { FIXTURE_FILE_NAMES, sampleFile } from './samples.ts';
import { decideExport, decisionInput, getOperationsBoard, getSnapshotReview, uploadExport } from './snapshots.ts';
import type { SampleKind, UploadOutcome } from '$lib/components/exports/types';

const ADMIN = 1;
const DANA = 2; // account manager
const PRIYA = 5; // operations
const JORDAN = 6; // operations
const TERRY = 7; // no longer active

const TODAY = '2026-09-17';
const CUSTOMER = 'T-OPS';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.customers (customer_no, name, price_group, customer_since)
		             values (${CUSTOMER}, 'Test Order Desk Customer', 'DEALER', '2020-01-01')`;
		for (const item of ['XT-A', 'XT-B', 'XT-C', 'XT-D', 'XT-NOSTOCK']) {
			await tx.sql`insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price, replenishment)
			             values (${item}, 'TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Prod. Order')`;
		}
		for (const [item, onHand] of [
			['XT-A', 10],
			['XT-B', 5],
			['XT-C', 100],
			['XT-D', 0]
		] as const) {
			await tx.sql`insert into nl.stock (item_no, on_hand, as_of) values (${item}, ${onHand}, ${TODAY})`;
		}
	});
});

afterAll(async () => {
	await db?.close();
});

beforeEach(async () => {
	await setToday(TODAY);
	await db.asSystem(async (tx) => {
		// The live tables point at the snapshot they came from, so they go first.
		// The world is seeded with two days of all three exports (db/seed.d/40_supply.sql);
		// these tests start from nothing so their numbers are their own.
		await tx.sql`delete from nl.open_order_lines`;
		await tx.sql`delete from nl.open_purchase_lines`;
		await tx.sql`delete from nl.open_production_orders`;
		await tx.sql`delete from nl.export_snapshots`;
	});
});

async function setToday(day: string) {
	await db.asSystem((tx) => tx.sql`select set_config('nl.today', ${day}, false)`);
}

interface Row {
	doc: string;
	line?: number;
	customer?: string;
	item: string;
	ship: string; // 'MM/DD/YYYY' or any format the reader takes
	qty: number | string;
	price?: number | string;
}

function csvOf(rows: Row[]): string {
	return toCsv([
		OPEN_LINES_HEADERS,
		...rows.map((r) => [
			r.doc,
			r.line ?? 10000,
			r.customer ?? CUSTOMER,
			r.item,
			'TEST PART',
			r.ship,
			r.qty,
			r.price ?? '40.00',
			'',
			'MAIN'
		])
	]);
}

async function upload(userId: number, text: string, name = 'open-sales-lines.csv', rid = randomUUID()) {
	return uploadExport(db, userId, { name, text }, rid);
}

function staged(outcome: UploadOutcome) {
	if (outcome.kind !== 'staged') throw new Error(`expected a staged file, got ${JSON.stringify(outcome)}`);
	return outcome;
}

async function review(id: number) {
	const r = await getSnapshotReview(db, PRIYA, id);
	if (!r) throw new Error(`snapshot ${id} is missing`);
	return r;
}

async function decide(
	userId: number,
	snapshotId: number,
	decision: 'apply' | 'release' | 'discard',
	options: { note?: string; version?: string; rid?: string } = {}
) {
	const version = options.version ?? (await review(snapshotId)).updatedAt;
	return decideExport(db, userId, {
		snapshotId,
		decision,
		note: options.note ?? '',
		expectedUpdatedAt: version,
		requestId: options.rid ?? randomUUID()
	});
}

/** Stage a file as operations and apply it. */
async function load(rows: Row[] | string, name?: string) {
	const s = staged(await upload(PRIYA, typeof rows === 'string' ? rows : csvOf(rows), name));
	expect(s.status).toBe('staged');
	return decide(PRIYA, s.snapshotId, 'apply');
}

async function rejection(work: Promise<unknown>): Promise<AppError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error('expected the write to be refused');
}

/** Row counts of everything this workflow writes. */
async function footprint() {
	const [row] = await db.asSystem((tx) =>
		tx.sql<Record<string, number>>`
			select (select count(*) from nl.export_snapshots) as snapshots,
			       (select count(*) from nl.export_snapshot_lines) as lines,
			       (select count(*) from nl.export_snapshot_errors) as errors,
			       (select count(*) from nl.open_order_lines) as live,
			       (select count(*) from nl.audit_log) as audit,
			       (select count(*) from nl.request_log) as requests`
	);
	return row;
}

async function liveLines() {
	return db.asSystem((tx) =>
		tx.sql<{ document_no: string; quantity: number; first_seen_on: string; last_snapshot_id: number }>`
			select document_no, quantity, first_seen_on, last_snapshot_id
			from nl.open_order_lines order by document_no, line_no`
	);
}

async function allocation() {
	return db.asUser(DANA, (tx) =>
		tx.sql<{ document_no: string; item_no: string; allocated: number; short: number; bucket: string }>`
			select document_no, item_no, allocated, short, bucket
			from nl.open_line_allocation order by item_no, ship_date, document_no`
	);
}

describe('staging', () => {
	it('stages a clean first file without touching the live table', async () => {
		const s = staged(await upload(PRIYA, csvOf([{ doc: 'D1', item: 'XT-A', ship: '09/20/2026', qty: 2 }])));
		expect(s).toMatchObject({ status: 'staged', replayed: false });
		const r = await review(s.snapshotId);
		expect(r).toMatchObject({ rowCount: 1, lineCount: 1, errorCount: 0, totalQuantity: 2, totalValue: 80, holdReasons: [] });
		expect(r.diff).toEqual({ added: 1, changed: 0, removed: 0, unchanged: 0 });
		expect(await liveLines()).toEqual([]);

		const [audit] = await db.asSystem((tx) =>
			tx.sql<{ via: string; actor_id: number }>`
				select via, actor_id from nl.audit_log where entity = 'export_snapshot' and entity_id = ${String(s.snapshotId)}`
		);
		expect(audit).toEqual({ via: 'import', actor_id: PRIYA });
	});

	it('recognizes the same data again, whatever the file is called, and writes nothing', async () => {
		const rows: Row[] = [
			{ doc: 'D1', item: 'XT-A', ship: '09/20/2026', qty: 2 },
			{ doc: 'D2', item: 'XT-B', ship: '09/21/2026', qty: 1 }
		];
		const first = staged(await upload(PRIYA, csvOf(rows), 'open-sales-lines-0600.csv'));
		const before = await footprint();

		// Another name, other row order, dates written another way.
		const again = await upload(JORDAN, csvOf([{ ...rows[1], ship: '2026-09-21' }, rows[0]]), 'open-sales-lines-0715.csv');
		expect(again).toMatchObject({
			kind: 'duplicate',
			snapshotId: first.snapshotId,
			// The real day it was loaded, in the company's time zone (not the pinned "today").
			stagedOn: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }),
			stagedBy: 'Priya Raman',
			status: 'staged'
		});
		expect(await footprint()).toEqual(before);

		// A corrected value is new data.
		const corrected = await upload(PRIYA, csvOf([rows[0], { ...rows[1], qty: 3 }]));
		expect(corrected.kind).toBe('staged');
	});

	it('replays a repeated request instead of staging twice', async () => {
		const rid = randomUUID();
		const text = csvOf([{ doc: 'D1', item: 'XT-A', ship: '09/20/2026', qty: 2 }]);
		const first = staged(await upload(PRIYA, text, 'a.csv', rid));
		const before = await footprint();
		const second = staged(await upload(PRIYA, text, 'a.csv', rid));
		expect(second).toEqual({ ...first, replayed: true });
		expect(await footprint()).toEqual(before);
	});

	it('refuses the wrong report and writes nothing', async () => {
		const before = await footprint();
		const outcome = await upload(
			PRIYA,
			'Document No.,Line No.,Sell-to Customer No.,Posting Date,No.,Quantity,Unit Price,Amount\r\nSI1,10000,T-OPS,09/01/2026,XT-A,1,40,40\r\n',
			'posted-invoices.csv'
		);
		expect(outcome.kind).toBe('refused');
		if (outcome.kind !== 'refused') return;
		expect(outcome.refusal.missing).toEqual(['Shipment Date', 'Outstanding Quantity']);
		expect(outcome.refusal.looksLike).toBe('a posted sales invoice lines export');
		expect(await footprint()).toEqual(before);
	});

	it('holds a file with row errors, lists them, and keeps them out of the staged lines', async () => {
		const s = staged(
			await upload(
				PRIYA,
				csvOf([
					{ doc: 'D1', item: 'XT-A', ship: '09/20/2026', qty: 2 },
					{ doc: 'D2', item: 'XT-NOPE', ship: '09/20/2026', qty: 2 },
					{ doc: 'D3', customer: 'NOBODY', item: 'XT-A', ship: '09/20/2026', qty: 2 },
					{ doc: 'D4', item: 'XT-A', ship: 'next week', qty: 2 },
					{ doc: 'D5', item: 'XT-A', ship: '09/20/2026', qty: 0 },
					{ doc: 'D1', item: 'XT-B', ship: '09/21/2026', qty: 1 }
				])
			)
		);
		expect(s.status).toBe('held');
		const r = await review(s.snapshotId);
		expect(r).toMatchObject({ rowCount: 6, lineCount: 0, errorCount: 6 });
		expect(r.holdReasons.map((h) => h.code)).toEqual(['row_errors']);
		expect(r.holdReasons[0].message).toBe('6 of 6 rows failed a check. Releasing loads the other 0 and leaves these out.');
		expect(r.errors.map((e) => [e.rowNo, e.documentNo, e.reasons.join(' ')])).toEqual([
			[2, 'D1', 'Document No. D1, Line No. 10000 appears more than once (rows 2, 7).'],
			[3, 'D2', 'Item XT-NOPE is not in the item list.'],
			[4, 'D3', 'Customer NOBODY is not in the customer list.'],
			[5, 'D4', 'Shipment Date "next week" is not a date.'],
			[6, 'D5', 'Outstanding Quantity is 0; it must be more than zero.'],
			[7, 'D1', 'Document No. D1, Line No. 10000 appears more than once (rows 2, 7).']
		]);
	});

	it('holds a file where every ship date has passed', async () => {
		const s = staged(
			await upload(PRIYA, csvOf([
				{ doc: 'D1', item: 'XT-A', ship: '09/16/2026', qty: 2 },
				{ doc: 'D2', item: 'XT-A', ship: '08/01/2026', qty: 2 }
			]))
		);
		expect(s.status).toBe('held');
		const r = await review(s.snapshotId);
		expect(r.holdReasons).toEqual([
			{ code: 'stale', message: 'Every ship date is before today (the latest is Sep 16, 2026). This looks like an old export.' }
		]);
		// One line due today is enough to not be stale.
		const fresh = staged(await upload(PRIYA, csvOf([{ doc: 'D1', item: 'XT-A', ship: '09/17/2026', qty: 2 }])));
		expect(fresh.status).toBe('staged');
	});

	it('holds a file with under 40% of the lines behind the live data', async () => {
		const ten = Array.from({ length: 10 }, (_, i): Row => ({ doc: `D${i}`, item: 'XT-C', ship: '09/30/2026', qty: 1 }));
		await load(ten);
		// 4 of 10 is not under 40%; 3 is.
		expect(staged(await upload(PRIYA, csvOf(ten.slice(0, 4)))).status).toBe('staged');
		const s = staged(await upload(PRIYA, csvOf(ten.slice(0, 3))));
		expect(s.status).toBe('held');
		expect((await review(s.snapshotId)).holdReasons).toEqual([
			{
				code: 'partial',
				message:
					'This file has 3 lines; the live data came from a file with 10. Under 40% of the last export usually means the export was cut short.'
			}
		]);
	});
});

describe('who may decide', () => {
	it('lets an account manager look but not stage, apply, release or discard', async () => {
		const text = csvOf([{ doc: 'D1', item: 'XT-A', ship: '09/20/2026', qty: 2 }]);
		expect((await rejection(upload(DANA, text))).status).toBe(403);

		const s = staged(await upload(PRIYA, text));
		const held = staged(await upload(PRIYA, csvOf([{ doc: 'D9', item: 'XT-A', ship: '01/01/2026', qty: 2 }])));
		expect(await getSnapshotReview(db, DANA, s.snapshotId)).not.toBeNull();

		expect((await rejection(decide(DANA, s.snapshotId, 'apply'))).status).toBe(403);
		expect((await rejection(decide(DANA, s.snapshotId, 'discard'))).status).toBe(403);
		expect((await rejection(decide(DANA, held.snapshotId, 'release', { note: 'looks fine' }))).status).toBe(403);
		expect((await review(s.snapshotId)).status).toBe('staged');
		expect(await liveLines()).toEqual([]);

		// The table policies refuse a direct write too, even if a function forgot to check.
		await expect(
			db.asUser(DANA, (tx) =>
				tx.sql`insert into nl.open_order_lines (document_no, line_no, customer_no, item_no, ship_date, quantity,
				                                         unit_price, first_seen_on, last_snapshot_id)
				       values ('X', 1, ${CUSTOMER}, 'XT-A', ${TODAY}, 1, 1, ${TODAY}, ${s.snapshotId})`
			)
		).rejects.toThrow(/row-level security/);
	});

	it('lets operations and admins decide, and nobody who is inactive', async () => {
		const a = staged(await upload(PRIYA, csvOf([{ doc: 'D1', item: 'XT-A', ship: '09/20/2026', qty: 2 }])));
		expect((await rejection(decide(TERRY, a.snapshotId, 'apply'))).status).toBe(401);
		const done = await decide(ADMIN, a.snapshotId, 'apply');
		expect(done.summary).toEqual({ added: 1, changed: 0, removed: 0 });
		const b = staged(await upload(JORDAN, csvOf([{ doc: 'D2', item: 'XT-A', ship: '09/20/2026', qty: 2 }])));
		await decide(JORDAN, b.snapshotId, 'discard');
		expect((await review(b.snapshotId)).status).toBe('discarded');
	});
});

describe('applying', () => {
	it('upserts on document and line, keeps first_seen_on, and removes lines that are gone', async () => {
		const day1 = await load([
			{ doc: 'D1', item: 'XT-C', ship: '09/20/2026', qty: 2 },
			{ doc: 'D2', item: 'XT-C', ship: '09/21/2026', qty: 3 },
			{ doc: 'D3', item: 'XT-C', ship: '09/22/2026', qty: 4 }
		]);
		expect(day1.summary).toEqual({ added: 3, changed: 0, removed: 0 });

		await setToday('2026-09-18');
		const day2 = await load([
			{ doc: 'D1', item: 'XT-C', ship: '09/20/2026', qty: 5 }, // changed
			{ doc: 'D2', item: 'XT-C', ship: '09/21/2026', qty: 3 }, // the same
			{ doc: 'D4', item: 'XT-C', ship: '09/25/2026', qty: 1 } // new; D3 shipped
		]);
		expect(day2.summary).toEqual({ added: 1, changed: 1, removed: 1 });
		expect(await liveLines()).toEqual([
			{ document_no: 'D1', quantity: 5, first_seen_on: '2026-09-17', last_snapshot_id: day2.snapshotId },
			{ document_no: 'D2', quantity: 3, first_seen_on: '2026-09-17', last_snapshot_id: day2.snapshotId },
			{ document_no: 'D4', quantity: 1, first_seen_on: '2026-09-18', last_snapshot_id: day2.snapshotId }
		]);

		const current = await db.asSystem((tx) =>
			tx.sql<{ id: number }>`select id from nl.export_snapshots where is_current`
		);
		expect(current).toEqual([{ id: day2.snapshotId }]);
		expect((await review(day1.snapshotId)).status).toBe('applied');
		expect((await review(day2.snapshotId)).applySummary).toEqual({ added: 1, changed: 1, removed: 1 });
	});

	it('refuses to apply a snapshot older than the current one', async () => {
		const older = staged(await upload(PRIYA, csvOf([{ doc: 'D1', item: 'XT-C', ship: '09/20/2026', qty: 1 }])));
		const newer = staged(await upload(PRIYA, csvOf([{ doc: 'D1', item: 'XT-C', ship: '09/20/2026', qty: 2 }])));
		await decide(PRIYA, newer.snapshotId, 'apply');

		expect((await review(older.snapshotId)).olderThanCurrent).toBe(true);
		const refused = await rejection(decide(PRIYA, older.snapshotId, 'apply'));
		expect(refused.status).toBe(422);
		expect(refused.message).toMatch(/older than the live data/);
		expect((await liveLines())[0].quantity).toBe(2);
		// It can still be thrown away.
		await decide(PRIYA, older.snapshotId, 'discard');
	});

	it('refuses a decision made on a stale version of the snapshot', async () => {
		const s = staged(await upload(PRIYA, csvOf([{ doc: 'D1', item: 'XT-C', ship: '09/20/2026', qty: 1 }])));
		const version = (await review(s.snapshotId)).updatedAt;
		const stale = new Date(Date.parse(version) - 1).toISOString();
		expect((await rejection(decide(PRIYA, s.snapshotId, 'apply', { version: stale }))).status).toBe(409);

		// Someone else discarded it after this page loaded.
		await decide(JORDAN, s.snapshotId, 'discard', { version });
		expect((await rejection(decide(PRIYA, s.snapshotId, 'apply', { version }))).status).toBe(409);
	});

	it('replays a repeated request id instead of applying twice', async () => {
		const s = staged(await upload(PRIYA, csvOf([{ doc: 'D1', item: 'XT-C', ship: '09/20/2026', qty: 1 }])));
		const version = (await review(s.snapshotId)).updatedAt;
		const rid = randomUUID();
		const first = await decide(PRIYA, s.snapshotId, 'apply', { version, rid });
		expect(first.replayed).toBe(false);
		const again = await decide(PRIYA, s.snapshotId, 'apply', { version, rid });
		expect(again).toEqual({ ...first, replayed: true });

		const audit = await db.asSystem((tx) =>
			tx.sql<{ action: string; via: string }>`
				select action, via from nl.audit_log
				where entity = 'export_snapshot' and entity_id = ${String(s.snapshotId)} order by id`
		);
		expect(audit).toEqual([
			{ action: 'stage_export', via: 'import' },
			{ action: 'apply_export', via: 'ui' }
		]);
		// The same id for a different decision is refused.
		expect((await rejection(decide(PRIYA, s.snapshotId, 'discard', { version, rid }))).status).toBe(409);
	});

	it('releases a held snapshot only with a note, loading its good rows; discard is final', async () => {
		const held = staged(
			await upload(
				PRIYA,
				csvOf([
					{ doc: 'D1', item: 'XT-C', ship: '09/20/2026', qty: 1 },
					{ doc: 'D2', item: 'XT-NOPE', ship: '09/20/2026', qty: 1 }
				])
			)
		);
		expect(held.status).toBe('held');
		expect((await rejection(decide(PRIYA, held.snapshotId, 'apply'))).message).toMatch(/is held/);
		// The page checks the note, and so does the database.
		expect(decisionInput.safeParse({
			snapshotId: held.snapshotId, decision: 'release', note: ' ', expectedUpdatedAt: new Date().toISOString(), requestId: randomUUID()
		}).success).toBe(false);
		expect((await rejection(decide(PRIYA, held.snapshotId, 'release', { note: '' }))).message).toMatch(/needs a note/);

		const released = await decide(PRIYA, held.snapshotId, 'release', { note: 'XT-NOPE is being set up; load the rest.' });
		expect(released.summary).toEqual({ added: 1, changed: 0, removed: 0 });
		const r = await review(held.snapshotId);
		expect(r).toMatchObject({ status: 'applied', isCurrent: true, decidedBy: 'Priya Raman', decisionNote: 'XT-NOPE is being set up; load the rest.' });
		expect((await liveLines()).map((l) => l.document_no)).toEqual(['D1']);

		const gone = staged(await upload(PRIYA, csvOf([{ doc: 'D7', item: 'XT-C', ship: '09/20/2026', qty: 1 }])));
		await decide(PRIYA, gone.snapshotId, 'discard');
		expect((await rejection(decide(PRIYA, gone.snapshotId, 'apply'))).message).toMatch(/already discarded/);
		expect((await rejection(decide(PRIYA, gone.snapshotId, 'discard'))).status).toBe(422);
	});
});

describe('allocation and buckets', () => {
	it('gives stock to the oldest ship date first, then by document, and buckets every line', async () => {
		// XT-A has 10 on hand. Today is Sep 17; the horizon ends Oct 1.
		await load([
			{ doc: 'L', item: 'XT-A', ship: '10/30/2026', qty: 2 },
			{ doc: 'F', item: 'XT-A', ship: '10/02/2026', qty: 1 },
			{ doc: 'E', item: 'XT-A', ship: '10/01/2026', qty: 1 },
			{ doc: 'B', item: 'XT-A', ship: '09/25/2026', qty: 3 },
			{ doc: 'D-A', item: 'XT-A', ship: '09/20/2026', qty: 5 },
			{ doc: 'D-0', item: 'XT-A', ship: '09/20/2026', qty: 3 }, // same day, sorts first
			{ doc: 'G', item: 'XT-A', ship: '09/17/2026', qty: 1 }, // due today
			{ doc: 'P', item: 'XT-A', ship: '09/10/2026', qty: 4 }, // late: first in line
			{ doc: 'N', item: 'XT-NOSTOCK', ship: '09/20/2026', qty: 2 }, // no stock row at all
			{ doc: 'Z', item: 'XT-D', ship: '12/01/2026', qty: 1 } // zero on hand, due later
		]);
		expect((await allocation()).map((a) => [a.document_no, a.allocated, a.short, a.bucket])).toEqual([
			['P', 4, 0, 'past_due'],
			['G', 1, 0, 'on_pace'],
			['D-0', 3, 0, 'on_pace'],
			['D-A', 2, 3, 'at_risk'],
			['B', 0, 3, 'at_risk'],
			['E', 0, 1, 'at_risk'],
			['F', 0, 1, 'later'],
			['L', 0, 2, 'later'],
			['Z', 0, 1, 'later'],
			['N', 0, 2, 'at_risk']
		]);

		const board = await getOperationsBoard(db, DANA);
		expect(board.buckets).toEqual([
			{ bucket: 'past_due', lines: 1, quantity: 4, short: 0, value: 160 },
			{ bucket: 'at_risk', lines: 4, quantity: 11, short: 9, value: 440 },
			{ bucket: 'on_pace', lines: 2, quantity: 4, short: 0, value: 160 },
			{ bucket: 'later', lines: 3, quantity: 4, short: 4, value: 160 }
		]);
		expect(board.riskLines.map((l) => l.documentNo)).toEqual(['P', 'D-A', 'N', 'B', 'E']);
		expect(board.riskLineCount).toBe(5);
	});

	it('puts every line in exactly one bucket (the fixture day)', async () => {
		await load(fixture('yesterday'));
		await load(fixture('today'));
		const [check] = await db.asUser(DANA, (tx) =>
			tx.sql<{ lines: number; keys: number; quantity: number; view_lines: number; view_quantity: number; unknown: number }>`
				select (select count(*) from nl.open_order_lines) as lines,
				       (select count(distinct (document_no, line_no)) from nl.open_line_allocation) as keys,
				       (select sum(quantity) from nl.open_order_lines) as quantity,
				       (select count(*) from nl.open_line_allocation) as view_lines,
				       (select sum(quantity) from nl.open_line_allocation) as view_quantity,
				       (select count(*) from nl.open_line_allocation
				        where bucket not in ('past_due', 'at_risk', 'on_pace', 'later')
				           or allocated + short <> quantity or allocated < 0 or short < 0) as unknown`
		);
		expect(check.lines).toBeGreaterThan(80);
		expect(check.view_lines).toBe(check.lines);
		expect(check.keys).toBe(check.lines);
		expect(check.view_quantity).toBe(check.quantity);
		expect(check.unknown).toBe(0);

		const board = await getOperationsBoard(db, DANA);
		const sum = (key: 'lines' | 'quantity') => board.buckets.reduce((total, b) => total + b[key], 0);
		expect(sum('lines')).toBe(check.lines);
		expect(sum('quantity')).toBe(check.quantity);
		expect(board.totals.lines).toBe(check.lines);
		// A realistic day has some of every kind.
		for (const b of board.buckets) expect(b.lines, b.bucket).toBeGreaterThan(0);
	});
});

describe('day over day', () => {
	it('lists new, shipped and newly short lines between the last two applied snapshots', async () => {
		// XT-B has 5 on hand.
		await load([
			{ doc: 'K1', item: 'XT-B', ship: '09/20/2026', qty: 2 }, // covered both days
			{ doc: 'K2', item: 'XT-B', ship: '09/21/2026', qty: 2 }, // covered, then short
			{ doc: 'K3', item: 'XT-C', ship: '09/18/2026', qty: 1 }, // ships
			{ doc: 'K5', item: 'XT-D', ship: '09/22/2026', qty: 1 } // short both days
		]);
		let board = await getOperationsBoard(db, DANA);
		expect(board.dayOverDay.previousId).toBeNull();
		expect(board.dayOverDay.counts).toEqual({ new: 4, shipped: 0, newly_short: 0 });

		await setToday('2026-09-18');
		const day2 = await load([
			{ doc: 'K1', item: 'XT-B', ship: '09/20/2026', qty: 2 },
			{ doc: 'K2', item: 'XT-B', ship: '09/21/2026', qty: 6 },
			{ doc: 'K4', item: 'XT-C', ship: '09/30/2026', qty: 1 },
			{ doc: 'K5', item: 'XT-D', ship: '09/22/2026', qty: 1 }
		]);
		board = await getOperationsBoard(db, DANA);
		expect(board.current?.id).toBe(day2.snapshotId);
		expect(board.dayOverDay.counts).toEqual({ new: 1, shipped: 1, newly_short: 1 });
		expect(board.dayOverDay.lines.map((l) => [l.change, l.documentNo, l.shortBefore, l.shortNow])).toEqual([
			['newly_short', 'K2', 0, 3],
			['new', 'K4', null, 0],
			['shipped', 'K3', 0, null]
		]);

		// The stored figures do not move when stock does.
		await db.asSystem((tx) => tx.sql`update nl.stock set on_hand = 100 where item_no = 'XT-B'`);
		try {
			expect((await getOperationsBoard(db, DANA)).dayOverDay.counts.newly_short).toBe(1);
		} finally {
			await db.asSystem((tx) => tx.sql`update nl.stock set on_hand = 5 where item_no = 'XT-B'`);
		}
	});
});

// ---------------------------------------------------------------------------
// The sample files in fixtures/exports
// ---------------------------------------------------------------------------

function fixture(kind: SampleKind): string {
	return readFileSync(resolve(process.cwd(), '..', 'fixtures', 'exports', FIXTURE_FILE_NAMES[kind](TODAY)), 'utf8');
}

describe('the fixture files', () => {
	it('are exactly what the generator makes for the small world today', async () => {
		await db.asUser(DANA, async (tx) => {
			for (const kind of ['yesterday', 'today', 'messy', 'partial', 'stale', 'wrong-report'] as SampleKind[]) {
				expect((await sampleFile(tx, kind)).text, kind).toBe(fixture(kind));
			}
		});
	});

	it('behave as described: two days apply, the messy copy is recognized, the rest are held or refused', async () => {
		const yesterday = staged(await upload(PRIYA, fixture('yesterday'), 'open-sales-lines-2026-09-16.csv'));
		expect(yesterday.status).toBe('staged');
		expect((await review(yesterday.snapshotId)).errorCount).toBe(0);
		await decide(PRIYA, yesterday.snapshotId, 'apply');

		const today = staged(await upload(PRIYA, fixture('today'), 'open-sales-lines-2026-09-17.csv'));
		expect(today.status).toBe('staged');
		const r = await review(today.snapshotId);
		expect(r.errorCount).toBe(0);
		// A realistic day later: some shipped, some new, a few changed, most the same.
		expect(r.diff.added).toBeGreaterThan(0);
		expect(r.diff.removed).toBeGreaterThan(0);
		expect(r.diff.changed).toBeGreaterThan(0);
		expect(r.diff.unchanged).toBeGreaterThan(r.lineCount / 2);
		await decide(PRIYA, today.snapshotId, 'apply');

		const board = await getOperationsBoard(db, PRIYA);
		expect(board.dayOverDay.counts.new).toBe(r.diff.added);
		expect(board.dayOverDay.counts.shipped).toBe(r.diff.removed);

		// Same data as today's file after a spreadsheet saved it.
		const messy = await upload(PRIYA, fixture('messy'), 'messy-export.csv');
		expect(messy).toMatchObject({ kind: 'duplicate', snapshotId: today.snapshotId });

		const partial = staged(await upload(PRIYA, fixture('partial'), 'partial-export.csv'));
		expect((await review(partial.snapshotId)).holdReasons.map((h) => h.code)).toEqual(['partial']);

		const stale = staged(await upload(PRIYA, fixture('stale'), 'stale-export.csv'));
		expect((await review(stale.snapshotId)).holdReasons.map((h) => h.code)).toEqual(['stale']);

		const wrong = await upload(PRIYA, fixture('wrong-report'), 'wrong-report.csv');
		expect(wrong.kind).toBe('refused');
	});
});
