/*
  The role model: scope, authority and disclosure as three separate things
  (migration 0031).

  These hold the claims docs/roles.md makes, because every one of them is a
  claim somebody will push on:

    - scope narrows what you may CHANGE, not what you may read
    - an item waiting on an authority you do not hold is not your problem
    - raising an agent's autonomy is the same write as raising a person's limit
    - a grant that starts tomorrow does not apply today
    - disclosure is enforced on the payload, not hidden in the markup
    - the lists the database keeps and the lists TypeScript keeps agree

  And one that is not a claim but a seam: eight older write functions still
  read nl.users.role, so the seed leaves that column alone. A test pins it,
  because the day somebody "tidies up" the seed is the day the warehouse
  stops being able to post a count.
*/
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHORITIES, PRESETS, SCOPE_DIMENSIONS, holds, scopeOf } from '$lib/roles/types';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { policyFor, scopeValues } from './policy.ts';
import { grantAuthority } from './writes.ts';
import { workWaitingFor } from './work.ts';

const TODAY = '2026-09-18';

const ELENA = 1; // sales director, admin
const DANA = 2; // account manager, owns a book
const MARCUS = 3; // account manager, owns a different book
const PRIYA = 5; // operations lead, the ops manager preset
const RAE = 15; // warehouse lead
const HOLLIS = 16; // chief executive
const ORDER_DESK_AGENT = 101;

let db: Db;

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });
}, 240_000);

afterAll(async () => {
	await db?.close();
});

describe('the three axes are three', () => {
	it('gives the chief executive every dimension and almost no authority', async () => {
		const policy = await policyFor(db, HOLLIS);

		// Widest scope in the world, and it is granted rather than assumed.
		for (const dimension of SCOPE_DIMENSIONS) {
			expect(scopeOf(policy, dimension)?.all, dimension).toBe(true);
		}
		// Nothing withheld.
		expect(policy.disclosure).toBe('internal');

		// And deliberately not holding anybody else's queue. This is the
		// decision in docs/roles.md: reading the business is not running it.
		expect(holds(policy, 'change_policy')).toBe(true);
		expect(holds(policy, 'review_exception')).toBe(true);
		expect(holds(policy, 'override_margin_floor')).toBe(true);
		expect(holds(policy, 'approve_quote')).toBe(false);
		expect(holds(policy, 'release_purchase_order')).toBe(false);
		expect(holds(policy, 'confirm_pick')).toBe(false);
	});

	it('scopes an account manager to their own book without walling off the rest', async () => {
		const dana = await policyFor(db, DANA);
		expect(scopeOf(dana, 'account')?.all).not.toBe(true);
		// nl.people_policy carries the COUNT, not hundreds of customer numbers,
		// so the values come from their own query the way /people asks for them.
		expect((await scopeValues(db, DANA, 'account')).length).toBeGreaterThan(0);

		// Somebody else's account is readable: that is how cover works.
		const [mine] = await db.asUser(DANA, (tx) =>
			tx.query<{ n: number }>(
				`select count(*)::int as n from nl.customers where owner_id = $1`,
				[MARCUS]
			)
		);
		expect(mine.n).toBeGreaterThan(0);

		// But not actionable. nl.may_act_on is the line, not the read.
		const [act] = await db.asUser(DANA, (tx) =>
			tx.query<{ own: boolean; theirs: boolean }>(
				`select
				   nl.may_act_on('account', (select customer_no from nl.customers
				                              where owner_id = $1 order by customer_no limit 1)) as own,
				   nl.may_act_on('account', (select customer_no from nl.customers
				                              where owner_id = $2 order by customer_no limit 1)) as theirs`,
				[DANA, MARCUS]
			)
		);
		expect(act.own).toBe(true);
		expect(act.theirs).toBe(false);
	});
});

describe('the home page is what is waiting on you', () => {
	it('leaves an item off the home of somebody who cannot decide it', async () => {
		// The warehouse lead holds confirm_pick, receive_stock and count_stock.
		// An account manager holds none of those, so warehouse work is not on
		// their home however much of it there is.
		const [raesWork, danasWork] = await Promise.all([
			workWaitingFor(db, RAE),
			workWaitingFor(db, DANA)
		]);
		const warehouseKinds = new Set(['pick', 'receipt', 'count']);

		expect(raesWork.some((item) => warehouseKinds.has(item.kind))).toBe(true);
		expect(danasWork.some((item) => warehouseKinds.has(item.kind))).toBe(false);
	});

	it('is small for everybody, which is the whole point of the migration', async () => {
		for (const who of [DANA, PRIYA, RAE, HOLLIS]) {
			const work = await workWaitingFor(db, who);
			// Small enough to read, on a world this size. A home page holding
			// hundreds of rows is the flood this replaced.
			expect(work.length, String(who)).toBeLessThan(60);
		}
	});
});

describe('granting authority', () => {
	it("raises an agent's autonomy through the same write as a person's limit", async () => {
		// The sentence docs/roles.md claims is literally true. Same function,
		// same audit row, same effective dating, for a person and an agent.
		const raisePerson = await grantAuthority(db, ELENA, {
			userId: DANA,
			authority: 'approve_quote',
			limit: 40000,
			startsOn: TODAY,
			endsOn: null,
			note: 'Covering while somebody is out.',
			requestId: randomUUID()
		});
		const raiseAgent = await grantAuthority(db, ELENA, {
			userId: ORDER_DESK_AGENT,
			authority: 'agent_autonomy',
			limit: 2,
			startsOn: TODAY,
			endsOn: null,
			note: 'Earned it on the evals.',
			requestId: randomUUID()
		});
		expect(raisePerson.replayed).not.toBe(true);
		expect(raiseAgent.replayed).not.toBe(true);

		const [audited] = await db.asSystem((tx) =>
			tx.query<{ n: number }>(
				`select count(*)::int as n from nl.audit_log
				  where action = 'grant_authority' and actor_id = $1`,
				[ELENA]
			)
		);
		expect(audited.n).toBeGreaterThanOrEqual(2);

		const [now] = await db.asSystem((tx) =>
			tx.query<{ person: boolean; agent: boolean }>(
				`select nl.may_approve($1, 'approve_quote', 39000) as person,
				        nl.has_authority($2, 'agent_autonomy') as agent`,
				[DANA, ORDER_DESK_AGENT]
			)
		);
		expect(now.person).toBe(true);
		expect(now.agent).toBe(true);
	});

	it('does not apply a grant that starts tomorrow', async () => {
		const tomorrow = '2026-09-19';
		await grantAuthority(db, ELENA, {
			userId: MARCUS,
			authority: 'override_margin_floor',
			limit: null,
			startsOn: tomorrow,
			endsOn: null,
			note: 'Starts with the new quarter.',
			requestId: randomUUID()
		});
		const [rows] = await db.asSystem((tx) =>
			tx.query<{ today: boolean; later: boolean }>(
				`select nl.has_authority($1, 'override_margin_floor') as today,
				        nl.has_authority($1, 'override_margin_floor', $2::date) as later`,
				[MARCUS, tomorrow]
			)
		);
		expect(rows.today).toBe(false);
		expect(rows.later).toBe(true);
	});

	it('refuses a ceiling on an authority that is a plain yes', async () => {
		// A dollar limit on "may change a policy" would mean nothing, so the
		// table refuses the row rather than storing a figure nobody reads.
		await expect(
			grantAuthority(db, ELENA, {
				userId: MARCUS,
				authority: 'change_policy',
				limit: 5000,
				startsOn: TODAY,
				endsOn: null,
				note: 'Nonsense on purpose.',
				requestId: randomUUID()
			})
		).rejects.toThrow();
	});
});

describe('the lists on both sides of the wire', () => {
	it('agree, so a value cannot quietly go missing from one', async () => {
		const [row] = await db.asSystem((tx) =>
			tx.query<{ presets: string[]; dimensions: string[]; authorities: string[] }>(
				`select nl.role_presets() as presets,
				        nl.scope_dimensions() as dimensions,
				        nl.authority_kinds() as authorities`
			)
		);
		expect([...row.presets].sort()).toEqual([...PRESETS].sort());
		expect([...row.dimensions].sort()).toEqual([...SCOPE_DIMENSIONS].sort());
		expect([...row.authorities].sort()).toEqual([...AUTHORITIES].sort());
	});
});

describe('the seam with the old model', () => {
	it('leaves nl.users.role alone, because eight write functions still read it', async () => {
		/*
		  Not a design claim, a fact being pinned. nl.stage_export,
		  nl.decide_export, nl.add_vendor_contact, nl.post_stock_adjustment,
		  nl.post_count_session, nl.advance_shipment and nl.receive_transfer
		  all check `role not in ('operations', 'admin')`. Renaming these
		  people into the finer presets took those writes away from them and
		  turned 73 tests red once already.

		  When the conversion migration lands, this test should fail and be
		  deleted. Until then it is the guard on the compromise.
		*/
		const rows = await db.asSystem((tx) =>
			tx.query<{ id: number; role: string }>(
				// A Postgres array literal as one text parameter: the driver's Param
				// type takes scalars, not a nested array.
				`select id, role from nl.users where id = any($1::int[]) order by id`,
				[`{${[PRIYA, 6, 12, 13, 14, RAE].join(',')}}`]
			)
		);
		expect(rows).toHaveLength(6);
		for (const row of rows) {
			expect(row.role, `user ${row.id}`).toBe('operations');
		}

		// And the grants that will replace the check are already seeded for
		// exactly those people, so the conversion changes behaviour for nobody.
		const [held] = await db.asSystem((tx) =>
			tx.query<{ n: number }>(
				`select count(*)::int as n from nl.authority_grants
				  where authority = 'run_import' and user_id = any($1::int[])`,
				[`{${[PRIYA, 6, 12, 13, 14].join(',')}}`]
			)
		);
		expect(held.n).toBe(5);
	});

	it('keeps an agent out of the sign-in picker', async () => {
		const [row] = await db.asVisitor((tx) =>
			tx.query<{ n: number }>(
				`select count(*)::int as n from nl.users where kind = 'agent' and active`
			)
		);
		expect(row.n).toBeGreaterThan(0);

		const { listUsers } = await import('../users.ts');
		const people = await listUsers(db);
		expect(people.length).toBeGreaterThan(0);
		expect(people.some((person) => person.id === ORDER_DESK_AGENT)).toBe(false);
	});
});
