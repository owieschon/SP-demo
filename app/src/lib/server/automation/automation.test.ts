// Automation rules: compiling, matching, dry runs, real runs, the schedule.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The
// world has commitments and accounts of its own, so each test narrows its
// rule to the fixtures below:
//   * commitments belong to Tess, a test user, and her rules say "owner is me";
//   * the quiet accounts earn far more than any account in the world;
//   * the world's open order lines are removed, so only ours exist.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Rule } from '$lib/automation/catalog';
import { describeRule, renderTemplate } from '$lib/automation/describe';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { compileRule } from './compile.ts';
import { checkCronAccess } from './cron.ts';
import { getRule, listRules, runRule, runScheduled, saveRule, testRule } from './rules.ts';

const ADMIN = 1;
const DANA = 2;
const MARCUS = 3;
const TERRY = 7; // no longer active
const TESS = 90; // test user who owns the test commitments
const LEAVER = 91; // test user who leaves after saving a rule

const RICH = 500_000_000; // more revenue than any account in the world

let db: Db;
let seq = 0;

// Subjects the fixtures create, by name.
const subject: Record<string, string> = {};
const commitmentId: Record<string, number> = {};

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.users (id, email, full_name, title, role) values
			(${TESS}, 'tess.tester@northline.example', 'Tess Tester', 'Account Manager', 'account_manager'),
			(${LEAVER}, 'lee.leaving@northline.example', 'Lee Leaving', 'Account Manager', 'account_manager')`;
		for (const item of ['ZA-1', 'ZA-2']) {
			await tx.sql`insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price, replenishment)
			             values (${item}, 'TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Prod. Order')`;
		}
		await tx.sql`insert into nl.stock (item_no, on_hand, as_of) values ('ZA-1', 4, '2026-09-17'), ('ZA-2', 100, '2026-09-17')`;
		// Only our open lines, from one applied snapshot.
		await tx.sql`delete from nl.open_order_lines`;
	});

	// window_closed_short: two closed short, one kept, one answered.
	commitmentId.short16 = await commitment('2026-06-01', '2026-09-01', 20000, 5000);
	commitmentId.short2 = await commitment('2026-06-01', '2026-09-15', 30000, 0);
	commitmentId.kept = await commitment('2026-06-01', '2026-09-01', 10000, 9600);
	commitmentId.answered = await commitment('2026-06-01', '2026-09-01', 10000, 0);
	await db.asSystem(
		(tx) => tx.sql`insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, note)
		               values (${commitmentId.answered}, 'broken', 'person', ${TESS}, '')`
	);
	subject.short16 = `commitment:${commitmentId.short16}`;
	subject.short2 = `commitment:${commitmentId.short2}`;

	// commitment_behind_pace: one behind, one ahead.
	commitmentId.behind = await commitment('2026-09-01', '2026-10-31', 10000, 0);
	commitmentId.ahead = await commitment('2026-09-01', '2026-10-31', 10000, 6000);
	subject.behind = `commitment:${commitmentId.behind}:behind`;

	// account_gone_quiet: ordered monthly, quiet since May. No owner, a
	// departed owner, and Dana.
	for (const [name, owner] of [
		['quietNone', null],
		['quietTerry', TERRY],
		['quietDana', DANA]
	] as const) {
		const customerNo = await customer(owner);
		// Gaps of 31 and 31 days, last order May 2.
		for (const day of ['2026-03-01', '2026-04-01', '2026-05-02']) {
			await invoice(customerNo, day, 300_000_000);
		}
		subject[name] = `account:${customerNo}:2026-05-02`;
	}

	// order_line_at_risk: at risk (short), past due, and a later line.
	const lineCustomer = await customer(DANA);
	const noOwner = await customer(null);
	await db.asSystem(async (tx) => {
		const [snap] = await tx.sql<{ id: number }>`
			insert into nl.export_snapshots (file_name, content_hash, status, row_count, line_count, error_count,
			                                 total_quantity, total_value, staged_by, decided_by, decided_at)
			values ('test.csv', ${'a'.repeat(64)}, 'applied', 3, 3, 0, 13, 600, 5, 5, now())
			returning id`;
		await tx.sql`insert into nl.open_order_lines (document_no, line_no, customer_no, item_no, ship_date, quantity, unit_price, first_seen_on, last_snapshot_id) values
			('SO-1', 10000, ${lineCustomer}, 'ZA-1', '2026-09-20', 10, 50, '2026-09-01', ${snap.id}),
			('SO-2', 10000, ${noOwner}, 'ZA-2', '2026-09-10', 2, 25, '2026-09-01', ${snap.id}),
			('SO-3', 10000, ${lineCustomer}, 'ZA-2', '2026-12-01', 1, 10, '2026-09-01', ${snap.id})`;
	});
	subject.atRisk = 'line:SO-1:10000:2026-09-20';
	subject.pastDue = 'line:SO-2:10000:2026-09-10';
});

afterAll(async () => {
	await db?.close();
});

async function customer(owner: number | null): Promise<string> {
	seq += 1;
	const customerNo = `AU${seq}`;
	await db.asSystem(
		(tx) => tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
		               values (${customerNo}, ${`Test Account ${seq}`}, 'DEALER', ${owner}, '2020-01-01')`
	);
	return customerNo;
}

async function invoice(customerNo: string, postedOn: string, amount: number, itemNo: string | null = null) {
	seq += 1;
	const invoiceNo = `AU-INV${seq}`;
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
		             values (${invoiceNo}, 'invoice', ${customerNo}, ${customerNo}, ${postedOn}, ${amount})`;
		if (itemNo) {
			await tx.sql`insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
			             values (${invoiceNo}, 1, ${customerNo}, ${postedOn}, ${itemNo}, 1, ${amount}, ${amount}, 10)`;
		}
	});
}

/** A commitment of Tess's on its own account for ZA-1, with `delivered` already invoiced. */
async function commitment(startsOn: string, endsOn: string, value: number, delivered: number): Promise<number> {
	const customerNo = await customer(TESS);
	const id = await db.asSystem(async (tx) => {
		const [row] = await tx.sql<{ id: number }>`
			insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on, confidence, created_by)
			values ('Test chrome program', ${customerNo}, ${TESS}, ${value}, ${startsOn}, ${endsOn}, 60, ${TESS})
			returning id`;
		await tx.sql`insert into nl.commitment_items (commitment_id, item_no) values (${row.id}, 'ZA-1')`;
		return row.id;
	});
	if (delivered > 0) await invoice(customerNo, startsOn, delivered, 'ZA-1');
	return id;
}

const ME = { field: 'owner_id', op: 'eq', value: 'me' } as const;

function rule(overrides: Partial<Rule> = {}): Rule {
	return {
		name: 'Test rule',
		description: '',
		trigger: 'window_closed_short',
		conditions: [ME],
		action: { kind: 'next_step', title: 'Ask {customer} about {commitment}', dueInDays: 2, assignTo: 'record_owner' },
		enabled: false,
		...overrides
	};
}

async function save(userId: number, r: Rule, ruleId: number | null = null, version: string | null = null) {
	return saveRule(db, userId, { ruleId, rule: r, expectedUpdatedAt: version, requestId: randomUUID() });
}

async function rejection(work: Promise<unknown>): Promise<AppError> {
	try {
		await work;
	} catch (error) {
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error('expected a refusal');
}

async function subjects(userId: number, r: Rule, ruleId: number | null = null) {
	const result = await testRule(db, userId, r, ruleId);
	return result.matches.map((m) => m.subjectKey);
}

async function counts() {
	const [row] = await db.asSystem((tx) =>
		tx.sql<Record<string, number>>`
			select (select count(*) from nl.automation_rules)::int as rules,
			       (select count(*) from nl.automation_runs)::int as runs,
			       (select count(*) from nl.automation_firings)::int as firings,
			       (select count(*) from nl.next_steps)::int as steps,
			       (select count(*) from nl.activities)::int as activities,
			       (select count(*) from nl.audit_log)::int as audit,
			       (select count(*) from nl.request_log)::int as requests`
	);
	return row;
}

describe('compiling a rule', () => {
	const options = { ownerId: DANA, ruleId: null, limit: 25 };

	it('uses only catalog columns, fixed operators and bound values', () => {
		const compiled = compileRule(
			rule({
				conditions: [
					{ field: 'committed_value', op: 'gte', value: 12345 },
					{ field: 'owner_id', op: 'neq', value: 'me' }
				]
			}),
			options
		);
		expect(compiled.text).toContain('s.committed_value >= $2::numeric');
		expect(compiled.text).toContain('s.owner_id is distinct from $3::int');
		expect(compiled.text).not.toContain('12345');
		// $1 is the rule id, then the values, then the limit. "me" is the owner.
		expect(compiled.params).toEqual([null, 12345, DANA, 25]);
	});

	it('refuses a field the trigger does not have, or one made up', () => {
		for (const field of ['days_quiet', 'owner_id; drop table nl.users', 'Committed_Value']) {
			const attempt = () =>
				compileRule(rule({ conditions: [{ field, op: 'gte', value: 1 }] }), options);
			expect(attempt, field).toThrow(AppError);
		}
	});

	it('refuses an operator outside the table, or one the type does not allow', () => {
		const like = { conditions: [{ field: 'shortfall', op: 'like', value: 1 }] } as unknown as Partial<Rule>;
		expect(() => compileRule(rule(like), options)).toThrow(AppError);
		// Money has no "is".
		expect(() => compileRule(rule({ conditions: [{ field: 'shortfall', op: 'eq', value: 1 }] }), options)).toThrow(
			/cannot use/
		);
	});

	it('never lets a value become SQL', () => {
		const evil = "0; delete from nl.users; --";
		const bad = { conditions: [{ field: 'shortfall', op: 'gte', value: evil }] } as unknown as Partial<Rule>;
		expect(() => compileRule(rule(bad), options)).toThrow(AppError);
		// "me" is only for people.
		expect(() => compileRule(rule({ conditions: [{ field: 'shortfall', op: 'gte', value: 'me' }] }), options)).toThrow(
			AppError
		);
		// A template placeholder the trigger cannot fill is refused too.
		const action = { kind: 'note', body: 'Quiet for {days_quiet}' } as const;
		expect(() => compileRule(rule({ action }), options)).toThrow(/is not a value/);
	});
});

describe('the four triggers', () => {
	it('window closed short: closed, short and unanswered only', async () => {
		const result = await testRule(db, TESS, rule());
		const keys = result.matches.map((m) => m.subjectKey);
		expect(keys).toEqual([subject.short2, subject.short16]); // biggest shortfall first
		const first = result.matches[0];
		expect(first.values).toEqual({ days_since_close: 2, committed_value: 30000, shortfall: 30000 });
		expect(first.text).toBe(`Ask ${first.customerName} about C-${commitmentId.short2}`);
		expect(first.assigneeName).toBe('Tess Tester');
		const second = result.matches[1];
		expect(second.values.shortfall).toBe(15000);
		expect(result.total).toBe(2);
	});

	it('commitment behind pace: open windows further along in time than in value', async () => {
		const result = await testRule(
			db,
			TESS,
			rule({
				trigger: 'commitment_behind_pace',
				conditions: [ME],
				action: { kind: 'note', body: '{commitment} is {gap_pts} behind with {days_left} to go' }
			})
		);
		expect(result.matches.map((m) => m.subjectKey)).toEqual([subject.behind]);
		// 16 of 61 days gone, nothing delivered.
		expect(result.matches[0].values.gap_pts).toBe(26.2);
		expect(result.matches[0].text).toBe(`C-${commitmentId.behind} is 26.2% behind with 44 days to go`);
	});

	it("account gone quiet: measured against the account's own rhythm", async () => {
		const result = await testRule(
			db,
			DANA,
			rule({
				trigger: 'account_gone_quiet',
				conditions: [{ field: 'revenue_12m', op: 'gte', value: RICH }],
				action: { kind: 'note', body: '{customer} has been quiet {days_quiet}, usually {typical_gap_days}' }
			})
		);
		expect(result.matches.map((m) => m.subjectKey).sort()).toEqual(
			[subject.quietNone, subject.quietTerry, subject.quietDana].sort()
		);
		expect(result.matches[0].values).toEqual({ revenue_12m: 900_000_000, days_quiet: 138, typical_gap_days: 31 });
		expect(result.matches[0].text).toMatch(/has been quiet 138 days, usually 31 days$/);
	});

	it('order line at risk: short soon, or past due', async () => {
		const result = await testRule(
			db,
			DANA,
			rule({
				trigger: 'order_line_at_risk',
				conditions: [],
				action: { kind: 'note', body: '{headline} ships in {days_to_ship}, {short_qty} short, {line_value}' }
			})
		);
		expect(result.matches.map((m) => m.subjectKey)).toEqual([subject.pastDue, subject.atRisk]);
		expect(result.matches[1].values).toEqual({ days_to_ship: 3, short_qty: 6, line_value: 500 });
		expect(result.matches[1].text).toBe('SO-1 line 10000, ZA-1 ships in 3 days, 6 short, $500');
		expect(result.matches[0].values.days_to_ship).toBe(-7);
	});
});

describe('conditions', () => {
	const closed = (op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq', value: number) =>
		rule({ conditions: [ME, { field: 'days_since_close', op, value }] });

	it('filter with each operator', async () => {
		expect(await subjects(TESS, closed('gte', 16))).toEqual([subject.short16]);
		expect(await subjects(TESS, closed('gt', 16))).toEqual([]);
		expect(await subjects(TESS, closed('gt', 15))).toEqual([subject.short16]);
		expect(await subjects(TESS, closed('lte', 2))).toEqual([subject.short2]);
		expect(await subjects(TESS, closed('lt', 2))).toEqual([]);
		expect(await subjects(TESS, closed('eq', 2))).toEqual([subject.short2]);
		const both = rule({
			conditions: [ME, { field: 'shortfall', op: 'lt', value: 20000 }, { field: 'delivered_pct', op: 'gte', value: 25 }]
		});
		expect(await subjects(TESS, both)).toEqual([subject.short16]);
	});

	it('"is not" a person includes records nobody owns', async () => {
		const quiet = (op: 'eq' | 'neq') =>
			rule({
				trigger: 'account_gone_quiet',
				conditions: [
					{ field: 'revenue_12m', op: 'gte', value: RICH },
					{ field: 'owner_id', op, value: 'me' }
				],
				action: { kind: 'note', body: 'Check in with {customer}' }
			});
		expect(await subjects(DANA, quiet('eq'))).toEqual([subject.quietDana]);
		expect((await subjects(DANA, quiet('neq'))).sort()).toEqual([subject.quietNone, subject.quietTerry].sort());
		// A person picked by id works the same way.
		const byId = rule({ conditions: [{ field: 'owner_id', op: 'eq', value: TESS }, { field: 'days_since_close', op: 'eq', value: 16 }] });
		expect(await subjects(DANA, byId)).toEqual([subject.short16]);
	});

	it('"me" is the rule\'s owner, whoever is looking', async () => {
		const saved = await save(TESS, rule({ name: 'Tess closes' }));
		// Someone else tries Tess's saved rule: "me" is Tess.
		expect((await testRule(db, LEAVER, rule(), saved.ruleId)).total).toBe(2);
		// The same rule, unsaved, tried by someone with no commitments: "me" is them.
		expect((await testRule(db, LEAVER, rule())).total).toBe(0);
	});
});

describe('a dry run', () => {
	it('writes nothing at all', async () => {
		const saved = await save(TESS, rule({ name: 'Dry run check' }));
		await runRule(db, TESS, saved.ruleId, 'ui');
		const before = await counts();
		const result = await testRule(db, TESS, rule(), saved.ruleId);
		expect(result.matches.every((m) => m.alreadyFired)).toBe(true);
		expect(result.alreadyFired).toBe(2);
		await testRule(db, DANA, rule({ trigger: 'order_line_at_risk', conditions: [] }));
		expect(await counts()).toEqual(before);
	});

	it('runs in a transaction the database keeps read only', async () => {
		// The same setting testRule uses: any write in it is refused.
		const attempt = db.asUser(TESS, async (tx) => {
			await tx.sql`set transaction read only`;
			await tx.sql`insert into nl.activities (customer_no, kind, body, author_id) values ('AU1', 'note', 'x', ${TESS})`;
		});
		await expect(attempt).rejects.toThrow(/read-only/);
	});

	it('refuses an unknown saved rule', async () => {
		expect((await rejection(testRule(db, TESS, rule(), 999999))).status).toBe(404);
	});
});

describe('running a rule', () => {
	it('fires once per subject; a second run skips them', async () => {
		const saved = await save(TESS, rule({ name: 'Once only' }));
		const first = await runRule(db, TESS, saved.ruleId, 'ui');
		expect(first).toMatchObject({ matched: 2, fired: 2, skipped: 0, error: null });
		const second = await runRule(db, TESS, saved.ruleId, 'ui');
		expect(second).toMatchObject({ matched: 2, fired: 0, skipped: 2, error: null });

		const detail = await getRule(db, DANA, saved.ruleId);
		expect(detail?.firingCount).toBe(2);
		expect(detail?.runs.map((r) => [r.fired, r.skipped])).toEqual([
			[0, 2],
			[2, 0]
		]);
		expect(detail?.runs.every((r) => r.finishedAt !== null && r.runBy === 'Tess Tester')).toBe(true);
		const firing = detail?.firings.find((f) => f.commitmentId === commitmentId.short16);
		expect(firing).toMatchObject({ kind: 'next_step', assigneeName: 'Tess Tester', dueOn: '2026-09-19' });
		expect(firing?.text).toBe(`Ask ${firing?.customerName} about C-${commitmentId.short16}`);

		// The steps really exist, on the commitment, written by Tess.
		const steps = await db.asSystem((tx) =>
			tx.sql<{ commitment_id: number; owner_id: number; created_by: number }>`
				select ns.commitment_id, ns.owner_id, ns.created_by
				from nl.automation_firings f
				join nl.next_steps ns on ns.id = (f.result ->> 'id')::bigint
				where f.rule_id = ${saved.ruleId}
				order by ns.commitment_id`
		);
		expect(steps).toEqual([
			{ commitment_id: commitmentId.short16, owner_id: TESS, created_by: TESS },
			{ commitment_id: commitmentId.short2, owner_id: TESS, created_by: TESS }
		]);
	});

	it('gives a next step to the record owner, or the rule owner when there is none or they left', async () => {
		const saved = await save(
			MARCUS,
			rule({
				name: 'Quiet accounts',
				trigger: 'account_gone_quiet',
				conditions: [{ field: 'revenue_12m', op: 'gte', value: RICH }],
				action: { kind: 'next_step', title: 'Call {customer}', dueInDays: 0, assignTo: 'record_owner' }
			})
		);
		expect((await runRule(db, MARCUS, saved.ruleId, 'ui')).fired).toBe(3);
		const detail = await getRule(db, MARCUS, saved.ruleId);
		const bySubject = Object.fromEntries(detail!.firings.map((f) => [f.subjectKey, f.assigneeName]));
		expect(bySubject).toEqual({
			[subject.quietDana]: 'Dana Whitlock',
			[subject.quietNone]: 'Marcus Bell',
			[subject.quietTerry]: 'Marcus Bell'
		});
		expect(detail!.firings.every((f) => f.dueOn === '2026-09-17' && f.commitmentId === null)).toBe(true);
	});

	it('gives every next step to the rule owner when the rule says so', async () => {
		const saved = await save(
			ADMIN,
			rule({
				name: 'Lines to me',
				trigger: 'order_line_at_risk',
				conditions: [],
				action: { kind: 'next_step', title: 'Chase {headline}', dueInDays: 1, assignTo: 'rule_owner' }
			})
		);
		expect((await runRule(db, ADMIN, saved.ruleId, 'ui')).fired).toBe(2);
		const detail = await getRule(db, ADMIN, saved.ruleId);
		expect(detail!.firings.map((f) => f.assigneeName)).toEqual(['Elena Brooks', 'Elena Brooks']);
	});

	it('writes a note as an automation, with firings and audit rows', async () => {
		const saved = await save(
			TESS,
			rule({ name: 'Note behind', trigger: 'commitment_behind_pace', action: { kind: 'note', body: '{commitment} is behind' } })
		);
		const run = await runRule(db, TESS, saved.ruleId, 'ui');
		expect(run).toMatchObject({ matched: 1, fired: 1, skipped: 0 });

		const notes = await db.asSystem((tx) =>
			tx.sql<{ body: string; via: string; author_id: number; kind: string }>`
				select body, via, author_id, kind from nl.activities where commitment_id = ${commitmentId.behind}`
		);
		expect(notes).toEqual([{ body: `C-${commitmentId.behind} is behind`, via: 'automation', author_id: TESS, kind: 'note' }]);

		const [firing] = await db.asSystem((tx) =>
			tx.sql<{ run_id: number; subject_key: string; kind: string }>`
				select run_id, subject_key, result ->> 'kind' as kind from nl.automation_firings where rule_id = ${saved.ruleId}`
		);
		expect(firing).toEqual({ run_id: run.runId, subject_key: subject.behind, kind: 'note' });

		const audit = await db.asSystem((tx) =>
			tx.sql<{ action: string; via: string; actor_id: number }>`
				select action, via, actor_id from nl.audit_log
				where entity = 'automation_rule' and entity_id = ${String(saved.ruleId)} order by id`
		);
		expect(audit).toEqual([
			{ action: 'create_rule', via: 'ui', actor_id: TESS },
			{ action: 'fire_note', via: 'automation', actor_id: TESS }
		]);
	});

	it('records a rule that no longer fits the catalog as a failed run, and writes nothing', async () => {
		const saved = await save(TESS, rule({ name: 'Broken later' }));
		// Someone changes the stored rule behind the app's back.
		await db.asSystem(
			(tx) => tx.sql`update nl.automation_rules
			               set conditions = '[{"field": "1=1 or owner_id", "op": "gte", "value": 0}]'
			               where id = ${saved.ruleId}`
		);
		const before = await counts();
		const run = await runRule(db, TESS, saved.ruleId, 'ui');
		expect(run.fired).toBe(0);
		expect(run.error).toMatch(/does not fit the catalog/);
		const after = await counts();
		expect(after.firings).toBe(before.firings);
		expect(after.steps).toBe(before.steps);
		expect((await getRule(db, TESS, saved.ruleId))?.runs[0].error).toMatch(/does not fit/);
	});
});

describe('who may do what', () => {
	it('lets only the owner or an admin change or run a rule', async () => {
		const saved = await save(TESS, rule({ name: 'Tess only' }));
		const version = saved.updatedAt;
		expect((await rejection(save(DANA, rule({ name: 'Taken' }), saved.ruleId, version))).status).toBe(403);
		expect((await rejection(runRule(db, DANA, saved.ruleId, 'ui'))).status).toBe(403);

		// An admin may do both; the owner stays Tess.
		const changed = await save(ADMIN, rule({ name: 'Renamed by admin' }), saved.ruleId, version);
		expect((await runRule(db, ADMIN, saved.ruleId, 'ui')).error).toBeNull();
		const detail = await getRule(db, DANA, saved.ruleId);
		expect(detail).toMatchObject({ ownerId: TESS, canEdit: false, updatedAt: changed.updatedAt });
		expect(detail?.rule.name).toBe('Renamed by admin');
		expect((await getRule(db, ADMIN, saved.ruleId))?.canEdit).toBe(true);
	});

	it('refuses a save over a newer version (409), and replays a repeated request', async () => {
		const saved = await save(TESS, rule({ name: 'Versioned' }));
		const requestId = randomUUID();
		const input = { ruleId: saved.ruleId, rule: rule({ name: 'Versioned 2' }), expectedUpdatedAt: saved.updatedAt, requestId };
		const changed = await saveRule(db, TESS, input);
		expect(changed.replayed).toBe(false);
		// The same request again: the first answer, no second write.
		expect(await saveRule(db, TESS, input)).toMatchObject({ replayed: true, ruleId: saved.ruleId });
		// A new request from a page that still has the old version.
		const stale = await rejection(save(TESS, rule({ name: 'Versioned 3' }), saved.ruleId, saved.updatedAt));
		expect(stale.status).toBe(409);
	});

	it('checks the rule on save', async () => {
		const bad = rule({ conditions: [{ field: 'days_quiet', op: 'gte', value: 1 }] });
		expect((await rejection(save(TESS, bad))).status).toBe(422);
		// A change without the version it was loaded at.
		expect((await rejection(save(TESS, rule(), 101, null))).status).toBe(422);
	});

	it('lets the fire function take the action from the stored rule only', async () => {
		const saved = await save(TESS, rule({ name: 'Stored note', action: { kind: 'note', body: 'Stored note text' } }));
		const steps = (await counts()).steps;
		await db.asUser(TESS, async (tx) => {
			const [run] = await tx.sql<{ id: number }>`select nl.start_automation_run(${saved.ruleId}, 'ui') as id`;
			// Arguments shaped like a next step still make a note.
			const [fired] = await tx.sql<{ outcome: string }>`
				select nl.fire_automation(${run.id}, 'custom:1', 'AU1', null::bigint, ${DANA}, 'Pretend step', '2026-09-20'::date) as outcome`;
			expect(fired.outcome).toBe('fired');
		});
		expect((await counts()).steps).toBe(steps);
		const [note] = await db.asSystem((tx) =>
			tx.sql<{ body: string }>`select body from nl.activities where body = 'Pretend step'`
		);
		expect(note.body).toBe('Pretend step');
		// There is no way to name a kind.
		const withKind = db.asUser(TESS, (tx) =>
			tx.sql`select nl.fire_automation(1, 'x', 'AU1', null::bigint, 2, 'y', null::date, 'next_step')`
		);
		await expect(withKind).rejects.toThrow(/does not exist/);
	});

	it("does not let anyone fire into someone else's run", async () => {
		const saved = await save(TESS, rule({ name: 'Run owner' }));
		const runId = await db.asUser(TESS, async (tx) => {
			const [run] = await tx.sql<{ id: number }>`select nl.start_automation_run(${saved.ruleId}, 'ui') as id`;
			return run.id;
		});
		const attempt = db.asUser(ADMIN, (tx) =>
			tx.sql`select nl.fire_automation(${runId}, 'x', 'AU1', null::bigint, 1, 'Sneaky', null::date)`
		);
		await expect(attempt).rejects.toMatchObject({ code: 'NL403' });
	});
});

describe('the schedule', () => {
	it('refuses to run a switched-off rule on schedule', async () => {
		const saved = await save(TESS, rule({ name: 'Off', enabled: false }));
		const refusal = await rejection(runRule(db, TESS, saved.ruleId, 'schedule'));
		expect(refusal.status).toBe(422);
	});

	it('runs every switched-on rule as its owner; a leaver or a broken rule stops nothing', async () => {
		const good = await save(TESS, rule({ name: 'Scheduled good', enabled: true }));
		const off = await save(TESS, rule({ name: 'Scheduled off', enabled: false }));
		const leaver = await save(LEAVER, rule({ name: 'Scheduled leaver', enabled: true, conditions: [] }));
		const broken = await save(TESS, rule({ name: 'Scheduled broken', enabled: true }));
		await db.asSystem(async (tx) => {
			await tx.sql`update nl.users set active = false where id = ${LEAVER}`;
			await tx.sql`update nl.automation_rules set action = '{"kind": "note"}' where id = ${broken.ruleId}`;
		});

		const summary = await runScheduled(db);
		const byId = new Map(summary.results.map((r) => [r.ruleId, r]));
		expect(byId.has(off.ruleId)).toBe(false);
		expect(byId.get(good.ruleId)).toMatchObject({ ownerId: TESS, matched: 2, fired: 2, error: null });
		expect(byId.get(leaver.ruleId)?.error).toMatch(/Lee Leaving is no longer active/);
		expect(byId.get(broken.ruleId)?.error).toMatch(/does not fit the catalog/);
		expect(summary.failed).toBeGreaterThanOrEqual(2);

		// Both failures are on record, and the schedule wrote nothing for the leaver.
		expect((await getRule(db, ADMIN, leaver.ruleId))?.runs).toMatchObject([
			{ via: 'schedule', fired: 0, runBy: 'Lee Leaving' }
		]);
		expect((await getRule(db, ADMIN, good.ruleId))?.runs[0]).toMatchObject({ via: 'schedule', fired: 2 });
	});

	it('only answers a caller with the secret', () => {
		expect(checkCronAccess('Bearer s3cret-value', 's3cret-value')).toBe('ok');
		expect(checkCronAccess('Bearer wrong', 's3cret-value')).toBe('denied');
		expect(checkCronAccess(null, 's3cret-value')).toBe('denied');
		expect(checkCronAccess('s3cret-value', 's3cret-value')).toBe('denied');
		expect(checkCronAccess('Bearer ', '')).toBe('not_configured');
		expect(checkCronAccess('Bearer x', undefined)).toBe('not_configured');
	});
});

describe('reading rules', () => {
	it('lists rules as sentences with their last run', async () => {
		const saved = await save(
			DANA,
			rule({
				name: 'Listed rule',
				conditions: [
					{ field: 'committed_value', op: 'gte', value: 10000 },
					{ field: 'days_since_close', op: 'gte', value: 3 },
					{ field: 'owner_id', op: 'eq', value: 'me' }
				]
			})
		);
		await runRule(db, DANA, saved.ruleId, 'ui');
		const rules = await listRules(db, MARCUS);
		const listed = rules.find((r) => r.id === saved.ruleId);
		expect(listed).toMatchObject({
			ownerName: 'Dana Whitlock',
			canEdit: false,
			triggerLabel: 'A commitment window closed short',
			lastRun: { via: 'ui', error: null }
		});
		expect(listed?.sentence).toBe(
			'When a commitment window closed short, if committed value is at least $10,000, days since the window closed ' +
				'is at least 3 days and owner is Dana Whitlock, add a next step for the record owner, due in 2 days: ' +
				'"Ask {customer} about {commitment}".'
		);
	});

	it('formats template values by type', () => {
		const row = { customer_name: 'Test Fleet', commitment_id: null, headline: 'H', shortfall: 1234.5, delivered_pct: 40, days_since_close: 1 };
		expect(renderTemplate('window_closed_short', '{customer} {commitment} {shortfall} {delivered_pct} {days_since_close}', row)).toBe(
			'Test Fleet $1,235 40% 1 day'
		);
		expect(
			describeRule(rule({ conditions: [], action: { kind: 'note', body: 'Hi' } }), () => '')
		).toBe('When a commitment window closed short, add a note to the account: "Hi".');
	});
});
