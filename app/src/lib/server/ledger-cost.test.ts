// The ledger's cost per line must be the cost that applied that day.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './db/pglite.ts';
import type { Db } from './db/types.ts';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

describe('seed.d/55: the ledger agrees with the cost timeline', () => {
	it('stamps every line with the cost of its own day', async () => {
		const [row] = await db.asSystem((tx) =>
			tx.sql<{ wrong: number; lines: number }>`
				select count(*) filter (where il.unit_cost is distinct from nl.item_cost_on(il.item_no, il.posted_on))::int as wrong,
				       count(*)::int as lines
				from nl.invoice_lines il`
		);
		expect(row.lines).toBeGreaterThan(100);
		expect(row.wrong).toBe(0);
	});

	it('leaves older years with a different cost than today, so margin history means something', async () => {
		const [row] = await db.asSystem((tx) =>
			tx.sql<{ older: number; same: number }>`
				select count(*) filter (where il.unit_cost is distinct from i.unit_cost)::int as older,
				       count(*) filter (where il.unit_cost = i.unit_cost)::int as same
				from nl.invoice_lines il
				join nl.items i on i.item_no = il.item_no
				where il.posted_on < nl.today() - 365`
		);
		expect(row.older).toBeGreaterThan(0);
	});
});
