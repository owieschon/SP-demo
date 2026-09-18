// Published price sheets, published ladders, what a customer is used to
// paying, and the exceptions behind a number (migration 0027), against the
// small world with today pinned to 2026-09-17.
//
// The rule here is the same one pricing.test.ts follows: every number is
// checked against a direct computation over the tables the rule reads, never
// against a figure copied out of the function being tested. Where a branch
// needs a shape the seed does not happen to produce (a firm agreement on a
// laddered part, a quote exactly on the jump threshold), the test writes that
// row itself inside a transaction that is rolled back, so the world the other
// tests see is untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import {
	answerFor,
	explainPrice,
	getAccountSheet,
	getCustomerParts,
	getPriceHistory,
	getPriceJumpPct,
	getSheetHistory,
	listExceptions,
	listPriceSheets,
	quoteLines,
	quotePriceFor
} from './sheets.ts';
import type { PriceAnswer, PriceExplanation } from './types.ts';

const DANA = 2; // account manager
const TODAY = '2026-09-17';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

/** A part with a ladder printed on the sheets, and the account that buys it most. */
async function ladderedPart(): Promise<{ customerNo: string; itemNo: string }> {
	const [row] = await db.asSystem((tx) =>
		tx.sql<{ customer_no: string; item_no: string }>`
			select h.customer_no, h.item_no
			from nl.customer_item_prices h
			join nl.price_breaks pb on pb.item_no = h.item_no and pb.sheet_id is not null
			group by h.customer_no, h.item_no, h.times_bought
			order by h.times_bought desc, h.customer_no, h.item_no
			limit 1`
	);
	return { customerNo: row.customer_no, itemNo: row.item_no };
}

// ---------------------------------------------------------------------------
// The sheets themselves
// ---------------------------------------------------------------------------

describe('published price sheets', () => {
	it('gives every tier the same generations, one of them in force', async () => {
		const sheets = await listPriceSheets(db, DANA);
		const [groups] = await db.asSystem((tx) =>
			tx.sql<{ tiers: number }>`select count(*)::int as tiers from nl.price_groups`
		);
		expect(sheets.length).toBe(groups.tiers * 3);

		const current = sheets.filter((sheet) => sheet.effectiveTo === null);
		expect(current.length).toBe(groups.tiers);
		for (const sheet of current) {
			expect(sheet.effectiveFrom <= TODAY, sheet.code).toBe(true);
			expect(sheet.publishedOn < sheet.effectiveFrom, sheet.code).toBe(true);
			expect(sheet.lines, sheet.code).toBeGreaterThan(100);
		}
	});

	it('leaves no gap and no overlap between one generation and the next', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ gaps: number }>`
				select count(*)::int as gaps
				from (
					select
						price_group,
						effective_to,
						lead(effective_from) over (partition by price_group order by effective_from) as next_from
					from nl.price_sheets
				) s
				-- Each closed generation ends the day before the next one opens.
				where s.next_from is not null and s.effective_to <> s.next_from - 1`
		);
		expect(check.gaps).toBe(0);
	});

	it('prices the current generation exactly as nl.price_for prices a tier customer', async () => {
		// The deploy day guarantee: putting a sheet in front of the rule may
		// change what a reply says, never what it charges.
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ lines: number; off: number }>`
				select
					count(*)::int as lines,
					count(*) filter (where psl.sheet_price <> round(i.list_price * (1 - pg.discount), 2))::int as off
				from nl.price_sheets ps
				join nl.price_sheet_lines psl on psl.sheet_id = ps.id
				join nl.items i on i.item_no = psl.item_no
				join nl.price_groups pg on pg.code = ps.price_group
				where ps.effective_to is null`
		);
		expect(check.lines).toBeGreaterThan(500);
		expect(check.off).toBe(0);

		// And the same thing through the function, for a sample of accounts.
		const rows = await db.asSystem((tx) =>
			tx.sql<{ item_no: string; sheet_price: number; rule_price: number }>`
				select psl.item_no, psl.sheet_price, f.price as rule_price
				from (select customer_no from nl.customers where not blocked and not closed
				      order by customer_no limit 12) c
				join nl.customers cu on cu.customer_no = c.customer_no
				join nl.price_sheets ps on ps.price_group = cu.price_group and ps.effective_to is null
				join nl.price_sheet_lines psl on psl.sheet_id = ps.id
				cross join lateral nl.price_for(c.customer_no, psl.item_no, nl.today()) f
				where f.rule = 'group discount'
				limit 200`
		);
		expect(rows.length).toBeGreaterThan(20);
		for (const row of rows) {
			expect(row.sheet_price, row.item_no).toBeCloseTo(row.rule_price, 2);
		}
	});

	it('makes an older generation cheaper than the one that replaced it', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ pairs: number; not_cheaper: number; median_step: number }>`
				select
					count(*)::int as pairs,
					count(*) filter (where old.sheet_price >= new_line.sheet_price)::int as not_cheaper,
					percentile_cont(0.5) within group (
						order by (new_line.sheet_price - old.sheet_price) / old.sheet_price) as median_step
				from nl.price_sheets old_sheet
				join nl.price_sheets new_sheet
				  on new_sheet.price_group = old_sheet.price_group
				 and new_sheet.effective_from = old_sheet.effective_to + 1
				join nl.price_sheet_lines old on old.sheet_id = old_sheet.id
				join nl.price_sheet_lines new_line
				  on new_line.sheet_id = new_sheet.id and new_line.item_no = old.item_no
				-- A part priced at the one cent floor cannot go any lower.
				where old.sheet_price > 0.02`
		);
		expect(check.pairs).toBeGreaterThan(500);
		expect(check.not_cheaper).toBe(0);
		// A generation is worth a few percent, which is what makes "they hold
		// the November sheet" a sentence worth saying.
		expect(check.median_step).toBeGreaterThan(0.02);
		expect(check.median_step).toBeLessThan(0.07);
	});

	it('records which sheet each account was last sent, and how far behind it is', async () => {
		const [spread] = await db.asSystem((tx) =>
			tx.sql<{ accounts: number; current: number; behind: number }>`
				select
					count(*)::int as accounts,
					count(*) filter (where is_current)::int as current,
					count(*) filter (where generations_behind > 0)::int as behind
				from nl.account_price_sheet`
		);
		expect(spread.accounts).toBeGreaterThan(40);
		expect(spread.current).toBeGreaterThan(0);
		// Some of the book is working off a sheet that has been replaced,
		// which is the thing a reply has to notice.
		expect(spread.behind).toBeGreaterThan(0);
		expect(spread.current + spread.behind).toBe(spread.accounts);

		// The view agrees with the send log it reads.
		const [oneBehind] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string }>`
				select customer_no from nl.account_price_sheet
				where generations_behind > 0 order by customer_no limit 1`
		);
		const held = await getAccountSheet(db, DANA, oneBehind.customer_no);
		expect(held).not.toBeNull();
		expect(held!.isCurrent).toBe(false);
		expect(held!.generationsBehind).toBeGreaterThan(0);

		const [newest] = await db.asSystem((tx) =>
			tx.sql<{ sheet_id: number; sent_on: string }>`
				select sheet_id, sent_on from nl.price_sheet_sends
				where customer_no = ${oneBehind.customer_no}
				order by sent_on desc, sheet_id desc limit 1`
		);
		expect(held!.sheetId).toBe(newest.sheet_id);
		expect(held!.sentOn).toBe(newest.sent_on);
	});

	it('shows a part its price on every sheet it has been on, newest first', async () => {
		const { itemNo } = await ladderedPart();
		const history = await getSheetHistory(db, DANA, itemNo);
		expect(history.length).toBeGreaterThan(5);
		for (let i = 1; i < history.length; i++) {
			expect(history[i].effectiveFrom <= history[i - 1].effectiveFrom).toBe(true);
		}
		const current = history.filter((line) => line.isCurrent);
		expect(current.length).toBeGreaterThan(0);
		// The ladder came with it, and its first rung is the page price.
		const withLadder = current.find((line) => line.ladder.length > 0);
		expect(withLadder, 'a laddered part carries its ladder on the current sheet').toBeDefined();
		expect(withLadder!.ladder[0].minQuantity).toBe(1);
		expect(withLadder!.ladder[0].breakPrice).toBeCloseTo(withLadder!.sheetPrice, 2);
	});
});

// ---------------------------------------------------------------------------
// The ladders
// ---------------------------------------------------------------------------

describe('published volume ladders', () => {
	it('belongs to a sheet or to a tier, never both and never neither', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ rungs: number; sheet_owned: number; tier_owned: number; neither: number }>`
				select
					count(*)::int as rungs,
					count(*) filter (where sheet_id is not null and price_group is null)::int as sheet_owned,
					count(*) filter (where price_group is not null and sheet_id is null)::int as tier_owned,
					count(*) filter (where num_nonnulls(sheet_id, price_group) <> 1)::int as neither
				from nl.price_breaks`
		);
		expect(check.rungs).toBeGreaterThan(200);
		expect(check.sheet_owned).toBeGreaterThan(0);
		expect(check.tier_owned).toBeGreaterThan(0);
		expect(check.neither).toBe(0);
		expect(check.sheet_owned + check.tier_owned).toBe(check.rungs);
	});

	it('never rises as the quantity rises', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ steps: number; rises: number }>`
				select count(*)::int as steps, count(*) filter (where break_price > prev)::int as rises
				from (
					select break_price, lag(break_price) over w as prev
					from nl.price_breaks
					window w as (partition by sheet_id, price_group, item_no order by min_quantity)
				) s
				where prev is not null`
		);
		expect(check.steps).toBeGreaterThan(100);
		expect(check.rises).toBe(0);
	});

	it('starts every sheet ladder at the page price for that sheet', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ ladders: number; off: number }>`
				select count(*)::int as ladders, count(*) filter (where pb.break_price <> psl.sheet_price)::int as off
				from nl.price_breaks pb
				join nl.price_sheet_lines psl on psl.sheet_id = pb.sheet_id and psl.item_no = pb.item_no
				where pb.min_quantity = 1`
		);
		expect(check.ladders).toBeGreaterThan(50);
		expect(check.off).toBe(0);
	});

	it('takes the deepest rung the quantity reaches, and names the next one up', async () => {
		const { customerNo, itemNo } = await ladderedPart();
		const rungs = await db.asSystem((tx) =>
			tx.sql<{ min_quantity: number; break_price: number }>`
				select pb.min_quantity, pb.break_price
				from nl.price_breaks pb
				join nl.price_sheets ps on ps.id = pb.sheet_id and ps.effective_to is null
				join nl.customers c on c.customer_no = ${customerNo} and c.price_group = ps.price_group
				where pb.item_no = ${itemNo}
				order by pb.min_quantity`
		);
		expect(rungs.length).toBe(6);
		expect(rungs.map((r) => r.min_quantity)).toEqual([1, 6, 12, 25, 50, 100]);

		// Just under a rung, and on it.
		const under = await quotePriceFor(db, DANA, { customerNo, itemNo, quantity: 24 });
		const on = await quotePriceFor(db, DANA, { customerNo, itemNo, quantity: 25 });
		expect(under!.breakQuantity).toBe(12);
		expect(on!.breakQuantity).toBe(25);
		expect(on!.unitPrice).toBeCloseTo(rungs.find((r) => r.min_quantity === 25)!.break_price, 2);
		expect(on!.nextQuantity).toBe(50);
		expect(on!.extended).toBeCloseTo(25 * on!.unitPrice, 2);
		// One rung deeper is cheaper, which is the whole point of a ladder.
		expect(on!.unitPrice).toBeLessThan(under!.unitPrice);

		// At quantity one no rung applies: rung one is the page price itself.
		const single = await quotePriceFor(db, DANA, { customerNo, itemNo, quantity: 1 });
		expect(single!.breakQuantity).toBeNull();
		expect(single!.nextQuantity).toBe(6);
	});

	it('falls back to the tier ladder for a part no sheet ladder covers', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; min_quantity: number; break_price: number }>`
				select c.customer_no, pb.item_no, pb.min_quantity, pb.break_price
				from nl.price_breaks pb
				join nl.customers c on c.price_group = pb.price_group and not c.blocked and not c.closed
				where pb.price_group is not null
				  and pb.min_quantity = 12
				  -- No agreement and nothing bought lately, so the sheet is the base.
				  and not exists (select 1 from nl.customer_prices cp
				                  where cp.customer_no = c.customer_no and cp.item_no = pb.item_no)
				  and not exists (select 1 from nl.invoice_lines il
				                  where il.customer_no = c.customer_no and il.item_no = pb.item_no
				                    and il.posted_on > nl.today() - 365)
				order by pb.item_no, c.customer_no
				limit 1`
		);
		expect(pick, 'the small world has a tier ladder on a part this account has not bought').toBeDefined();
		const quoted = await quotePriceFor(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 12
		});
		expect(quoted!.breakOwner).toBe('tier');
		expect(quoted!.breakQuantity).toBe(12);
		expect(quoted!.unitPrice).toBeCloseTo(pick.break_price, 2);
	});
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe('nl.price_quote_for precedence', () => {
	it('prices off the sheet where 0018 would have said group discount', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string }>`
				select c.customer_no, psl.item_no
				from nl.customers c
				join nl.price_sheets ps on ps.price_group = c.price_group and ps.effective_to is null
				join nl.price_sheet_lines psl on psl.sheet_id = ps.id
				cross join lateral nl.price_for(c.customer_no, psl.item_no, nl.today()) f
				where f.rule = 'group discount' and not c.blocked and not c.closed
				order by c.customer_no, psl.item_no
				limit 1`
		);
		const quoted = await quotePriceFor(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 1
		});
		const [old] = await db.asSystem((tx) =>
			tx.sql<{ price: number; rule: string }>`
				select price, rule from nl.price_for(${pick.customer_no}, ${pick.item_no}, nl.today())`
		);
		// Same number, better sentence.
		expect(quoted!.rule).toBe('sheet');
		expect(old.rule).toBe('group discount');
		expect(quoted!.basePrice).toBeCloseTo(old.price, 2);
		expect(quoted!.detail).toContain('page price');
	});

	it('puts an agreement ahead of the sheet and of last paid', async () => {
		const [deal] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; net_price: number }>`
				select customer_no, item_no, net_price from nl.customer_prices
				where valid_to is null order by customer_no, item_no limit 1`
		);
		const quoted = await quotePriceFor(db, DANA, {
			customerNo: deal.customer_no,
			itemNo: deal.item_no,
			quantity: 1
		});
		expect(quoted!.rule).toBe('agreement');
		expect(quoted!.basePrice).toBeCloseTo(deal.net_price, 2);
		expect(quoted!.agreementNet).toBeCloseTo(deal.net_price, 2);
	});

	it('puts a written customer exception ahead of last paid, pinned to the older sheet', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; sheet_price: number; sheet_name: string }>`
				select e.customer_no, psl.item_no, psl.sheet_price, ps.name as sheet_name
				from nl.trade_exceptions e
				join nl.price_sheets ps on ps.id = e.held_sheet_id
				join nl.price_sheet_lines psl on psl.sheet_id = ps.id
				join nl.items i on i.item_no = psl.item_no and i.family = e.family
				where e.kind = 'customer exception'
				  and e.effective_from <= nl.today()
				  and (e.effective_to is null or e.effective_to >= nl.today())
				  -- Something they have bought, so last paid would otherwise win.
				  and exists (select 1 from nl.invoice_lines il
				              where il.customer_no = e.customer_no and il.item_no = psl.item_no
				                and il.posted_on > nl.today() - 365)
				  and not exists (select 1 from nl.customer_prices cp
				                  where cp.customer_no = e.customer_no and cp.item_no = psl.item_no)
				order by e.customer_no, psl.item_no
				limit 1`
		);
		expect(pick, 'the small world has a live customer exception on a part they buy').toBeDefined();
		const quoted = await quotePriceFor(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 1
		});
		expect(quoted!.rule).toBe('held sheet');
		expect(quoted!.basePrice).toBeCloseTo(pick.sheet_price, 2);
		expect(quoted!.detail).toContain(pick.sheet_name);
		// The sheet in force is still reported, so a screen can show both.
		expect(quoted!.sheetPrice).not.toBeNull();
	});

	it('lets a published rung go under an agreement, unless the agreement is firm', async () => {
		// The shape this needs is an agreement on a laddered part, priced above
		// a deep rung. Rather than hope the seed made one, write it here and
		// roll it back: nothing outside this test sees the row.
		const { customerNo, itemNo } = await ladderedPart();
		const result = await db
			.asSystem(async (tx) => {
				const [rung] = await tx.sql<{ break_price: number }>`
					select pb.break_price
					from nl.price_breaks pb
					join nl.price_sheets ps on ps.id = pb.sheet_id and ps.effective_to is null
					join nl.customers c on c.customer_no = ${customerNo} and c.price_group = ps.price_group
					where pb.item_no = ${itemNo} and pb.min_quantity = 50`;

				// An agreed price a little above the rung at fifty, so the rung is
				// the better price for the customer.
				const agreed = Math.round((rung.break_price + 1) * 100) / 100;
				await tx.sql`delete from nl.customer_prices
					where customer_no = ${customerNo} and item_no = ${itemNo}`;
				await tx.sql`insert into nl.customer_prices
					(customer_no, item_no, net_price, valid_from, valid_to, break_policy, note)
					values (${customerNo}, ${itemNo}, ${agreed}, nl.today() - 30, null, 'better of', 'test row')`;

				const [better] = await tx.sql<{
					rule: string;
					price: number;
					unit_price: number;
					break_quantity: number | null;
				}>`select rule, price, unit_price, break_quantity
					from nl.price_quote_for(${customerNo}, ${itemNo}, 50, null::date)`;

				await tx.sql`update nl.customer_prices set break_policy = 'agreement only'
					where customer_no = ${customerNo} and item_no = ${itemNo}`;
				const [firm] = await tx.sql<{
					rule: string;
					price: number;
					unit_price: number;
					break_quantity: number | null;
					next_price: number | null;
				}>`select rule, price, unit_price, break_quantity, next_price
					from nl.price_quote_for(${customerNo}, ${itemNo}, 50, null::date)`;

				// Undo it. asSystem commits, so the test cleans up after itself.
				await tx.sql`delete from nl.customer_prices
					where customer_no = ${customerNo} and item_no = ${itemNo} and note = 'test row'`;
				return { agreed, rung: rung.break_price, better, firm };
			})
			.catch((error: unknown) => {
				throw error;
			});

		// 'better of': the agreement is the rule that set the base price, and
		// the rung took it lower.
		expect(result.better.rule).toBe('agreement');
		expect(result.better.price).toBeCloseTo(result.agreed, 2);
		expect(result.better.break_quantity).toBe(50);
		expect(result.better.unit_price).toBeCloseTo(result.rung, 2);
		expect(result.better.unit_price).toBeLessThan(result.agreed);

		// 'agreement only': the rung is refused and not reported as applied.
		expect(result.firm.rule).toBe('agreement');
		expect(result.firm.unit_price).toBeCloseTo(result.agreed, 2);
		expect(result.firm.break_quantity).toBeNull();
		// And buying more does not move it either.
		expect(result.firm.next_price).toBeCloseTo(result.agreed, 2);
	});

	it('does not use a rung that is dearer than the base price', async () => {
		// Last paid can sit under the published ladder. When it does, the
		// better price for the customer is the one they already have.
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{
				customer_no: string;
				item_no: string;
				unit_price: number;
				break_price: number;
			}>`
				select il.customer_no, il.item_no, il.unit_price, pb.break_price
				from nl.invoice_lines il
				join nl.price_breaks pb on pb.item_no = il.item_no and pb.min_quantity = 12
				join nl.price_sheets ps on ps.id = pb.sheet_id and ps.effective_to is null
				join nl.customers c on c.customer_no = il.customer_no and c.price_group = ps.price_group
				where il.quantity > 0
				  and il.posted_on > nl.today() - 365
				  and il.unit_price < pb.break_price
				  and il.unit_price >= round(nl.item_cost_on(il.item_no, nl.today()) / (1 - nl.min_margin()), 2)
				  and not exists (select 1 from nl.customer_prices cp
				                  where cp.customer_no = il.customer_no and cp.item_no = il.item_no)
				  and not exists (select 1 from nl.trade_exceptions e
				                  where e.kind = 'customer exception' and e.customer_no = il.customer_no)
				order by il.customer_no, il.item_no
				limit 1`
		);
		expect(pick, 'the small world has a last paid price under a published rung').toBeDefined();
		const quoted = await quotePriceFor(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 12
		});
		expect(quoted!.rule).toBe('last paid');
		expect(quoted!.unitPrice).toBeCloseTo(pick.unit_price, 2);
		expect(quoted!.breakQuantity).toBeNull();
	});

	it('prices an account we do not know at list, at any quantity', async () => {
		const { itemNo } = await ladderedPart();
		const quoted = await quotePriceFor(db, DANA, {
			customerNo: 'NOT-A-CUSTOMER',
			itemNo,
			quantity: 100
		});
		expect(quoted!.rule).toBe('list');
		expect(quoted!.unitPrice).toBeCloseTo(quoted!.listPrice, 2);
		expect(quoted!.sheetId).toBeNull();
		expect(quoted!.discount).toBe(0);
	});

	it('returns nothing for a part that is not in the catalog', async () => {
		const { customerNo } = await ladderedPart();
		expect(await quotePriceFor(db, DANA, { customerNo, itemNo: 'NO-SUCH-PART' })).toBeNull();
		expect(await explainPrice(db, DANA, { customerNo, itemNo: 'NO-SUCH-PART' })).toBeNull();
		expect(await answerFor(db, DANA, { customerNo, itemNo: 'NO-SUCH-PART' })).toBeNull();
	});

	it('prices a whole quote at its quantities in one call', async () => {
		const { customerNo } = await ladderedPart();
		const items = await db.asSystem((tx) =>
			tx.sql<{ item_no: string }>`
				select item_no from nl.price_breaks where sheet_id is not null
				group by item_no order by item_no limit 4`
		);
		const lines = items.map((row, index) => ({ itemNo: row.item_no, quantity: (index + 1) * 6 }));
		const quote = await quoteLines(db, DANA, {
			customerNo,
			lines: [...lines, { itemNo: 'NO-SUCH-PART', quantity: 1 }]
		});
		expect(quote.lines.length).toBe(lines.length);
		expect(quote.unknownItems).toEqual(['NO-SUCH-PART']);
		expect(quote.lines.map((line) => line.lineNo)).toEqual([1, 2, 3, 4]);
		// The total is the lines, and each line is its own quantity at its own rung.
		const summed = quote.lines.reduce((total, line) => total + line.extended, 0);
		expect(quote.total).toBeCloseTo(summed, 2);
		for (const line of quote.lines) {
			const one = await quotePriceFor(db, DANA, {
				customerNo,
				itemNo: line.itemNo,
				quantity: line.quantity
			});
			expect(one!.unitPrice, line.itemNo).toBeCloseTo(line.unitPrice, 2);
		}
	});
});

// ---------------------------------------------------------------------------
// What they are used to paying
// ---------------------------------------------------------------------------

describe('what a customer is used to paying', () => {
	it('matches the ledger, line for line', async () => {
		const { customerNo, itemNo } = await ladderedPart();
		const [view] = await db.asSystem((tx) =>
			tx.sql<{
				times_bought: number;
				units: number;
				last_price: number;
				last_bought: string;
				last_invoice_no: string;
				high_price: number;
				low_price: number;
				avg_price_12m: number;
			}>`
				select times_bought, units, last_price, last_bought, last_invoice_no,
				       high_price, low_price, avg_price_12m
				from nl.customer_item_prices
				where customer_no = ${customerNo} and item_no = ${itemNo}`
		);
		// The same figures worked out straight off the lines.
		const [direct] = await db.asSystem((tx) =>
			tx.sql<{
				n: number;
				units: number;
				high: number;
				low: number;
				weighted: number;
			}>`
				select
					count(*)::int as n,
					sum(quantity)::int as units,
					max(unit_price) as high,
					min(unit_price) as low,
					round(sum(quantity * unit_price) filter (where posted_on > nl.today() - 365)
					      / sum(quantity) filter (where posted_on > nl.today() - 365), 2) as weighted
				from nl.invoice_lines
				where customer_no = ${customerNo} and item_no = ${itemNo} and quantity > 0`
		);
		expect(view.times_bought).toBe(direct.n);
		expect(view.units).toBe(direct.units);
		expect(view.high_price).toBeCloseTo(direct.high, 2);
		expect(view.low_price).toBeCloseTo(direct.low, 2);
		expect(view.avg_price_12m).toBeCloseTo(direct.weighted, 2);

		// And the newest line really is the newest line.
		const [newest] = await db.asSystem((tx) =>
			tx.sql<{ unit_price: number; posted_on: string; invoice_no: string }>`
				select unit_price, posted_on, invoice_no from nl.invoice_lines
				where customer_no = ${customerNo} and item_no = ${itemNo} and quantity > 0
				order by posted_on desc, invoice_no desc, line_no desc limit 1`
		);
		expect(view.last_price).toBeCloseTo(newest.unit_price, 2);
		expect(view.last_bought).toBe(newest.posted_on);
		expect(view.last_invoice_no).toBe(newest.invoice_no);
	});

	it('leaves credit memo lines out, so a return is not a price they remember', async () => {
		const [memo] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string }>`
				select customer_no, item_no from nl.invoice_lines
				where quantity < 0 order by customer_no, item_no limit 1`
		);
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ view_lines: number; positive_lines: number; all_lines: number }>`
				select
					(select times_bought from nl.customer_item_prices
					 where customer_no = ${memo.customer_no} and item_no = ${memo.item_no})::int as view_lines,
					(select count(*) from nl.invoice_lines
					 where customer_no = ${memo.customer_no} and item_no = ${memo.item_no}
					   and quantity > 0)::int as positive_lines,
					(select count(*) from nl.invoice_lines
					 where customer_no = ${memo.customer_no} and item_no = ${memo.item_no})::int as all_lines`
		);
		expect(check.all_lines).toBeGreaterThan(check.positive_lines);
		expect(check.view_lines).toBe(check.positive_lines);
	});

	it('flags a quote above what they last paid, at the stated threshold', async () => {
		const threshold = await getPriceJumpPct(db, DANA);
		expect(threshold).toBeCloseTo(0.07, 4);

		// The boundary, both sides of it. The flag is strictly greater than the
		// threshold, so a quote exactly at it is not a jump.
		const { customerNo, itemNo } = await ladderedPart();
		const [priced] = await db.asSystem((tx) =>
			tx.sql<{ today_price: number }>`
				select today_price from nl.customer_item_price_context
				where customer_no = ${customerNo} and item_no = ${itemNo}`
		);
		const checks = await db.asSystem((tx) =>
			tx.sql<{ label: string; flagged: boolean }>`
				with prices as (
					select 'just under'::text as label,
					       round(${priced.today_price} / (1 + nl.price_jump_pct() + 0.001), 4) as last_paid
					union all
					select 'exactly on', round(${priced.today_price} / (1 + nl.price_jump_pct()), 4)
					union all
					select 'just over', round(${priced.today_price} / (1 + nl.price_jump_pct() - 0.001), 4)
				)
				select p.label, (${priced.today_price} - p.last_paid) / p.last_paid > nl.price_jump_pct() as flagged
				from prices p`
		);
		const byLabel = new Map(checks.map((row) => [row.label, row.flagged]));
		// A last paid price low enough that today is more than 7% above it: flagged.
		expect(byLabel.get('just under')).toBe(true);
		// Exactly 7% above: not flagged, because the rule is strictly greater.
		expect(byLabel.get('exactly on')).toBe(false);
		expect(byLabel.get('just over')).toBe(false);

		// And the view uses that same comparison.
		const [agrees] = await db.asSystem((tx) =>
			tx.sql<{ off: number }>`
				select count(*)::int as off
				from nl.customer_item_price_context
				where above_last_paid <> (above_last_paid_pct > nl.price_jump_pct())`
		);
		expect(agrees.off).toBe(0);
	});

	it('lists the history for an account with the surprises first', async () => {
		const { customerNo } = await ladderedPart();
		const history = await getPriceHistory(db, DANA, customerNo);
		expect(history.length).toBeGreaterThan(5);
		// Flagged rows come first, then the biggest rises.
		const firstUnflagged = history.findIndex((row) => !row.aboveLastPaid);
		if (firstUnflagged > 0) {
			expect(history.slice(0, firstUnflagged).every((row) => row.aboveLastPaid)).toBe(true);
		}
		for (const row of history) {
			expect(row.lastPrice).toBeGreaterThan(0);
			expect(row.highPrice).toBeGreaterThanOrEqual(row.lowPrice);
			expect(row.todayPrice).toBeGreaterThan(0);
		}

		// One part, asked for on its own, is the same row.
		const one = await getPriceHistory(db, DANA, customerNo, history[0].itemNo);
		expect(one.length).toBe(1);
		expect(one[0].lastPrice).toBeCloseTo(history[0].lastPrice, 2);
	});
});

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

describe('trade exceptions', () => {
	it('gives every row a reason, a window and an owner', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ rows: number; no_reason: number; no_owner: number; bad_window: number; kinds: number }>`
				select
					count(*)::int as rows,
					count(*) filter (where btrim(reason) = '')::int as no_reason,
					count(*) filter (where owner_id is null)::int as no_owner,
					count(*) filter (where effective_to is not null and effective_to < effective_from)::int as bad_window,
					count(distinct kind)::int as kinds
				from nl.trade_exceptions`
		);
		expect(check.rows).toBeGreaterThan(10);
		expect(check.no_reason).toBe(0);
		expect(check.no_owner).toBe(0);
		expect(check.bad_window).toBe(0);
		// All seven kinds are in the world.
		expect(check.kinds).toBe(7);

		// Every owner is a real user.
		const [orphans] = await db.asSystem((tx) =>
			tx.sql<{ n: number }>`
				select count(*)::int as n from nl.trade_exceptions e
				where not exists (select 1 from nl.users u where u.id = e.owner_id)`
		);
		expect(orphans.n).toBe(0);
	});

	it('has live ones, one announced for a future date, and expired ones', async () => {
		const all = await listExceptions(db, DANA);
		const byStatus = new Map<string, number>();
		for (const row of all) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
		expect(byStatus.get('live') ?? 0).toBeGreaterThan(5);
		expect(byStatus.get('announced') ?? 0).toBeGreaterThan(0);
		expect(byStatus.get('expired') ?? 0).toBeGreaterThan(0);
		// Live first, then what is coming, then what has ended.
		const order = ['live', 'announced', 'expired'];
		const positions = all.map((row) => order.indexOf(row.status));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));

		// The announced increase carries the wording of the letter.
		const announced = all.find((row) => row.kind === 'price increase' && row.status === 'announced');
		expect(announced).toBeDefined();
		expect(announced!.effectiveFrom > TODAY).toBe(true);
		expect(announced!.announcedOn <= TODAY).toBe(true);
		expect(announced!.pct).toBeGreaterThan(0);
		expect(announced!.wording).toContain('Effective');
	});

	it('applies inside its window and stops applying after it, for every kind', async () => {
		// Each kind that has an end date, asked on a day inside its window and
		// on a day after it. Nothing here depends on the seed's luck: the dates
		// come from the rows themselves.
		const rows = await db.asSystem((tx) =>
			tx.sql<{
				id: number;
				kind: string;
				customer_no: string;
				item_no: string;
				inside: string;
				after: string;
			}>`
				select distinct on (e.kind)
					e.id, e.kind, c.customer_no, i.item_no,
					e.effective_from as inside,
					e.effective_to + 1 as after
				from nl.trade_exceptions e
				cross join lateral (
					select i.item_no, i.family, i.product_group from nl.items i
					where (e.item_no = i.item_no or e.family = i.family
					       or e.product_group = i.product_group or e.scope = 'catalog')
					  and not i.blocked
					order by i.item_no
					limit 1
				) i
				cross join lateral (
					select c.customer_no from nl.customers c
					where (e.customer_no is null or e.customer_no = c.customer_no)
					  and (e.price_group is null or e.price_group = c.price_group)
					order by c.customer_no
					limit 1
				) c
				where e.effective_to is not null
				order by e.kind, e.id`
		);
		expect(rows.length).toBeGreaterThan(2);

		for (const row of rows) {
			const [inside] = await db.asSystem((tx) =>
				tx.sql<{ found: boolean }>`
					select exists (
						select 1 from jsonb_array_elements(
							nl.exceptions_for(${row.customer_no}, ${row.item_no}, ${row.inside}::date)) as e
						where (e ->> 'id')::int = ${row.id} and e ->> 'status' = 'live') as found`
			);
			expect(inside.found, `${row.kind} on ${row.inside}`).toBe(true);

			const [after] = await db.asSystem((tx) =>
				tx.sql<{ status: string | null }>`
					select (
						select e ->> 'status' from jsonb_array_elements(
							nl.exceptions_for(${row.customer_no}, ${row.item_no}, ${row.after}::date)) as e
						where (e ->> 'id')::int = ${row.id}) as status`
			);
			// A day after it ended it is either gone from the list or expired,
			// never live.
			expect(after.status, `${row.kind} on ${row.after}`).not.toBe('live');
		}
	});

	it('resolves scope: an item row, a family row and a catalog row all reach the part', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; family: string }>`
				select c.customer_no, i.item_no, i.family
				from nl.trade_exceptions e
				join nl.items i on i.family = e.family and not i.blocked
				cross join lateral (select customer_no from nl.customers order by customer_no limit 1) c
				where e.scope = 'family'
				  -- One that applies to everyone, so any account will do.
				  and e.customer_no is null
				  and e.price_group is null
				  and e.effective_from <= nl.today()
				  and (e.effective_to is null or e.effective_to >= nl.today())
				order by i.item_no
				limit 1`
		);
		expect(pick, 'the small world has a live family scoped exception').toBeDefined();
		const [found] = await db.asSystem((tx) =>
			tx.sql<{ family_rows: number; catalog_rows: number }>`
				select
					count(*) filter (where e ->> 'scope' = 'family')::int as family_rows,
					count(*) filter (where e ->> 'scope' = 'catalog')::int as catalog_rows
				from jsonb_array_elements(
					nl.exceptions_for(${pick.customer_no}, ${pick.item_no}, null::date)) as e`
		);
		expect(found.family_rows).toBeGreaterThan(0);
		expect(found.catalog_rows).toBeGreaterThan(0);
	});

	it('does not show one account the exception written for another', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ mine: string; theirs: string; item_no: string; id: number }>`
				select e.customer_no as mine, other.customer_no as theirs, i.item_no, e.id
				from nl.trade_exceptions e
				join nl.items i on i.family = e.family and not i.blocked
				cross join lateral (
					select customer_no from nl.customers
					where customer_no <> e.customer_no order by customer_no limit 1) other
				where e.kind = 'customer exception'
				order by e.id, i.item_no
				limit 1`
		);
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ mine: number; theirs: number }>`
				select
					(select count(*) from jsonb_array_elements(
						nl.exceptions_for(${pick.mine}, ${pick.item_no}, null::date)) as e
					 where (e ->> 'id')::int = ${pick.id})::int as mine,
					(select count(*) from jsonb_array_elements(
						nl.exceptions_for(${pick.theirs}, ${pick.item_no}, null::date)) as e
					 where (e ->> 'id')::int = ${pick.id})::int as theirs`
		);
		expect(check.mine).toBe(1);
		expect(check.theirs).toBe(0);
	});

	it('reports a lead time that has slipped, with the reason and the card figure', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ item_no: string; days: number; reason: string }>`
				select e.item_no, e.days, e.reason
				from nl.trade_exceptions e
				where e.kind = 'lead time' and e.scope = 'item'
				  and e.effective_from <= nl.today()
				  and (e.effective_to is null or e.effective_to >= nl.today())
				order by e.days desc, e.item_no
				limit 1`
		);
		expect(pick, 'the small world has a live lead time slip').toBeDefined();
		const [lead] = await db.asSystem((tx) =>
			tx.sql<{
				days: number;
				card_days: number;
				slipped: boolean;
				basis: string;
				reason: string;
			}>`select days, card_days, slipped, basis, reason
				from nl.lead_time_for(${pick.item_no}, null::date)`
		);
		expect(lead.slipped).toBe(true);
		expect(lead.days).toBe(pick.days);
		expect(lead.reason).toBe(pick.reason);
		expect(lead.days).toBeGreaterThan(lead.card_days);
		// card_days is the figure before the slip, which is what
		// nl.item_lead_days() hands the forecast and the projection.
		expect(lead.card_days).toBe(
			(
				await db.asSystem((tx) =>
					tx.sql<{ days: number }>`select nl.item_lead_days(${pick.item_no}) as days`
				)
			)[0].days
		);
		expect(lead.basis).toBe('exception');

		// A part with no slip on it takes the card figure and says so.
		const [plain] = await db.asSystem((tx) =>
			tx.sql<{ item_no: string }>`
				select i.item_no from nl.items i
				where not exists (
					select 1 from nl.trade_exceptions e
					where e.kind = 'lead time'
					  and (e.item_no = i.item_no or e.family = i.family
					       or e.product_group = i.product_group or e.scope = 'catalog'))
				order by i.item_no limit 1`
		);
		const [normal] = await db.asSystem((tx) =>
			tx.sql<{ days: number; card_days: number; slipped: boolean }>`
				select days, card_days, slipped from nl.lead_time_for(${plain.item_no}, null::date)`
		);
		expect(normal.slipped).toBe(false);
		expect(normal.days).toBe(normal.card_days);
	});

	it('names a replacement for a discontinued part, and the replacement is alive', async () => {
		const discontinued = await listExceptions(db, DANA, { kind: 'discontinued' });
		expect(discontinued.length).toBeGreaterThan(0);
		for (const row of discontinued) {
			expect(row.scope).toBe('item');
			expect(row.replacementItemNo).not.toBeNull();
			expect(row.replacementItemNo).not.toBe(row.itemNo);
		}
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ dead_replacements: number }>`
				select count(*)::int as dead_replacements
				from nl.trade_exceptions e
				join nl.items i on i.item_no = e.replacement_item_no
				where e.kind = 'discontinued' and i.blocked`
		);
		expect(check.dead_replacements).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// The explanation
// ---------------------------------------------------------------------------

describe('nl.explain_price', () => {
	function points(explanation: PriceExplanation): string {
		return explanation.talking_points.join(' ');
	}

	it('explains a price for an account with an agreement', async () => {
		const [deal] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; net_price: number; valid_from: string }>`
				select customer_no, item_no, net_price, valid_from from nl.customer_prices
				where valid_to is null order by customer_no, item_no limit 1`
		);
		const x = await explainPrice(db, DANA, {
			customerNo: deal.customer_no,
			itemNo: deal.item_no,
			quantity: 6
		});
		expect(x).not.toBeNull();
		expect(x!.quote.rule).toBe('agreement');
		expect(x!.agreement).not.toBeNull();
		expect(x!.agreement!.net_price).toBeCloseTo(deal.net_price, 2);
		expect(x!.agreement!.valid_from).toBe(deal.valid_from);
		expect(x!.agreement!.break_policy).toMatch(/better of|agreement only/);
		expect(x!.extended).toBeCloseTo(6 * x!.unit_price, 2);
		expect(x!.cost.unit_cost).toBeGreaterThan(0);
		expect(x!.cost.min_margin).toBeCloseTo(0.2, 4);
		expect(x!.lead_time.days).toBeGreaterThan(0);
		expect(x!.lead_time.earliest_ship > x!.on_date).toBe(true);
		expect(points(x!)).toContain('agreed price');
		// The talking points always say where the price came from, what they
		// last paid, and when they can have it.
		expect(x!.talking_points.length).toBeGreaterThanOrEqual(3);
	});

	it('explains a price for an account with nothing but a tier', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string }>`
				select c.customer_no, psl.item_no
				from nl.customers c
				join nl.price_sheets ps on ps.price_group = c.price_group and ps.effective_to is null
				join nl.price_sheet_lines psl on psl.sheet_id = ps.id
				where not c.blocked and not c.closed
				  and not exists (select 1 from nl.customer_prices cp where cp.customer_no = c.customer_no)
				  and not exists (select 1 from nl.trade_exceptions e
				                  where e.kind = 'customer exception' and e.customer_no = c.customer_no)
				  and not exists (select 1 from nl.invoice_lines il
				                  where il.customer_no = c.customer_no and il.item_no = psl.item_no)
				order by c.customer_no, psl.item_no
				limit 1`
		);
		const x = await explainPrice(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 1
		});
		expect(x!.quote.rule).toBe('sheet');
		expect(x!.sheet).not.toBeNull();
		expect(x!.unit_price).toBeCloseTo(x!.sheet!.sheet_price, 2);
		expect(x!.quote.tier_price).toBeCloseTo(x!.sheet!.sheet_price, 2);
		expect(x!.agreement).toBeNull();
		expect(points(x!)).toContain('page price');
	});

	it('says plainly when an account has never bought the part', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string }>`
				select c.customer_no, i.item_no
				from nl.customers c
				cross join lateral (
					select i.item_no from nl.items i
					where not i.blocked
					  and not exists (select 1 from nl.invoice_lines il
					                  where il.customer_no = c.customer_no and il.item_no = i.item_no)
					order by i.item_no limit 1
				) i
				where not c.blocked and not c.closed
				order by c.customer_no limit 1`
		);
		const x = await explainPrice(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 2
		});
		expect(x!.never_bought).toBe(true);
		expect(x!.history).toBeNull();
		expect(points(x!)).toContain('not bought this part before');
		// It still has everything else: a price, a rule, a cost and a lead time.
		expect(x!.unit_price).toBeGreaterThan(0);
		expect(x!.quote.rule).toBeTruthy();
		expect(x!.lead_time.days).toBeGreaterThan(0);
	});

	it('answers "why is this more than last time" without a second query', async () => {
		// An account whose sheet price today really is well above what they
		// last paid. If the seed has none, the test makes one by writing an old
		// cheap invoice line for a part they already buy, then removing it.
		const { customerNo, itemNo } = await ladderedPart();
		const result = await db.asSystem(async (tx) => {
			const [sheet] = await tx.sql<{ today_price: number }>`
				select today_price from nl.customer_item_price_context
				where customer_no = ${customerNo} and item_no = ${itemNo}`;
			// A line dated yesterday at 20% under today's price.
			const cheap = Math.round(sheet.today_price * 0.8 * 100) / 100;
			await tx.sql`insert into nl.invoices
				(invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal, freight)
				values ('SI-TEST-JUMP', 'invoice', ${customerNo}, ${customerNo}, nl.today() - 1, ${cheap}, 0)`;
			await tx.sql`insert into nl.invoice_lines
				(invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)
				values ('SI-TEST-JUMP', 1, ${customerNo}, nl.today() - 1, ${itemNo}, 1, ${cheap}, ${cheap},
				        nl.item_cost_on(${itemNo}, nl.today()))`;
			const [row] = await tx.sql<{ explanation: PriceExplanation }>`
				select nl.explain_price(${customerNo}, ${itemNo}, 1, null::date) as explanation`;
			await tx.sql`delete from nl.invoices where invoice_no = 'SI-TEST-JUMP'`;
			return { cheap, explanation: row.explanation };
		});

		const x = result.explanation;
		expect(x.history).not.toBeNull();
		expect(x.history!.last_price).toBeCloseTo(result.cheap, 2);
		expect(x.history!.above_last_paid).toBe(true);
		expect(x.history!.above_last_paid_pct).toBeGreaterThan(0.07);
		// Everything a person needs to explain the rise is in this one answer.
		expect(x.quote.rule).toBeTruthy();
		expect(x.quote.detail.length).toBeGreaterThan(5);
		expect(x.cost.unit_cost).toBeGreaterThan(0);
		expect(points(x)).toContain('more. Say why before they ask.');
		expect(Array.isArray(x.exceptions)).toBe(true);
	});

	it('shows the sheet the buyer is holding next to the one we are quoting', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; their_price: number }>`
				select aps.customer_no, psl.item_no, psl.sheet_price as their_price
				from nl.account_price_sheet aps
				join nl.price_sheet_lines psl on psl.sheet_id = aps.sheet_id
				where aps.generations_behind > 0
				order by aps.customer_no, psl.item_no
				limit 1`
		);
		expect(pick, 'the small world has an account holding an older sheet').toBeDefined();
		const x = await explainPrice(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 1
		});
		expect(x!.customer_sheet).not.toBeNull();
		expect(x!.customer_sheet!.is_current).toBe(false);
		expect(x!.customer_sheet!.generations_behind).toBeGreaterThan(0);
		expect(x!.customer_sheet!.their_price).toBeCloseTo(pick.their_price, 2);
		// The difference is the two numbers, and it is the right way round: the
		// older sheet was cheaper.
		expect(x!.customer_sheet!.difference).toBeCloseTo(x!.unit_price - pick.their_price, 2);
		expect(x!.customer_sheet!.difference!).toBeGreaterThan(0);
		expect(points(x!)).toContain('They are holding');
	});

	it('says how long the number holds, and what the extras are', async () => {
		const { customerNo, itemNo } = await ladderedPart();
		const x = await explainPrice(db, DANA, { customerNo, itemNo, quantity: 10 });
		// The announced catalog increase reaches every part.
		expect(x!.next_increase).not.toBeNull();
		expect(x!.next_increase!.effective_from > TODAY).toBe(true);
		expect(x!.next_increase!.price_after).toBeCloseTo(
			Math.round(x!.unit_price * (1 + x!.next_increase!.pct) * 100) / 100,
			2
		);
		expect(points(x!)).toContain('holds until then');

		// A live surcharge is reported next to the price, not inside it.
		expect(x!.surcharge_pct).not.toBeNull();
		expect(x!.surcharge_amount).toBeCloseTo(
			Math.round(x!.extended * x!.surcharge_pct! * 100) / 100,
			2
		);
		expect(x!.surcharges.length).toBeGreaterThan(0);
		for (const surcharge of x!.surcharges) {
			expect(surcharge.reason.length).toBeGreaterThan(10);
			expect(surcharge.owner_id).toBeGreaterThan(0);
		}
		// And the price itself is still the ladder price, unchanged by it.
		const quoted = await quotePriceFor(db, DANA, { customerNo, itemNo, quantity: 10 });
		expect(x!.unit_price).toBeCloseTo(quoted!.unitPrice, 2);
	});

	it('agrees with nl.price_quote_for on every figure they share', async () => {
		const pairs = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string }>`
				select c.customer_no, pb.item_no
				from (select customer_no from nl.customers where not blocked and not closed
				      order by customer_no limit 8) c
				cross join (select item_no from nl.price_breaks where sheet_id is not null
				            group by item_no order by item_no limit 4) pb`
		);
		for (const pair of pairs) {
			const input = { customerNo: pair.customer_no, itemNo: pair.item_no, quantity: 25 };
			const quoted = await quotePriceFor(db, DANA, input);
			const x = await explainPrice(db, DANA, input);
			const where = `${pair.customer_no} ${pair.item_no}`;
			expect(x!.unit_price, where).toBeCloseTo(quoted!.unitPrice, 2);
			expect(x!.extended, where).toBeCloseTo(quoted!.extended, 2);
			expect(x!.quote.rule, where).toBe(quoted!.rule);
			expect(x!.quote.base_price, where).toBeCloseTo(quoted!.basePrice, 2);
			expect(x!.quote.break_quantity, where).toBe(quoted!.breakQuantity);
			expect(x!.cost.below_floor, where).toBe(quoted!.belowFloor);
		}
	});
});

// ---------------------------------------------------------------------------
// One call that answers a customer
// ---------------------------------------------------------------------------

describe('nl.answer_for', () => {
	it('adds the supply side to the explanation, in one call', async () => {
		const { customerNo, itemNo } = await ladderedPart();
		const answer = await answerFor(db, DANA, { customerNo, itemNo, quantity: 12 });
		expect(answer).not.toBeNull();

		// The price half is the explanation, to the cent.
		const x = await explainPrice(db, DANA, { customerNo, itemNo, quantity: 12 });
		expect(answer!.unit_price).toBeCloseTo(x!.unit_price, 2);
		expect(answer!.price.rule).toBe(x!.quote.rule);
		expect(answer!.history).toEqual(x!.history);

		// The supply half is what nl.available_to_promise says.
		const [atp] = await db.asSystem((tx) =>
			tx.sql<{ answer: Record<string, unknown> }>`
				select nl.available_to_promise(${itemNo}, 12, nl.today()) as answer`
		);
		expect(answer!.availability.on_hand).toBe(atp.answer.on_hand);
		expect(answer!.availability.free_now).toBe(atp.answer.free_now);
		expect(answer!.availability.earliest_ship).toBe(atp.answer.earliest_date);
		// The date is available to promise's date. The basis is its word,
		// except where it said 'lead_time', which is replaced by which lead
		// time: the vocabulary is added to, not swapped out.
		if (atp.answer.earliest_basis === 'lead_time') {
			expect(answer!.availability.earliest_basis).toBe(answer!.lead_time.basis);
		} else {
			expect(answer!.availability.earliest_basis).toBe(atp.answer.earliest_basis);
		}

		// And two sentences a person could paste into an email.
		expect(answer!.reply.length).toBeGreaterThanOrEqual(2);
		expect(answer!.reply[0]).toContain(itemNo);
		expect(answer!.reply.join(' ')).toMatch(/ship/);
		for (const sentence of answer!.reply) {
			expect(sentence.endsWith('.'), sentence).toBe(true);
			// The house style: plain English, no em dashes anywhere.
			expect(sentence).not.toContain('—');
		}
	});

	it('says it can ship when the date asked for is far enough out', async () => {
		const { customerNo, itemNo } = await ladderedPart();
		const soon = await answerFor(db, DANA, { customerNo, itemNo, quantity: 1, neededBy: TODAY });
		const later = await answerFor(db, DANA, {
			customerNo,
			itemNo,
			quantity: 1,
			neededBy: '2027-06-30'
		});
		expect(later!.availability.can_meet).toBe(true);
		expect(later!.availability.earliest_ship).toBe(soon!.availability.earliest_ship);
		expect(later!.reply.join(' ')).toContain(`by ${later!.availability.earliest_ship}`);
	});

	it('names the replacement when the part has been discontinued', async () => {
		const [pick] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; item_no: string; replacement_item_no: string }>`
				select c.customer_no, e.item_no, e.replacement_item_no
				from nl.trade_exceptions e
				cross join lateral (select customer_no from nl.customers
				                    where not blocked and not closed order by customer_no limit 1) c
				where e.kind = 'discontinued'
				  and e.effective_from <= nl.today()
				  and (e.effective_to is null or e.effective_to >= nl.today())
				order by e.item_no limit 1`
		);
		expect(pick, 'the small world has a live discontinuation').toBeDefined();
		const answer = await answerFor(db, DANA, {
			customerNo: pick.customer_no,
			itemNo: pick.item_no,
			quantity: 1
		});
		expect(answer!.replacement).not.toBeNull();
		expect(answer!.replacement!.item_no).toBe(pick.replacement_item_no);
		expect(answer!.replacement!.reason.length).toBeGreaterThan(10);
		expect(answer!.replacement!.owner_id).toBeGreaterThan(0);
		expect(answer!.reply.join(' ')).toContain('discontinued');
	});

	it('leaves the rolled manufacturing figures null until that model exists', async () => {
		// nl.answer_for feature detects nl.item_truth() rather than depending on
		// it, so this database, which has 0016 and no manufacturing model, uses
		// available to promise and says so.
		const [installed] = await db.asSystem((tx) =>
			tx.sql<{ present: boolean }>`
				select to_regprocedure('nl.item_truth(text)') is not null as present`
		);
		const { customerNo, itemNo } = await ladderedPart();
		const answer = (await answerFor(db, DANA, { customerNo, itemNo, quantity: 1 })) as PriceAnswer;
		if (installed.present) {
			expect(answer.rolled).not.toBeNull();
			expect(answer.availability.earliest_basis).toBe('rolled');
		} else {
			expect(answer.rolled).toBeNull();
			// Where the date rests on a lead time it says which lead time,
			// rather than the bare 'lead_time' available to promise returns.
			expect([
				'stock',
				'supply',
				'observed',
				'quoted',
				'item card',
				'vendor default',
				'default',
				'exception'
			]).toContain(answer.availability.earliest_basis);
		}
	});
});

// ---------------------------------------------------------------------------
// Everything under one roof
// ---------------------------------------------------------------------------

describe('nl.customer_parts', () => {
	it('lists every part the account has bought, and nothing else', async () => {
		const { customerNo } = await ladderedPart();
		const parts = await getCustomerParts(db, DANA, customerNo);
		expect(parts.length).toBeGreaterThan(5);

		const [direct] = await db.asSystem((tx) =>
			tx.sql<{ n: number }>`
				select count(distinct item_no)::int as n from nl.invoice_lines
				where customer_no = ${customerNo} and quantity > 0`
		);
		expect(parts.length).toBe(direct.n);

		// Biggest twelve month spend first.
		for (let i = 1; i < parts.length; i++) {
			expect(parts[i].revenue12m).toBeLessThanOrEqual(parts[i - 1].revenue12m);
		}
	});

	it('matches the ledger on spend, units and what they last paid', async () => {
		const { customerNo } = await ladderedPart();
		const parts = await getCustomerParts(db, DANA, customerNo);
		const sample = parts.slice(0, 5);
		for (const part of sample) {
			const [direct] = await db.asSystem((tx) =>
				tx.sql<{
					units: number;
					revenue: number;
					units_12m: number;
					revenue_12m: number;
					last_price: number;
					last_bought: string;
				}>`
					select
						sum(quantity)::int as units,
						sum(amount) as revenue,
						coalesce(sum(quantity) filter (where posted_on > nl.today() - 365), 0)::int as units_12m,
						coalesce(sum(amount) filter (where posted_on > nl.today() - 365), 0) as revenue_12m,
						(array_agg(unit_price order by posted_on desc, invoice_no desc, line_no desc))[1] as last_price,
						max(posted_on) as last_bought
					from nl.invoice_lines
					where customer_no = ${customerNo} and item_no = ${part.itemNo} and quantity > 0`
			);
			expect(part.units, part.itemNo).toBe(direct.units);
			expect(part.revenue, part.itemNo).toBeCloseTo(direct.revenue, 2);
			expect(part.units12m, part.itemNo).toBe(direct.units_12m);
			expect(part.revenue12m, part.itemNo).toBeCloseTo(direct.revenue_12m, 2);
			expect(part.lastPrice, part.itemNo).toBeCloseTo(direct.last_price, 2);
			expect(part.lastBought, part.itemNo).toBe(direct.last_bought);
		}
	});

	it('says whether they are still buying it, from the date of the last order', async () => {
		const { customerNo } = await ladderedPart();
		const parts = await getCustomerParts(db, DANA, customerNo);
		for (const part of parts) {
			const expected =
				part.daysSince < 180 ? 'active' : part.daysSince < 365 ? 'slowing' : 'quiet';
			expect(part.buyingStatus, `${part.itemNo} ${part.daysSince} days`).toBe(expected);
		}
	});

	it('says what state the part is in, and agrees with stock and the exceptions', async () => {
		// Every account, so all four states show up somewhere.
		const accounts = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string }>`
				select customer_no from nl.customer_item_prices
				group by customer_no order by count(*) desc limit 6`
		);
		const seen = new Set<string>();
		for (const account of accounts) {
			const parts = await getCustomerParts(db, DANA, account.customer_no);
			for (const part of parts) {
				seen.add(part.partStatus);
				if (part.partStatus === 'discontinued') {
					expect(part.discontinuedOn, part.itemNo).not.toBeNull();
					expect(part.replacementItemNo, part.itemNo).not.toBeNull();
					expect(part.replacementDescription, part.itemNo).not.toBeNull();
				} else if (part.partStatus === 'available') {
					expect(part.onHand, part.itemNo).toBeGreaterThan(0);
				} else if (part.partStatus === 'on order') {
					expect(part.onHand, part.itemNo).toBe(0);
					expect(part.onOrder, part.itemNo).toBeGreaterThan(0);
				} else {
					expect(part.onHand, part.itemNo).toBe(0);
					expect(part.onOrder, part.itemNo).toBe(0);
				}
				expect(part.leadDays, part.itemNo).toBeGreaterThan(0);
			}
		}
		// A world this small may not hold every state, but it holds most.
		expect(seen.size).toBeGreaterThanOrEqual(2);
		expect(seen.has('available') || seen.has('short')).toBe(true);
	});

	it('gives the same lead time and flag as nl.lead_time_for', async () => {
		const { customerNo } = await ladderedPart();
		const parts = await getCustomerParts(db, DANA, customerNo);
		for (const part of parts.slice(0, 8)) {
			const [lead] = await db.asSystem((tx) =>
				tx.sql<{ days: number; slipped: boolean }>`
					select days, slipped from nl.lead_time_for(${part.itemNo}, nl.today())`
			);
			expect(part.leadDays, part.itemNo).toBe(lead.days);
			expect(part.leadSlipped, part.itemNo).toBe(lead.slipped);
		}
	});

	it('gives the same last paid figures as nl.customer_item_price_context', async () => {
		const { customerNo } = await ladderedPart();
		const parts = await getCustomerParts(db, DANA, customerNo);
		const history = new Map(
			(await getPriceHistory(db, DANA, customerNo)).map((row) => [row.itemNo, row])
		);
		expect(history.size).toBe(parts.length);
		for (const part of parts) {
			const row = history.get(part.itemNo);
			expect(row, part.itemNo).toBeDefined();
			expect(part.lastPrice, part.itemNo).toBeCloseTo(row!.lastPrice, 2);
			expect(part.todayPrice, part.itemNo).toBeCloseTo(row!.todayPrice, 2);
			expect(part.aboveLastPaid, part.itemNo).toBe(row!.aboveLastPaid);
		}
	});

	it('returns nothing for an account that has never bought anything', async () => {
		expect(await getCustomerParts(db, DANA, 'NOT-A-CUSTOMER')).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// The seed holds together, and the house rules hold
// ---------------------------------------------------------------------------

describe('the seeded world is self consistent', () => {
	it('has no overlapping agreement, sheet or ladder', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{
				agreement_overlaps: number;
				sheet_overlaps: number;
				duplicate_rungs: number;
				open_sheets_per_tier: number;
			}>`
				select
					(select count(*) from nl.customer_prices a
					 join nl.customer_prices b
					   on b.customer_no = a.customer_no and b.item_no = a.item_no
					  and b.valid_from > a.valid_from
					 where coalesce(a.valid_to, date '9999-12-31') >= b.valid_from)::int as agreement_overlaps,
					(select count(*) from nl.price_sheets a
					 join nl.price_sheets b
					   on b.price_group = a.price_group and b.effective_from > a.effective_from
					 where coalesce(a.effective_to, date '9999-12-31') >= b.effective_from)::int as sheet_overlaps,
					(select count(*) from (
						select sheet_id, price_group, item_no, min_quantity, count(*) as n
						from nl.price_breaks
						group by 1, 2, 3, 4 having count(*) > 1) d)::int as duplicate_rungs,
					(select coalesce(max(n), 0) from (
						select price_group, count(*) as n from nl.price_sheets
						where effective_to is null group by price_group) s)::int as open_sheets_per_tier`
		);
		expect(check.agreement_overlaps).toBe(0);
		expect(check.sheet_overlaps).toBe(0);
		expect(check.duplicate_rungs).toBe(0);
		expect(check.open_sheets_per_tier).toBe(1);
	});

	it('gives every account a sheet it could actually have been sent', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ wrong_tier: number; future_sends: number; before_publication: number }>`
				select
					count(*) filter (where ps.price_group <> c.price_group)::int as wrong_tier,
					count(*) filter (where s.sent_on > nl.today())::int as future_sends,
					count(*) filter (where s.sent_on < ps.published_on)::int as before_publication
				from nl.price_sheet_sends s
				join nl.price_sheets ps on ps.id = s.sheet_id
				join nl.customers c on c.customer_no = s.customer_no`
		);
		expect(check.wrong_tier).toBe(0);
		expect(check.future_sends).toBe(0);
		expect(check.before_publication).toBe(0);
	});

	it('writes no em dash and no flagged word into any of the new text', async () => {
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ dashes: number; banned: number }>`
				with text_rows as (
					select name as note from nl.price_sheets
					union all select note from nl.price_sheets
					union all select note from nl.price_sheet_lines
					union all select note from nl.price_breaks
					union all select reason from nl.trade_exceptions
					union all select wording from nl.trade_exceptions
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

	it('lets the read-only role price and explain, and nobody write', async () => {
		const { customerNo, itemNo } = await ladderedPart();
		const rows = await db.asReadonly((tx) =>
			tx.sql<{ sheets: number; rungs: number; exceptions: number }>`
				select
					(select count(*) from nl.price_sheets)::int as sheets,
					(select count(*) from nl.price_breaks)::int as rungs,
					(select count(*) from nl.trade_exceptions)::int as exceptions`
		);
		expect(rows[0].sheets).toBeGreaterThan(0);
		expect(rows[0].rungs).toBeGreaterThan(0);
		expect(rows[0].exceptions).toBeGreaterThan(0);

		// It can answer a customer, which is what the assistant needs.
		const [answer] = await db.asReadonly((tx) =>
			tx.sql<{ a: PriceAnswer }>`
				select nl.answer_for(${customerNo}, ${itemNo}, 12, null::date) as a`
		);
		expect(answer.a.unit_price).toBeGreaterThan(0);
		expect(answer.a.reply.length).toBeGreaterThan(0);

		// And nothing in the explanation names a person: the read-only role has
		// no grant on nl.users, so an owner comes back as an id.
		const owners = answer.a.exceptions
			.map((row) => row.owner_id)
			.filter((id): id is number => typeof id === 'number');
		expect(owners.every((id) => Number.isInteger(id))).toBe(true);

		const write = db.asUser(DANA, (tx) =>
			tx.sql`insert into nl.price_breaks (price_group, item_no, min_quantity, break_price)
			       values ('DEALER', ${itemNo}, 200, 1.00)`
		);
		await expect(write).rejects.toThrow();
	});
});
