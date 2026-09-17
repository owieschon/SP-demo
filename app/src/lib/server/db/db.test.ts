// The database foundation: the schema loads, the world builds, and row-level
// security stops one user from changing another user's rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './pglite.ts';
import type { Db } from './types.ts';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

describe('the small world', () => {
	it('has every commitment status, windows waiting on a person, and evidence for the nightly job', async () => {
		const rows = await db.asSystem((tx) =>
			tx.sql<{ status: string; n: number; waiting: number }>`
				select status, count(*)::int as n, count(*) filter (where needs_outcome)::int as waiting
				from nl.commitment_progress
				group by status`
		);
		const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.n]));
		expect(Object.keys(byStatus).sort()).toEqual(
			['broken', 'delivering', 'kept', 'promised', 'pushed', 'quoted'].sort()
		);
		expect(rows.reduce((sum, r) => sum + r.waiting, 0)).toBe(3);

		const [nightly] = await db.asSystem((tx) =>
			tx.sql<{ result: { answered_pushed: number[] } }>`select nl.answer_pushed_windows() as result`
		);
		expect(nightly.result.answered_pushed).toHaveLength(1);
	});
});

describe('row-level security', () => {
	// Dana (2) and Marcus (3) are account managers; Elena (1) is the admin.
	async function aCommitmentOwnedBy(ownerId: number) {
		const [row] = await db.asSystem((tx) =>
			tx.sql<{ id: number }>`select id from nl.commitments where owner_id = ${ownerId} order by id limit 1`
		);
		return row.id;
	}

	it('lets a user read everything the team shares', async () => {
		const rows = await db.asUser(2, (tx) => tx.sql`select id from nl.commitments`);
		const [all] = await db.asSystem((tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.commitments`);
		expect(rows).toHaveLength(all.n);
	});

	it('stops one user from changing another user\'s commitment', async () => {
		const marcus = await aCommitmentOwnedBy(3);
		const updated = await db.asUser(2, (tx) =>
			tx.sql`update nl.commitments set confidence = 1 where id = ${marcus} returning id`
		);
		expect(updated).toHaveLength(0);
		const [row] = await db.asSystem((tx) =>
			tx.sql<{ confidence: number }>`select confidence from nl.commitments where id = ${marcus}`
		);
		expect(row.confidence).not.toBe(1);
	});

	it('lets the owner and an admin change it', async () => {
		const marcus = await aCommitmentOwnedBy(3);
		const byOwner = await db.asUser(3, (tx) =>
			tx.sql`update nl.commitments set notes = 'owner was here' where id = ${marcus} returning id`
		);
		const byAdmin = await db.asUser(1, (tx) =>
			tx.sql`update nl.commitments set notes = 'admin was here' where id = ${marcus} returning id`
		);
		expect(byOwner).toHaveLength(1);
		expect(byAdmin).toHaveLength(1);
	});

	it('refuses a note written in someone else\'s name', async () => {
		await expect(
			db.asUser(2, (tx) =>
				tx.sql`insert into nl.activities (customer_no, kind, body, author_id)
				       values ('1101', 'note', 'pretending to be Marcus', 3)`
			)
		).rejects.toThrow(/row-level security/);
	});

	it('gives a visitor who is not signed in no way to write', async () => {
		const marcus = await aCommitmentOwnedBy(3);
		const updated = await db.asVisitor((tx) =>
			tx.sql`update nl.commitments set confidence = 1 where id = ${marcus} returning id`
		);
		expect(updated).toHaveLength(0);
	});
});
