/*
  The overview: every figure against a direct query of the same thing, every
  link against a route that exists and a filter that page really reads, and
  the drift check behind the stored month roll-up.

  The shape of this file follows the one rule the page is built to. A figure
  that cannot be reproduced by asking the database the same question a second
  way is a figure nobody should believe, so each test here asks it the other
  way and compares. The link tests do the same for addresses: an href is only
  a link if the route exists and the query string is one the target reads.

  One small world for the whole file, "today" pinned to 2026-09-17.
*/
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { readFilters as readAccountFilters } from '../accounts/list.ts';
import { readFilters as readForecastFilters } from '../supply/forecast.ts';
import { readBoard } from '../harness/ladder.ts';
import { QUEUE_SOURCES } from '$lib/workspace/types';
import { OPEN, readDisclosure } from './disclosure.ts';
import { links } from './links.ts';
import { isLeak, readLeak, readMoney, readRevenue } from './money.ts';
import { readPromiseDetail, readPromises } from './promises.ts';
import { readAgents, readRunFeed } from './agents.ts';
import { readLateSupply, readRisk } from './risk.ts';
import type { Figure } from './types.ts';

const ADMIN = 1;

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

// ---------------------------------------------------------------------------
// The stored month roll-up (migration 0034)
// ---------------------------------------------------------------------------

describe('nl.ledger_month', () => {
	it('agrees with a fresh count of the ledger', async () => {
		const drift = await db.asSystem((tx) => tx.sql`select * from nl.ledger_month_drift()`);
		expect(drift).toEqual([]);
	});

	it('stores the same revenue and cost as a direct group by', async () => {
		const rows = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ month: string; stored: number; measured: number; stored_cost: number; measured_cost: number }>`
				select m.month::text as month,
				       m.revenue as stored,
				       d.revenue as measured,
				       m.cost_of_goods as stored_cost,
				       d.cost as measured_cost
				from nl.ledger_month m
				join (
				  select date_trunc('month', posted_on)::date as month,
				         sum(amount) as revenue,
				         sum(quantity * unit_cost) as cost
				  from nl.invoice_lines group by 1
				) d on d.month = m.month`
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(Number(row.stored)).toBe(Number(row.measured));
			expect(Number(row.stored_cost)).toBe(Number(row.measured_cost));
		}
	});

	it('has no drift after an insert, an update and a delete', async () => {
		await db.asSystem(async (tx) => {
			await tx.sql`insert into nl.customers (customer_no, name, price_group, customer_since, email_domain)
			             values ('ZL-1', 'Ledger Test Supply', 'DEALER', '2020-01-01', 'ledgertest.example')`;
			await tx.sql`insert into nl.items (item_no, description, category, family, product_group,
			                                   unit_cost, list_price, replenishment)
			             values ('ZL-PART', 'LEDGER TEST PART', 'PIPE', 'pipe', 'PIPE', 10, 40, 'Purchase')`;
			await tx.sql`insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
			             values ('ZL-INV-1', 'invoice', 'ZL-1', 'ZL-1', '2026-08-04', 500)`;
			await tx.sql`insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no,
			                                           quantity, unit_price, amount, unit_cost)
			             values ('ZL-INV-1', 1, 'ZL-1', '2026-08-04', 'ZL-PART', 10, 50, 500, 10)`;
		});
		let drift = await db.asSystem((tx) => tx.sql`select * from nl.ledger_month_drift()`);
		expect(drift).toEqual([]);

		// A changed amount inside the same month.
		await db.asSystem((tx) =>
			tx.sql`update nl.invoice_lines set quantity = 12, amount = 600
			       where invoice_no = 'ZL-INV-1' and line_no = 1`
		);
		drift = await db.asSystem((tx) => tx.sql`select * from nl.ledger_month_drift()`);
		expect(drift).toEqual([]);

		// A line moved to an invoice in another month, which has to re-measure
		// both the month it left and the month it arrived in. The line carries
		// its header's date, so this is one update over two months.
		await db.asSystem(async (tx) => {
			await tx.sql`insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal)
			             values ('ZL-INV-2', 'invoice', 'ZL-1', 'ZL-1', '2026-07-04', 600)`;
			await tx.sql`update nl.invoice_lines set invoice_no = 'ZL-INV-2', posted_on = '2026-07-04'
			             where invoice_no = 'ZL-INV-1' and line_no = 1`;
		});
		drift = await db.asSystem((tx) => tx.sql`select * from nl.ledger_month_drift()`);
		expect(drift).toEqual([]);

		await db.asSystem((tx) => tx.sql`delete from nl.invoice_lines where invoice_no = 'ZL-INV-2'`);
		drift = await db.asSystem((tx) => tx.sql`select * from nl.ledger_month_drift()`);
		expect(drift).toEqual([]);
	});

	it('repairs drift somebody wrote past the triggers, and reports what it repaired', async () => {
		// Only a superuser can do this, which is the point: nl_app has SELECT
		// only on the table and no EXECUTE on the measuring function.
		await db.asSystem((tx) =>
			tx.sql`update nl.ledger_month set revenue = revenue + 1000
			       where month = (select max(month) from nl.ledger_month)`
		);
		const before = await db.asSystem((tx) => tx.sql`select * from nl.ledger_month_drift()`);
		expect(before.length).toBe(1);

		const [{ result }] = await db.asSystem(
			(tx) => tx.sql<{ result: { repaired: string[] } }>`select nl.repair_ledger_month() as result`
		);
		expect(result.repaired.length).toBe(1);

		const after = await db.asSystem((tx) => tx.sql`select * from nl.ledger_month_drift()`);
		expect(after).toEqual([]);
	});

	it('is readable but not writable by the app role', async () => {
		await expect(
			db.asUser(ADMIN, (tx) => tx.sql`update nl.ledger_month set revenue = 0`)
		).rejects.toThrow();
		const rows = await db.asUser(ADMIN, (tx) => tx.sql`select count(*)::int as n from nl.ledger_month`);
		expect(Number(rows[0].n)).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 1. Is the money where it should be, and where is it leaking?
// ---------------------------------------------------------------------------

function figure(figures: Figure[], id: string): Figure {
	const found = figures.find((f) => f.id === id);
	if (!found) throw new Error(`no figure ${id}: ${figures.map((f) => f.id).join(', ')}`);
	return found;
}

describe('money', () => {
	it('reports the revenue a direct query of the same twelve months reports', async () => {
		const money = await readMoney(db, ADMIN, OPEN);
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ revenue: number; cost: number }>`
				with b as (select date_trunc('month', nl.today())::date as this_month)
				select coalesce(sum(il.amount), 0) as revenue,
				       coalesce(sum(il.quantity * il.unit_cost), 0) as cost
				from nl.invoice_lines il, b
				where il.posted_on >= (b.this_month - interval '12 months')::date
				  and il.posted_on < b.this_month`
		);
		expect(figure(money.figures, 'revenue').value).toBe(Number(direct.revenue));
		expect(figure(money.figures, 'margin').value).toBe(Number(direct.revenue) - Number(direct.cost));
	});

	it('never shows a figure without something to compare it against', async () => {
		const money = await readMoney(db, ADMIN, OPEN);
		expect(money.figures.length).toBeGreaterThan(0);
		for (const f of money.figures) {
			expect(f.compare.length).toBeGreaterThan(0);
			expect(f.href.length).toBeGreaterThan(0);
		}
	});

	it('marks the month in progress on the chart and leaves it out of the figures', async () => {
		const money = await readMoney(db, ADMIN, OPEN);
		const partial = money.months.filter((m) => m.partial);
		expect(partial.length).toBe(1);
		// The window the figures cover ends with the month before this one.
		expect(money.periodLabel).not.toContain('September 2026');
	});

	it('gives the chart a reference line: every month carries the same month a year earlier', async () => {
		const money = await readMoney(db, ADMIN, OPEN);
		expect(money.months.length).toBe(13);
		const [checked] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ revenue: number }>`
				select coalesce(sum(amount), 0) as revenue
				from nl.invoice_lines
				where posted_on >= (${money.months[0].month}::date - interval '1 year')::date
				  and posted_on < (${money.months[0].month}::date - interval '1 year' + interval '1 month')::date`
		);
		expect(money.months[0].priorRevenue).toBe(Number(checked.revenue));
	});

	it('leaves cost and margin out of the payload when disclosure says so', async () => {
		const closed = await readMoney(db, ADMIN, { cost: false, margin: false, modelPresent: true });
		expect(closed.figures.map((f) => f.id)).not.toContain('margin');
		expect(closed.figures.map((f) => f.id)).not.toContain('margin-pct');
		expect(closed.showsMargin).toBe(false);
		// The two leaks that are cost arithmetic go with them; freight stays,
		// because freight billed against a published tariff is not cost.
		expect(closed.leaks.map((l) => l.id)).toEqual(['freight']);
	});

	it('gives every leak a headline that matches the total on its own page', async () => {
		const money = await readMoney(db, ADMIN, OPEN);
		expect(money.leaks.length).toBe(3);
		for (const leak of money.leaks) {
			expect(isLeak(leak.id)).toBe(true);
			if (!isLeak(leak.id)) continue;
			const detail = await readLeak(db, ADMIN, leak.id, null, OPEN);
			expect(detail.total).toBeCloseTo(leak.value, 2);
		}
	});

	it('says there is nothing to recover rather than showing an empty table', async () => {
		const money = await readMoney(db, ADMIN, OPEN);
		for (const leak of money.leaks) {
			// Whether or not this world has any, the words are ready either way.
			expect(leak.nothing.length).toBeGreaterThan(0);
			expect(leak.nothing.toLowerCase()).toContain('nothing');
			if (leak.count === 0) expect(leak.value).toBe(0);
		}
	});

	it('reaches the invoice lines behind one price agreement', async () => {
		const detail = await readLeak(db, ADMIN, 'price-exceptions', null, OPEN);
		if (detail.rows.length === 0) {
			// An honest empty leak still has to say so, and still has no table.
			expect(detail.nothing).toContain('Nothing to recover');
			return;
		}
		const row = detail.rows[0];
		const [customerNo, itemNo] = row.key.split('|');
		const evidence = await readLeak(db, ADMIN, 'price-exceptions', row.key, OPEN);
		expect(evidence.evidence).not.toBeNull();
		expect(evidence.evidence!.rows.length).toBeGreaterThan(0);

		// The lines the page shows are the lines the view counted.
		const [counted] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ lines: number }>`
				select count(*)::int as lines
				from nl.invoice_lines
				where customer_no = ${customerNo} and item_no = ${itemNo} and quantity > 0
				  and posted_on > nl.today() - 365 and posted_on <= nl.today()`
		);
		expect(evidence.evidence!.rows.length).toBe(Number(counted.lines));
	});

	it('prices freight the same way per invoice as nl.freight_by_month does per month', async () => {
		const mismatches = await db.asUser(ADMIN, (tx) =>
			tx.sql`
				select m.month
				from nl.freight_by_month m
				join (
				  select month, sum(freight_billed) as billed, sum(freight_at_rate) as at_rate,
				         count(*)::int as invoices
				  from nl.invoice_freight group by month
				) i on i.month = m.month
				where (m.freight_billed, m.freight_at_rate, m.invoices)
				      is distinct from (i.billed, i.at_rate, i.invoices)`
		);
		expect(mismatches).toEqual([]);
	});

	it('counts the same freight shortfall on the leak page as in the headline', async () => {
		const detail = await readLeak(db, ADMIN, 'freight', null, OPEN);
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ total: number }>`
				select coalesce(sum(shortfall), 0) as total
				from nl.invoice_freight
				where not ships_own_carrier
				  and posted_on > nl.today() - 365 and posted_on <= nl.today()`
		);
		expect(detail.total).toBeCloseTo(Number(direct.total), 2);
	});

	it('leaves an account on its own carrier out of the freight leak', async () => {
		const rows = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ n: number }>`
				select count(*)::int as n
				from nl.invoice_freight
				where ships_own_carrier and shortfall > 0`
		);
		// There may be none in this world; what matters is that the leak's own
		// total never includes them, which the query below proves.
		const detail = await readLeak(db, ADMIN, 'freight', null, OPEN);
		const [withThem] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ total: number }>`
				select coalesce(sum(shortfall), 0) as total
				from nl.invoice_freight
				where posted_on > nl.today() - 365 and posted_on <= nl.today()`
		);
		if (Number(rows[0].n) > 0) expect(Number(withThem.total)).toBeGreaterThan(detail.total);
		else expect(Number(withThem.total)).toBeCloseTo(detail.total, 2);
	});

	it('shows the months, one month and one account inside it', async () => {
		const all = await readRevenue(db, ADMIN, { month: null, customer: null }, OPEN);
		expect(all.months.length).toBeGreaterThan(0);
		expect(all.accounts).toEqual([]);

		const month = all.months.find((m) => !m.partial && m.revenue > 0)!;
		const opened = await readRevenue(db, ADMIN, { month: month.month.slice(0, 7), customer: null }, OPEN);
		expect(opened.accounts.length).toBeGreaterThan(0);
		// The accounts in a month add up to the month, unless the list was cut
		// off at the limit.
		if (opened.accounts.length < 50) {
			const sum = opened.accounts.reduce((total, a) => total + a.revenue, 0);
			expect(sum).toBeCloseTo(month.revenue, 2);
		}

		const account = opened.accounts[0];
		const lines = await readRevenue(
			db,
			ADMIN,
			{ month: month.month.slice(0, 7), customer: account.customerNo },
			OPEN
		);
		expect(lines.evidence).not.toBeNull();
		expect(lines.evidence!.rows.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// 2. Are we keeping our promises?
// ---------------------------------------------------------------------------

describe('promises', () => {
	it('counts kept, pushed and broken the way the commitment board does', async () => {
		const section = await readPromises(db, ADMIN);
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ kept: number; missed: number }>`
				select count(*) filter (where status = 'kept')::int as kept,
				       count(*) filter (where status in ('pushed', 'broken'))::int as missed
				from nl.commitment_progress
				where ends_on > nl.today() - 365 and ends_on <= nl.today()`
		);
		expect(figure(section.figures, 'windows-kept').value).toBe(Number(direct.kept));
		expect(figure(section.figures, 'windows-missed').value).toBe(Number(direct.missed));
	});

	it('counts the open lines the forecast says will miss their date', async () => {
		const section = await readPromises(db, ADMIN);
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ late: number }>`
				select count(*)::int as late from nl.open_line_projection where days_late > 0`
		);
		expect(figure(section.figures, 'late-lines').value).toBe(Number(direct.late));
	});

	it('times quote turnaround from the emailed request, and says so when there is nothing to time', async () => {
		const section = await readPromises(db, ADMIN);
		const turnaround = figure(section.figures, 'quote-turnaround');
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ answered: number }>`
				select count(*)::int as answered from nl.rfq_drafts
				where status = 'approved' and decided_at is not null
				  and decided_at > (nl.today() - 90)::timestamptz`
		);
		if (Number(direct.answered) === 0) {
			expect(turnaround.value).toBe(0);
			expect(turnaround.compare).toContain('nothing to time');
		} else {
			expect(turnaround.value).toBeGreaterThan(0);
			expect(turnaround.compare).toContain(`${Number(direct.answered)} answered`);
		}
	});

	it('names the accounts whose recent windows did not hold, worst first', async () => {
		const section = await readPromises(db, ADMIN);
		for (const account of section.slipping) {
			expect(account.pushed + account.broken).toBeGreaterThan(0);
			expect(account.href).toBe(links.promises({ customer: account.customerNo }));
			expect(account.accountHref).toBe(links.account(account.customerNo));
		}
		for (let i = 1; i < section.slipping.length; i++) {
			const before = section.slipping[i - 1];
			const now = section.slipping[i];
			expect(before.pushed + before.broken).toBeGreaterThanOrEqual(now.pushed + now.broken);
		}
	});

	it('drills from an account to the windows it missed, and from a window to the commitment', async () => {
		const section = await readPromises(db, ADMIN);
		if (section.slipping.length === 0) return expect(section.slipping).toEqual([]);
		const worst = section.slipping[0];
		const detail = await readPromiseDetail(db, ADMIN, { outcome: null, customer: worst.customerNo });
		expect(detail.rows.length).toBe(worst.windows);
		for (const row of detail.rows) {
			expect(row.customerNo).toBe(worst.customerNo);
			expect(row.href).toBe(links.commitment(row.id));
		}
	});

	it('filters the window list by outcome', async () => {
		const broken = await readPromiseDetail(db, ADMIN, { outcome: 'broken', customer: null });
		for (const row of broken.rows) expect(row.status).toBe('broken');
	});
});

// ---------------------------------------------------------------------------
// 3. Are the agents earning trust?
// ---------------------------------------------------------------------------

describe('agents', () => {
	it('reads every per-agent number from the harness board and changes none of it', async () => {
		const section = await readAgents(db, ADMIN);
		const board = await readBoard(db, ADMIN);
		expect(section.rows.length).toBe(board.length);
		for (const row of section.rows) {
			const mine = board.find((b) => b.agent === row.agent && b.workKind === row.workKind)!;
			expect(mine).toBeDefined();
			expect(row.runs).toBe(mine.runs);
			expect(row.waiting).toBe(mine.waiting);
			expect(row.reviewed).toBe(mine.reviewed);
			expect(row.approvalRate).toBe(mine.approvalRate);
			expect(row.editRate).toBe(mine.editRate);
			expect(row.refusals).toBe(mine.refusals);
			expect(row.actedAlone).toBe(mine.actedAlone);
			expect(row.level).toBe(mine.level);
			expect(row.verdict).toBe(mine.verdict);
		}
	});

	it('blends its totals from the board own counts', async () => {
		const section = await readAgents(db, ADMIN);
		const board = await readBoard(db, ADMIN);
		expect(figure(section.figures, 'agent-runs').value).toBe(
			board.reduce((sum, b) => sum + b.runs, 0)
		);
		const reviewed = board.reduce((sum, b) => sum + b.reviewed, 0);
		const approvedEither = board.reduce((sum, b) => sum + b.approved + b.edited, 0);
		expect(figure(section.figures, 'agent-approval').value).toBe(
			reviewed === 0 ? 0 : approvedEither / reviewed
		);
	});

	it('gives every value ledger line a count it can point at', async () => {
		const section = await readAgents(db, ADMIN);
		expect(section.value.length).toBeGreaterThan(0);
		for (const line of section.value) {
			expect(line.count).toBeGreaterThanOrEqual(0);
			expect(line.basis.length).toBeGreaterThan(0);
			expect(line.href.length).toBeGreaterThan(0);
		}
		// And it says out loud that it is not money.
		expect(section.valueCaveat).toContain('Counted, not valued');
	});

	it('counts this week the same way a direct query does', async () => {
		const section = await readAgents(db, ADMIN);
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ acted: number; refused: number }>`
				select (select count(*) from nl.agent_actions
				         where acted_at > now() - interval '7 days')::int as acted,
				       (select count(*) from nl.agent_events
				         where at > now() - interval '7 days'
				           and kind = 'guardrail' and verdict <> 'pass')::int as refused`
		);
		const acted = section.value.find((v) => v.id === 'week-acted')!;
		const refused = section.value.find((v) => v.id === 'week-refused')!;
		expect(acted.count).toBe(Number(direct.acted));
		expect(refused.count).toBe(Number(direct.refused));
	});

	it('lists the runs the harness lists, with a link to each one', async () => {
		const feed = await readRunFeed(db, ADMIN, {
			agent: null,
			workKind: null,
			refused: false,
			acted: false
		});
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ n: number }>`select count(*)::int as n from nl.agent_run_log`
		);
		expect(feed.rows.length).toBe(Math.min(Number(direct.n), 100));
		for (const row of feed.rows) expect(row.href).toBe(links.run(row.runKey));
	});
});

// ---------------------------------------------------------------------------
// 4. What is at risk right now?
// ---------------------------------------------------------------------------

describe('risk', () => {
	it('counts coverage gaps, late supply, the queue and the quiet accounts directly', async () => {
		const section = await readRisk(db, ADMIN);
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ no_supply: number; past_due: number; queue: number; quiet: number }>`
				select (select count(*) from nl.open_line_projection where status = 'no_supply')::int as no_supply,
				       (select count(*) from nl.procurement_late_supply where past_due)::int as past_due,
				       (select count(*) from nl.agent_queue)::int as queue,
				       (select count(*) from nl.account_list where gone_quiet)::int as quiet`
		);
		expect(figure(section.figures, 'no-supply').value).toBe(Number(direct.no_supply));
		expect(figure(section.figures, 'late-supply').value).toBe(Number(direct.past_due));
		expect(figure(section.figures, 'queue').value).toBe(Number(direct.queue));
		expect(figure(section.figures, 'quiet').value).toBe(Number(direct.quiet));
	});

	it('reaches the part and the vendor behind a late supply order', async () => {
		const detail = await readLateSupply(db, ADMIN);
		const [direct] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ n: number }>`select count(*)::int as n from nl.procurement_late_supply`
		);
		expect(detail.rows.length).toBe(Math.min(Number(direct.n), 100));
		for (const row of detail.rows) {
			expect(row.partHref).toBe(links.part(row.itemNo));
			if (row.vendorNo) expect(row.vendorHref).toBe(links.vendor(row.vendorNo));
		}
	});
});

// ---------------------------------------------------------------------------
// Disclosure, present and absent
// ---------------------------------------------------------------------------

describe('disclosure', () => {
	it('shows cost and margin when the roles model is not in this database', async () => {
		const answer = await db.asUser(ADMIN, (tx) => readDisclosure(tx, ADMIN));
		const [present] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ ok: boolean }>`
				select pg_catalog.to_regprocedure('nl.may_see(int,text)') is not null as ok`
		);
		if (present.ok) {
			expect(answer.modelPresent).toBe(true);
		} else {
			expect(answer).toEqual(OPEN);
		}
	});

	it('asks nl.may_see when it exists, and takes no for an answer', async () => {
		const [present] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ ok: boolean }>`
				select pg_catalog.to_regprocedure('nl.may_see(int,text)') is not null as ok`
		);
		if (present.ok) {
			// The roles branch has landed: trust its answer rather than a stub.
			const answer = await db.asUser(ADMIN, (tx) => readDisclosure(tx, ADMIN));
			expect(typeof answer.cost).toBe('boolean');
			return;
		}
		// Stand in a function with the roles signature that refuses everything,
		// and check the reader believes it. Dropped again at the end, so the
		// rest of this file sees the world it expects.
		await db.asSystem((tx) =>
			tx.query(`create function nl.may_see(int, text) returns boolean
			          language sql immutable set search_path = '' as $$ select false $$`)
		);
		try {
			const answer = await db.asUser(ADMIN, (tx) => readDisclosure(tx, ADMIN));
			expect(answer).toEqual({ cost: false, margin: false, modelPresent: true });

			const money = await readMoney(db, ADMIN, answer);
			const serialised = JSON.stringify(money);
			expect(serialised).not.toContain('"margin"');
			expect(money.leaks.map((l) => l.id)).toEqual(['freight']);

			// And the leak pages that are cost arithmetic have no figures on them.
			const leak = await readLeak(db, ADMIN, 'cost-passthrough', null, answer);
			expect(leak.rows).toEqual([]);
			expect(leak.total).toBe(0);
		} finally {
			await db.asSystem((tx) => tx.query('drop function nl.may_see(int, text)'));
		}
	});
});

// ---------------------------------------------------------------------------
// Every link resolves to a real route, with filters that page really reads
// ---------------------------------------------------------------------------

/** Every route pattern in the app, as a regex, read off the filesystem. */
function routePatterns(): { pattern: RegExp; source: string }[] {
	const root = fileURLToPath(new URL('../../../routes', import.meta.url));
	const found: { pattern: RegExp; source: string }[] = [];

	function walk(dir: string, urlPath: string) {
		const entries = readdirSync(dir);
		if (entries.includes('+page.svelte') || entries.includes('+server.ts')) {
			// [id=id] and [customer=customer] are one segment each; the matcher
			// itself is not re-implemented here, only the shape.
			const source = urlPath === '' ? '/' : urlPath;
			const text = source
				.split('/')
				.map((part) => (part.startsWith('[') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
				.join('/');
			found.push({ pattern: new RegExp(`^${text}$`), source });
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			if (!statSync(full).isDirectory()) continue;
			// Route groups and other SvelteKit folders are not path segments.
			if (entry.startsWith('(') || entry.startsWith('.')) {
				walk(full, urlPath);
				continue;
			}
			walk(full, `${urlPath}/${entry}`);
		}
	}
	walk(root, '');
	return found;
}

const PATTERNS = routePatterns();

function resolves(href: string): boolean {
	const url = new URL(href, 'http://test.example');
	return PATTERNS.some((route) => route.pattern.test(url.pathname));
}

/** Every href a page of this feature can render, gathered from the payloads. */
async function everyHref(): Promise<string[]> {
	const money = await readMoney(db, ADMIN, OPEN);
	const promises = await readPromises(db, ADMIN);
	const agents = await readAgents(db, ADMIN);
	const risk = await readRisk(db, ADMIN);
	const revenue = await readRevenue(db, ADMIN, { month: null, customer: null }, OPEN);
	const late = await readLateSupply(db, ADMIN);
	const feed = await readRunFeed(db, ADMIN, { agent: null, workKind: null, refused: false, acted: false });

	const hrefs = [
		...money.figures.map((f) => f.href),
		...money.leaks.map((l) => l.href),
		...promises.figures.map((f) => f.href),
		...promises.slipping.flatMap((s) => [s.href, s.accountHref]),
		...agents.figures.map((f) => f.href),
		...agents.rows.flatMap((r) => [r.href, r.refusalsHref, r.actedHref]),
		...agents.value.map((v) => v.href),
		...risk.figures.map((f) => f.href),
		...revenue.months.map((m) => m.href),
		...late.rows.flatMap((r) => [r.partHref, r.forecastHref, r.vendorHref]),
		...feed.rows.flatMap((r) => [r.href, r.subjectHref]),
		...feed.refusals.map((r) => r.href)
	];

	for (const leak of money.leaks) {
		if (!isLeak(leak.id)) continue;
		const detail = await readLeak(db, ADMIN, leak.id, null, OPEN);
		hrefs.push(...detail.rows.flatMap((r) => [r.recordHref, r.evidenceHref]));
	}
	return hrefs.filter((href): href is string => typeof href === 'string' && href.length > 0);
}

describe('links', () => {
	it('every href the overview renders lands on a route that exists', async () => {
		const hrefs = await everyHref();
		expect(hrefs.length).toBeGreaterThan(20);
		const broken = [...new Set(hrefs)].filter((href) => !resolves(href));
		expect(broken).toEqual([]);
	});

	it('is the only place the overview builds a URL: every href matches links.ts', async () => {
		// The page and the components never concatenate a URL, so every href in
		// a payload has to be reproducible from this module.
		const built = new Set<string>([
			links.overview(),
			links.revenue(),
			links.promises(),
			links.runs(),
			links.queue(),
			links.autonomy(),
			links.noSupply(),
			links.lateSupply(),
			links.late(),
			links.quietAccounts(),
			links.quoteRequests(),
			links.riskTopic('late-supply')
		]);
		const money = await readMoney(db, ADMIN, OPEN);
		for (const leak of money.leaks) built.add(links.leak(leak.id as never));
		for (const figureHref of money.figures.map((f) => f.href)) {
			expect(built.has(figureHref)).toBe(true);
		}
	});

	it('filters the accounts list the way that page reads it', () => {
		const url = new URL(links.quietAccounts(), 'http://test.example');
		const filters = readAccountFilters(url.searchParams, 'mine');
		expect(filters.quiet).toBe(true);
		expect(filters.sort).toBe('quiet');
		expect(filters.who).toBe('all');
	});

	it('filters the open order forecast the way that page reads it', () => {
		// readFilters throws on a status it does not know, so this test is the
		// proof that the three links are spelled the way the page expects.
		expect(readForecastFilters(new URL(links.noSupply(), 'http://test.example')).status).toBe('no_supply');
		expect(readForecastFilters(new URL(links.lateSupply(), 'http://test.example')).status).toBe(
			'late_supply_overdue'
		);
		expect(readForecastFilters(new URL(links.late(), 'http://test.example')).status).toBe('late');
	});

	it('names a queue source the queue knows', () => {
		const url = new URL(links.queue('purchase'), 'http://test.example');
		expect(QUEUE_SOURCES).toContain(url.searchParams.get('source'));
	});

	it('escapes a record id exactly once', () => {
		expect(links.run('order_desk:12')).toBe('/overview/runs/order_desk%3A12');
		expect(links.account('A/B')).toBe('/accounts/A%2FB');
		expect(links.leak('freight', 'X&Y')).toBe('/overview/leak/freight?key=X%26Y');
	});
});
