// Workflow A: commitments that measure themselves.
//
// Each test builds its own commitment on its own customer family (a head
// office and a branch that bills to it), so no test's invoices count toward
// another's. "Today" is pinned to 2026-09-17.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from './db/pglite.ts';
import type { Db } from './db/types.ts';
import { getCommitment, listBoard, recordOutcome, setConfidence, type RecordOutcomeInput } from './commitments.ts';

const ADMIN = 1;
const DANA = 2;
const MARCUS = 3;
const TERRY = 7; // no longer active

let db: Db;
let familySeq = 0;
let invoiceSeq = 0;

beforeAll(async () => {
	db = await createTestDb();
	await db.asSystem(async (tx) => {
		for (const item of ['ZT-100', 'ZT-200', 'ZT-300']) {
			await tx.sql`insert into nl.items (item_no, description, category, family, product_group, unit_cost, list_price, replenishment)
			             values (${item}, 'TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Prod. Order')`;
		}
		await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
		             values ('T-OTHER', 'Unrelated Test Shop', 'DEALER', ${DANA}, '2020-01-01')`;
	});
});

afterAll(async () => {
	await db?.close();
});

interface Fixture {
	id: number;
	hq: string;
	branch: string;
}

/** A head office, a branch billed to it, and a commitment on the head office for ZT-100 and ZT-200. */
async function commitment(options: {
	value: number;
	startsOn: string;
	endsOn: string;
	owner?: number;
	confidence?: number;
}): Promise<Fixture> {
	familySeq += 1;
	const hq = `T${familySeq}-HQ`;
	const branch = `T${familySeq}-BR`;
	const owner = options.owner ?? DANA;
	const id = await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since)
		             values (${hq}, 'Test Fleet', 'DEALER', ${owner}, '2020-01-01')`;
		await tx.sql`insert into nl.customers (customer_no, name, bill_to_no, price_group, owner_id, customer_since)
		             values (${branch}, 'Test Fleet Branch', ${hq}, 'DEALER', ${owner}, '2020-01-01')`;
		const [row] = await tx.sql<{ id: number }>`
			insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on, confidence, created_by)
			values ('Test commitment', ${hq}, ${owner}, ${options.value}, ${options.startsOn}, ${options.endsOn},
			        ${options.confidence ?? 50}, ${owner})
			returning id`;
		await tx.sql`insert into nl.commitment_items (commitment_id, item_no)
		             values (${row.id}, 'ZT-100'), (${row.id}, 'ZT-200')`;
		return row.id;
	});
	return { id, hq, branch };
}

/** One invoice (a credit memo when the amount is negative) with one line. */
async function invoice(customerNo: string, postedOn: string, itemNo: string, amount: number) {
	invoiceSeq += 1;
	const invoiceNo = `T${invoiceSeq}`;
	await db.asSystem(async (tx) => {
		const [c] = await tx.sql<{ bill_to: string }>`
			select coalesce(bill_to_no, customer_no) as bill_to from nl.customers where customer_no = ${customerNo}`;
		await tx.sql`insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
		             values (${invoiceNo}, ${amount < 0 ? 'credit_memo' : 'invoice'}, ${customerNo}, ${c.bill_to},
		                     ${postedOn}, ${amount})`;
		await tx.sql`insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no,
		                                           quantity, unit_price, amount, unit_cost)
		             values (${invoiceNo}, 1, ${customerNo}, ${postedOn}, ${itemNo},
		                     ${Math.sign(amount)}, ${Math.abs(amount)}, ${amount}, 10)`;
	});
}

async function quote(customerNo: string, quotedOn: string, itemNo: string, commitmentId: number | null = null) {
	await db.asSystem(async (tx) => {
		const [q] = await tx.sql<{ id: number }>`
			insert into nl.quotes (customer_no, commitment_id, quoted_on, created_by)
			values (${customerNo}, ${commitmentId}, ${quotedOn}, ${DANA}) returning id`;
		await tx.sql`insert into nl.quote_lines (quote_id, line_no, item_no, quantity, unit_price)
		             values (${q.id}, 1, ${itemNo}, 5, 30)`;
	});
}

async function progress(id: number) {
	const [row] = await db.asUser(DANA, (tx) =>
		tx.sql<{
			status: string;
			delivered: number;
			expected_value: number;
			needs_outcome: boolean;
			kept_by_measure: boolean;
			updated_at: Date;
		}>`select status, delivered, expected_value, needs_outcome, kept_by_measure, updated_at
		   from nl.commitment_progress where id = ${id}`
	);
	return { ...row, version: row.updated_at.toISOString() };
}

async function outcomes(id: number) {
	return db.asSystem((tx) =>
		tx.sql<{ outcome: string; source: string; answered_by: number | null }>`
			select outcome, source, answered_by from nl.commitment_outcomes where commitment_id = ${id} order by id`
	);
}

async function answerNightly() {
	const [row] = await db.asSystem((tx) =>
		tx.sql<{ result: { answered_pushed: number[] } }>`select nl.answer_pushed_windows() as result`
	);
	return row.result.answered_pushed;
}

describe('status is derived', () => {
	it('is promised with nothing quoted and nothing delivered', async () => {
		const c = await commitment({ value: 1000, startsOn: '2026-09-01', endsOn: '2026-12-31' });
		expect((await progress(c.id)).status).toBe('promised');
	});

	it('is quoted once a quote is written for it', async () => {
		const c = await commitment({ value: 1000, startsOn: '2026-09-01', endsOn: '2026-12-31' });
		await quote(c.hq, '2026-09-10', 'ZT-100', c.id);
		expect((await progress(c.id)).status).toBe('quoted');
	});

	it('is delivering once a matching line lands, even at a branch', async () => {
		const c = await commitment({ value: 1000, startsOn: '2026-06-01', endsOn: '2026-12-31' });
		await quote(c.hq, '2026-06-02', 'ZT-100', c.id);
		await invoice(c.branch, '2026-07-01', 'ZT-100', 200);
		const p = await progress(c.id);
		expect(p.status).toBe('delivering');
		expect(p.delivered).toBe(200);
	});

	it('is kept once delivery reaches 95% of the committed value, even before the window closes', async () => {
		const c = await commitment({ value: 10000, startsOn: '2026-08-01', endsOn: '2026-12-31' });
		await invoice(c.hq, '2026-08-02', 'ZT-100', 9000);
		await invoice(c.hq, '2026-08-03', 'ZT-200', 499);
		expect((await progress(c.id)).status).toBe('delivering'); // 94.99%
		await invoice(c.hq, '2026-08-04', 'ZT-200', 1);
		const p = await progress(c.id);
		expect(p.status).toBe('kept'); // exactly 95%
		expect(p.kept_by_measure).toBe(true);
		expect(p.expected_value).toBe(9500);
	});
});

describe('delivery is measured from the ledger', () => {
	it('counts scope items in the window for the customer family, net of returns, and nothing else', async () => {
		const c = await commitment({ value: 100000, startsOn: '2026-03-01', endsOn: '2026-03-31' });
		await invoice(c.hq, '2026-03-01', 'ZT-100', 100); // counts: first day
		await invoice(c.branch, '2026-03-31', 'ZT-200', 50); // counts: branch, last day
		await invoice(c.hq, '2026-02-28', 'ZT-100', 1000); // before the window
		await invoice(c.hq, '2026-04-01', 'ZT-100', 1000); // after the window
		await invoice(c.hq, '2026-03-15', 'ZT-300', 1000); // not in scope
		await invoice('T-OTHER', '2026-03-15', 'ZT-100', 1000); // someone else
		await invoice(c.hq, '2026-03-20', 'ZT-100', -30); // a return
		expect((await progress(c.id)).delivered).toBe(120);

		const detail = await getCommitment(db, DANA, c.id);
		expect(detail?.lines.map((l) => l.amount)).toEqual([100, -30, 50]);
		expect(detail?.lines.map((l) => l.runningDelivered)).toEqual([100, 70, 120]);
		expect(detail?.lines.find((l) => l.customerNo === c.branch)?.viaFamily).toBe(true);
		expect(detail?.items.find((i) => i.itemNo === 'ZT-100')?.delivered).toBe(70);
	});

	it('counts accounts billed to a branch, and stops at a billing loop', async () => {
		const c = await commitment({ value: 100000, startsOn: '2026-05-01', endsOn: '2026-05-31' });
		const grandchild = `${c.branch}-G`;
		await db.asSystem(async (tx) => {
			await tx.sql`insert into nl.customers (customer_no, name, bill_to_no, price_group, owner_id, customer_since)
			             values (${grandchild}, 'Test Fleet Yard', ${c.branch}, 'DEALER', ${DANA}, '2020-01-01')`;
		});
		await invoice(grandchild, '2026-05-10', 'ZT-100', 40);
		expect((await progress(c.id)).delivered).toBe(40);

		// Bad data: the head office now bills to its own grandchild. The walk
		// must still end, and still count each account once.
		await db.asSystem((tx) => tx.sql`update nl.customers set bill_to_no = ${grandchild} where customer_no = ${c.hq}`);
		await invoice(c.hq, '2026-05-11', 'ZT-100', 5);
		expect((await progress(c.id)).delivered).toBe(45);
		const family = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; depth: number }>`
				select customer_no, depth from nl.commitment_family where commitment_id = ${c.id} order by depth`
		);
		expect(family).toEqual([
			{ customer_no: c.hq, depth: 0 },
			{ customer_no: c.branch, depth: 1 },
			{ customer_no: grandchild, depth: 2 }
		]);
	});

	it('flags a window that closed short with nobody having answered', async () => {
		const c = await commitment({ value: 5000, startsOn: '2026-05-01', endsOn: '2026-08-31' });
		await invoice(c.hq, '2026-05-10', 'ZT-100', 1000);
		const p = await progress(c.id);
		expect(p.needs_outcome).toBe(true);
		expect(p.status).toBe('delivering');
		const board = await listBoard(db, DANA, DANA);
		expect(board.cards.find((card) => card.id === c.id)?.needsOutcome).toBe(true);
	});
});

describe('expected value', () => {
	it('is delivered plus confidence times what remains', async () => {
		const c = await commitment({ value: 10000, startsOn: '2026-09-01', endsOn: '2026-12-31', confidence: 70 });
		await invoice(c.hq, '2026-09-05', 'ZT-100', 2000);
		expect((await progress(c.id)).expected_value).toBe(2000 + 0.7 * 8000);
	});
});

describe('recording an outcome', () => {
	async function closedShort(owner = DANA) {
		const c = await commitment({ value: 5000, startsOn: '2026-05-01', endsOn: '2026-08-31', owner });
		return { ...c, version: (await progress(c.id)).version };
	}

	function answer(c: { id: number; version: string }, outcome: RecordOutcomeInput['outcome'], requestId = randomUUID()) {
		return { commitmentId: c.id, outcome, note: '', expectedUpdatedAt: c.version, requestId };
	}

	it('lets the owner answer, and the answer settles the commitment', async () => {
		const c = await closedShort();
		const result = await recordOutcome(db, DANA, { ...answer(c, 'broken'), note: 'Lost on price' });
		expect(result.replayed).toBe(false);
		const p = await progress(c.id);
		expect(p.status).toBe('broken');
		expect(p.needs_outcome).toBe(false);
		expect(p.expected_value).toBe(0);
		expect(await outcomes(c.id)).toEqual([{ outcome: 'broken', source: 'person', answered_by: DANA }]);
	});

	it('refuses another account manager', async () => {
		const c = await closedShort();
		await expect(recordOutcome(db, MARCUS, answer(c, 'kept'))).rejects.toMatchObject({ status: 403 });
		expect(await outcomes(c.id)).toEqual([]);
	});

	it("lets an admin answer on the owner's behalf, in the admin's name", async () => {
		const c = await closedShort();
		await recordOutcome(db, ADMIN, answer(c, 'kept'));
		expect(await outcomes(c.id)).toEqual([{ outcome: 'kept', source: 'person', answered_by: ADMIN }]);
		expect((await progress(c.id)).status).toBe('kept');
	});

	it('refuses a user who is no longer active, even for their own commitment', async () => {
		const c = await closedShort(TERRY);
		await expect(recordOutcome(db, TERRY, answer(c, 'kept'))).rejects.toMatchObject({ status: 401 });
	});

	it('refuses while the window is still open', async () => {
		const c = await commitment({ value: 5000, startsOn: '2026-09-01', endsOn: '2026-12-31' });
		const version = (await progress(c.id)).version;
		await expect(recordOutcome(db, DANA, answer({ id: c.id, version }, 'pushed'))).rejects.toMatchObject({
			status: 422
		});
	});

	it('refuses when the ledger already says kept', async () => {
		const c = await commitment({ value: 100, startsOn: '2026-05-01', endsOn: '2026-08-31' });
		await invoice(c.hq, '2026-05-02', 'ZT-100', 100);
		const version = (await progress(c.id)).version;
		await expect(recordOutcome(db, DANA, answer({ id: c.id, version }, 'broken'))).rejects.toMatchObject({
			status: 422
		});
	});

	it('refuses an answer made from a stale page', async () => {
		const c = await closedShort();
		await recordOutcome(db, DANA, answer(c, 'pushed'));
		await expect(recordOutcome(db, DANA, answer(c, 'broken'))).rejects.toMatchObject({ status: 409 });
		expect((await outcomes(c.id)).map((o) => o.outcome)).toEqual(['pushed']);
	});

	it('writes once when the same request arrives twice', async () => {
		const c = await closedShort();
		const input = answer(c, 'pushed');
		const first = await recordOutcome(db, DANA, input);
		const second = await recordOutcome(db, DANA, input);
		expect(first.replayed).toBe(false);
		expect(second.replayed).toBe(true);
		expect(second.updatedAt).toBe(first.updatedAt);
		expect(await outcomes(c.id)).toHaveLength(1);
		const [audit] = await db.asSystem((tx) =>
			tx.sql<{ n: number }>`select count(*)::int as n from nl.audit_log
			                      where entity = 'commitment' and entity_id = ${String(c.id)}`
		);
		expect(audit.n).toBe(1);
	});

	it("does not let another user reuse someone else's request id", async () => {
		const c = await closedShort();
		const requestId = randomUUID();
		await recordOutcome(db, DANA, answer(c, 'pushed', requestId));
		await expect(recordOutcome(db, ADMIN, answer(c, 'pushed', requestId))).rejects.toMatchObject({ status: 409 });
		expect(await outcomes(c.id)).toHaveLength(1);
	});
});

describe('changing confidence', () => {
	it('changes expected value and moves the row version', async () => {
		const c = await commitment({ value: 10000, startsOn: '2026-09-01', endsOn: '2026-12-31', confidence: 50 });
		const before = await progress(c.id);
		const result = await setConfidence(db, DANA, {
			commitmentId: c.id,
			confidence: 90,
			expectedUpdatedAt: before.version,
			requestId: randomUUID()
		});
		const after = await progress(c.id);
		expect(after.expected_value).toBe(9000);
		expect(after.version).not.toBe(before.version);
		expect(new Date(result.updatedAt).getTime()).toBe(new Date(after.version).getTime());
	});

	it('is refused for someone who does not own the commitment', async () => {
		const c = await commitment({ value: 10000, startsOn: '2026-09-01', endsOn: '2026-12-31' });
		const attempt = setConfidence(db, MARCUS, {
			commitmentId: c.id,
			confidence: 10,
			expectedUpdatedAt: (await progress(c.id)).version,
			requestId: randomUUID()
		});
		await expect(attempt).rejects.toMatchObject({ status: 403 });
	});

	it('is refused on a settled commitment', async () => {
		const c = await commitment({ value: 100, startsOn: '2026-09-01', endsOn: '2026-12-31' });
		await invoice(c.hq, '2026-09-02', 'ZT-200', 100);
		const attempt = setConfidence(db, DANA, {
			commitmentId: c.id,
			confidence: 10,
			expectedUpdatedAt: (await progress(c.id)).version,
			requestId: randomUUID()
		});
		await expect(attempt).rejects.toMatchObject({ status: 422 });
	});
});

describe('the nightly job', () => {
	it('answers "pushed" only with a later quote for the same parts', async () => {
		const withEvidence = await commitment({ value: 5000, startsOn: '2026-05-01', endsOn: '2026-07-31' });
		const otherParts = await commitment({ value: 5000, startsOn: '2026-05-01', endsOn: '2026-07-31' });
		const quotedTooEarly = await commitment({ value: 5000, startsOn: '2026-05-01', endsOn: '2026-07-31' });

		await quote(withEvidence.branch, '2026-08-15', 'ZT-100'); // after the window, a part in scope
		await quote(otherParts.hq, '2026-08-15', 'ZT-300'); // after the window, a part not in scope
		await quote(quotedTooEarly.hq, '2026-07-15', 'ZT-100'); // a part in scope, but inside the window

		const answered = await answerNightly();
		expect(answered).toContain(withEvidence.id);
		expect(answered).not.toContain(otherParts.id);
		expect(answered).not.toContain(quotedTooEarly.id);
		expect(await outcomes(withEvidence.id)).toEqual([{ outcome: 'pushed', source: 'nightly', answered_by: null }]);
		expect((await progress(withEvidence.id)).status).toBe('pushed');
		expect((await progress(otherParts.id)).needs_outcome).toBe(true);

		// A second run changes nothing: the question has been answered.
		expect(await answerNightly()).not.toContain(withEvidence.id);
	});

	it('can never answer "broken", not even by hand', async () => {
		const c = await commitment({ value: 5000, startsOn: '2026-05-01', endsOn: '2026-07-31' });
		await expect(
			db.asSystem((tx) =>
				tx.sql`insert into nl.commitment_outcomes (commitment_id, outcome, source, evidence)
				       values (${c.id}, 'broken', 'nightly', '{}')`
			)
		).rejects.toThrow(/outcomes_nightly_pushed_with_evidence/);
	});
});

describe('the stored delivered figure (migration 0008)', () => {
	async function drift() {
		return db.asSystem((tx) =>
			tx.sql<{ commitment_id: number }>`select commitment_id from nl.delivery_drift()`
		);
	}

	it('follows a line being corrected and removed', async () => {
		const c = await commitment({ value: 100000, startsOn: '2026-04-01', endsOn: '2026-04-30' });
		await invoice(c.branch, '2026-04-10', 'ZT-100', 300);
		expect((await progress(c.id)).delivered).toBe(300);
		const invoiceNo = `T${invoiceSeq}`;

		await db.asSystem((tx) => tx.sql`update nl.invoice_lines set amount = 250 where invoice_no = ${invoiceNo}`);
		expect((await progress(c.id)).delivered).toBe(250);

		// Deleting the invoice deletes its lines (on delete cascade).
		await db.asSystem((tx) => tx.sql`delete from nl.invoices where invoice_no = ${invoiceNo}`);
		expect((await progress(c.id)).delivered).toBe(0);
	});

	it('follows the scope and the window', async () => {
		const c = await commitment({ value: 100000, startsOn: '2026-04-01', endsOn: '2026-04-30' });
		await invoice(c.hq, '2026-04-10', 'ZT-300', 70); // not in scope yet
		await invoice(c.hq, '2026-05-10', 'ZT-100', 20); // after the window
		expect((await progress(c.id)).delivered).toBe(0);

		await db.asSystem((tx) => tx.sql`insert into nl.commitment_items (commitment_id, item_no) values (${c.id}, 'ZT-300')`);
		expect((await progress(c.id)).delivered).toBe(70);

		await db.asSystem((tx) => tx.sql`update nl.commitments set ends_on = '2026-05-31' where id = ${c.id}`);
		expect((await progress(c.id)).delivered).toBe(90);

		await db.asSystem(
			(tx) => tx.sql`delete from nl.commitment_items where commitment_id = ${c.id} and item_no = 'ZT-300'`
		);
		expect((await progress(c.id)).delivered).toBe(20);
	});

	it('follows an account moving to another family', async () => {
		const a = await commitment({ value: 100000, startsOn: '2026-04-01', endsOn: '2026-04-30' });
		const b = await commitment({ value: 100000, startsOn: '2026-04-01', endsOn: '2026-04-30' });
		await invoice(a.branch, '2026-04-10', 'ZT-100', 400);
		expect((await progress(a.id)).delivered).toBe(400);

		await db.asSystem((tx) => tx.sql`update nl.customers set bill_to_no = ${b.hq} where customer_no = ${a.branch}`);
		expect((await progress(a.id)).delivered).toBe(0);
		expect((await progress(b.id)).delivered).toBe(400);
	});

	it('matches a fresh count for every commitment, including the whole seeded world', async () => {
		const [{ n }] = await db.asSystem((tx) => tx.sql<{ n: number }>`select count(*) as n from nl.commitments`);
		expect(n).toBeGreaterThan(30);
		expect(await drift()).toEqual([]);
	});

	it('can be repaired by the nightly job if something ever writes around the triggers', async () => {
		const c = await commitment({ value: 100000, startsOn: '2026-04-01', endsOn: '2026-04-30' });
		await invoice(c.hq, '2026-04-10', 'ZT-100', 60);
		await db.asSystem((tx) => tx.sql`update nl.commitment_delivery set delivered = 1 where commitment_id = ${c.id}`);
		expect((await drift()).map((d) => d.commitment_id)).toEqual([c.id]);

		const [row] = await db.asSystem((tx) => tx.sql<{ result: { repaired: number[] } }>`select nl.repair_delivery() as result`);
		expect(row.result.repaired).toEqual([c.id]);
		expect(await drift()).toEqual([]);
	});

	it('cannot be written by a signed-in user', async () => {
		const c = await commitment({ value: 100000, startsOn: '2026-04-01', endsOn: '2026-04-30' });
		await expect(
			db.asUser(DANA, (tx) => tx.sql`update nl.commitment_delivery set delivered = 99999 where commitment_id = ${c.id}`)
		).rejects.toThrow(/permission denied/);
		await expect(
			db.asUser(DANA, (tx) => tx.sql`select nl.measure_commitments(array[${c.id}::bigint])`)
		).rejects.toThrow(/permission denied/);
	});
});
