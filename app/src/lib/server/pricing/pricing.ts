// Cost, freight and pricing: everything a screen needs to answer "what does
// this cost us, what do we charge, and does it still make money".
//
// All of it is read only. The rules live in migration 0018 and nowhere else:
//
//   nl.price_for(customer, item, date)   the price and which rule set it
//   nl.item_cost_on(item, date)          the cost that applied that day
//   nl.freight_for(subtotal, date)       what the freight tariff says
//   nl.item_margin_history               margin per part and month
//   nl.customer_margin                   margin per account and year
//   nl.freight_by_month                  freight billed against the tariff
//
// Nothing in this file works a price out in JavaScript. If a page and the
// assistant ask the same question they get the same answer, because there is
// only one implementation and it is in SQL.
import type { Db } from '../db/types.ts';
import type {
	Agreement,
	CostPoint,
	CustomerMarginYear,
	Freight,
	FreightMonth,
	ItemMarginMonth,
	Price,
	PricedLine,
	PricedLines,
	PriceRule
} from './types.ts';

/** How many months of history the part and freight charts show. */
export const MARGIN_MONTHS = 24;

/** The most lines one quote is priced in a single call. */
export const PRICE_LINE_LIMIT = 200;

interface PriceDb {
	customer_no: string;
	item_no: string;
	on_date: string;
	price: number;
	rule: PriceRule;
	detail: string;
	list_price: number;
	discount: number;
	unit_cost: number;
	floor_price: number;
	margin_pct: number | null;
	below_floor: boolean;
}

function toPrice(r: PriceDb): Price {
	return {
		customerNo: r.customer_no,
		itemNo: r.item_no,
		onDate: r.on_date,
		price: r.price,
		rule: r.rule,
		detail: r.detail,
		listPrice: r.list_price,
		discount: r.discount,
		unitCost: r.unit_cost,
		floorPrice: r.floor_price,
		marginPct: r.margin_pct,
		belowFloor: r.below_floor
	};
}

/**
 * The price this account pays for this part, and which rule said so. `onDate`
 * defaults to the company's today, and can be a future date to price a quote
 * that ships later. Null when the part is not in the catalog.
 */
export async function priceFor(
	db: Db,
	userId: number,
	input: { customerNo: string; itemNo: string; onDate?: string | null }
): Promise<Price | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<PriceDb>`
			select * from nl.price_for(${input.customerNo}, ${input.itemNo}, ${input.onDate ?? null}::date)`
	);
	return row ? toPrice(row) : null;
}

/**
 * Price a whole quote in one round trip, in the order the lines were given.
 * A line for a part that is not in the catalog is left out of `lines` and its
 * number is listed in `unknownItems`, so the caller can say which one it was.
 */
export async function priceLines(
	db: Db,
	userId: number,
	input: {
		customerNo: string;
		onDate?: string | null;
		lines: { itemNo: string; quantity: number }[];
	}
): Promise<PricedLines> {
	const asked = input.lines.slice(0, PRICE_LINE_LIMIT).map((line, index) => ({
		line_no: index + 1,
		item_no: line.itemNo,
		quantity: line.quantity
	}));
	if (asked.length === 0) {
		return { lines: [], total: 0, belowFloor: 0, unknownItems: [] };
	}

	const rows = await db.asUser(userId, (tx) =>
		tx.query<PriceDb & { line_no: number; quantity: number; extended: number }>(
			`select l.line_no, l.quantity, p.*, round(l.quantity * p.price, 2) as extended
			 from jsonb_to_recordset($1::jsonb) as l (line_no int, item_no text, quantity int)
			 cross join lateral nl.price_for($2, l.item_no, $3::date) p
			 order by l.line_no`,
			[JSON.stringify(asked), input.customerNo, input.onDate ?? null]
		)
	);

	const lines: PricedLine[] = rows.map((r) => ({
		...toPrice(r),
		lineNo: r.line_no,
		quantity: r.quantity,
		extended: r.extended
	}));
	const priced = new Set(lines.map((line) => line.lineNo));
	return {
		lines,
		// Rounded because adding money in floating point does not stay money.
		total: Math.round(lines.reduce((sum, line) => sum + line.extended, 0) * 100) / 100,
		belowFloor: lines.filter((line) => line.belowFloor).length,
		unknownItems: asked.filter((line) => !priced.has(line.line_no)).map((line) => line.item_no)
	};
}

/** The cost that applied to a part on a date, null for an unknown part. */
export async function costOn(
	db: Db,
	userId: number,
	itemNo: string,
	onDate?: string | null
): Promise<number | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ unit_cost: number | null }>`
			select nl.item_cost_on(${itemNo}, ${onDate ?? null}::date) as unit_cost`
	);
	return row?.unit_cost ?? null;
}

/** A part's cost revisions, oldest first, for the cost history on its page. */
export async function getCostTimeline(db: Db, userId: number, itemNo: string): Promise<CostPoint[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			effective_from: string;
			effective_to: string | null;
			is_current: boolean;
			unit_cost: number;
			vendor_no: string | null;
			source: CostPoint['source'];
			note: string;
			change: number | null;
			change_pct: number | null;
		}>`
			select effective_from, effective_to, is_current, unit_cost, vendor_no, source, note, change, change_pct
			from nl.item_cost_timeline
			where item_no = ${itemNo}
			order by effective_from`
	);
	return rows.map((r) => ({
		effectiveFrom: r.effective_from,
		effectiveTo: r.effective_to,
		isCurrent: r.is_current,
		unitCost: r.unit_cost,
		vendorNo: r.vendor_no,
		source: r.source,
		note: r.note,
		change: r.change,
		changePct: r.change_pct
	}));
}

/**
 * A part's margin by month, oldest first, for the last `months` months
 * including this one. Months with no sales are left out.
 */
export async function getItemMargin(
	db: Db,
	userId: number,
	itemNo: string,
	months = MARGIN_MONTHS
): Promise<ItemMarginMonth[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			month: string;
			lines: number;
			units: number;
			revenue: number;
			cost_of_goods: number;
			gross_margin: number;
			margin_pct: number | null;
		}>(
			`select month, lines, units, revenue, cost_of_goods, gross_margin, margin_pct
			 from nl.item_margin_history
			 where item_no = $1
			   and month >= (date_trunc('month', nl.today()) - make_interval(months => $2::int - 1))::date
			   and month <= date_trunc('month', nl.today())::date
			 order by month`,
			[itemNo, months]
		)
	);
	return rows.map((r) => ({
		month: r.month,
		lines: r.lines,
		units: r.units,
		revenue: r.revenue,
		costOfGoods: r.cost_of_goods,
		grossMargin: r.gross_margin,
		marginPct: r.margin_pct
	}));
}

/** An account's margin by year, newest first. */
export async function getCustomerMargin(
	db: Db,
	userId: number,
	customerNo: string
): Promise<CustomerMarginYear[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			year: number;
			lines: number;
			items: number;
			units: number;
			revenue: number;
			cost_of_goods: number;
			gross_margin: number;
			margin_pct: number | null;
		}>`
			select year, lines, items, units, revenue, cost_of_goods, gross_margin, margin_pct
			from nl.customer_margin
			where customer_no = ${customerNo}
			order by year desc`
	);
	return rows.map((r) => ({
		year: r.year,
		lines: r.lines,
		items: r.items,
		units: r.units,
		revenue: r.revenue,
		costOfGoods: r.cost_of_goods,
		grossMargin: r.gross_margin,
		marginPct: r.margin_pct
	}));
}

/** What the freight tariff charges a shipment of this size on this date. */
export async function freightFor(
	db: Db,
	userId: number,
	subtotal: number,
	onDate?: string | null
): Promise<Freight | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{
			freight: number;
			base_rate: number;
			surcharge_pct: number;
			free_over: number;
			band_min: number;
		}>`select * from nl.freight_for(${subtotal}, ${onDate ?? null}::date)`
	);
	return row
		? {
				freight: row.freight,
				baseRate: row.base_rate,
				surchargePct: row.surcharge_pct,
				freeOver: row.free_over,
				bandMin: row.band_min
			}
		: null;
}

/** Freight billed against the tariff, oldest month first. */
export async function getFreightByMonth(
	db: Db,
	userId: number,
	months = MARGIN_MONTHS
): Promise<FreightMonth[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			month: string;
			invoices: number;
			invoices_with_freight: number;
			subtotal: number;
			freight_billed: number;
			freight_at_rate: number;
			difference: number;
			recovery_ratio: number | null;
		}>(
			`select month, invoices, invoices_with_freight, subtotal, freight_billed, freight_at_rate,
			        difference, recovery_ratio
			 from nl.freight_by_month
			 where month >= (date_trunc('month', nl.today()) - make_interval(months => $1::int - 1))::date
			   and month <= date_trunc('month', nl.today())::date
			 order by month`,
			[months]
		)
	);
	return rows.map((r) => ({
		month: r.month,
		invoices: r.invoices,
		invoicesWithFreight: r.invoices_with_freight,
		subtotal: r.subtotal,
		freightBilled: r.freight_billed,
		freightAtRate: r.freight_at_rate,
		difference: r.difference,
		recoveryRatio: r.recovery_ratio
	}));
}

/**
 * The price agreements on an account, the ones in force first, then by part.
 * groupPrice is what the account would pay today off its tier, so a screen
 * can show what the agreement is worth.
 */
export async function listAgreements(db: Db, userId: number, customerNo: string): Promise<Agreement[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			customer_no: string;
			item_no: string;
			description: string;
			net_price: number;
			valid_from: string;
			valid_to: string | null;
			agreed_by: string | null;
			note: string;
			status: Agreement['status'];
			group_price: number;
			below_floor: boolean;
		}>`
			select
				cp.customer_no,
				cp.item_no,
				i.description,
				cp.net_price,
				cp.valid_from,
				cp.valid_to,
				u.full_name as agreed_by,
				cp.note,
				case when cp.valid_from > t.today then 'upcoming'
				     when cp.valid_to is not null and cp.valid_to < t.today then 'expired'
				     else 'in_force'
				end as status,
				round(i.list_price * (1 - pg.discount), 2) as group_price,
				cp.net_price < round(nl.item_cost_on(cp.item_no, t.today) / (1 - nl.min_margin()), 2) as below_floor
			from nl.customer_prices cp
			join nl.items i on i.item_no = cp.item_no
			join nl.customers c on c.customer_no = cp.customer_no
			join nl.price_groups pg on pg.code = c.price_group
			left join nl.users u on u.id = cp.agreed_by
			cross join (select nl.today() as today) t
			where cp.customer_no = ${customerNo}
			order by (case when cp.valid_from > t.today then 2
			               when cp.valid_to is not null and cp.valid_to < t.today then 3
			               else 1 end),
			         i.description, cp.valid_from desc`
	);
	return rows.map((r) => ({
		customerNo: r.customer_no,
		itemNo: r.item_no,
		description: r.description,
		netPrice: r.net_price,
		validFrom: r.valid_from,
		validTo: r.valid_to,
		agreedBy: r.agreed_by,
		note: r.note,
		status: r.status,
		groupPrice: r.group_price,
		belowFloor: r.below_floor
	}));
}

/** The margin floor the app flags a price against, as a share (0.20 = 20%). */
export async function getMinMargin(db: Db, userId: number): Promise<number> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ min_margin: number }>`select nl.min_margin() as min_margin`
	);
	return row.min_margin;
}
