/*
  Question one: is the money where it should be, and where is it leaking?

  Revenue and gross margin come from nl.ledger_month (migration 0039), which
  is the invoice ledger rolled up per calendar month and kept current by
  triggers. The definition is the one nl.item_margin_history and
  nl.customer_margin already use, so the top of this page and the part page
  cannot disagree: revenue is the sum of invoice line amounts, cost of goods
  is quantity times the cost carried on the line, and credit memo lines are in
  with their negative signs.

  The window is the last twelve COMPLETED months against the twelve before
  them. Not year to date: the month we are in is part of a month on one side
  and a whole month on the other, and comparing those two is how a dashboard
  starts lying. The month in progress is on the chart, marked as partial, and
  in none of the figures.

  Then the leaks. Each one is a view in migration 0039, each names the
  customers or parts behind it, and each reaches the invoice lines that prove
  it. They are reported one by one and never added up: the frozen-agreement
  leak and the cost-passthrough leak can count the same dollar from two sides.
*/
import type { Db, Tx } from '../db/types.ts';
import { links, type LeakId } from './links.ts';
import type { Disclosure } from './disclosure.ts';
import type { EvidenceRow, Figure, LeakSummary, MonthPoint, MoneySection } from './types.ts';

/** The margin floor the pricing rule uses, for the words on the page. */
const FLOOR_MARGIN = 0.2;

interface PeriodRow {
	today: string;
	from_month: string;
	to_month: string;
	prior_from_month: string;
	prior_to_month: string;
	revenue: number;
	cost_of_goods: number;
	lines: number;
	prior_revenue: number;
	prior_cost_of_goods: number;
	months: number;
}

/*
  The two windows and their sums in one trip. `b` is the month we are in;
  everything is measured strictly before it, so no partial month is counted.
  The join is on nl.ledger_month's primary key, which is 84 rows on the full
  world, so this is a handful of index lookups however long the ledger is.
*/
const PERIOD_SQL = `
	with clock as (select nl.today() as today),
	b as (
		select k.today,
		       date_trunc('month', k.today)::date                        as this_month,
		       (date_trunc('month', k.today) - interval '12 months')::date as from_month,
		       (date_trunc('month', k.today) - interval '24 months')::date as prior_from_month
		from clock k
	),
	current_window as (
		select coalesce(sum(m.revenue), 0)       as revenue,
		       coalesce(sum(m.cost_of_goods), 0) as cost_of_goods,
		       coalesce(sum(m.lines), 0)         as lines,
		       count(*)::int                     as months
		from nl.ledger_month m, b
		where m.month >= b.from_month and m.month < b.this_month
	),
	prior_window as (
		select coalesce(sum(m.revenue), 0)       as revenue,
		       coalesce(sum(m.cost_of_goods), 0) as cost_of_goods
		from nl.ledger_month m, b
		where m.month >= b.prior_from_month and m.month < b.from_month
	)
	select b.today::text                                       as today,
	       b.from_month::text                                  as from_month,
	       (b.this_month - 1)::text                            as to_month,
	       b.prior_from_month::text                            as prior_from_month,
	       (b.from_month - 1)::text                            as prior_to_month,
	       c.revenue, c.cost_of_goods, c.lines, c.months,
	       p.revenue       as prior_revenue,
	       p.cost_of_goods as prior_cost_of_goods
	from b, current_window c, prior_window p`;

interface MonthRow {
	month: string;
	revenue: number;
	prior_revenue: number;
	partial: boolean;
}

/*
  Thirteen months for the chart, including the one in progress, each beside
  the same month a year earlier. generate_series supplies the months so a
  month with no invoices is a gap in the bars rather than a missing bar.
*/
const MONTHS_SQL = `
	with clock as (select nl.today() as today),
	b as (select date_trunc('month', k.today)::date as this_month from clock k),
	wanted as (
		select g.month::date as month
		from b
		cross join generate_series(
			(b.this_month - interval '12 months'), b.this_month, interval '1 month') as g (month)
	)
	select w.month::text                        as month,
	       coalesce(cur.revenue, 0)             as revenue,
	       coalesce(prev.revenue, 0)            as prior_revenue,
	       (w.month = b.this_month)             as partial
	from wanted w
	cross join b
	left join nl.ledger_month cur  on cur.month = w.month
	left join nl.ledger_month prev on prev.month = (w.month - interval '1 year')::date
	order by w.month`;

interface LeakTotals {
	agreements: number;
	agreements_below_floor: number;
	agreements_absorbed: number;
	freight_invoices: number;
	freight_shortfall: number;
	freight_billed: number;
	freight_at_rate: number;
	parts: number;
	parts_shortfall: number;
}

/*
  The three leak headlines, in one trip and one pass per view.

  The first version asked each view once per figure: four scans of
  nl.invoice_freight and three of nl.overview_price_exceptions. On the small
  world that was 1,790 ms, and nearly all of it was the same rows read seven
  times. Each view is now read once, in its own CTE, and the figures are
  `filter` clauses over that one pass. The numbers are identical; the page is
  two orders of magnitude cheaper (see docs/overview.md).
*/
const LEAK_SQL = `
	with clock as (select nl.today() as today),
	agreements as (
		select count(*)::int                                          as rows_count,
		       count(*) filter (where below_floor_now)::int            as below_floor,
		       coalesce(sum(absorbed), 0)                              as absorbed
		from nl.overview_price_exceptions
	),
	freight as (
		select count(*) filter (where f.shortfall > 0)::int            as invoices,
		       coalesce(sum(f.shortfall), 0)                           as shortfall,
		       coalesce(sum(f.freight_billed), 0)                      as billed,
		       coalesce(sum(f.freight_at_rate), 0)                     as at_rate
		from nl.invoice_freight f, clock k
		where not f.ships_own_carrier
		  and f.posted_on > k.today - 365 and f.posted_on <= k.today
	),
	parts as (
		select count(*)::int                                          as rows_count,
		       coalesce(sum(shortfall), 0)                             as shortfall
		from nl.overview_cost_passthrough
	)
	select a.rows_count      as agreements,
	       a.below_floor     as agreements_below_floor,
	       a.absorbed        as agreements_absorbed,
	       f.invoices        as freight_invoices,
	       f.shortfall       as freight_shortfall,
	       f.billed          as freight_billed,
	       f.at_rate         as freight_at_rate,
	       p.rows_count      as parts,
	       p.shortfall       as parts_shortfall
	from agreements a, freight f, parts p`;

/** "up 8%", "down 3%", or "level with" when the two are the same to the dollar. */
function movement(now: number, before: number): string {
	if (before === 0) return now === 0 ? 'the same as' : 'against nothing in';
	const change = (now - before) / Math.abs(before);
	const pct = Math.abs(Math.round(change * 1000) / 10);
	if (pct < 0.05) return 'level with';
	return `${change > 0 ? 'up' : 'down'} ${pct}% on`;
}

function monthName(iso: string): string {
	const [year, month] = iso.split('-').map(Number);
	const names = ['January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'];
	return `${names[month - 1]} ${year}`;
}

/** "October 2025 to September 2026", or one month when the window is one month. */
function windowLabel(fromMonth: string, toMonth: string): string {
	const from = monthName(fromMonth.slice(0, 7) + '-01');
	const to = monthName(toMonth.slice(0, 7) + '-01');
	return from === to ? from : `${from} to ${to}`;
}

export async function readMoney(db: Db, userId: number, disclosure: Disclosure): Promise<MoneySection> {
	return db.asUser(userId, async (tx) => {
		const [period] = await tx.query<PeriodRow>(PERIOD_SQL);
		const monthRows = await tx.query<MonthRow>(MONTHS_SQL);
		const [leaks] = await tx.query<LeakTotals>(LEAK_SQL);

		const periodLabel = windowLabel(period.from_month, period.to_month);
		const priorPeriodLabel = windowLabel(period.prior_from_month, period.prior_to_month);
		const revenue = Number(period.revenue);
		const priorRevenue = Number(period.prior_revenue);
		const margin = revenue - Number(period.cost_of_goods);
		const priorMargin = priorRevenue - Number(period.prior_cost_of_goods);
		const marginPct = revenue === 0 ? 0 : margin / revenue;
		const priorMarginPct = priorRevenue === 0 ? 0 : priorMargin / priorRevenue;

		const figures: Figure[] = [
			{
				id: 'revenue',
				label: `Revenue, ${periodLabel}`,
				value: revenue,
				unit: 'money',
				compare: `${movement(revenue, priorRevenue)} ${moneyWords(priorRevenue)} in ${priorPeriodLabel}`,
				source: 'invoice lines, before freight',
				href: links.revenue(),
				hrefLabel: 'Month by month',
				tone: revenue < priorRevenue ? 'warn' : 'plain',
				toneWord: revenue < priorRevenue ? 'behind last year' : undefined
			}
		];

		// Margin is cost. A reader whose disclosure level does not allow cost
		// does not get these two figures at all, rather than getting them with
		// a class that hides them.
		if (disclosure.margin) {
			figures.push(
				{
					id: 'margin',
					label: `Gross margin, ${periodLabel}`,
					value: margin,
					unit: 'money',
					compare: `${movement(margin, priorMargin)} ${moneyWords(priorMargin)} in ${priorPeriodLabel}`,
					source: 'invoice lines, cost as posted',
					href: links.revenue(),
					hrefLabel: 'Month by month',
					tone: margin < priorMargin ? 'warn' : 'plain',
					toneWord: margin < priorMargin ? 'behind last year' : undefined
				},
				{
					id: 'margin-pct',
					label: 'Margin rate',
					value: marginPct,
					unit: 'percent',
					compare: `${(priorMarginPct * 100).toFixed(1)}% in ${priorPeriodLabel}`,
					source: 'the same lines',
					href: links.revenue(),
					hrefLabel: 'Month by month',
					tone: marginPct < priorMarginPct - 0.005 ? 'warn' : 'plain',
					toneWord: marginPct < priorMarginPct - 0.005 ? 'thinner than last year' : undefined
				}
			);
		}

		const months: MonthPoint[] = monthRows.map((row) => ({
			month: row.month,
			revenue: Number(row.revenue),
			priorRevenue: Number(row.prior_revenue),
			partial: row.partial === true
		}));

		return {
			today: period.today,
			periodLabel,
			priorPeriodLabel,
			figures,
			months,
			leaks: leakSummaries(leaks, disclosure),
			showsMargin: disclosure.margin
		};
	});
}

/** A money figure in words, for the inside of a comparison sentence. */
function moneyWords(value: number): string {
	const sign = value < 0 ? '-' : '';
	const size = Math.abs(value);
	if (size >= 1_000_000) return `${sign}$${(size / 1_000_000).toFixed(1)}M`;
	if (size >= 1_000) return `${sign}$${Math.round(size / 1_000)}K`;
	return `${sign}$${Math.round(size)}`;
}

function leakSummaries(t: LeakTotals, disclosure: Disclosure): LeakSummary[] {
	const out: LeakSummary[] = [];

	// Two of the three leaks are cost arithmetic and are left out entirely for
	// a reader who may not be shown cost. Freight is a billed amount against a
	// published tariff, so it stays.
	if (disclosure.cost) {
		const agreements = Number(t.agreements);
		out.push({
			id: 'price-exceptions',
			name: 'Price agreements the cost rose underneath',
			question: 'Which agreed prices have not moved since the day they were signed?',
			value: Number(t.agreements_absorbed),
			unit: 'money',
			count: agreements,
			detail:
				`${agreements} open-ended ${agreements === 1 ? 'agreement' : 'agreements'} where the part costs ` +
				`more than it did when the price was agreed. The figure is that cost increase on the units billed ` +
				`in the last year. ${Number(t.agreements_below_floor)} of them now price under the ` +
				`${Math.round(FLOOR_MARGIN * 100)}% floor.`,
			nothing:
				'Nothing to recover: no open-ended agreement is priced against a cost that has since gone up.',
			href: links.leak('price-exceptions'),
			tone: Number(t.agreements_below_floor) > 0 ? 'danger' : agreements > 0 ? 'warn' : 'plain'
		});
	}

	const freightInvoices = Number(t.freight_invoices);
	const billed = Number(t.freight_billed);
	const atRate = Number(t.freight_at_rate);
	out.push({
		id: 'freight',
		name: 'Freight nobody billed',
		question: 'Which invoices shipped without the freight the tariff says they owe?',
		value: Number(t.freight_shortfall),
		unit: 'money',
		count: freightInvoices,
		detail:
			`${freightInvoices} ${freightInvoices === 1 ? 'invoice' : 'invoices'} in the last year were billed less ` +
			`freight than the tariff of the day. Across every invoice to an account that does not ship on its own ` +
			`carrier we billed ${moneyWords(billed)} against ${moneyWords(atRate)} at the tariff` +
			`${atRate > 0 ? `, which is ${Math.round((billed / atRate) * 100)}% recovery` : ''}.`,
		nothing:
			'Nothing to recover: every invoice to an account that pays its own freight was billed at the tariff.',
		href: links.leak('freight'),
		tone: atRate > 0 && billed / atRate < 0.9 ? 'warn' : 'plain'
	});

	if (disclosure.cost) {
		const parts = Number(t.parts);
		out.push({
			id: 'cost-passthrough',
			name: 'Cost rises the price never followed',
			question: 'Which parts cost more than they did, at the same selling price?',
			value: Number(t.parts_shortfall),
			unit: 'money',
			count: parts,
			detail:
				`${parts} ${parts === 1 ? 'part' : 'parts'} had a cost revision in the last year that the price paid ` +
				`since has not caught up with. The figure is the part of each rise the price did not pick up, on the ` +
				`units sold since it happened.`,
			nothing: 'Nothing to recover: every cost rise in the last year has been matched by the price paid since.',
			href: links.leak('cost-passthrough'),
			tone: parts > 0 ? 'warn' : 'plain'
		});
	}

	return out;
}

// ---------------------------------------------------------------------------
// One leak: its segments, then the evidence behind one of them
// ---------------------------------------------------------------------------

export interface LeakRow {
	/** The key that opens this row's evidence. */
	key: string;
	title: string;
	subtitle: string;
	value: number;
	facts: { label: string; value: number; unit: 'money' | 'count' | 'percent' | 'days' }[];
	/** The record's own page: an account, a part. */
	recordHref: string;
	recordLabel: string;
	evidenceHref: string;
}

export interface LeakDetail {
	id: LeakId;
	name: string;
	question: string;
	/** How the money is worked out, in a sentence a person can argue with. */
	method: string;
	nothing: string;
	unit: 'money';
	total: number;
	rows: LeakRow[];
	/** Set when a row's key was given: the evidence behind it. */
	evidence: { title: string; note: string; rows: EvidenceRow[] } | null;
}

export function isLeak(value: string): value is LeakId {
	return value === 'price-exceptions' || value === 'freight' || value === 'cost-passthrough';
}

interface AgreementRow {
	customer_no: string;
	customer_name: string;
	item_no: string;
	description: string;
	net_price: number;
	valid_from: string;
	days_in_force: number;
	cost_when_agreed: number;
	cost_today: number;
	cost_rise: number;
	below_floor_now: boolean;
	margin_when_agreed: number | null;
	margin_now: number | null;
	units: number;
	revenue: number;
	absorbed: number;
}

interface FreightRow {
	customer_no: string;
	customer_name: string;
	invoices: number;
	short_invoices: number;
	billed: number;
	at_rate: number;
	shortfall: number;
}

interface PartRow {
	item_no: string;
	description: string;
	rose_on: string;
	cost_before: number;
	cost_after: number;
	cost_step: number;
	price_before: number;
	price_since: number;
	passed_through: number;
	not_recovered: number;
	units_since: number;
	revenue_since: number;
	shortfall: number;
}

const SEGMENT_LIMIT = 50;
const EVIDENCE_LIMIT = 100;

export async function readLeak(
	db: Db,
	userId: number,
	leak: LeakId,
	key: string | null,
	disclosure: Disclosure
): Promise<LeakDetail> {
	// The two cost leaks do not exist for a reader who may not be shown cost.
	if (!disclosure.cost && leak !== 'freight') {
		return {
			id: leak,
			name: 'Not shown',
			question: 'This leak is worked out from unit cost.',
			method: 'Your disclosure level does not include unit cost or margin, so this page has no figures on it.',
			nothing: 'There is nothing here for you to see.',
			unit: 'money',
			total: 0,
			rows: [],
			evidence: null
		};
	}
	return db.asUser(userId, async (tx) => {
		if (leak === 'price-exceptions') return agreementLeak(tx, key);
		if (leak === 'freight') return freightLeak(tx, key);
		return partLeak(tx, key);
	});
}

// --------------------------------------------------------- price agreements

async function agreementLeak(tx: Tx, key: string | null): Promise<LeakDetail> {
	const rows = await tx.query<AgreementRow>(
		`select customer_no, customer_name, item_no, description, net_price, valid_from::text as valid_from,
		        days_in_force, cost_when_agreed, cost_today, cost_rise, below_floor_now,
		        margin_when_agreed, margin_now, units, revenue, absorbed
		 from nl.overview_price_exceptions
		 order by absorbed desc, customer_no, item_no
		 limit $1`,
		[SEGMENT_LIMIT]
	);
	const [{ total }] = await tx.sql<{ total: number }>`
		select coalesce(sum(absorbed), 0) as total from nl.overview_price_exceptions`;

	const detail: LeakDetail = {
		id: 'price-exceptions',
		name: 'Price agreements the cost rose underneath',
		question: 'Which agreed prices have not moved since the day they were signed?',
		method:
			'Each row is an open-ended agreement in nl.customer_prices. The cost when it was agreed and the cost ' +
			'today both come from nl.item_costs. The money is the difference between them times the units this ' +
			'account bought of this part in the last year, so it is what the frozen price absorbed on business we ' +
			'actually did, not on business we might have done.',
		nothing: 'Nothing to recover: no open-ended agreement is priced against a cost that has since gone up.',
		unit: 'money',
		total: Number(total),
		rows: rows.map((r) => ({
			key: `${r.customer_no}|${r.item_no}`,
			title: `${r.customer_name} buying ${r.item_no}`,
			subtitle:
				`${r.description}. Agreed at $${Number(r.net_price).toFixed(2)} on ${r.valid_from}, ` +
				`${r.days_in_force} days ago. Cost has gone from $${Number(r.cost_when_agreed).toFixed(2)} to ` +
				`$${Number(r.cost_today).toFixed(2)}` +
				(r.below_floor_now ? `, which puts the agreed price under the margin floor.` : '.'),
			value: Number(r.absorbed),
			facts: [
				{ label: 'Absorbed', value: Number(r.absorbed), unit: 'money' },
				{ label: 'Units billed', value: Number(r.units), unit: 'count' },
				{ label: 'Margin then', value: Number(r.margin_when_agreed ?? 0), unit: 'percent' },
				{ label: 'Margin now', value: Number(r.margin_now ?? 0), unit: 'percent' }
			],
			recordHref: links.account(r.customer_no),
			recordLabel: r.customer_name,
			evidenceHref: links.leak('price-exceptions', `${r.customer_no}|${r.item_no}`)
		})),
		evidence: null
	};

	if (!key) return detail;
	const [customerNo, itemNo] = key.split('|');
	if (!customerNo || !itemNo) return detail;

	const lines = await tx.sql<{
		invoice_no: string;
		posted_on: string;
		quantity: number;
		unit_price: number;
		amount: number;
		unit_cost: number;
	}>`
		select il.invoice_no, il.posted_on::text as posted_on, il.quantity, il.unit_price, il.amount, il.unit_cost
		from nl.invoice_lines il
		where il.customer_no = ${customerNo}
		  and il.item_no = ${itemNo}
		  and il.quantity > 0
		  and il.posted_on > nl.today() - 365
		  and il.posted_on <= nl.today()
		order by il.posted_on desc, il.invoice_no desc
		limit ${EVIDENCE_LIMIT}`;

	detail.evidence = {
		title: `Invoice lines: ${customerNo} buying ${itemNo}, last twelve months`,
		note:
			'These are the lines the figure is a sum over. The price is the price that was billed and the cost is ' +
			'the cost carried on the line, which is the cost that applied the day it was posted.',
		rows: lines.map((l, i) => ({
			key: `${l.invoice_no}-${i}`,
			ref: l.invoice_no,
			on: l.posted_on,
			label: itemNo,
			numbers: [
				{ label: 'Qty', value: Number(l.quantity), unit: 'count' },
				{ label: 'Price', value: Number(l.unit_price), unit: 'money' },
				{ label: 'Cost', value: Number(l.unit_cost), unit: 'money' },
				{ label: 'Amount', value: Number(l.amount), unit: 'money' }
			],
			href: links.part(itemNo),
			hrefLabel: 'The part'
		}))
	};
	return detail;
}

// ------------------------------------------------------------------ freight

async function freightLeak(tx: Tx, key: string | null): Promise<LeakDetail> {
	const rows = await tx.query<FreightRow>(
		`select f.customer_no, f.customer_name,
		        count(*)::int                                   as invoices,
		        count(*) filter (where f.shortfall > 0)::int     as short_invoices,
		        sum(f.freight_billed)                            as billed,
		        sum(f.freight_at_rate)                           as at_rate,
		        sum(f.shortfall)                                 as shortfall
		 from nl.invoice_freight f
		 where not f.ships_own_carrier
		   and f.posted_on > nl.today() - 365
		   and f.posted_on <= nl.today()
		 group by f.customer_no, f.customer_name
		 having sum(f.shortfall) > 0
		 order by sum(f.shortfall) desc, f.customer_no
		 limit $1`,
		[SEGMENT_LIMIT]
	);
	const [{ total }] = await tx.sql<{ total: number }>`
		select coalesce(sum(f.shortfall), 0) as total
		from nl.invoice_freight f
		where not f.ships_own_carrier and f.posted_on > nl.today() - 365 and f.posted_on <= nl.today()`;

	const detail: LeakDetail = {
		id: 'freight',
		name: 'Freight nobody billed',
		question: 'Which invoices shipped without the freight the tariff says they owe?',
		method:
			'nl.invoice_freight prices every invoice at the freight tariff of the day it was posted: the band rate ' +
			'for its subtotal, plus the fuel surcharge published that month, or nothing once the subtotal reaches the ' +
			'free freight threshold. The shortfall is that figure less the freight actually billed. Accounts that ' +
			'ship on their own carrier account are left out, because the terms say they were never meant to be ' +
			'billed. It is billed against policy, not billed against what a carrier charged us: this business does ' +
			'not record the carrier invoice.',
		nothing:
			'Nothing to recover: every invoice to an account that pays its own freight was billed at the tariff.',
		unit: 'money',
		total: Number(total),
		rows: rows.map((r) => ({
			key: r.customer_no,
			title: r.customer_name,
			subtitle:
				`${r.short_invoices} of ${r.invoices} invoices in the last year came up short. ` +
				`Billed $${Number(r.billed).toFixed(2)} against $${Number(r.at_rate).toFixed(2)} at the tariff.`,
			value: Number(r.shortfall),
			facts: [
				{ label: 'Short by', value: Number(r.shortfall), unit: 'money' },
				{ label: 'Invoices short', value: Number(r.short_invoices), unit: 'count' },
				{ label: 'Billed', value: Number(r.billed), unit: 'money' },
				{ label: 'At the tariff', value: Number(r.at_rate), unit: 'money' }
			],
			recordHref: links.account(r.customer_no),
			recordLabel: r.customer_name,
			evidenceHref: links.leak('freight', r.customer_no)
		})),
		evidence: null
	};

	if (!key) return detail;

	const invoices = await tx.sql<{
		invoice_no: string;
		posted_on: string;
		subtotal: number;
		freight_billed: number;
		freight_at_rate: number;
		free_over: number;
		shortfall: number;
	}>`
		select f.invoice_no, f.posted_on::text as posted_on, f.subtotal, f.freight_billed,
		       f.freight_at_rate, f.free_over, f.shortfall
		from nl.invoice_freight f
		where f.customer_no = ${key}
		  and f.posted_on > nl.today() - 365
		  and f.posted_on <= nl.today()
		order by f.shortfall desc, f.posted_on desc
		limit ${EVIDENCE_LIMIT}`;

	detail.evidence = {
		title: `Invoices: ${key}, last twelve months`,
		note:
			'The subtotal is what decided the band and whether the order shipped free. An invoice with no shortfall ' +
			'is left in, so the rows add up to the figure rather than only supporting it.',
		rows: invoices.map((i) => ({
			key: i.invoice_no,
			ref: i.invoice_no,
			on: i.posted_on,
			label: `Ships free over $${Number(i.free_over).toFixed(0)}`,
			numbers: [
				{ label: 'Subtotal', value: Number(i.subtotal), unit: 'money' },
				{ label: 'Freight billed', value: Number(i.freight_billed), unit: 'money' },
				{ label: 'At the tariff', value: Number(i.freight_at_rate), unit: 'money' },
				{ label: 'Short by', value: Number(i.shortfall), unit: 'money' }
			],
			href: links.account(key),
			hrefLabel: 'The account'
		}))
	};
	return detail;
}

// --------------------------------------------------------- cost passthrough

async function partLeak(tx: Tx, key: string | null): Promise<LeakDetail> {
	const rows = await tx.query<PartRow>(
		`select item_no, description, rose_on::text as rose_on, cost_before, cost_after, cost_step,
		        price_before, price_since, passed_through, not_recovered, units_since, revenue_since, shortfall
		 from nl.overview_cost_passthrough
		 order by shortfall desc, item_no
		 limit $1`,
		[SEGMENT_LIMIT]
	);
	const [{ total }] = await tx.sql<{ total: number }>`
		select coalesce(sum(shortfall), 0) as total from nl.overview_cost_passthrough`;

	const detail: LeakDetail = {
		id: 'cost-passthrough',
		name: 'Cost rises the price never followed',
		question: 'Which parts cost more than they did, at the same selling price?',
		method:
			'Each row is a part whose most recent cost revision inside the last year was a rise. The price before is ' +
			'the volume-weighted price paid in the year before the rise, the price since is the volume-weighted ' +
			'price paid since it. What the price did not pick up, times the units sold since, is the money. Parts ' +
			'with fewer than three invoice lines on either side are left out, because an average of one line is not ' +
			'a price level.',
		nothing: 'Nothing to recover: every cost rise in the last year has been matched by the price paid since.',
		unit: 'money',
		total: Number(total),
		rows: rows.map((r) => ({
			key: r.item_no,
			title: r.item_no,
			subtitle:
				`${r.description}. Cost rose $${Number(r.cost_step).toFixed(2)} on ${r.rose_on}, from ` +
				`$${Number(r.cost_before).toFixed(2)} to $${Number(r.cost_after).toFixed(2)}. The price paid went ` +
				`from $${Number(r.price_before).toFixed(2)} to $${Number(r.price_since).toFixed(2)}.`,
			value: Number(r.shortfall),
			facts: [
				{ label: 'Not recovered', value: Number(r.shortfall), unit: 'money' },
				{ label: 'Per unit', value: Number(r.not_recovered), unit: 'money' },
				{ label: 'Units since', value: Number(r.units_since), unit: 'count' },
				{ label: 'Revenue since', value: Number(r.revenue_since), unit: 'money' }
			],
			recordHref: links.part(r.item_no),
			recordLabel: r.item_no,
			evidenceHref: links.leak('cost-passthrough', r.item_no)
		})),
		evidence: null
	};

	if (!key) return detail;

	const lines = await tx.sql<{
		invoice_no: string;
		posted_on: string;
		customer_no: string;
		quantity: number;
		unit_price: number;
		unit_cost: number;
		amount: number;
	}>`
		select il.invoice_no, il.posted_on::text as posted_on, il.customer_no, il.quantity,
		       il.unit_price, il.unit_cost, il.amount
		from nl.invoice_lines il
		join nl.overview_cost_passthrough p on p.item_no = il.item_no
		where il.item_no = ${key}
		  and il.quantity > 0
		  and il.posted_on >= p.rose_on
		  and il.posted_on <= nl.today()
		order by il.posted_on desc, il.invoice_no desc
		limit ${EVIDENCE_LIMIT}`;

	detail.evidence = {
		title: `Invoice lines for ${key} since the cost rose`,
		note:
			'Every line sold since the revision, with the price it went out at and the cost it carried. The cost on ' +
			'the line is the cost that applied the day it was posted, which is why the rise shows up here at all.',
		rows: lines.map((l, i) => ({
			key: `${l.invoice_no}-${i}`,
			ref: l.invoice_no,
			on: l.posted_on,
			label: l.customer_no,
			numbers: [
				{ label: 'Qty', value: Number(l.quantity), unit: 'count' },
				{ label: 'Price', value: Number(l.unit_price), unit: 'money' },
				{ label: 'Cost', value: Number(l.unit_cost), unit: 'money' },
				{ label: 'Amount', value: Number(l.amount), unit: 'money' }
			],
			href: links.account(l.customer_no),
			hrefLabel: 'The account'
		}))
	};
	return detail;
}

// ---------------------------------------------------------------------------
// Revenue by month, and one month's accounts
// ---------------------------------------------------------------------------

export interface RevenueMonth {
	month: string;
	revenue: number;
	priorRevenue: number;
	costOfGoods: number | null;
	lines: number;
	partial: boolean;
	href: string;
}

export interface RevenueAccount {
	customerNo: string;
	customerName: string;
	revenue: number;
	priorRevenue: number;
	lines: number;
	href: string;
	linesHref: string;
}

export interface RevenueDetail {
	today: string;
	months: RevenueMonth[];
	/** The month a person opened, if any. */
	month: string | null;
	accounts: RevenueAccount[];
	/** Set when a person opened one account inside the month. */
	evidence: { title: string; note: string; rows: EvidenceRow[] } | null;
	showsMargin: boolean;
}

export async function readRevenue(
	db: Db,
	userId: number,
	options: { month: string | null; customer: string | null },
	disclosure: Disclosure
): Promise<RevenueDetail> {
	return db.asUser(userId, async (tx) => {
		const [{ today }] = await tx.sql<{ today: string }>`select nl.today()::text as today`;

		// Two years of months, each beside the same month a year earlier.
		const months = await tx.sql<{
			month: string;
			revenue: number;
			prior_revenue: number;
			cost_of_goods: number;
			lines: number;
			partial: boolean;
		}>`
			with b as (select date_trunc('month', nl.today())::date as this_month)
			select m.month::text as month, m.revenue, m.cost_of_goods, m.lines,
			       coalesce(prev.revenue, 0) as prior_revenue,
			       (m.month = b.this_month) as partial
			from nl.ledger_month m
			cross join b
			left join nl.ledger_month prev on prev.month = (m.month - interval '1 year')::date
			where m.month > (b.this_month - interval '24 months')::date
			order by m.month desc`;

		const detail: RevenueDetail = {
			today,
			months: months.map((m) => ({
				month: m.month,
				revenue: Number(m.revenue),
				priorRevenue: Number(m.prior_revenue),
				costOfGoods: disclosure.margin ? Number(m.cost_of_goods) : null,
				lines: Number(m.lines),
				partial: m.partial === true,
				href: links.revenue({ month: m.month.slice(0, 7) })
			})),
			month: null,
			accounts: [],
			evidence: null,
			showsMargin: disclosure.margin
		};

		if (!options.month) return detail;
		// A month arrives as YYYY-MM and is turned into a date here, so nothing
		// downstream has to parse it twice.
		const monthStart = `${options.month}-01`;
		detail.month = monthStart;

		const accounts = await tx.sql<{
			customer_no: string;
			customer_name: string;
			revenue: number;
			prior_revenue: number;
			lines: number;
		}>`
			with m as (select ${monthStart}::date as month)
			select il.customer_no,
			       c.name as customer_name,
			       sum(il.amount) as revenue,
			       count(*)::int as lines,
			       coalesce((
			         select sum(p.amount) from nl.invoice_lines p
			         where p.customer_no = il.customer_no
			           and p.posted_on >= ((select month from m) - interval '1 year')::date
			           and p.posted_on < ((select month from m) - interval '1 year' + interval '1 month')::date
			       ), 0) as prior_revenue
			from nl.invoice_lines il
			join nl.customers c on c.customer_no = il.customer_no
			where il.posted_on >= (select month from m)
			  and il.posted_on < ((select month from m) + interval '1 month')::date
			group by il.customer_no, c.name
			order by sum(il.amount) desc
			limit ${SEGMENT_LIMIT}`;

		detail.accounts = accounts.map((a) => ({
			customerNo: a.customer_no,
			customerName: a.customer_name,
			revenue: Number(a.revenue),
			priorRevenue: Number(a.prior_revenue),
			lines: Number(a.lines),
			href: links.account(a.customer_no),
			linesHref: links.revenue({ month: options.month!, customer: a.customer_no })
		}));

		if (!options.customer) return detail;

		const lines = await tx.sql<{
			invoice_no: string;
			posted_on: string;
			item_no: string;
			quantity: number;
			unit_price: number;
			amount: number;
		}>`
			with m as (select ${monthStart}::date as month)
			select il.invoice_no, il.posted_on::text as posted_on, il.item_no, il.quantity,
			       il.unit_price, il.amount
			from nl.invoice_lines il
			where il.customer_no = ${options.customer}
			  and il.posted_on >= (select month from m)
			  and il.posted_on < ((select month from m) + interval '1 month')::date
			order by il.posted_on, il.invoice_no, il.line_no
			limit ${EVIDENCE_LIMIT}`;

		detail.evidence = {
			title: `Invoice lines: ${options.customer}, ${monthName(monthStart)}`,
			note:
				'Every line that made up this account revenue in the month. A credit memo line is negative, which ' +
				'is how a return takes revenue back off.',
			rows: lines.map((l, i) => ({
				key: `${l.invoice_no}-${i}`,
				ref: l.invoice_no,
				on: l.posted_on,
				label: l.item_no,
				numbers: [
					{ label: 'Qty', value: Number(l.quantity), unit: 'count' },
					{ label: 'Price', value: Number(l.unit_price), unit: 'money' },
					{ label: 'Amount', value: Number(l.amount), unit: 'money' }
				],
				href: links.part(l.item_no),
				hrefLabel: 'The part'
			}))
		};
		return detail;
	});
}
