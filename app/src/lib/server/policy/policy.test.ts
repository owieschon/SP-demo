// The policy engine, against the small world.
//
// The rules under test are the ones a reviewer will ask about: which policy
// wins, from when, what breaks a tie, what happens when nothing matches, and
// what the trace says about the rows that lost. The four rules this migration
// moved are checked twice each: the answer they gave before the engine
// existed, and the answer they give once somebody sets an exception.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import {
	allocationSummary,
	backtestMarginFloor,
	listPolicies,
	listPolicyTypes,
	resolvePolicies,
	resolvePolicy,
	traceFor
} from './read.ts';
import { endPolicy, setPolicy } from './write.ts';

const ADMIN = 1; // Elena Brooks, admin
const DANA = 2; // Dana Whitlock, account manager
const PRIYA = 5; // Priya Raman, operations

const TODAY = '2026-09-17';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

/**
 * Policies the tests arrange, as the seed does: straight in, so the role
 * rules are not in the way of a test about resolution. The role rules get
 * their own tests through nl.set_policy().
 */
async function arrange(
	rows: {
		type: string;
		scopeKind: string;
		scopeId?: string;
		value: unknown;
		from?: string;
		to?: string | null;
		priority?: number;
		note?: string;
	}[]
): Promise<void> {
	for (const row of rows) {
		await db.asSystem((tx) =>
			tx.query(
				`insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from, effective_to, priority, note)
				 values ($1, $2, $3, $4::jsonb, $5::date, $6::date, $7, $8)`,
				[
					row.type,
					row.scopeKind,
					row.scopeId ?? '',
					JSON.stringify(row.value),
					row.from ?? '2026-01-01',
					row.to ?? null,
					row.priority ?? 0,
					row.note ?? 'arranged by a test'
				]
			)
		);
	}
}

/** Everything the tests added, so each test starts from the seeded world. */
async function forgetArranged(): Promise<void> {
	await db.asSystem((tx) => tx.query(`delete from nl.policies where note = 'arranged by a test'`));
}

async function one<T extends object>(sql: string, params: unknown[] = []): Promise<T> {
	const rows = await db.asSystem((tx) => tx.query<T>(sql, params as never[]));
	return rows[0];
}

/** An account with no policy of its own, so a test starts from the default. */
async function plainAccount(): Promise<string> {
	const row = await one<{ customer_no: string }>(
		`select c.customer_no
		 from nl.customers c
		 where not c.blocked and not c.closed
		   and not exists (select 1 from nl.policies p where p.scope_kind = 'customer' and p.scope_id = c.customer_no)
		 order by c.customer_no
		 limit 1`
	);
	return row.customer_no;
}

beforeEach(forgetArranged);

describe('the catalog', () => {
	it('is loaded, and every type can hold its own default', async () => {
		const types = await listPolicyTypes(db, DANA);
		expect(types.length).toBeGreaterThanOrEqual(28);
		// The check constraint would have refused a default that does not fit,
		// so this is really asking whether every type made it in.
		for (const type of types) {
			expect(type.scopes).toContain('global');
			expect(type.defaultWords).not.toBe('');
			expect(type.description.length).toBeGreaterThan(20);
		}
		const groups = new Set(types.map((type) => type.groupKey));
		expect([...groups].sort()).toEqual([
			'agents',
			'commercial',
			'freight',
			'fulfilment',
			'operations',
			'quality'
		]);
	});

	it('says what reads each policy, and refuses to be edited where nothing does', async () => {
		const types = await listPolicyTypes(db, DANA);
		const moved = types.filter((type) => type.readBy !== '' && !type.readBy.startsWith('nothing yet'));
		// The five this migration moved, plus the freight terms that came with
		// the free freight threshold and the receipt count that comes with the
		// promise percentile.
		expect(moved.map((type) => type.key).sort()).toEqual([
			'commercial.min_margin',
			'commercial.quote_valid_days',
			'freight.free_over',
			'freight.terms',
			'fulfilment.allocation_priority',
			'operations.promise_min_receipts',
			'operations.promise_percentile'
		]);
		// A policy whose old hard-coded reader has not moved is not editable,
		// because editing it would change a number on screen and nothing else.
		for (const type of types.filter((one) => one.readBy.startsWith('nothing yet'))) {
			expect(type.editable).toBe(false);
		}
	});
});

describe('resolution order', () => {
	it('takes the most specific scope, all the way down the ladder', async () => {
		const account = await plainAccount();
		const segment = (
			await one<{ price_group: string }>(`select price_group from nl.customers where customer_no = $1`, [
				account
			])
		).price_group;
		const part = (
			await one<{ item_no: string; family: string }>(
				`select item_no, family from nl.items where family = 'elbow' order by item_no limit 1`
			)
		);

		const context = { customerNo: account, itemNo: part.item_no };
		const floor = async () => (await resolvePolicy(db, DANA, 'commercial.min_margin', context)).value;

		// Nothing set for any of them: the company-wide row the seed made.
		expect(await floor()).toBe(0.2);

		await arrange([{ type: 'commercial.min_margin', scopeKind: 'customer_segment', scopeId: segment, value: 0.21 }]);
		expect(await floor()).toBe(0.21);

		await arrange([{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.22 }]);
		expect(await floor()).toBe(0.22);

		await arrange([{ type: 'commercial.min_margin', scopeKind: 'item_family', scopeId: part.family, value: 0.23 }]);
		expect(await floor()).toBe(0.23);

		await arrange([{ type: 'commercial.min_margin', scopeKind: 'item', scopeId: part.item_no, value: 0.24 }]);
		expect(await floor()).toBe(0.24);

		// And the answer says which of them won.
		const answer = await resolvePolicy(db, DANA, 'commercial.min_margin', context);
		expect(answer.scopeKind).toBe('item');
		expect(answer.scopeId).toBe(part.item_no);
		expect(answer.beat.map((beaten) => beaten.scopeKind)).toEqual(['item_family', 'customer', 'customer_segment']);
	});

	it('answers at every scope kind the engine has', async () => {
		// One policy per scope kind, each on a type that allows that scope, so
		// no scope kind is left untested.
		const account = await plainAccount();
		const vendor = (await one<{ vendor_no: string }>(`select vendor_no from nl.vendors order by vendor_no limit 1`))
			.vendor_no;
		const part = (await one<{ item_no: string }>(`select item_no from nl.items order by item_no limit 1`)).item_no;
		const family = (await one<{ family: string }>(`select family from nl.items order by family limit 1`)).family;
		const segment = (await one<{ code: string }>(`select code from nl.price_groups order by code limit 1`)).code;
		const location = (await one<{ code: string }>(`select code from nl.locations order by code limit 1`)).code;

		const cases: { kind: string; type: string; id: string; value: unknown; context: Record<string, unknown> }[] = [
			{ kind: 'global', type: 'freight.carrier', id: '', value: 'parcel', context: {} },
			{ kind: 'customer_segment', type: 'freight.terms', id: segment, value: 'collect', context: { customerSegment: segment } },
			{ kind: 'customer', type: 'freight.terms', id: account, value: 'prepaid', context: { customerNo: account } },
			{ kind: 'vendor', type: 'operations.overdue_supply_days', id: vendor, value: 9, context: { vendorNo: vendor } },
			{ kind: 'item', type: 'fulfilment.order_multiple', id: part, value: 12, context: { itemNo: part } },
			{ kind: 'item_family', type: 'fulfilment.order_multiple', id: family, value: 6, context: { itemFamily: family } },
			{ kind: 'location', type: 'freight.carrier', id: location, value: 'regional ltl', context: { locationCode: location } },
			{ kind: 'mailbox', type: 'agents.daily_cap', id: '1', value: 5, context: { mailboxId: 1 } },
			{ kind: 'order', type: 'fulfilment.expedite_rule', id: 'SO-TEST', value: 'never', context: { documentNo: 'SO-TEST' } },
			{
				kind: 'order_line',
				type: 'fulfilment.expedite_rule',
				id: 'SO-TEST:3',
				value: 'always allowed',
				context: { documentNo: 'SO-TEST', lineNo: 3 }
			}
		];

		for (const each of cases) {
			await forgetArranged();
			await arrange([{ type: each.type, scopeKind: each.kind, scopeId: each.id, value: each.value }]);
			const answer = await resolvePolicy(db, DANA, each.type, each.context);
			expect({ kind: answer.scopeKind, value: answer.value }).toEqual({ kind: each.kind, value: each.value });
		}
	});

	it('works out the price group and the family, so a caller does not have to', async () => {
		const account = await plainAccount();
		const segment = (
			await one<{ price_group: string }>(`select price_group from nl.customers where customer_no = $1`, [account])
		).price_group;
		await arrange([
			{ type: 'commercial.payment_terms', scopeKind: 'customer_segment', scopeId: segment, value: 'net 60' }
		]);
		// The context names only the account.
		const answer = await resolvePolicy(db, DANA, 'commercial.payment_terms', { customerNo: account });
		expect(answer.value).toBe('net 60');
		expect(answer.scopeWords).toContain(segment);
	});
});

describe('effective dates', () => {
	it('ignores a policy that has not started, and one that has run out', async () => {
		const account = await plainAccount();
		await arrange([
			{ type: 'commercial.quote_valid_days', scopeKind: 'customer', scopeId: account, value: 7, from: '2025-01-01', to: '2025-12-31' },
			{ type: 'commercial.quote_valid_days', scopeKind: 'customer', scopeId: account, value: 45, from: '2027-01-01' }
		]);
		const ask = async (onDate?: string) =>
			await resolvePolicy(db, DANA, 'commercial.quote_valid_days', { customerNo: account, onDate });

		// Today, neither applies: the company-wide row does.
		const now = await ask();
		expect(now.value).toBe(30);
		expect(now.scopeKind).toBe('global');

		// Inside the window that has run out, it does.
		expect((await ask('2025-06-01')).value).toBe(7);
		// And after the one that starts later starts.
		expect((await ask('2027-03-01')).value).toBe(45);
	});

	it('keeps the expired rows the seed made, and does not use them today', async () => {
		const expired = await listPolicies(db, ADMIN);
		const ran_out = expired.filter((row) => row.status === 'expired');
		expect(ran_out.length).toBeGreaterThanOrEqual(2);
		for (const row of ran_out) {
			const answer = await resolvePolicy(db, ADMIN, row.policyType, {
				customerNo: row.scopeKind === 'customer' ? row.scopeId : null
			});
			expect(answer.policyId).not.toBe(row.id);
		}
	});

	it('ends a policy without losing what it said', async () => {
		const account = await plainAccount();
		const created = await setPolicy(db, ADMIN, {
			policyType: 'commercial.min_margin',
			scopeKind: 'customer',
			scopeId: account,
			value: '0.3',
			effectiveFrom: '2026-01-01',
			priority: 0,
			note: 'arranged by a test',
			requestId: randomUUID()
		});
		expect((await resolvePolicy(db, DANA, 'commercial.min_margin', { customerNo: account })).value).toBe(0.3);

		await endPolicy(db, ADMIN, {
			policyId: created.policyId,
			effectiveTo: '2026-09-16',
			expectedUpdatedAt: created.updatedAt,
			requestId: randomUUID()
		});

		// Gone from today's answer, still there for the day it applied.
		expect((await resolvePolicy(db, DANA, 'commercial.min_margin', { customerNo: account })).value).toBe(0.2);
		expect(
			(await resolvePolicy(db, DANA, 'commercial.min_margin', { customerNo: account, onDate: '2026-05-01' })).value
		).toBe(0.3);
		const still = await listPolicies(db, ADMIN, 'commercial.min_margin');
		expect(still.some((row) => row.id === created.policyId)).toBe(true);
	});
});

describe('priority and the default', () => {
	it('breaks a tie at the same scope with priority, and the trace says so', async () => {
		const account = await plainAccount();
		await arrange([
			{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.25, from: '2026-03-01', priority: 0 },
			{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.18, from: '2026-03-01', priority: 10 }
		]);
		const answer = await resolvePolicy(db, DANA, 'commercial.min_margin', { customerNo: account });
		expect(answer.value).toBe(0.18);
		expect(answer.priority).toBe(10);
		expect(answer.beat[0]).toMatchObject({ value: 0.25, reason: 'a lower priority' });

		const trace = await traceFor(db, DANA, 'commercial.min_margin', { customerNo: account });
		const loser = trace.find((row) => row.value === 0.25);
		expect(loser?.reason).toBe('a row at the same scope has a higher priority');
	});

	it('falls back to the newest effective date when the priority is level', async () => {
		const account = await plainAccount();
		await arrange([
			{ type: 'commercial.quote_valid_days', scopeKind: 'customer', scopeId: account, value: 20, from: '2026-02-01' },
			{ type: 'commercial.quote_valid_days', scopeKind: 'customer', scopeId: account, value: 25, from: '2026-06-01' }
		]);
		const answer = await resolvePolicy(db, DANA, 'commercial.quote_valid_days', { customerNo: account });
		expect(answer.value).toBe(25);
		expect(answer.beat[0]).toMatchObject({ value: 20, reason: 'an older effective date' });
	});

	it('uses the built-in default when nothing matches at all', async () => {
		// A type the seed sets nothing for, asked about nothing in particular.
		const answer = await resolvePolicy(db, DANA, 'quality.inspection_level', {});
		expect(answer.source).toBe('default');
		expect(answer.value).toBe('normal');
		expect(answer.policyId).toBeNull();
		expect(answer.explanation).toContain('built-in default');

		const trace = await traceFor(db, DANA, 'quality.inspection_level', {});
		const last = trace[trace.length - 1];
		expect(last).toMatchObject({ scopeKind: 'default', isWinner: true, reason: 'nothing is set for this context' });
	});

	it('refuses a policy nobody has heard of', async () => {
		await expect(resolvePolicy(db, DANA, 'freight.unicorns', {})).rejects.toThrow(
			/no policy type called freight.unicorns/i
		);
	});

	it('answers many policies in one call, the same way it answers one', async () => {
		const account = await plainAccount();
		const keys = ['freight.terms', 'freight.free_over', 'commercial.min_margin', 'commercial.quote_valid_days'];
		const many = await resolvePolicies(db, DANA, keys, { customerNo: account });
		expect(Object.keys(many).sort()).toEqual([...keys].sort());
		for (const key of keys) {
			const alone = await resolvePolicy(db, DANA, key, { customerNo: account });
			expect(many[key]).toEqual(alone);
		}
	});
});

describe('the trace', () => {
	it('names every candidate and the reason each one lost', async () => {
		const account = await plainAccount();
		const other = (
			await one<{ customer_no: string }>(
				`select customer_no from nl.customers where customer_no <> $1 order by customer_no desc limit 1`,
				[account]
			)
		).customer_no;
		await arrange([
			{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.26, from: '2026-03-01' },
			{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: other, value: 0.4, from: '2026-03-01' },
			{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.5, from: '2025-01-01', to: '2025-06-30' },
			{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.6, from: '2027-01-01' }
		]);

		const trace = await traceFor(db, DANA, 'commercial.min_margin', { customerNo: account });
		const winner = trace.find((row) => row.isWinner);
		expect(winner?.value).toBe(0.26);
		expect(winner?.reason).toContain('most specific');

		// Keyed on the row rather than the value, because the company-wide row
		// and the built-in default both say a fifth.
		const reasonFor = (value: unknown, scopeKind: string) =>
			trace.find((row) => row.value === value && row.scopeKind === scopeKind)?.reason;
		expect(reasonFor(0.4, 'customer')).toBe('set for an account, not this one');
		expect(reasonFor(0.5, 'customer')).toContain('expired on 30 June 2025');
		expect(reasonFor(0.6, 'customer')).toContain('does not start until 1 January 2027');
		// The company-wide row lost on specificity, and the default is last.
		expect(reasonFor(0.2, 'global')).toBe('an account is more specific');
		expect(trace[trace.length - 1].scopeKind).toBe('default');
		expect(trace[trace.length - 1].reason).toBe('only used when nothing is set');
	});

	it('cannot disagree with the value in use', async () => {
		const account = await plainAccount();
		await arrange([
			{ type: 'freight.free_over', scopeKind: 'customer', scopeId: account, value: 1500, from: '2026-03-01' }
		]);
		const answer = await resolvePolicy(db, DANA, 'freight.free_over', { customerNo: account });
		const trace = await traceFor(db, DANA, 'freight.free_over', { customerNo: account });
		const winner = trace.find((row) => row.isWinner);
		expect(winner?.policyId).toBe(answer.policyId);
		expect(winner?.valueWords).toBe(answer.valueWords);
	});
});

describe('values have to fit their policy', () => {
	const cases: { type: string; value: string; because: RegExp }[] = [
		{ type: 'commercial.min_margin', value: '1.5', because: /above the highest value allowed/i },
		{ type: 'commercial.min_margin', value: '"a fifth"', because: /is not a number/i },
		{ type: 'commercial.quote_valid_days', value: '10.5', because: /not a whole number/i },
		{ type: 'commercial.quote_valid_days', value: '0', because: /below the lowest value allowed/i },
		{ type: 'freight.terms', value: '"whatever they like"', because: /is not one of/i },
		{ type: 'quality.required_documents', value: '["glitter"]', because: /is not one of/i },
		{ type: 'quality.required_documents', value: '"packing list"', because: /this policy is a list/i },
		{ type: 'fulfilment.split_shipments', value: '"yes"', because: /yes or no/i },
		{ type: 'operations.default_lead_days', value: '{"purchase": 30}', because: /missing/i }
	];

	for (const each of cases) {
		it(`refuses ${each.value} for ${each.type}`, async () => {
			await expect(
				db.asSystem((tx) =>
					tx.query(
						`insert into nl.policies (policy_type, scope_kind, value, effective_from)
						 values ($1, 'global', $2::jsonb, '2026-01-01')`,
						[each.type, each.value]
					)
				)
			).rejects.toThrow(each.because);
		});
	}

	it('refuses a scope the policy is not set at', async () => {
		await expect(
			arrange([{ type: 'operations.partial_export_hold_ratio', scopeKind: 'customer', scopeId: '1218', value: 0.5 }])
		).rejects.toThrow(/cannot be set at customer scope/i);
	});

	it('refuses a company-wide policy with something in its scope id', async () => {
		await expect(
			arrange([{ type: 'freight.terms', scopeKind: 'global', scopeId: '1218', value: 'collect' }])
		).rejects.toThrow(/policies_global_scope/);
	});

	it('refuses a window that ends before it starts', async () => {
		await expect(
			arrange([{ type: 'freight.terms', scopeKind: 'global', value: 'collect', from: '2026-06-01', to: '2026-01-01' }])
		).rejects.toThrow(/policies_window/);
	});
});

describe('who may change what', () => {
	async function attempt(userId: number, type: string, value: string) {
		const account = await plainAccount();
		return setPolicy(db, userId, {
			policyType: type,
			scopeKind: 'customer',
			scopeId: account,
			value,
			effectiveFrom: TODAY,
			priority: 0,
			note: 'arranged by a test',
			requestId: randomUUID()
		});
	}

	it('lets an account manager set quote validity and nothing else', async () => {
		await expect(attempt(DANA, 'commercial.quote_valid_days', '21')).resolves.toMatchObject({ replayed: false });
		await expect(attempt(DANA, 'commercial.min_margin', '0.3')).rejects.toThrow(/is for admins/i);
		await expect(attempt(DANA, 'freight.terms', '"collect"')).rejects.toThrow(/for operations and admins/i);
	});

	it('lets operations set freight and fulfilment', async () => {
		await expect(attempt(PRIYA, 'freight.terms', '"collect"')).resolves.toMatchObject({ replayed: false });
		await expect(attempt(PRIYA, 'fulfilment.allocation_priority', '50')).resolves.toMatchObject({ replayed: false });
		await expect(attempt(PRIYA, 'commercial.payment_terms', '"net 60"')).rejects.toThrow(/is for admins/i);
	});

	it('lets an admin set anything that is editable, and nothing that is not', async () => {
		await expect(attempt(ADMIN, 'commercial.min_margin', '0.3')).resolves.toMatchObject({ replayed: false });
		await expect(attempt(ADMIN, 'freight.terms', '"third party"')).resolves.toMatchObject({ replayed: false });
		await expect(attempt(ADMIN, 'operations.kept_ratio', '0.9')).rejects.toThrow(/not something the app can change/i);
	});

	it('refuses a scope id that is not anything', async () => {
		await expect(
			setPolicy(db, ADMIN, {
				policyType: 'commercial.min_margin',
				scopeKind: 'customer',
				scopeId: 'nobody-at-all',
				value: '0.3',
				effectiveFrom: TODAY,
				priority: 0,
				note: 'arranged by a test',
				requestId: randomUUID()
			})
		).rejects.toThrow(/there is no account nobody-at-all/i);
	});

	it('writes once per request id, and refuses a stale row version', async () => {
		const account = await plainAccount();
		const requestId = randomUUID();
		const input = {
			policyType: 'commercial.quote_valid_days',
			scopeKind: 'customer' as const,
			scopeId: account,
			value: '21',
			effectiveFrom: TODAY,
			priority: 0,
			note: 'arranged by a test',
			requestId
		};
		const first = await setPolicy(db, DANA, input);
		const again = await setPolicy(db, DANA, input);
		expect(again.replayed).toBe(true);
		expect(again.policyId).toBe(first.policyId);

		await expect(
			setPolicy(db, DANA, {
				...input,
				policyId: first.policyId,
				value: '22',
				expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
				requestId: randomUUID()
			})
		).rejects.toThrow(/changed since it was loaded/i);
	});

	it('records every change in the audit log, with who made it', async () => {
		const account = await plainAccount();
		const created = await setPolicy(db, ADMIN, {
			policyType: 'commercial.min_margin',
			scopeKind: 'customer',
			scopeId: account,
			value: '0.27',
			effectiveFrom: TODAY,
			priority: 0,
			note: 'arranged by a test',
			requestId: randomUUID()
		});
		await endPolicy(db, ADMIN, {
			policyId: created.policyId,
			expectedUpdatedAt: created.updatedAt,
			requestId: randomUUID()
		});
		const rows = await db.asSystem((tx) =>
			tx.query<{ action: string; actor_id: number }>(
				`select action, actor_id from nl.audit_log
				 where entity = 'policy' and entity_id = $1 order by id`,
				[String(created.policyId)]
			)
		);
		expect(rows.map((row) => row.action)).toEqual(['set_policy', 'end_policy']);
		expect(rows.every((row) => row.actor_id === ADMIN)).toBe(true);
	});
});

describe('moved rule 1: the margin floor', () => {
	it('gives the same answer the literal gave', async () => {
		const [row] = await db.asSystem((tx) => tx.sql<{ floor: number }>`select nl.min_margin() as floor`);
		expect(row.floor).toBe(0.2);
	});

	it('can be set for one account or one family, which the literal could not', async () => {
		const account = await plainAccount();
		await arrange([{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.35 }]);
		const [scoped] = await db.asSystem((tx) =>
			tx.sql<{ floor: number; company: number }>`
				select nl.min_margin_for(${account}, null, null) as floor, nl.min_margin() as company`
		);
		expect(scoped).toEqual({ floor: 0.35, company: 0.2 });
	});

	it('leaves nl.price_for on the company-wide floor, which is the call site still to move', async () => {
		const account = await plainAccount();
		const part = (await one<{ item_no: string }>(`select item_no from nl.items order by item_no limit 1`)).item_no;
		await arrange([{ type: 'commercial.min_margin', scopeKind: 'customer', scopeId: account, value: 0.5 }]);
		const [priced] = await db.asSystem((tx) =>
			tx.sql<{ floor_price: number; unit_cost: number }>`
				select floor_price, unit_cost from nl.price_for(${account}, ${part}, null)`
		);
		// Still cost / (1 - 0.20), not cost / (1 - 0.50). Documented as a gap
		// rather than papered over: see docs/policy-engine.md.
		expect(priced.floor_price).toBeCloseTo(Math.round((priced.unit_cost / 0.8) * 100) / 100, 2);
	});
});

describe('moved rule 5: which percentile a promise uses', () => {
	/** A part with enough receipts for the observed figure to be in use. */
	async function partWithHistory(): Promise<{ item_no: string; median: number; p90: number }> {
		return one<{ item_no: string; median: number; p90: number }>(
			`select p.item_no, p.median_days as median, p.p90_days as p90
			 from (
			   select r.item_no
			   from nl.purchase_receipts r
			   group by r.item_no
			   having count(*) >= 6
			   order by count(*) desc, r.item_no
			   limit 10
			 ) picked
			 cross join lateral nl.promise_lead_days(picked.item_no) p
			 where p.basis = 'observed'
			   and p.p90_days > p.median_days
			 order by p.p90_days - p.median_days desc, p.item_no
			 limit 1`
		);
	}

	it('still promises the ninetieth percentile when nothing is set', async () => {
		const [row] = await db.asSystem((tx) =>
			tx.sql<{ percentile: number; receipts: number }>`
				select nl.promise_percentile() as percentile, nl.promise_min_receipts() as receipts`
		);
		expect(Number(row.percentile)).toBe(0.9);
		expect(row.receipts).toBe(4);
	});

	it('changes the promise when the policy changes', async () => {
		const part = await partWithHistory();
		// Nothing arranged: the ninetieth percentile, which is the p90 figure.
		const before = await one<{ lead_days: number }>(
			`select lead_days from nl.promise_lead_days($1)`,
			[part.item_no]
		);

		// The company decides a median promise is enough. This is the whole
		// point of the engine: the number moves and no code is deployed.
		await arrange([{ type: 'operations.promise_percentile', scopeKind: 'global', value: 0.5 }]);
		const after = await one<{ lead_days: number }>(
			`select lead_days from nl.promise_lead_days($1)`,
			[part.item_no]
		);

		expect(Number(before.lead_days)).toBe(Math.round(Number(part.p90)));
		expect(Number(after.lead_days)).toBe(Math.round(Number(part.median)));
		expect(Number(after.lead_days)).toBeLessThan(Number(before.lead_days));
	});

	it('can be set for one vendor, which the constant could not', async () => {
		const vendor = (
			await one<{ vendor_no: string }>(
				`select vendor_no from nl.purchase_receipts group by vendor_no
				 order by count(*) desc, vendor_no limit 1`
			)
		).vendor_no;
		await arrange([
			{ type: 'operations.promise_percentile', scopeKind: 'vendor', scopeId: vendor, value: 0.6 }
		]);
		const [row] = await db.asSystem((tx) =>
			tx.sql<{ theirs: number; everyone: number }>`
				select nl.promise_percentile_for(${vendor}, null) as theirs,
				       nl.promise_percentile() as everyone`
		);
		expect(Number(row.theirs)).toBe(0.6);
		expect(Number(row.everyone)).toBe(0.9);
	});

	it('leaves the session hook 0032 wrote in front of the policy', async () => {
		await arrange([{ type: 'operations.promise_percentile', scopeKind: 'global', value: 0.75 }]);
		const [row] = await db.asSystem((tx) =>
			tx.sql<{ pinned: number }>`
				select (select nl.promise_percentile()
				        from (select set_config('nl.promise_percentile', '0.55', true)) as pinned) as pinned`
		);
		expect(Number(row.pinned)).toBe(0.55);
	});
});

describe('backtesting the margin floor', () => {
	const FROM = '2026-06-17';
	const TO = TODAY;

	it('adds up the same way the ledger does', async () => {
		const run = await backtestMarginFloor(db, DANA, { floor: 0.25, from: FROM, to: TO });
		const [straight] = await db.asSystem((tx) =>
			tx.sql<{ lines: number; revenue: number; margin: number; below: number; below_revenue: number }>`
				select
				  count(*)::int as lines,
				  sum(il.amount) as revenue,
				  sum(il.amount) - sum(il.quantity * il.unit_cost) as margin,
				  count(*) filter (where il.unit_price < round(il.unit_cost / (1 - 0.25), 2))::int as below,
				  coalesce(sum(il.amount) filter (where il.unit_price < round(il.unit_cost / (1 - 0.25), 2)), 0)
				    as below_revenue
				from nl.invoice_lines il
				where il.posted_on >= ${FROM} and il.posted_on <= ${TO}
				  and il.quantity > 0 and il.amount > 0`
		);
		expect(run.lines).toBe(straight.lines);
		expect(run.revenue).toBeCloseTo(Number(straight.revenue), 2);
		expect(run.margin).toBeCloseTo(Number(straight.margin), 2);
		expect(run.linesBelow).toBe(straight.below);
		expect(run.revenueBelow).toBeCloseTo(Number(straight.below_revenue), 2);
	});

	it('finds more under a higher floor, never less', async () => {
		const low = await backtestMarginFloor(db, DANA, { floor: 0.1, from: FROM, to: TO });
		const mid = await backtestMarginFloor(db, DANA, { floor: 0.25, from: FROM, to: TO });
		const high = await backtestMarginFloor(db, DANA, { floor: 0.45, from: FROM, to: TO });

		expect(mid.linesBelow).toBeGreaterThanOrEqual(low.linesBelow);
		expect(high.linesBelow).toBeGreaterThanOrEqual(mid.linesBelow);
		expect(high.marginGained).toBeGreaterThanOrEqual(mid.marginGained);
		expect(mid.marginGained).toBeGreaterThanOrEqual(low.marginGained);
		// The window itself does not move: the same lines are being judged.
		expect(mid.lines).toBe(low.lines);
		expect(high.revenue).toBeCloseTo(low.revenue, 2);
	});

	it('reports both bounds, and they are on the right sides of what happened', async () => {
		const run = await backtestMarginFloor(db, DANA, { floor: 0.4, from: FROM, to: TO });
		expect(run.linesBelow).toBeGreaterThan(0);
		// Repricing only ever adds, and refusing only ever takes away.
		expect(run.marginGained).toBeGreaterThan(0);
		expect(run.marginAfter).toBeGreaterThan(run.margin);
		expect(run.revenueBelow).toBeGreaterThan(0);
		expect(run.marginBelow).toBeLessThan(run.margin);
		// Every account listed has something to gain, longest first.
		const gains = run.accounts.map((one) => one.marginGained);
		expect([...gains].sort((a, b) => b - a)).toEqual(gains);
	});

	it('finds nothing under a floor of nothing but lines sold under cost', async () => {
		const run = await backtestMarginFloor(db, DANA, { floor: 0, from: FROM, to: TO });
		const [under] = await db.asSystem((tx) =>
			tx.sql<{ n: number }>`
				select count(*)::int as n from nl.invoice_lines
				where posted_on >= ${FROM} and posted_on <= ${TO}
				  and quantity > 0 and amount > 0 and unit_price < unit_cost`
		);
		// A floor of zero is the cost itself, so the only lines under it are the
		// ones that lost money.
		expect(run.linesBelow).toBe(under.n);
	});
});

describe('moved rule 2: freight terms and the free freight threshold', () => {
	it('prices freight exactly as the tariff tables did, at every band and period', async () => {
		const rows = await db.asSystem((tx) =>
			tx.sql<{ subtotal: number; on_date: string; engine: number; tariff: number; engine_free: number; tariff_free: number }>`
				with asks as (
				  select s.subtotal, p.effective_from as on_date
				  from (values (0::numeric), (100), (300), (1200), (1999), (5000)) as s(subtotal)
				  cross join nl.freight_periods p
				),
				-- The rule as migration 0018 wrote it, worked out here from the
				-- tables rather than by calling the function under test.
				before as (
				  select
				    a.subtotal, a.on_date,
				    case when a.subtotal >= p.free_over then 0::numeric
				         else round(b.rate * (1 + s.percent / 100), 2) end as freight,
				    p.free_over
				  from asks a
				  cross join lateral (
				    select fp.effective_from, fp.free_over from nl.freight_periods fp
				    where fp.effective_from <= a.on_date order by fp.effective_from desc limit 1) p
				  cross join lateral (
				    select fr.rate from nl.freight_rates fr
				    where fr.effective_from = p.effective_from and fr.min_subtotal <= a.subtotal
				    order by fr.min_subtotal desc limit 1) b
				  cross join lateral (
				    select coalesce((select fs.percent from nl.fuel_surcharge fs
				      where fs.month <= date_trunc('month', a.on_date)::date
				      order by fs.month desc limit 1), 0) as percent) s
				)
				select b.subtotal, b.on_date, f.freight as engine, b.freight as tariff,
				       f.free_over as engine_free, b.free_over as tariff_free
				from before b
				cross join lateral nl.freight_for(b.subtotal, b.on_date) f`
		);
		expect(rows.length).toBeGreaterThan(10);
		for (const row of rows) {
			expect(row.engine).toBe(row.tariff);
			expect(row.engine_free).toBe(row.tariff_free);
		}
	});

	it('lets one account ship free sooner, and says why', async () => {
		const account = await plainAccount();
		await arrange([
			{
				type: 'freight.free_over',
				scopeKind: 'customer',
				scopeId: account,
				value: 1000,
				from: '2026-03-01',
				note: 'arranged by a test'
			}
		]);
		const [theirs] = await db.asSystem((tx) =>
			tx.sql<{ freight: number; free_over: number; free_over_explanation: string }>`
				select freight, free_over, free_over_explanation from nl.freight_quote(${account}, 1200, null)`
		);
		const [everyone] = await db.asSystem((tx) =>
			tx.sql<{ freight: number; free_over: number }>`select freight, free_over from nl.freight_for(1200, null)`
		);
		expect(theirs.freight).toBe(0);
		expect(theirs.free_over).toBe(1000);
		expect(theirs.free_over_explanation).toContain('since 1 March 2026');
		expect(everyone.freight).toBeGreaterThan(0);
		expect(everyone.free_over).toBe(2000);
	});

	it('says who pays, which nothing could say before', async () => {
		const collects = await one<{ customer_no: string }>(
			`select customer_no from nl.customers where ships_own_carrier order by customer_no limit 1`
		);
		const [theirs] = await db.asSystem((tx) =>
			tx.sql<{ terms: string; terms_explanation: string }>`
				select terms, terms_explanation from nl.freight_quote(${collects.customer_no}, 300, null)`
		);
		expect(theirs.terms).toBe('collect');
		expect(theirs.terms_explanation).toContain('because this account has said so');

		const plain = await plainAccount();
		const [standard] = await db.asSystem((tx) =>
			tx.sql<{ terms: string }>`select terms from nl.freight_quote(${plain}, 300, null)`
		);
		expect(standard.terms).toBe('prepaid and add');
	});
});

describe('moved rule 3: how long a quote holds', () => {
	/** A draft ready to approve, built the way the validator would leave it. */
	async function readyDraft(customerNo: string): Promise<{ draftId: number; updatedAt: string }> {
		const part = await one<{ item_no: string; unit_price: number }>(
			`select i.item_no, round(i.list_price * (1 - g.discount), 2) as unit_price
			 from nl.items i
			 join nl.customers c on c.customer_no = $1
			 join nl.price_groups g on g.code = c.price_group
			 where not i.blocked and i.list_price > 0
			 order by i.item_no
			 limit 1`,
			[customerNo]
		);
		const validation = {
			needs_review: 0,
			customer: { customer_no: customerNo, status: 'ok' },
			needed_by: { date: null, status: 'ok' },
			lines: [
				{ item_no: part.item_no, quantity: 4, unit_price: Number(part.unit_price), status: 'ok' }
			]
		};
		const row = await one<{ id: number; updated_at: Date | string }>(
			`insert into nl.rfq_drafts (created_by, source_text, source_name, extractor, draft, validation, needs_review, customer_no)
			 values ($1, 'a test asking for a price', 'test', 'rules', '{}'::jsonb, $2::jsonb, 0, $3)
			 returning id, updated_at`,
			[DANA, JSON.stringify(validation), customerNo]
		);
		return {
			draftId: row.id,
			updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at)
		};
	}

	async function approve(draftId: number, updatedAt: string): Promise<{ quoteId: number; validDays: number }> {
		const [row] = await db.asUser(DANA, (tx) =>
			tx.query<{ result: Record<string, unknown> }>(
				`select nl.approve_rfq_draft($1::bigint, $2::timestamptz, $3) as result`,
				[draftId, updatedAt, randomUUID()]
			)
		);
		return { quoteId: Number(row.result.quote_id), validDays: Number(row.result.valid_days) };
	}

	it('still holds a quote for thirty days when nothing is set', async () => {
		const account = await plainAccount();
		const draft = await readyDraft(account);
		const approved = await approve(draft.draftId, draft.updatedAt);
		expect(approved.validDays).toBe(30);
		const [quote] = await db.asSystem((tx) =>
			tx.sql<{ quoted_on: string; valid_until: string }>`
				select quoted_on, valid_until from nl.quotes where id = ${approved.quoteId}`
		);
		expect(quote).toEqual({ quoted_on: TODAY, valid_until: '2026-10-17' });
	});

	it('holds it for as long as the account has agreed, and records why', async () => {
		const account = await plainAccount();
		await arrange([
			{ type: 'commercial.quote_valid_days', scopeKind: 'customer', scopeId: account, value: 14, from: '2026-03-01' }
		]);
		const draft = await readyDraft(account);
		const approved = await approve(draft.draftId, draft.updatedAt);
		expect(approved.validDays).toBe(14);
		const [quote] = await db.asSystem((tx) =>
			tx.sql<{ valid_until: string }>`select valid_until from nl.quotes where id = ${approved.quoteId}`
		);
		expect(quote.valid_until).toBe('2026-10-01');

		const [audit] = await db.asSystem((tx) =>
			tx.sql<{ detail: Record<string, unknown> }>`
				select detail from nl.audit_log
				where action = 'approve_rfq_draft' and entity_id = ${String(draft.draftId)}`
		);
		expect(audit.detail.valid_days).toBe(14);
		expect(String(audit.detail.valid_days_why)).toContain('because this account has said so');
	});
});

describe('moved rule 4: allocation priority', () => {
	/** Every line of one part, as each view allocates it. */
	async function linesFor(itemNo: string) {
		return db.asSystem((tx) =>
			tx.sql<{
				document_no: string;
				line_no: number;
				by_date: number;
				by_priority: number;
				priority_rank: number;
			}>`
				select o.document_no, o.line_no, o.allocated as by_date,
				       p.allocated as by_priority, p.priority_rank
				from nl.open_line_allocation o
				join nl.allocation_plan p on p.document_no = o.document_no and p.line_no = o.line_no
				where o.item_no = ${itemNo}
				order by o.ship_date, o.document_no, o.line_no`
		);
	}

	/** A part several accounts are waiting for, where stock does not cover it. */
	async function contendedPart(): Promise<{ item_no: string; behind: string }> {
		return one<{ item_no: string; behind: string }>(
			`select l.item_no,
			        (array_agg(l.customer_no order by l.ship_date desc, l.document_no desc))[1] as behind
			 from nl.open_order_lines l
			 join nl.stock s on s.item_no = l.item_no
			 group by l.item_no, s.on_hand
			 having count(*) >= 2 and sum(l.quantity) > s.on_hand and s.on_hand > 0
			 order by count(*) desc, l.item_no
			 limit 1`
		);
	}

	it('matches the old ship-date allocation exactly when nobody has a priority', async () => {
		const part = await contendedPart();
		// The seed does give two accounts a priority, so this compares the two
		// views for a part where none of the accounts involved has one.
		const rows = await db.asSystem((tx) =>
			tx.sql<{ same: number; total: number }>`
				select count(*) filter (where o.allocated = p.allocated)::int as same, count(*)::int as total
				from nl.open_line_allocation o
				join nl.allocation_plan p on p.document_no = o.document_no and p.line_no = o.line_no
				where p.item_no in (
				  select item_no from nl.allocation_plan group by item_no having max(priority_rank) = 0)`
		);
		expect(rows[0].total).toBeGreaterThan(0);
		expect(rows[0].same).toBe(rows[0].total);
		expect(part.item_no).not.toBe('');
	});

	it('puts a priority account in front of an earlier ship date', async () => {
		const part = await contendedPart();
		const before = await linesFor(part.item_no);
		// The account at the back of the queue for this part goes to the front.
		await arrange([
			{ type: 'fulfilment.allocation_priority', scopeKind: 'customer', scopeId: part.behind, value: 95 }
		]);
		const after = await linesFor(part.item_no);

		const theirs = (rows: typeof before) =>
			rows.filter((row) => row.by_priority !== row.by_date || row.priority_rank > 0);
		expect(theirs(after).length).toBeGreaterThan(0);

		// The same total is handed out either way: a priority decides who waits,
		// it does not make stock.
		const sum = (rows: typeof before, key: 'by_date' | 'by_priority') =>
			rows.reduce((total, row) => total + row[key], 0);
		expect(sum(after, 'by_priority')).toBe(sum(before, 'by_date'));

		// And nl.open_line_allocation is untouched, which is the whole reason
		// there are two views.
		expect(sum(after, 'by_date')).toBe(sum(before, 'by_date'));
	});

	it('shows what moved, with the reason', async () => {
		const part = await contendedPart();
		await arrange([
			{
				type: 'fulfilment.allocation_priority',
				scopeKind: 'customer',
				scopeId: part.behind,
				value: 95,
				note: 'arranged by a test'
			}
		]);
		const summary = await allocationSummary(db, PRIYA);
		expect(summary.lines).toBeGreaterThan(0);
		expect(summary.prioritized).toBeGreaterThan(0);
		expect(summary.moved).toBeGreaterThan(0);

		const [move] = await db.asSystem((tx) =>
			tx.sql<{ priority_reason: string; change: number }>`
				select priority_reason, change from nl.allocation_priority_effect
				where customer_no = ${part.behind} order by change desc limit 1`
		);
		expect(move.priority_reason).toContain('because this account has said so');
	});
});

describe('the read-only role', () => {
	it('can read the policies and the dictionary, and answer with them', async () => {
		const rows = await db.asReadonly((tx) =>
			tx.sql<{ types: number; policies: number; fields: number }>`
				select (select count(*) from nl.policy_types)::int as types,
				       (select count(*) from nl.policies)::int as policies,
				       (select count(*) from nl.data_dictionary)::int as fields`
		);
		expect(rows[0].types).toBeGreaterThan(20);
		expect(rows[0].policies).toBeGreaterThan(20);
		expect(rows[0].fields).toBeGreaterThan(100);

		const answered = await db.asReadonly((tx) =>
			tx.sql<{ value: unknown }>`
				select nl.resolve_policy('commercial.min_margin', '{}'::jsonb) -> 'value' as value`
		);
		expect(Number(answered[0].value)).toBe(0.2);
	});

	it('cannot see who set a policy', async () => {
		await expect(db.asReadonly((tx) => tx.sql`select set_by from nl.policies limit 1`)).rejects.toThrow(
			/permission denied/i
		);
		// Which also means it cannot select everything without naming columns.
		await expect(db.asReadonly((tx) => tx.sql`select * from nl.policies limit 1`)).rejects.toThrow(
			/permission denied/i
		);
		// And the editor view, which resolves the name, is not granted at all.
		await expect(db.asReadonly((tx) => tx.sql`select 1 from nl.policy_list limit 1`)).rejects.toThrow(
			/permission denied/i
		);
	});

	it('cannot write a policy, whatever it asks', async () => {
		await expect(
			db.asReadonly((tx) =>
				tx.sql`insert into nl.policies (policy_type, scope_kind, value, effective_from)
				       values ('freight.terms', 'global', '"collect"'::jsonb, '2026-01-01')`
			)
		).rejects.toThrow();
	});
});

describe('resolution is quick enough to sit inside quoting', () => {
	/**
	 * How long one answer takes, measured inside the database over many
	 * contexts in a single statement. A round trip to PGlite costs about
	 * twenty milliseconds on its own, which would drown the thing being
	 * measured if each answer were its own query.
	 */
	async function perAnswer(sql: string, contexts: number): Promise<number> {
		await db.asSystem((tx) => tx.query(sql)); // warm the plans
		const rows = await db.asSystem((tx) => tx.query<{ 'QUERY PLAN': string }>(`explain (analyze) ${sql}`));
		const line = rows.map((row) => row['QUERY PLAN']).find((text) => text.startsWith('Execution Time'));
		return Number((line ?? '0').replace(/[^0-9.]/g, '')) / contexts;
	}

	const CONTEXTS = 200;
	const ACCOUNTS = `(select customer_no from nl.customers order by customer_no limit ${CONTEXTS}) c`;
	const ONE = `select nl.resolve_policy('commercial.min_margin', jsonb_build_object('customer_no', c.customer_no)) from ${ACCOUNTS}`;
	const EIGHT = `select nl.resolve_policies(array['commercial.min_margin','commercial.quote_valid_days','freight.terms','freight.free_over','fulfilment.allocation_priority','commercial.payment_terms','quality.required_documents','fulfilment.split_shipments'], jsonb_build_object('customer_no', c.customer_no)) from ${ACCOUNTS}`;

	it('costs about the same with a few thousand policies as with a few dozen', async () => {
		// As the seed leaves it: a few dozen rows.
		const smallOne = await perAnswer(ONE, CONTEXTS);
		const smallEight = await perAnswer(EIGHT, CONTEXTS);

		// A few thousand rows, spread over the types and the accounts and the
		// parts, so the index is doing the work rather than the table being
		// small enough to read.
		for (const scope of ['customer', 'item']) {
			await db.asSystem((tx) =>
				tx.query(
					`insert into nl.policies (policy_type, scope_kind, scope_id, value, effective_from, note)
					 select t.key, $1, ${scope === 'customer' ? 'c.customer_no' : 'c.item_no'},
					        case t.value_type when 'integer' then to_jsonb(30 + (row_number() over ())::int % 7)
					                          when 'number' then to_jsonb(0.5 + ((row_number() over ())::int % 4) / 100.0)
					                          when 'boolean' then to_jsonb((row_number() over ())::int % 2 = 0)
					                          else to_jsonb(t.allowed[1]) end,
					        date '2026-01-01' + ((row_number() over ())::int % 30),
					        'arranged by a test'
					 from nl.policy_types t
					 cross join ${scope === 'customer' ? 'nl.customers c' : 'nl.items c'}
					 where $1 = any (t.scopes)
					   and t.value_type in ('integer', 'number', 'boolean', 'enum')
					 limit ${scope === 'customer' ? 3000 : 2000}`,
					[scope]
				)
			);
		}
		// What autovacuum would have done by itself on a real database.
		await db.asSystem((tx) => tx.query('analyze nl.policies'));
		const [{ rows: total }] = await db.asSystem((tx) =>
			tx.sql<{ rows: number }>`select count(*)::int as rows from nl.policies`
		);
		expect(total).toBeGreaterThan(3000);

		const bigOne = await perAnswer(ONE, CONTEXTS);
		const bigEight = await perAnswer(EIGHT, CONTEXTS);

		console.log(
			`policy resolution, per answer, measured inside the database:
` +
				`  one policy:    ${smallOne.toFixed(2)} ms at 34 rows, ${bigOne.toFixed(2)} ms at ${total}
` +
				`  eight at once: ${smallEight.toFixed(2)} ms at 34 rows, ${bigEight.toFixed(2)} ms at ${total}
` +
				`  (PGlite, Postgres 17 in WebAssembly, in the test runner's own process)`
		);

		// The assertion that matters: the cost does not follow the size of the
		// table. A resolution that started scanning instead of probing the index
		// went from 3 ms to 60 ms when this was written, and this is what caught
		// it. The bounds are loose because this runs on whatever laptop it runs
		// on, and tight enough to fail if the plan goes back to a scan.
		expect(bigOne).toBeLessThan(smallOne * 4 + 6);
		expect(bigEight).toBeLessThan(smallEight * 4 + 12);
		// And an absolute ceiling, so "slow everywhere" also fails.
		expect(bigOne).toBeLessThan(25);
		expect(bigEight).toBeLessThan(40);
	});

	it('resolves eight policies for less than eight times the cost of one', async () => {
		const one = await perAnswer(ONE, CONTEXTS);
		const eight = await perAnswer(EIGHT, CONTEXTS);
		console.log(`one: ${one.toFixed(2)} ms, eight in one call: ${eight.toFixed(2)} ms`);
		// The context is worked out once and the table is read once for all of
		// them, which is the whole reason nl.resolve_policies() exists.
		expect(eight).toBeLessThan(one * 8);
	});
});
