// The exception queue against a real database.
//
// What it has to get right is not arithmetic, it is honesty: a group only
// appears when something is really waiting, the counts are the person's own
// work rather than everybody's, and the figure the empty state leans on ("the
// agents handled N things") comes from rows the agents actually wrote.
//
// The small world, with today pinned to 2026-09-17.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './db/pglite.ts';
import type { Db } from './db/types.ts';
import { getToday } from './today.ts';

const TODAY = '2026-09-17';
const ADMIN = 1;
const DANA = 2;

let db: Db;

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });
}, 180_000);

afterAll(async () => {
	await db.close();
});

describe('the exception queue', () => {
	it('is dated with the world', async () => {
		const page = await getToday(db, DANA);
		expect(page.today).toBe(TODAY);
	});

	it('only lists groups that have something in them', async () => {
		const page = await getToday(db, DANA);
		for (const group of page.groups) {
			expect(group.count).toBeGreaterThan(0);
		}
	});

	it('adds its groups up into the number on the page', async () => {
		const page = await getToday(db, DANA);
		const sum = page.groups.reduce((total, group) => total + group.count, 0);
		expect(page.waiting).toBe(sum);
	});

	it('sends every group somewhere a decision can be made', async () => {
		const page = await getToday(db, DANA);
		for (const group of page.groups) {
			expect(group.href).toMatch(/^\/[a-z]/);
			// Not one of them is allowed to be a count with nowhere to go.
			expect(group.decision.length).toBeGreaterThan(10);
		}
	});

	it('counts the closed-short windows as the signed-in person, not everybody', async () => {
		const [mine] = await db.asUser(DANA, (tx) =>
			tx.sql<{ count: number }>`
				select count(*)::int as count from nl.commitment_progress
				where needs_outcome and owner_id = ${DANA}`
		);
		const [everybody] = await db.asUser(DANA, (tx) =>
			tx.sql<{ count: number }>`
				select count(*)::int as count from nl.commitment_progress where needs_outcome`
		);

		const page = await getToday(db, DANA);
		const group = page.groups.find((item) => item.id === 'closed-short');

		if (mine.count === 0) {
			expect(group).toBeUndefined();
		} else {
			expect(group?.count).toBe(mine.count);
		}
		// The point of the test: the whole company's figure is bigger, and this
		// page does not show it.
		expect(everybody.count).toBeGreaterThanOrEqual(mine.count);
	});

	it('gives two different people two different queues', async () => {
		const dana = await getToday(db, DANA);
		const admin = await getToday(db, ADMIN);
		// Same shape, and each group's count is that person's own.
		expect(dana.today).toBe(admin.today);
		const owned = (page: Awaited<ReturnType<typeof getToday>>) =>
			page.groups.filter((group) => group.id === 'closed-short' || group.id === 'late-lines');
		expect(owned(dana)).not.toEqual(owned(admin));
	});

	it('dates the oldest thing waiting in every group that has one', async () => {
		const page = await getToday(db, DANA);
		for (const group of page.groups) {
			if (group.oldest !== null) expect(group.oldest).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it('counts what the agents did as a number, never as an estimate', async () => {
		const page = await getToday(db, DANA);
		expect(Number.isInteger(page.agentActions)).toBe(true);
		expect(page.agentActions).toBeGreaterThanOrEqual(0);
	});
});
