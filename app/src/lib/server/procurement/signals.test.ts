// The signals that wake the desk: each one fires, and each one fires at most
// once per subject however often the sweep runs.
//
// These tests use the world the seed builds (db/seed.d/80_procurement.sql
// shapes it so every signal has something to find) rather than hand-built
// fixtures, because "the seed leaves something for every signal" is itself one
// of the guarantees worth proving.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../db/pglite.ts';
import { sweepSignals } from './requests.ts';
import type { Db } from '../db/types.ts';
import type { SignalKind } from '$lib/components/procurement/types';

const ADMIN = 1;
const DANA = 2; // account manager
const OPS = 5; // operations
const TERRY = 7; // no longer active

const EVERY_SIGNAL: SignalKind[] = [
	'below_reorder_point',
	'purchase_order_late',
	'vendor_cost_moved',
	'demand_jumped',
	'no_vendor',
	'no_cost',
	'under_vendor_minimum'
];

let db: Db;
/** The first sweep's result, which every test below reads. */
let first: Awaited<ReturnType<typeof sweepSignals>>;

beforeAll(async () => {
	db = await createTestDb();
	first = await sweepSignals(db, OPS, { requestId: randomUUID() });
});

afterAll(async () => {
	await db?.close();
});

async function counts(): Promise<Record<string, number>> {
	const rows = await db.asUser(
		OPS,
		(tx) => tx.sql<{ signal: string; n: number }>`
			select signal, count(*)::int as n from nl.procurement_signals group by signal`
	);
	return Object.fromEntries(rows.map((r) => [r.signal, r.n]));
}

describe('the seed leaves something for every signal', () => {
	it('raises at least one of each of the seven', async () => {
		const byKind = await counts();
		for (const signal of EVERY_SIGNAL) {
			expect(byKind[signal] ?? 0, `${signal} found nothing on a fresh world`).toBeGreaterThan(0);
		}
		expect(first.total).toBe(Object.values(byKind).reduce((sum, n) => sum + n, 0));
	});

	it('says what each one is about, in a sentence', async () => {
		const rows = await db.asUser(
			OPS,
			(tx) => tx.sql<{ signal: string; subject: string; headline: string }>`
				select distinct on (signal) signal, subject, headline
				from nl.procurement_signals order by signal, id`
		);
		expect(rows).toHaveLength(EVERY_SIGNAL.length);
		for (const row of rows) {
			expect(row.subject.length, row.signal).toBeGreaterThan(0);
			expect(row.headline.length, row.signal).toBeGreaterThan(10);
		}
	});

	it('finds the late purchase order the seed left, and that it also slipped', async () => {
		const [late] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ past_due: boolean; slipped: boolean; days_late: number; days_slipped: number }>`
				select past_due, slipped, days_late, days_slipped from nl.procurement_late_supply`
		);
		expect(late.past_due).toBe(true);
		expect(late.slipped).toBe(true);
		expect(late.days_late).toBeGreaterThan(0);
		expect(late.days_slipped).toBeGreaterThan(0);
	});

	it('finds the vendor whose short parts miss its minimum order', async () => {
		const [row] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ headline: string; detail: { subtotal: number; min_order: number | null } }>`
				select headline, detail from nl.procurement_signals
				where signal = 'under_vendor_minimum' limit 1`
		);
		expect(row.headline).toContain('parts short');
		expect(Number(row.detail.subtotal)).toBeGreaterThan(0);
	});

	it('finds the part with no vendor and the part with no cost, and they are different parts', async () => {
		const rows = await db.asUser(
			OPS,
			(tx) => tx.sql<{ signal: string; item_no: string }>`
				select signal, item_no from nl.procurement_signals
				where signal in ('no_vendor', 'no_cost')`
		);
		expect(rows).toHaveLength(2);
		expect(rows[0].item_no).not.toBe(rows[1].item_no);
	});
});

describe('a signal fires at most once per subject', () => {
	it('adds nothing on a second sweep', async () => {
		const before = await counts();
		const again = await sweepSignals(db, OPS, { requestId: randomUUID() });
		expect(again.total).toBe(0);
		expect(await counts()).toEqual(before);
	});

	it('is enforced by the database, not by the sweep', async () => {
		// Writing the same (signal, subject) straight into the table, as the
		// owner and with no sweep involved, is still refused.
		const [existing] = await db.asSystem(
			(tx) => tx.sql<{ signal: string; subject: string }>`
				select signal, subject from nl.procurement_signals limit 1`
		);
		await expect(
			db.asSystem(
				(tx) => tx.sql`
					insert into nl.procurement_signals (signal, subject, headline)
					values (${existing.signal}, ${existing.subject}, 'A second copy of the same news')`
			)
		).rejects.toMatchObject({ code: '23505' });
	});

	it('does not raise it again after it has been cleared', async () => {
		// Fix the part the signal was about, sweep (which clears it), then put
		// it back the way it was and sweep again. The log keeps its one row.
		const [signal] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ id: number; subject: string }>`
				select s.id, s.subject from nl.procurement_signals s
				where s.signal = 'below_reorder_point' and s.cleared_at is null
				order by s.id limit 1`
		);
		const [before] = await db.asSystem(
			(tx) => tx.sql<{ on_hand: number }>`
				select on_hand from nl.stock where item_no = ${signal.subject}`
		);

		await db.asSystem(
			(tx) => tx.sql`update nl.stock set on_hand = 100000 where item_no = ${signal.subject}`
		);
		const cleared = await sweepSignals(db, OPS, { requestId: randomUUID() });
		expect(cleared.cleared).toBeGreaterThan(0);
		const [after] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ cleared_at: Date | null }>`
				select cleared_at from nl.procurement_signals where id = ${signal.id}`
		);
		expect(after.cleared_at).not.toBeNull();

		await db.asSystem(
			(tx) => tx.sql`update nl.stock set on_hand = ${before.on_hand} where item_no = ${signal.subject}`
		);
		await sweepSignals(db, OPS, { requestId: randomUUID() });
		const [rows] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.procurement_signals
				where signal = 'below_reorder_point' and subject = ${signal.subject}`
		);
		expect(rows.n).toBe(1);
	});
});

describe('who may sweep', () => {
	it('lets an admin', async () => {
		await expect(sweepSignals(db, ADMIN, { requestId: randomUUID() })).resolves.toMatchObject({
			total: expect.any(Number)
		});
	});

	it('refuses an account manager', async () => {
		await expect(sweepSignals(db, DANA, { requestId: randomUUID() })).rejects.toMatchObject({
			status: 403
		});
	});

	it('refuses somebody who no longer works here', async () => {
		await expect(sweepSignals(db, TERRY, { requestId: randomUUID() })).rejects.toMatchObject({
			status: 401
		});
	});
});

describe('a repeated request', () => {
	it('sweeps once and hands the first answer back', async () => {
		// Put something new in front of the sweep so the first call has work.
		const [candidate] = await db.asSystem(
			(tx) => tx.sql<{ item_no: string }>`
				select r.item_no from nl.part_replenishment r
				where not r.needs_buying and r.policy_level is not null and r.policy_level > 4
				  and not r.blocked and r.vendor_no is not null
				  and not exists (select 1 from nl.procurement_signals s
				                  where s.signal = 'below_reorder_point' and s.subject = r.item_no)
				order by r.item_no limit 1`
		);
		await db.asSystem(
			(tx) => tx.sql`update nl.stock set on_hand = 0, on_purchase_order = 0, on_production_order = 0
			               where item_no = ${candidate.item_no}`
		);

		const requestId = randomUUID();
		const once = await sweepSignals(db, OPS, { requestId });
		const twice = await sweepSignals(db, OPS, { requestId });
		expect(once.replayed).toBe(false);
		expect(once.total).toBeGreaterThan(0);
		expect(twice.replayed).toBe(true);
		expect(twice.total).toBe(once.total);

		// And one audit row, not two.
		const [audit] = await db.asUser(
			OPS,
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.audit_log
				where action = 'sweep_procurement_signals' and request_id = ${requestId}`
		);
		expect(audit.n).toBe(1);
	});
});

describe('every sweep leaves an audit row', () => {
	it('records what it raised and who ran it', async () => {
		const rows = await db.asUser(
			OPS,
			(tx) => tx.sql<{ actor_id: number; via: string; detail: { total: number } }>`
				select actor_id, via, detail from nl.audit_log
				where action = 'sweep_procurement_signals' order by id limit 1`
		);
		expect(rows[0].actor_id).toBe(OPS);
		expect(rows[0].via).toBe('ui');
		expect(Number(rows[0].detail.total)).toBeGreaterThan(0);
	});
});
