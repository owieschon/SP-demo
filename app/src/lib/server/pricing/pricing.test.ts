// Cost, freight and pricing, against the small world.
//
// Every number is checked against a direct computation over the tables the
// rule reads, never against a figure copied out of the view or the function
// being tested. If the rule and the raw rows ever disagree, these fail.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import {
	costOn,
	freightFor,
	getCostTimeline,
	getCustomerMargin,
	getFreightByMonth,
	getItemMargin,
	getMinMargin,
	listAgreements,
	priceFor,
	priceLines
} from './pricing.ts';

const DANA = 2; // account manager
const ADMIN = 1;

const TODAY = '2026-09-17';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

/** The parts the small world's ledger sold the most of. */
async function bestSellers(howMany: number): Promise<string[]> {
	const rows = await db.asSystem((tx) =>
		tx.sql<{ item_no: string }>`
			select item_no from nl.invoice_lines
			group by item_no
			order by sum(amount) desc, item_no
			limit ${howMany}`
	);
	return rows.map((r) => r.item_no);
}

/** The accounts that bought the most. */
async function bestAccounts(howMany: number): Promise<string[]> {
	const rows = await db.asSystem((tx) =>
		tx.sql<{ customer_no: string }>`
			select customer_no from nl.invoice_lines
			group by customer_no
			order by sum(amount) desc, customer_no
			limit ${howMany}`
	);
	return rows.map((r) => r.customer_no);
}

describe('the cost timeline', () => {
	it('ends at the cost on the item card, for every part', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ items: number; with_history: number; mismatches: number }>`
				select
					(select count(*) from nl.items)::int as items,
					(select count(distinct item_no) from nl.item_costs)::int as with_history,
					(select count(*)
					 from nl.items i
					 join lateral (
					   select c.unit_cost
					   from nl.item_costs c
					   where c.item_no = i.item_no
					   order by c.effective_from desc
					   limit 1
					 ) newest on true
					 where newest.unit_cost <> i.unit_cost)::int as mismatches`
		);
		expect(check.items).toBeGreaterThan(100);
		// Every part has a timeline, and no timeline disagrees with its card.
		expect(check.with_history).toBe(check.items);
		expect(check.mismatches).toBe(0);
	});

	it('revises a part one to three times a year, mostly upward', async () => {
		const perYear = await db.asSystem((tx) =>
			tx.sql<{ revisions: number; item_no: string; year: number }>`
				select c.item_no, extract(year from c.effective_from)::int as year, count(*)::int as revisions
				from nl.item_costs c
				-- The opening cost sits on 1 January of the first year and is not
				-- a revision, so it is left out of the count.
				where c.note <> 'Opening standard cost, where this history starts'
				group by c.item_no, extract(year from c.effective_from)`
		);
		expect(perYear.length).toBeGreaterThan(100);
		for (const row of perYear) {
			expect(row.revisions, `${row.item_no} ${row.year}`).toBeGreaterThanOrEqual(1);
			expect(row.revisions, `${row.item_no} ${row.year}`).toBeLessThanOrEqual(3);
		}

		const [steps] = await db.asSystem((tx) =>
			tx.sql<{ rises: number; falls: number; biggest_rise: number; biggest_fall: number }>`
				select
					count(*) filter (where change > 0)::int as rises,
					count(*) filter (where change < 0)::int as falls,
					max(change_pct) as biggest_rise,
					min(change_pct) as biggest_fall
				from nl.item_cost_timeline`
		);
		// Rises outnumber falls, and neither is wild.
		expect(steps.rises).toBeGreaterThan(steps.falls);
		expect(steps.falls).toBeGreaterThan(0);
		expect(steps.biggest_rise).toBeLessThan(0.25);
		expect(steps.biggest_fall).toBeGreaterThan(-0.1);
	});

	it('gives bought parts a vendor and a quote, and made parts a standard revision', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ made_with_vendor: number; bought_without_vendor: number; sources: number }>`
				select
					count(*) filter (where i.replenishment <> 'Purchase' and c.vendor_no is not null)::int
						as made_with_vendor,
					count(*) filter (where i.replenishment = 'Purchase' and i.vendor_no is not null
					                   and c.vendor_no is null)::int as bought_without_vendor,
					count(distinct c.source)::int as sources
				from nl.item_costs c
				join nl.items i on i.item_no = c.item_no`
		);
		expect(check.made_with_vendor).toBe(0);
		expect(check.bought_without_vendor).toBe(0);
		expect(check.sources).toBe(3);
	});

	it('looks a cost up by date, and falls back to the oldest row before the history', async () => {
		const [itemNo] = await bestSellers(1);
		const timeline = await getCostTimeline(db, DANA, itemNo);
		expect(timeline.length).toBeGreaterThan(1);
		expect(timeline.at(-1)!.isCurrent).toBe(true);
		expect(timeline.at(-1)!.effectiveTo).toBeNull();

		// The middle of each step reads back that step's cost, and the day
		// before a step starts still reads the one before it.
		for (const point of timeline) {
			const inside = await costOn(db, DANA, itemNo, point.effectiveFrom);
			expect(inside, `${itemNo} on ${point.effectiveFrom}`).toBeCloseTo(point.unitCost, 2);
			if (point.effectiveTo) {
				const dayBefore = await costOn(db, DANA, itemNo, point.effectiveTo);
				expect(dayBefore, `${itemNo} on ${point.effectiveTo}`).toBeCloseTo(point.unitCost, 2);
			}
		}

		// Before the history starts, and with no date at all (today).
		expect(await costOn(db, DANA, itemNo, '2001-01-01')).toBeCloseTo(timeline[0].unitCost, 2);
		expect(await costOn(db, DANA, itemNo)).toBeCloseTo(timeline.at(-1)!.unitCost, 2);
		expect(await costOn(db, DANA, 'NO-SUCH-PART')).toBeNull();
	});
});

describe('the margin views', () => {
	it('matches a direct computation of a part\'s months', async () => {
		for (const itemNo of await bestSellers(3)) {
			const months = await getItemMargin(db, DANA, itemNo);
			expect(months.length, itemNo).toBeGreaterThan(0);

			for (const month of months) {
				const [direct] = await db.asSystem((tx) =>
					tx.sql<{ units: number; revenue: number; cost: number; lines: number }>`
						select
							coalesce(sum(il.quantity), 0)::int as units,
							coalesce(sum(il.amount), 0) as revenue,
							coalesce(sum(il.quantity * il.unit_cost), 0) as cost,
							count(*)::int as lines
						from nl.invoice_lines il
						where il.item_no = ${itemNo}
						  and date_trunc('month', il.posted_on)::date = ${month.month}::date`
				);
				expect(month.units, `${itemNo} ${month.month}`).toBe(direct.units);
				expect(month.revenue, `${itemNo} ${month.month}`).toBeCloseTo(direct.revenue, 2);
				expect(month.costOfGoods, `${itemNo} ${month.month}`).toBeCloseTo(direct.cost, 2);
				expect(month.grossMargin, `${itemNo} ${month.month}`).toBeCloseTo(direct.revenue - direct.cost, 2);
				expect(month.lines, `${itemNo} ${month.month}`).toBe(direct.lines);
				if (direct.revenue !== 0) {
					expect(month.marginPct!, `${itemNo} ${month.month}`).toBeCloseTo(
						(direct.revenue - direct.cost) / direct.revenue,
						3
					);
				}
			}
		}
	});

	it('matches a direct computation of an account\'s years', async () => {
		for (const customerNo of await bestAccounts(3)) {
			const years = await getCustomerMargin(db, DANA, customerNo);
			expect(years.length, customerNo).toBeGreaterThan(0);
			// Newest year first.
			expect(years.map((y) => y.year)).toEqual([...years.map((y) => y.year)].sort((a, b) => b - a));

			for (const year of years) {
				const [direct] = await db.asSystem((tx) =>
					tx.sql<{ revenue: number; cost: number; items: number; units: number }>`
						select
							coalesce(sum(il.amount), 0) as revenue,
							coalesce(sum(il.quantity * il.unit_cost), 0) as cost,
							count(distinct il.item_no)::int as items,
							coalesce(sum(il.quantity), 0)::int as units
						from nl.invoice_lines il
						where il.customer_no = ${customerNo}
						  and extract(year from il.posted_on) = ${year.year}`
				);
				expect(year.revenue, `${customerNo} ${year.year}`).toBeCloseTo(direct.revenue, 2);
				expect(year.costOfGoods, `${customerNo} ${year.year}`).toBeCloseTo(direct.cost, 2);
				expect(year.items, `${customerNo} ${year.year}`).toBe(direct.items);
				expect(year.units, `${customerNo} ${year.year}`).toBe(direct.units);
				expect(year.marginPct!, `${customerNo} ${year.year}`).toBeCloseTo(
					(direct.revenue - direct.cost) / direct.revenue,
					3
				);
			}
		}
	});

	it('takes its cost from the line, not from today\'s timeline', async () => {
		// The ledger line carries the cost that applied on its day, so the two
		// figures are allowed to differ. What matters is that the view reads the
		// line: a part whose cost has moved shows the line's cost, not the card's.
		const [itemNo] = await bestSellers(1);
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ view_cost: number; line_cost: number; card_cost: number }>`
				select
					(select sum(cost_of_goods) from nl.item_margin_history where item_no = ${itemNo}) as view_cost,
					(select sum(il.quantity * il.unit_cost) from nl.invoice_lines il where il.item_no = ${itemNo})
						as line_cost,
					(select sum(il.quantity) * i.unit_cost
					 from nl.invoice_lines il, nl.items i
					 where il.item_no = ${itemNo} and i.item_no = ${itemNo}
					 group by i.unit_cost) as card_cost`
		);
		expect(check.view_cost).toBeCloseTo(check.line_cost, 2);
	});
});

describe('the freight tariff', () => {
	it('prices each band of each period, with that month\'s surcharge', async () => {
		const bands = await db.asSystem((tx) =>
			tx.sql<{ effective_from: string; min_subtotal: number; rate: number; free_over: number }>`
				select r.effective_from, r.min_subtotal, r.rate, p.free_over
				from nl.freight_rates r
				join nl.freight_periods p on p.effective_from = r.effective_from
				order by r.effective_from, r.min_subtotal`
		);
		expect(bands.length).toBeGreaterThanOrEqual(3);

		for (const band of bands) {
			// A subtotal a dollar into the band, priced on the day the period starts.
			const subtotal = Number(band.min_subtotal) + 1;
			const quote = await freightFor(db, DANA, subtotal, band.effective_from);
			expect(quote, `${band.effective_from} ${band.min_subtotal}`).not.toBeNull();
			expect(quote!.bandMin).toBe(Number(band.min_subtotal));
			expect(quote!.baseRate).toBeCloseTo(Number(band.rate), 2);
			expect(quote!.freeOver).toBeCloseTo(Number(band.free_over), 2);

			const [surcharge] = await db.asSystem((tx) =>
				tx.sql<{ percent: number }>`
					select percent from nl.fuel_surcharge
					where month <= date_trunc('month', ${band.effective_from}::date)::date
					order by month desc limit 1`
			);
			expect(quote!.surchargePct).toBeCloseTo(surcharge.percent, 2);
			expect(quote!.freight).toBeCloseTo(
				Math.round(Number(band.rate) * (1 + surcharge.percent / 100) * 100) / 100,
				2
			);
		}
	});

	it('ships free once the subtotal reaches the threshold, and prices an old date at the oldest tariff', async () => {
		const [period] = await db.asSystem((tx) =>
			tx.sql<{ effective_from: string; free_over: number }>`
				select effective_from, free_over from nl.freight_periods order by effective_from limit 1`
		);
		// The threshold in force today, which is not the oldest one.
		const [current] = await db.asSystem((tx) =>
			tx.sql<{ free_over: number }>`
				select free_over from nl.freight_periods
				where effective_from <= nl.today()
				order by effective_from desc limit 1`
		);

		const free = await freightFor(db, DANA, Number(current.free_over) + 50, TODAY);
		expect(free!.freight).toBe(0);
		const paid = await freightFor(db, DANA, 300, TODAY);
		expect(paid!.freight).toBeGreaterThan(0);

		// A date years before the history still gets the oldest tariff, not nothing.
		const old = await freightFor(db, DANA, 300, '2001-05-05');
		const first = await freightFor(db, DANA, 300, period.effective_from);
		expect(old).toEqual(first);

		// No date means today.
		expect(await freightFor(db, DANA, 300)).toEqual(paid);
	});

	it('keeps the surcharge history inside its band, one row per month', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ months: number; expected: number; low: number; high: number }>`
				select
					count(*)::int as months,
					(select count(*) from generate_series(
					   (select make_date(first_year, 1, 1) from nl_seed.settings),
					   date_trunc('month', nl.today())::date,
					   interval '1 month'))::int as expected,
					min(percent) as low,
					max(percent) as high
				from nl.fuel_surcharge`
		);
		expect(check.months).toBe(check.expected);
		expect(check.low).toBeGreaterThanOrEqual(8);
		expect(check.high).toBeLessThanOrEqual(28);
	});

	it('adds up freight by month the same way nl.freight_for does', async () => {
		const months = await getFreightByMonth(db, DANA);
		expect(months.length).toBeGreaterThan(6);
		expect(months.at(-1)!.month).toBe('2026-09-01');

		// The view works the tariff out with joins, for speed. This is the same
		// question asked one invoice at a time through the function.
		const direct = await db.asSystem((tx) =>
			tx.sql<{ month: string; billed: number; at_rate: number; invoices: number }>`
				select
					date_trunc('month', i.posted_on)::date as month,
					sum(i.freight) as billed,
					sum(f.freight) as at_rate,
					count(*)::int as invoices
				from nl.invoices i
				cross join lateral nl.freight_for(i.subtotal, i.posted_on) f
				where i.doc_type = 'invoice'
				group by 1`
		);
		const byMonth = new Map(direct.map((r) => [r.month, r]));
		for (const month of months) {
			const same = byMonth.get(month.month);
			expect(same, month.month).toBeDefined();
			expect(month.freightBilled, month.month).toBeCloseTo(same!.billed, 2);
			expect(month.freightAtRate, month.month).toBeCloseTo(same!.at_rate, 2);
			expect(month.invoices, month.month).toBe(same!.invoices);
			expect(month.difference, month.month).toBeCloseTo(month.freightBilled - month.freightAtRate, 2);
		}
	});
});

describe('nl.price_for', () => {
	it('uses an agreement that covers the day, ahead of everything else', async () => {
		const [deal] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; net_price: number; valid_from: string }>`
				select customer_no, item_no, net_price, valid_from
				from nl.customer_prices
				where valid_to is null
				order by customer_no, item_no
				limit 1`
		);
		const price = await priceFor(db, DANA, { customerNo: deal.customer_no, itemNo: deal.item_no });
		expect(price).not.toBeNull();
		expect(price!.rule).toBe('agreement');
		expect(price!.price).toBeCloseTo(deal.net_price, 2);
		expect(price!.detail).toContain(deal.valid_from);
		// The agreement beats the tier price, which is what makes it an agreement.
		expect(price!.price).toBeLessThan(price!.listPrice * (1 - price!.discount) + 0.01);
	});

	it('does not use an agreement whose window has closed', async () => {
		const [expired] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; net_price: number; valid_to: string }>`
				select cp.customer_no, cp.item_no, cp.net_price, cp.valid_to
				from nl.customer_prices cp
				where cp.valid_to < nl.today()
				  -- No later agreement on the same part, or that one would price it.
				  and not exists (
				    select 1 from nl.customer_prices later
				    where later.customer_no = cp.customer_no
				      and later.item_no = cp.item_no
				      and later.valid_from > cp.valid_from)
				order by cp.customer_no, cp.item_no
				limit 1`
		);
		expect(expired, 'the small world has an expired agreement with nothing after it').toBeDefined();

		const today = await priceFor(db, DANA, { customerNo: expired.customer_no, itemNo: expired.item_no });
		expect(today!.rule).not.toBe('agreement');
		expect(today!.price).not.toBeCloseTo(expired.net_price, 2);

		// On a day inside the window it was the price.
		const then = await priceFor(db, DANA, {
			customerNo: expired.customer_no,
			itemNo: expired.item_no,
			onDate: expired.valid_to
		});
		expect(then!.rule).toBe('agreement');
		expect(then!.price).toBeCloseTo(expired.net_price, 2);
	});

	it('falls back to the last price they paid, then to the tier, then to list', async () => {
		// A part the account bought inside the last year, with no agreement on it.
		const [paid] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; unit_price: number; posted_on: string }>`
				select il.customer_no, il.item_no, il.unit_price, il.posted_on
				from nl.invoice_lines il
				where il.quantity > 0
				  and il.posted_on > nl.today() - 365
				  and il.posted_on <= nl.today()
				  and not exists (
				    select 1 from nl.customer_prices cp
				    where cp.customer_no = il.customer_no and cp.item_no = il.item_no)
				  -- The price has to clear the floor, or the rule skips it on purpose.
				  and il.unit_price >= round(nl.item_cost_on(il.item_no, nl.today()) / (1 - nl.min_margin()), 2)
				order by il.posted_on desc, il.invoice_no, il.line_no
				limit 1`
		);
		const lastPaid = await priceFor(db, DANA, { customerNo: paid.customer_no, itemNo: paid.item_no });
		expect(lastPaid!.rule).toBe('last paid');
		expect(lastPaid!.price).toBeCloseTo(paid.unit_price, 2);
		expect(lastPaid!.detail).toContain(paid.posted_on);

		// A part the same account has never bought prices off its price group.
		const [never] = await db.asSystem((tx) =>
			tx.sql<{ item_no: string; list_price: number; discount: number; price_group: string }>`
				select i.item_no, i.list_price, pg.discount, c.price_group
				from nl.items i
				cross join nl.customers c
				join nl.price_groups pg on pg.code = c.price_group
				where c.customer_no = ${paid.customer_no}
				  and not exists (
				    select 1 from nl.invoice_lines il
				    where il.customer_no = c.customer_no and il.item_no = i.item_no)
				order by i.item_no
				limit 1`
		);
		const tier = await priceFor(db, DANA, { customerNo: paid.customer_no, itemNo: never.item_no });
		expect(tier!.rule).toBe('group discount');
		expect(tier!.price).toBeCloseTo(
			Math.round(never.list_price * (1 - never.discount) * 100) / 100,
			2
		);
		expect(tier!.detail).toContain(never.price_group);

		// An account we have never heard of pays list.
		const stranger = await priceFor(db, DANA, { customerNo: '90000009', itemNo: never.item_no });
		expect(stranger!.rule).toBe('list');
		expect(stranger!.price).toBeCloseTo(never.list_price, 2);
		expect(stranger!.discount).toBe(0);

		// A part that is not in the catalog has no price at all.
		expect(await priceFor(db, DANA, { customerNo: paid.customer_no, itemNo: 'NO-SUCH-PART' })).toBeNull();
	});

	it('carries the cost of the day, the floor and the margin', async () => {
		const minMargin = await getMinMargin(db, DANA);
		expect(minMargin).toBeCloseTo(0.2, 4);

		const [customerNo] = await bestAccounts(1);
		for (const itemNo of await bestSellers(4)) {
			const price = await priceFor(db, DANA, { customerNo, itemNo, onDate: '2026-02-10' });
			expect(price, itemNo).not.toBeNull();

			// The cost is the one the timeline had on that day, not today's.
			const cost = await costOn(db, DANA, itemNo, '2026-02-10');
			expect(price!.unitCost, itemNo).toBeCloseTo(cost!, 2);
			// The floor is the price at which the margin equals the floor margin.
			expect(price!.floorPrice, itemNo).toBeCloseTo(
				Math.round((cost! / (1 - minMargin)) * 100) / 100,
				2
			);
			expect(price!.marginPct!, itemNo).toBeCloseTo(
				(price!.price - price!.unitCost) / price!.price,
				4
			);
			expect(price!.belowFloor, itemNo).toBe(price!.price < price!.floorPrice);
		}
	});

	it('flags an agreed price under the floor, and still honours it', async () => {
		// An agreement priced under cost plus the floor margin: the rule keeps
		// using it, because it is what was agreed, and says it is below the floor.
		const [deal] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; unit_cost: number }>`
				select c.customer_no, i.item_no, nl.item_cost_on(i.item_no, nl.today()) as unit_cost
				from nl.customers c
				cross join nl.items i
				where c.customer_no = (select customer_no from nl.customers order by customer_no limit 1)
				  and not exists (
				    select 1 from nl.customer_prices cp
				    where cp.customer_no = c.customer_no and cp.item_no = i.item_no)
				order by i.item_no
				limit 1`
		);
		const thin = Math.round(deal.unit_cost * 1.05 * 100) / 100;
		await db.asSystem((tx) =>
			tx.sql`
				insert into nl.customer_prices (customer_no, item_no, net_price, valid_from, valid_to, agreed_by, note)
				values (${deal.customer_no}, ${deal.item_no}, ${thin}, ${'2026-01-05'}, null, ${ADMIN},
				        ${'Agreed to hold the line on a part they were about to move'})`
		);

		const price = await priceFor(db, DANA, { customerNo: deal.customer_no, itemNo: deal.item_no });
		expect(price!.rule).toBe('agreement');
		expect(price!.price).toBeCloseTo(thin, 2);
		expect(price!.belowFloor).toBe(true);
		expect(price!.marginPct!).toBeLessThan(0.2);

		// And the account page sees the same thing.
		const agreements = await listAgreements(db, DANA, deal.customer_no);
		const shown = agreements.find((a) => a.itemNo === deal.item_no);
		expect(shown?.status).toBe('in_force');
		expect(shown?.belowFloor).toBe(true);
		expect(shown?.agreedBy).toBe('Elena Brooks');
		expect(shown!.groupPrice).toBeGreaterThan(shown!.netPrice);
	});

	it('skips the last paid price when cost has risen past the floor', async () => {
		// A part the account bought inside the last year, with no agreement.
		const [paid] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; unit_price: number }>`
				select il.customer_no, il.item_no, il.unit_price
				from nl.invoice_lines il
				where il.quantity > 0
				  and il.posted_on > nl.today() - 300
				  and il.posted_on <= nl.today()
				  and not exists (
				    select 1 from nl.customer_prices cp
				    where cp.customer_no = il.customer_no and cp.item_no = il.item_no)
				order by il.posted_on desc, il.invoice_no, il.line_no
				limit 1`
		);

		// A cost revision a month out, high enough that the price they paid no
		// longer clears the floor. Dated in the future, so it cannot collide with
		// a seeded revision, and removed again below.
		const future = '2026-10-17';
		const steep = Math.round(paid.unit_price * 3 * 100) / 100;
		try {
			await db.asSystem((tx) =>
				tx.sql`
					insert into nl.item_costs (item_no, effective_from, unit_cost, source, note)
					values (${paid.item_no}, ${future}::date, ${steep}, 'standard revision',
					        ${'Cost review for the test'})`
			);

			const later = await priceFor(db, DANA, {
				customerNo: paid.customer_no,
				itemNo: paid.item_no,
				onDate: '2026-10-20'
			});
			// The rule will not carry a price forward that no longer pays, so it
			// drops to the tier price and says the tier price is below the floor.
			expect(later!.rule).toBe('group discount');
			expect(later!.unitCost).toBeCloseTo(steep, 2);
			expect(later!.belowFloor).toBe(true);
		} finally {
			await db.asSystem((tx) =>
				tx.sql`delete from nl.item_costs where item_no = ${paid.item_no} and effective_from = ${future}::date`
			);
		}
	});

	it('prices a whole quote in order, and names the lines it could not price', async () => {
		const [customerNo] = await bestAccounts(1);
		const items = await bestSellers(3);
		const priced = await priceLines(db, DANA, {
			customerNo,
			lines: [
				{ itemNo: items[0], quantity: 4 },
				{ itemNo: 'NO-SUCH-PART', quantity: 1 },
				{ itemNo: items[1], quantity: 10 },
				{ itemNo: items[2], quantity: 1 }
			]
		});

		expect(priced.lines.map((line) => line.lineNo)).toEqual([1, 3, 4]);
		expect(priced.unknownItems).toEqual(['NO-SUCH-PART']);
		for (const line of priced.lines) {
			expect(line.extended, line.itemNo).toBeCloseTo(
				Math.round(line.quantity * line.price * 100) / 100,
				2
			);
		}
		expect(priced.total).toBeCloseTo(
			priced.lines.reduce((sum, line) => sum + line.extended, 0),
			2
		);
		expect(priced.belowFloor).toBe(priced.lines.filter((line) => line.belowFloor).length);

		// An empty quote asks the database nothing.
		expect(await priceLines(db, DANA, { customerNo, lines: [] })).toEqual({
			lines: [],
			total: 0,
			belowFloor: 0,
			unknownItems: []
		});
	});
});

describe('the seed extras', () => {
	it('writes agreements that do not overlap, some open and some expired', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{
				agreements: number;
				accounts: number;
				open: number;
				expired: number;
				overlaps: number;
				backwards: number;
				under_tier: number;
			}>`
				select
					count(*)::int as agreements,
					count(distinct cp.customer_no)::int as accounts,
					count(*) filter (where cp.valid_to is null)::int as open,
					count(*) filter (where cp.valid_to < nl.today())::int as expired,
					(select count(*)
					 from nl.customer_prices a
					 join nl.customer_prices b
					   on b.customer_no = a.customer_no and b.item_no = a.item_no
					  and b.valid_from > a.valid_from
					 where coalesce(a.valid_to, date '9999-12-31') >= b.valid_from)::int as overlaps,
					count(*) filter (where cp.valid_to is not null and cp.valid_to < cp.valid_from)::int as backwards,
					count(*) filter (where cp.net_price <= round(i.list_price * (1 - pg.discount), 2))::int
						as under_tier
				from nl.customer_prices cp
				join nl.items i on i.item_no = cp.item_no
				join nl.customers c on c.customer_no = cp.customer_no
				join nl.price_groups pg on pg.code = c.price_group`
		);
		expect(check.agreements).toBeGreaterThan(5);
		expect(check.accounts).toBeGreaterThan(1);
		expect(check.open).toBeGreaterThan(0);
		expect(check.expired).toBeGreaterThan(0);
		expect(check.overlaps).toBe(0);
		expect(check.backwards).toBe(0);
		// Every seeded agreement sits at or under the tier price it replaces.
		expect(check.under_tier).toBe(check.agreements);
	});

	it('writes no em dash and nothing that reads like marketing', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ dashes: number; banned: number }>`
				with text_rows as (
					select note from nl.item_costs
					union all select note from nl.customer_prices
					union all select note from nl.freight_periods
					union all select note from nl.fuel_surcharge
				)
				select
					count(*) filter (where note like '%' || chr(8212) || '%')::int as dashes,
					-- The word the name scan refuses, spelled in character codes so
					-- this file does not contain it either.
					count(*) filter (where position(chr(114) || chr(117) || chr(115) || chr(104)
					                           in lower(note)) > 0)::int as banned
				from text_rows`
		);
		expect(check.dashes).toBe(0);
		expect(check.banned).toBe(0);
	});
});

describe('access', () => {
	it('lets the assistant\'s read-only role read the money, and nobody write it', async () => {
		const rows = await db.asReadonly((tx) =>
			tx.sql<{ costs: number; agreements: number; rates: number }>`
				select
					(select count(*) from nl.item_costs)::int as costs,
					(select count(*) from nl.customer_prices)::int as agreements,
					(select count(*) from nl.freight_rates)::int as rates`
		);
		expect(rows[0].costs).toBeGreaterThan(0);
		expect(rows[0].agreements).toBeGreaterThan(0);
		expect(rows[0].rates).toBeGreaterThan(0);

		// It can price, which is what the assistant needs, and it cannot write.
		const [price] = await db.asReadonly((tx) =>
			tx.sql<{ rule: string }>`
				select rule from nl.price_for(
					(select customer_no from nl.customers order by customer_no limit 1),
					(select item_no from nl.items order by item_no limit 1),
					nl.today())`
		);
		expect(price.rule).toBeDefined();

		const write = db.asUser(DANA, (tx) =>
			tx.sql`insert into nl.item_costs (item_no, effective_from, unit_cost, source)
			       values ((select item_no from nl.items limit 1), date '2030-01-01', 1, 'vendor quote')`
		);
		await expect(write).rejects.toThrow();
	});
});
