// The warehouse: does the ledger tie out, and do the four writes hold their
// rules.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The first
// group of tests reads the world the seed built. The rest work on their own
// parts, bins, shipment, count and transfer (everything prefixed WH- or -T),
// rebuilt before each test, so the seeded world is never disturbed and the
// numbers never depend on it. The fixtures are themselves in agreement, so
// nl.warehouse_drift() stays empty from the first test to the last.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db, Tx } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { getPartLedger, getWarehouseBoard } from './read.ts';
import { advanceShipment, postCountSession, postStockAdjustment, receiveTransfer } from './writes.ts';

const ADMIN = 1;
const DANA = 2; // account manager
const PRIYA = 5; // operations
const JORDAN = 6; // operations
const TERRY = 7; // no longer active

const TODAY = '2026-09-17';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

function rid(): string {
	return randomUUID();
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

// ---------------------------------------------------------------------------
// What the seed built
// ---------------------------------------------------------------------------

describe('the world the seed builds', () => {
	it('has no drift between the item master, the bins and the ledger', async () => {
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.warehouse_drift()`);
		expect(drift).toEqual([]);
	});

	it('splits every part across locations without losing a piece', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ disagree: number; parts: number }>`
				select
				  count(*) filter (where x.total <> x.on_hand)::int as disagree,
				  count(*)::int as parts
				from (
				  select b.item_no, sum(b.quantity) as total, coalesce(s.on_hand, 0) as on_hand
				  from nl.stock_bins b
				  join nl.stock s on s.item_no = b.item_no
				  group by b.item_no, s.on_hand
				) x`
		);
		expect(row.disagree).toBe(0);
		expect(row.parts).toBeGreaterThan(50);
	});

	it('gives every bin an opening balance and a ledger that closes on it', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ bins: number; opening: number; moves: number }>`
				select
				  (select count(*)::int from nl.stock_bins) as bins,
				  (select count(*)::int from nl.stock_opening) as opening,
				  (select count(*)::int from nl.stock_moves) as moves`
		);
		expect(row.opening).toBe(row.bins);
		expect(row.moves).toBeGreaterThan(100);
	});

	it('closes the ledger on the item master for the busiest parts', async () => {
		const busiest = await db.asSystem(
			(tx) => tx.sql<{ item_no: string }>`
				select m.item_no
				from nl.stock_moves m
				group by m.item_no
				order by count(*) desc, m.item_no
				limit 6`
		);
		expect(busiest.length).toBe(6);
		for (const { item_no } of busiest) {
			const ledger = await getPartLedger(db, PRIYA, item_no);
			expect(ledger).not.toBeNull();
			// opening + every move = what the item master says. To the piece.
			expect(ledger!.opening + ledger!.moved).toBe(ledger!.onHand);
			expect(ledger!.closing).toBe(ledger!.onHand);
			expect(ledger!.agrees).toBe(true);
		}
	});

	it('fills every bucket on the board, and the pick queue is in promised order', async () => {
		const board = await getWarehouseBoard(db, PRIYA);
		expect(board.today).toBe(TODAY);
		expect(board.buckets.map((b) => b.bucket)).toEqual([
			'to_pick',
			'packed',
			'awaiting_carrier',
			'shipped_today',
			'in_transit',
			'counts_due'
		]);
		// A fresh world has something in every status, so the page is never blank.
		for (const bucket of board.buckets) {
			expect(bucket.documents).toBeGreaterThan(0);
		}
		const promised = board.pickQueue.map((s) => s.promisedOn ?? '9999-12-31');
		expect([...promised].sort()).toEqual(promised);
		// Nothing already gone sits in the queue.
		expect(board.pickQueue.every((s) => s.status !== 'shipped')).toBe(true);
	});

	it('has one count sheet open and due today, with variances on it', async () => {
		const board = await getWarehouseBoard(db, PRIYA);
		expect(board.openCount).not.toBeNull();
		const session = board.openCount!;
		expect(session.dueOn).toBe(TODAY);
		expect(session.lines.length).toBeGreaterThan(0);
		expect(session.counted).toBeGreaterThan(0);
		expect(session.withVariance).toBeGreaterThan(0);
		// A counted line can never claim a negative count.
		expect(session.lines.every((l) => l.countedQty === null || l.countedQty >= 0)).toBe(true);
	});

	it('has a transfer on the road and recent moves with reasons and names', async () => {
		const board = await getWarehouseBoard(db, PRIYA);
		expect(board.transit.length).toBeGreaterThan(0);
		expect(board.transit.every((t) => t.pieces > 0)).toBe(true);
		expect(board.recentMoves.length).toBeGreaterThan(0);
		// Every adjustment and count carries a reason; the ERP's own loads
		// carry no person, which is the honest answer.
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ missing_reason: number; bad_reason: number }>`
				select
				  count(*) filter (where kind in ('adjustment', 'count') and reason is null)::int as missing_reason,
				  count(*) filter (where kind not in ('adjustment', 'count') and reason is not null)::int as bad_reason
				from nl.stock_moves`
		);
		expect(row.missing_reason).toBe(0);
		expect(row.bad_reason).toBe(0);
	});

	it('writes no em dashes and no banned word into the world', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ text: string }>`
				select coalesce(string_agg(t, ' '), '') as text
				from (
				  select name as t from nl.locations
				  union all select city from nl.locations
				  union all select zone from nl.stock_bins
				  union all select note from nl.shipments
				  union all select carrier from nl.shipments
				  union all select note from nl.count_sessions
				  union all select note from nl.count_lines
				  union all select note from nl.transfers
				  union all select note from nl.stock_moves
				  union all select coalesce(reason, '') from nl.stock_moves
				) s`
		);
		expect(row.text.length).toBeGreaterThan(500);
		expect(row.text).not.toContain('—');
		expect(row.text).not.toContain('–');
		expect(row.text).not.toMatch(/\brush(ed|es|ing)?\b/i);
	});

	it('keeps the ledger away from the read-only role and lets it see the bins', async () => {
		const [bins] = await db.asReadonly(
			(tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.stock_bins`
		);
		expect(bins.n).toBeGreaterThan(0);
		await expect(
			db.asReadonly((tx) => tx.sql`select count(*) from nl.stock_moves`)
		).rejects.toThrow(/permission denied/i);
	});
});

// ---------------------------------------------------------------------------
// Fixtures of our own
// ---------------------------------------------------------------------------

const ITEM_A = 'WH-A';
const ITEM_B = 'WH-B';
const CUSTOMER = 'WH-CUST';

/** The bins and the item master for the test parts, in agreement. */
async function resetFixtures(tx: Tx) {
	await tx.sql`delete from nl.stock_moves where item_no in (${ITEM_A}, ${ITEM_B})`;
	await tx.sql`delete from nl.shipments where shipment_no like 'SH-T%'`;
	await tx.sql`delete from nl.count_sessions where session_no like 'CC-T%'`;
	await tx.sql`delete from nl.transfers where transfer_no like 'TR-T%'`;
	await tx.sql`delete from nl.stock_bins where item_no in (${ITEM_A}, ${ITEM_B})`;
	await tx.sql`delete from nl.stock_opening where item_no in (${ITEM_A}, ${ITEM_B})`;

	// WH-A: 100 pieces, 70 at the plant and 30 in the east.
	// WH-B: 40 pieces, all at the plant.
	await tx.sql`update nl.stock set on_hand = 100, as_of = ${TODAY} where item_no = ${ITEM_A}`;
	await tx.sql`update nl.stock set on_hand = 40, as_of = ${TODAY} where item_no = ${ITEM_B}`;
	await tx.sql`
		insert into nl.stock_bins (item_no, location_code, zone, aisle, shelf, bin, quantity)
		values (${ITEM_A}, 'MAIN', 'TEST ZONE', 'T', 'T-1', 'T-1-1', 70),
		       (${ITEM_A}, 'EAST', 'TEST ZONE', 'T', 'T-9', 'T-9-1', 30),
		       (${ITEM_B}, 'MAIN', 'TEST ZONE', 'T', 'T-2', 'T-2-1', 40)`;
	await tx.sql`
		insert into nl.stock_opening (item_no, location_code, opened_on, quantity)
		values (${ITEM_A}, 'MAIN', '2026-06-19', 70),
		       (${ITEM_A}, 'EAST', '2026-06-19', 30),
		       (${ITEM_B}, 'MAIN', '2026-06-19', 40)`;

	// One shipment still being picked and one already on the dock.
	await tx.sql`
		insert into nl.shipments (shipment_no, customer_no, location_code, carrier, status, promised_on)
		values ('SH-T001', ${CUSTOMER}, 'MAIN', 'LTL', 'picking', ${TODAY})`;
	await tx.sql`
		insert into nl.shipments (shipment_no, customer_no, location_code, carrier, status, promised_on,
		                          packed_by, packed_at)
		values ('SH-T002', ${CUSTOMER}, 'MAIN', 'parcel', 'awaiting carrier', ${TODAY},
		        ${JORDAN}, '2026-09-17T13:00:00Z')`;
	for (const shipment of ['SH-T001', 'SH-T002']) {
		await tx.sql`
			insert into nl.shipment_lines (shipment_no, line_no, document_no, order_line_no, item_no, quantity, bin)
			values (${shipment}, 1, 'SO-TEST', 10000, ${ITEM_A}, 5, 'T-1-1'),
			       (${shipment}, 2, 'SO-TEST', 20000, ${ITEM_B}, 2, 'T-2-1')`;
	}

	// A count sheet: two pieces missing on one part, three extra on the other.
	await tx.sql`
		insert into nl.count_sessions (session_no, location_code, zone, due_on, counted_on, counted_by, status, note)
		values ('CC-T001', 'MAIN', 'TEST ZONE', ${TODAY}, ${TODAY}, ${JORDAN}, 'open',
		        'Counted the test aisle before the truck came in.')`;
	await tx.sql`
		insert into nl.count_lines (session_id, line_no, item_no, bin, expected_qty, counted_qty, note)
		select c.id, 1, ${ITEM_A}, 'T-1-1', 70, 68, 'Two ends dented, pulled them out.'
		from nl.count_sessions c where c.session_no = 'CC-T001'`;
	await tx.sql`
		insert into nl.count_lines (session_id, line_no, item_no, bin, expected_qty, counted_qty, note)
		select c.id, 2, ${ITEM_B}, 'T-2-1', 40, 43, 'Found a box behind the rack.'
		from nl.count_sessions c where c.session_no = 'CC-T001'`;

	// Ten pieces of WH-B on a truck from the plant to the east.
	await tx.sql`
		insert into nl.transfers (transfer_no, from_location, to_location, status, sent_on, expected_on, sent_by, note)
		values ('TR-T001', 'MAIN', 'EAST', 'in transit', '2026-09-15', '2026-09-18', ${PRIYA},
		        'Top up the east desk on the test part.')`;
	await tx.sql`
		insert into nl.transfer_lines (transfer_no, line_no, item_no, quantity, from_bin, to_bin)
		values ('TR-T001', 1, ${ITEM_B}, 10, 'T-2-1', 'E-4-2')`;
}

async function sessionId(): Promise<number> {
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ id: number }>`select id from nl.count_sessions where session_no = 'CC-T001'`
	);
	return row.id;
}

async function version(table: 'shipments' | 'count_sessions' | 'transfers', key: string): Promise<string> {
	const column = table === 'shipments' ? 'shipment_no' : table === 'transfers' ? 'transfer_no' : 'session_no';
	const [row] = await db.asSystem((tx) =>
		tx.query<{ updated_at: Date }>(
			`select updated_at from nl.${table} where ${column} = $1`,
			[key]
		)
	);
	return row.updated_at.toISOString();
}

async function binVersion(itemNo: string, location: string): Promise<string> {
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ updated_at: Date }>`
			select updated_at from nl.stock_bins where item_no = ${itemNo} and location_code = ${location}`
	);
	return row.updated_at.toISOString();
}

async function figures(itemNo: string) {
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ on_hand: number; main: number; east: number; moves: number }>`
			select
			  (select on_hand from nl.stock where item_no = ${itemNo}) as on_hand,
			  coalesce((select quantity from nl.stock_bins where item_no = ${itemNo} and location_code = 'MAIN'), 0) as main,
			  coalesce((select quantity from nl.stock_bins where item_no = ${itemNo} and location_code = 'EAST'), 0) as east,
			  (select count(*)::int from nl.stock_moves where item_no = ${itemNo}) as moves`
	);
	return row;
}

describe('the warehouse writes', () => {
	beforeAll(async () => {
		await db.asSystem(async (tx) => {
			await tx.sql`
				insert into nl.customers (customer_no, name, price_group, customer_since)
				values (${CUSTOMER}, 'Test Receiving Dock', 'DEALER', '2021-03-01')`;
			for (const item of [ITEM_A, ITEM_B]) {
				await tx.sql`
					insert into nl.items (item_no, description, category, family, product_group,
					                      unit_cost, list_price, replenishment)
					values (${item}, 'TEST PART', 'PIPE', 'pipe', 'PIPE', 12, 48, 'Prod. Order')`;
				await tx.sql`insert into nl.stock (item_no, on_hand, as_of) values (${item}, 0, ${TODAY})`;
			}
		});
	});

	beforeEach(async () => {
		await db.asSystem(resetFixtures);
	});

	// -------------------------------------------------------------------------
	// Adjustments
	// -------------------------------------------------------------------------

	describe('nl.post_stock_adjustment', () => {
		const damaged = { itemNo: ITEM_A, locationCode: 'MAIN', quantity: -3, reason: 'damaged' as const, note: '' };

		it('lets operations correct a bin, and moves all three figures together', async () => {
			const result = await postStockAdjustment(db, PRIYA, { ...damaged, requestId: rid() });
			expect(result.binQuantity).toBe(67);
			expect(result.onHand).toBe(97);
			const after = await figures(ITEM_A);
			expect(after).toMatchObject({ on_hand: 97, main: 67, east: 30, moves: 1 });
			const drift = await db.asSystem((tx) => tx.sql`select * from nl.warehouse_drift()`);
			expect(drift).toEqual([]);
		});

		it('lets an admin do it too', async () => {
			const result = await postStockAdjustment(db, ADMIN, {
				...damaged,
				quantity: 4,
				reason: 'found',
				requestId: rid()
			});
			expect(result.binQuantity).toBe(74);
		});

		it('refuses an account manager with 403', async () => {
			const error = await rejection(postStockAdjustment(db, DANA, { ...damaged, requestId: rid() }));
			expect(error.status).toBe(403);
			expect((await figures(ITEM_A)).main).toBe(70);
		});

		it('refuses a user who is no longer active with 401', async () => {
			const error = await rejection(postStockAdjustment(db, TERRY, { ...damaged, requestId: rid() }));
			expect(error.status).toBe(401);
		});

		it('refuses taking more off the bin than it holds with 422', async () => {
			const error = await rejection(
				postStockAdjustment(db, PRIYA, { ...damaged, quantity: -200, requestId: rid() })
			);
			expect(error.status).toBe(422);
			expect(error.message).toMatch(/bin holds/);
		});

		it('refuses a correction on a bin that changed since the page loaded with 409', async () => {
			const stale = await binVersion(ITEM_A, 'MAIN');
			await postStockAdjustment(db, PRIYA, { ...damaged, quantity: -1, requestId: rid() });
			const error = await rejection(
				postStockAdjustment(db, PRIYA, { ...damaged, expectedUpdatedAt: stale, requestId: rid() })
			);
			expect(error.status).toBe(409);
			// The first correction stands; the second wrote nothing.
			expect((await figures(ITEM_A)).main).toBe(69);
		});

		it('takes the right version happily', async () => {
			const current = await binVersion(ITEM_A, 'MAIN');
			const result = await postStockAdjustment(db, PRIYA, {
				...damaged,
				expectedUpdatedAt: current,
				requestId: rid()
			});
			expect(result.binQuantity).toBe(67);
		});

		it('applies the same request id once, however many times it arrives', async () => {
			const requestId = rid();
			const first = await postStockAdjustment(db, PRIYA, { ...damaged, requestId });
			const second = await postStockAdjustment(db, PRIYA, { ...damaged, requestId });
			expect(first.replayed).toBe(false);
			expect(second.replayed).toBe(true);
			expect(second.binQuantity).toBe(first.binQuantity);
			expect((await figures(ITEM_A)).moves).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Counts
	// -------------------------------------------------------------------------

	describe('nl.post_count_session', () => {
		it('writes one move per variance and moves the stock by exactly that much', async () => {
			const id = await sessionId();
			const result = await postCountSession(db, JORDAN, {
				sessionId: id,
				expectedUpdatedAt: await version('count_sessions', 'CC-T001'),
				requestId: rid()
			});
			expect(result.linesCounted).toBe(2);
			expect(result.moves).toBe(2);
			// Two pieces off one part, three onto the other.
			expect(result.netChange).toBe(1);

			const a = await figures(ITEM_A);
			const b = await figures(ITEM_B);
			expect(a).toMatchObject({ on_hand: 98, main: 68, east: 30, moves: 1 });
			expect(b).toMatchObject({ on_hand: 43, main: 43, moves: 1 });

			const moves = await db.asSystem(
				(tx) => tx.sql<{ item_no: string; kind: string; quantity: number; reason: string; reference: string }>`
					select item_no, kind, quantity, reason, reference
					from nl.stock_moves
					where reference = 'CC-T001'
					order by item_no`
			);
			expect(moves).toEqual([
				{ item_no: ITEM_A, kind: 'count', quantity: -2, reason: 'miscount', reference: 'CC-T001' },
				{ item_no: ITEM_B, kind: 'count', quantity: 3, reason: 'found', reference: 'CC-T001' }
			]);

			const [session] = await db.asSystem(
				(tx) => tx.sql<{ status: string; posted_by: number }>`
					select status, posted_by from nl.count_sessions where session_no = 'CC-T001'`
			);
			expect(session).toEqual({ status: 'posted', posted_by: JORDAN });
			expect(await db.asSystem((tx) => tx.sql`select * from nl.warehouse_drift()`)).toEqual([]);
		});

		it('stamps every counted bin as counted, variance or not', async () => {
			await db.asSystem(
				(tx) => tx.sql`update nl.count_lines set counted_qty = 40
				               where item_no = ${ITEM_B}
				                 and session_id = (select id from nl.count_sessions where session_no = 'CC-T001')`
			);
			await postCountSession(db, JORDAN, {
				sessionId: await sessionId(),
				expectedUpdatedAt: await version('count_sessions', 'CC-T001'),
				requestId: rid()
			});
			const [bin] = await db.asSystem(
				(tx) => tx.sql<{ counted_on: string; quantity: number }>`
					select counted_on, quantity from nl.stock_bins
					where item_no = ${ITEM_B} and location_code = 'MAIN'`
			);
			expect(bin).toEqual({ counted_on: TODAY, quantity: 40 });
		});

		it('refuses an account manager with 403 and an inactive user with 401', async () => {
			const id = await sessionId();
			const expectedUpdatedAt = await version('count_sessions', 'CC-T001');
			expect((await rejection(postCountSession(db, DANA, { sessionId: id, expectedUpdatedAt, requestId: rid() }))).status).toBe(403);
			expect((await rejection(postCountSession(db, TERRY, { sessionId: id, expectedUpdatedAt, requestId: rid() }))).status).toBe(401);
			expect((await figures(ITEM_A)).moves).toBe(0);
		});

		it('refuses a count nobody has counted, and one already posted, with 422', async () => {
			const id = await sessionId();
			await db.asSystem((tx) => tx.sql`update nl.count_lines set counted_qty = null where session_id = ${id}`);
			const empty = await rejection(
				postCountSession(db, PRIYA, {
					sessionId: id,
					expectedUpdatedAt: await version('count_sessions', 'CC-T001'),
					requestId: rid()
				})
			);
			expect(empty.status).toBe(422);
			expect(empty.message).toMatch(/has been counted yet/);

			await db.asSystem((tx) => tx.sql`update nl.count_lines set counted_qty = 71 where session_id = ${id} and line_no = 1`);
			await postCountSession(db, PRIYA, {
				sessionId: id,
				expectedUpdatedAt: await version('count_sessions', 'CC-T001'),
				requestId: rid()
			});
			const again = await rejection(
				postCountSession(db, PRIYA, {
					sessionId: id,
					expectedUpdatedAt: await version('count_sessions', 'CC-T001'),
					requestId: rid()
				})
			);
			expect(again.status).toBe(422);
			expect(again.message).toMatch(/already posted/);
		});

		it('refuses a count that does not exist with 404', async () => {
			const error = await rejection(
				postCountSession(db, PRIYA, {
					sessionId: 999999,
					expectedUpdatedAt: '2026-09-17T12:00:00.000Z',
					requestId: rid()
				})
			);
			expect(error.status).toBe(404);
		});

		it('refuses a stale version with 409', async () => {
			const error = await rejection(
				postCountSession(db, PRIYA, {
					sessionId: await sessionId(),
					expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
					requestId: rid()
				})
			);
			expect(error.status).toBe(409);
			expect((await figures(ITEM_A)).moves).toBe(0);
		});

		it('posts the same request id once', async () => {
			const requestId = rid();
			const input = {
				sessionId: await sessionId(),
				expectedUpdatedAt: await version('count_sessions', 'CC-T001'),
				requestId
			};
			const first = await postCountSession(db, PRIYA, input);
			const second = await postCountSession(db, PRIYA, input);
			expect(first.replayed).toBe(false);
			expect(second.replayed).toBe(true);
			expect((await figures(ITEM_A)).moves).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Shipments
	// -------------------------------------------------------------------------

	describe('nl.advance_shipment', () => {
		it('walks a shipment one step at a time', async () => {
			const packed = await advanceShipment(db, JORDAN, {
				shipmentNo: 'SH-T001',
				toStatus: 'packed',
				tracking: null,
				expectedUpdatedAt: await version('shipments', 'SH-T001'),
				requestId: rid()
			});
			expect(packed.status).toBe('packed');
			expect(packed.moves).toBe(0);

			const dock = await advanceShipment(db, JORDAN, {
				shipmentNo: 'SH-T001',
				toStatus: 'awaiting carrier',
				tracking: null,
				expectedUpdatedAt: packed.updatedAt,
				requestId: rid()
			});
			expect(dock.status).toBe('awaiting carrier');

			const [row] = await db.asSystem(
				(tx) => tx.sql<{ packed_by: number; status: string }>`
					select packed_by, status from nl.shipments where shipment_no = 'SH-T001'`
			);
			expect(row).toEqual({ packed_by: JORDAN, status: 'awaiting carrier' });
		});

		it('refuses a step out of order with 422', async () => {
			const error = await rejection(
				advanceShipment(db, JORDAN, {
					shipmentNo: 'SH-T001',
					toStatus: 'shipped',
					tracking: null,
					expectedUpdatedAt: await version('shipments', 'SH-T001'),
					requestId: rid()
				})
			);
			expect(error.status).toBe(422);
			expect(error.message).toMatch(/the next step is packed/);
			expect((await figures(ITEM_A)).moves).toBe(0);
		});

		it('refuses a shipment that has already gone with 422', async () => {
			await advanceShipment(db, JORDAN, {
				shipmentNo: 'SH-T002',
				toStatus: 'shipped',
				tracking: 'NL5550101',
				expectedUpdatedAt: await version('shipments', 'SH-T002'),
				requestId: rid()
			});
			const error = await rejection(
				advanceShipment(db, JORDAN, {
					shipmentNo: 'SH-T002',
					toStatus: 'shipped',
					tracking: null,
					expectedUpdatedAt: await version('shipments', 'SH-T002'),
					requestId: rid()
				})
			);
			expect(error.status).toBe(422);
			expect(error.message).toMatch(/already gone/);
		});

		it('writes one move per line and takes the pieces out of the right bin', async () => {
			const result = await advanceShipment(db, PRIYA, {
				shipmentNo: 'SH-T002',
				toStatus: 'shipped',
				tracking: 'NL5550102',
				expectedUpdatedAt: await version('shipments', 'SH-T002'),
				requestId: rid()
			});
			expect(result.moves).toBe(2);
			expect(result.pieces).toBe(7);

			// The shipment is booked to MAIN, so only the MAIN bins move.
			expect(await figures(ITEM_A)).toMatchObject({ on_hand: 95, main: 65, east: 30, moves: 1 });
			expect(await figures(ITEM_B)).toMatchObject({ on_hand: 38, main: 38, moves: 1 });

			const moves = await db.asSystem(
				(tx) => tx.sql<{ item_no: string; kind: string; quantity: number; location_code: string }>`
					select item_no, kind, quantity, location_code
					from nl.stock_moves where reference = 'SH-T002' order by item_no`
			);
			expect(moves).toEqual([
				{ item_no: ITEM_A, kind: 'shipment', quantity: -5, location_code: 'MAIN' },
				{ item_no: ITEM_B, kind: 'shipment', quantity: -2, location_code: 'MAIN' }
			]);
			const [ship] = await db.asSystem(
				(tx) => tx.sql<{ tracking: string }>`select tracking from nl.shipments where shipment_no = 'SH-T002'`
			);
			expect(ship.tracking).toBe('NL5550102');
			expect(await db.asSystem((tx) => tx.sql`select * from nl.warehouse_drift()`)).toEqual([]);
		});

		it('refuses shipping more than the bin holds with 422', async () => {
			await db.asSystem(
				(tx) => tx.sql`update nl.shipment_lines set quantity = 500
				               where shipment_no = 'SH-T002' and item_no = ${ITEM_A}`
			);
			const error = await rejection(
				advanceShipment(db, PRIYA, {
					shipmentNo: 'SH-T002',
					toStatus: 'shipped',
					tracking: null,
					expectedUpdatedAt: await version('shipments', 'SH-T002'),
					requestId: rid()
				})
			);
			expect(error.status).toBe(422);
			expect(error.message).toMatch(/holds 70 pieces/);
			// Nothing at all moved: the whole step rolled back.
			expect((await figures(ITEM_B)).moves).toBe(0);
		});

		it('refuses an account manager with 403 and an inactive user with 401', async () => {
			const expectedUpdatedAt = await version('shipments', 'SH-T001');
			const input = { shipmentNo: 'SH-T001', toStatus: 'packed' as const, tracking: null, expectedUpdatedAt };
			expect((await rejection(advanceShipment(db, DANA, { ...input, requestId: rid() }))).status).toBe(403);
			expect((await rejection(advanceShipment(db, TERRY, { ...input, requestId: rid() }))).status).toBe(401);
		});

		it('refuses a shipment that does not exist with 404, and a stale version with 409', async () => {
			const missing = await rejection(
				advanceShipment(db, PRIYA, {
					shipmentNo: 'SH-NOPE',
					toStatus: 'packed',
					tracking: null,
					expectedUpdatedAt: '2026-09-17T12:00:00.000Z',
					requestId: rid()
				})
			);
			expect(missing.status).toBe(404);

			const stale = await rejection(
				advanceShipment(db, PRIYA, {
					shipmentNo: 'SH-T001',
					toStatus: 'packed',
					tracking: null,
					expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
					requestId: rid()
				})
			);
			expect(stale.status).toBe(409);
		});

		it('advances the same request id once', async () => {
			const input = {
				shipmentNo: 'SH-T002',
				toStatus: 'shipped' as const,
				tracking: null,
				expectedUpdatedAt: await version('shipments', 'SH-T002'),
				requestId: rid()
			};
			const first = await advanceShipment(db, PRIYA, input);
			const second = await advanceShipment(db, PRIYA, input);
			expect(first.replayed).toBe(false);
			expect(second.replayed).toBe(true);
			// One move per line, not two.
			expect((await figures(ITEM_A)).moves).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// Transfers
	// -------------------------------------------------------------------------

	describe('nl.receive_transfer', () => {
		function receiveOrThrow(
			userId: number,
			expectedUpdatedAt: string,
			requestId: string,
			transferNo = 'TR-T001'
		) {
			return receiveTransfer(db, userId, { transferNo, expectedUpdatedAt, requestId });
		}

		it('moves stock between locations and leaves the total alone', async () => {
			const before = await figures(ITEM_B);
			expect(before).toMatchObject({ on_hand: 40, main: 40, east: 0 });

			const result = await receiveOrThrow(PRIYA, await version('transfers', 'TR-T001'), rid());
			expect(result.lines).toBe(1);
			expect(result.pieces).toBe(10);

			const after = await figures(ITEM_B);
			// The pieces changed building; the item master never moved.
			expect(after).toMatchObject({ on_hand: 40, main: 30, east: 10, moves: 2 });

			const moves = await db.asSystem(
				(tx) => tx.sql<{ kind: string; quantity: number; location_code: string }>`
					select kind, quantity, location_code from nl.stock_moves
					where reference = 'TR-T001' order by kind`
			);
			expect(moves).toEqual([
				{ kind: 'transfer_in', quantity: 10, location_code: 'EAST' },
				{ kind: 'transfer_out', quantity: -10, location_code: 'MAIN' }
			]);

			const [transfer] = await db.asSystem(
				(tx) => tx.sql<{ status: string; received_by: number; received_on: string }>`
					select status, received_by, received_on from nl.transfers where transfer_no = 'TR-T001'`
			);
			expect(transfer).toEqual({ status: 'received', received_by: PRIYA, received_on: TODAY });
			// The new bin came from the transfer line's address.
			const [bin] = await db.asSystem(
				(tx) => tx.sql<{ bin: string; zone: string }>`
					select bin, zone from nl.stock_bins where item_no = ${ITEM_B} and location_code = 'EAST'`
			);
			expect(bin).toEqual({ bin: 'E-4-2', zone: 'TEST ZONE' });
			expect(await db.asSystem((tx) => tx.sql`select * from nl.warehouse_drift()`)).toEqual([]);
		});

		it('refuses one that has already been received with 422', async () => {
			await receiveOrThrow(PRIYA, await version('transfers', 'TR-T001'), rid());
			const error = await rejection(receiveOrThrow(PRIYA, await version('transfers', 'TR-T001'), rid()));
			expect(error.status).toBe(422);
			expect(error.message).toMatch(/is received/);
		});

		it('refuses more than the origin bin holds with 422', async () => {
			await db.asSystem(
				(tx) => tx.sql`update nl.transfer_lines set quantity = 400 where transfer_no = 'TR-T001'`
			);
			const error = await rejection(receiveOrThrow(PRIYA, await version('transfers', 'TR-T001'), rid()));
			expect(error.status).toBe(422);
			expect((await figures(ITEM_B)).moves).toBe(0);
		});

		it('refuses an account manager with 403 and an inactive user with 401', async () => {
			const at = await version('transfers', 'TR-T001');
			expect((await rejection(receiveOrThrow(DANA, at, rid()))).status).toBe(403);
			expect((await rejection(receiveOrThrow(TERRY, at, rid()))).status).toBe(401);
		});

		it('refuses one that does not exist with 404, and a stale version with 409', async () => {
			const missing = await rejection(
				receiveOrThrow(PRIYA, '2026-09-17T12:00:00.000Z', rid(), 'TR-NOPE')
			);
			expect(missing.status).toBe(404);
			const stale = await rejection(receiveOrThrow(PRIYA, '2020-01-01T00:00:00.000Z', rid()));
			expect(stale.status).toBe(409);
		});

		it('receives the same request id once', async () => {
			const requestId = rid();
			const at = await version('transfers', 'TR-T001');
			const first = await receiveOrThrow(PRIYA, at, requestId);
			const second = await receiveOrThrow(PRIYA, at, requestId);
			expect(first.replayed).toBe(false);
			expect(second.replayed).toBe(true);
			// Two moves, one each way, not four.
			expect((await figures(ITEM_B)).moves).toBe(2);
		});
	});

	it('leaves the whole world in agreement when every write has run', async () => {
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.warehouse_drift()`);
		expect(drift).toEqual([]);
	});
});
