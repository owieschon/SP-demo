// Published price sheets, published volume ladders, what a customer is used
// to paying, the exceptions behind a number, and the two functions that put
// all of it into one answer.
//
// The rules live in migration 0031 and nowhere else:
//
//   nl.price_quote_for(customer, item, quantity, date)  the quote level price
//   nl.explain_price(...)                               the price and the why
//   nl.answer_for(customer, item, quantity, needed_by)  the why plus the when
//   nl.customer_parts(customer)                         everything they own
//   nl.promise_lead_days(item)                          the lead time to promise
//   nl.vendor_part_lead_times                           quoted against observed
//   nl.customer_item_price_context                      what they last paid
//   nl.account_price_sheet                              the sheet they hold
//   nl.exceptions_for(...) / nl.lead_time_for(...)
//
// Like pricing.ts, nothing here works a price out in JavaScript. These
// functions call the database and rename the columns, so a page, the desk
// agent and the assistant cannot answer the same question three ways.
//
// A word on the JSON: nl.explain_price() and nl.answer_for() return one
// jsonb value each, deliberately, because an explanation is a tree and
// flattening it into columns would lose the shape. The types below say what
// is in it. Postgres has already validated the shape, so these are read as
// typed values rather than parsed again.
import type { Db } from '../db/types.ts';
import type {
	AccountSheet,
	CustomerPart,
	ItemPriceHistory,
	PriceAnswer,
	PriceExplanation,
	PriceSheet,
	PriceSheetLine,
	PromisedLeadTime,
	QuotedLine,
	QuotedLines,
	TradeException,
	VendorPartLeadTime
} from './types.ts';

/** The most lines one quote is priced in a single call, as in pricing.ts. */
export const QUOTE_LINE_LIMIT = 200;

interface QuoteDb {
	customer_no: string;
	item_no: string;
	on_date: string;
	quantity: number;
	price: number;
	rule: QuotedLine['rule'];
	detail: string;
	sheet_id: number | null;
	sheet_code: string | null;
	sheet_name: string | null;
	sheet_price: number | null;
	agreement_net: number | null;
	agreement_from: string | null;
	agreement_to: string | null;
	break_policy: QuotedLine['breakPolicy'];
	break_quantity: number | null;
	break_price: number | null;
	break_note: string;
	break_owner: QuotedLine['breakOwner'];
	unit_price: number;
	extended: number;
	next_quantity: number | null;
	next_price: number | null;
	list_price: number;
	discount: number;
	unit_cost: number;
	floor_price: number;
	margin_pct: number | null;
	below_floor: boolean;
}

function toQuoted(r: QuoteDb, lineNo: number): QuotedLine {
	return {
		lineNo,
		customerNo: r.customer_no,
		itemNo: r.item_no,
		onDate: r.on_date,
		quantity: r.quantity,
		basePrice: r.price,
		rule: r.rule,
		detail: r.detail,
		sheetId: r.sheet_id,
		sheetCode: r.sheet_code,
		sheetName: r.sheet_name,
		sheetPrice: r.sheet_price,
		agreementNet: r.agreement_net,
		agreementFrom: r.agreement_from,
		agreementTo: r.agreement_to,
		breakPolicy: r.break_policy,
		breakQuantity: r.break_quantity,
		breakPrice: r.break_price,
		breakNote: r.break_note === '' ? null : r.break_note,
		breakOwner: r.break_owner,
		unitPrice: r.unit_price,
		extended: r.extended,
		nextQuantity: r.next_quantity,
		nextPrice: r.next_price,
		listPrice: r.list_price,
		discount: r.discount,
		unitCost: r.unit_cost,
		floorPrice: r.floor_price,
		marginPct: r.margin_pct,
		belowFloor: r.below_floor
	};
}

/**
 * The price this account pays for this many of this part, which published
 * document said so, and what the next rung on the ladder costs. This is the
 * quote level rule: it knows the quantity and the sheet, which `priceFor` in
 * pricing.ts does not. Null when the part is not in the catalog.
 */
export async function quotePriceFor(
	db: Db,
	userId: number,
	input: { customerNo: string; itemNo: string; quantity?: number; onDate?: string | null }
): Promise<QuotedLine | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<QuoteDb>`
			select * from nl.price_quote_for(
				${input.customerNo}, ${input.itemNo}, ${input.quantity ?? 1}, ${input.onDate ?? null}::date)`
	);
	return row ? toQuoted(row, 1) : null;
}

/**
 * Price a whole quote at its quantities in one round trip, in the order the
 * lines were given. A line for a part that is not in the catalog is left out
 * of `lines` and its number is listed in `unknownItems`.
 */
export async function quoteLines(
	db: Db,
	userId: number,
	input: {
		customerNo: string;
		onDate?: string | null;
		lines: { itemNo: string; quantity: number }[];
	}
): Promise<QuotedLines> {
	const asked = input.lines.slice(0, QUOTE_LINE_LIMIT).map((line, index) => ({
		line_no: index + 1,
		item_no: line.itemNo,
		quantity: Math.max(1, line.quantity)
	}));
	if (asked.length === 0) {
		return { lines: [], total: 0, belowFloor: 0, unknownItems: [] };
	}

	const rows = await db.asUser(userId, (tx) =>
		tx.query<QuoteDb & { line_no: number }>(
			`select l.line_no, p.*
			 from jsonb_to_recordset($1::jsonb) as l (line_no int, item_no text, quantity int)
			 cross join lateral nl.price_quote_for($2, l.item_no, l.quantity, $3::date) p
			 order by l.line_no`,
			[JSON.stringify(asked), input.customerNo, input.onDate ?? null]
		)
	);

	const lines = rows.map((r) => toQuoted(r, r.line_no));
	const priced = new Set(lines.map((line) => line.lineNo));
	return {
		lines,
		// Rounded because adding money in floating point does not stay money.
		total: Math.round(lines.reduce((sum, line) => sum + line.extended, 0) * 100) / 100,
		belowFloor: lines.filter((line) => line.belowFloor).length,
		unknownItems: asked.filter((line) => !priced.has(line.line_no)).map((line) => line.item_no)
	};
}

/**
 * The price and the whole reasoning behind it: the rule, the ladder, the
 * sheet they hold, what they last paid, the exceptions, the lead time and the
 * sentences a person could say. One query, because an agent that had to ask
 * twice would sooner or later say two different things.
 */
export async function explainPrice(
	db: Db,
	userId: number,
	input: { customerNo: string; itemNo: string; quantity?: number; onDate?: string | null }
): Promise<PriceExplanation | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ explanation: PriceExplanation | null }>`
			select nl.explain_price(
				${input.customerNo}, ${input.itemNo}, ${input.quantity ?? 1}, ${input.onDate ?? null}::date
			) as explanation`
	);
	return row?.explanation ?? null;
}

/**
 * The same explanation with the supply side on it: what can ship now, the
 * earliest date the whole quantity can ship and why, and the part that
 * replaces this one if it has been discontinued. This is what the desk agent
 * calls inside a reply.
 */
export async function answerFor(
	db: Db,
	userId: number,
	input: { customerNo: string; itemNo: string; quantity?: number; neededBy?: string | null }
): Promise<PriceAnswer | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ answer: PriceAnswer | null }>`
			select nl.answer_for(
				${input.customerNo}, ${input.itemNo}, ${input.quantity ?? 1}, ${input.neededBy ?? null}::date
			) as answer`
	);
	return row?.answer ?? null;
}

/** The sheet generations for a tier, or for every tier, newest first. */
export async function listPriceSheets(
	db: Db,
	userId: number,
	priceGroup?: string | null
): Promise<PriceSheet[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			id: number;
			code: string;
			name: string;
			price_group: string;
			label: string;
			effective_from: string;
			effective_to: string | null;
			published_on: string;
			note: string;
			lines: number;
			sent_to: number;
		}>(
			`select
			   ps.id, ps.code, ps.name, ps.price_group, pg.label,
			   ps.effective_from, ps.effective_to, ps.published_on, ps.note,
			   (select count(*)::int from nl.price_sheet_lines l where l.sheet_id = ps.id) as lines,
			   (select count(*)::int from nl.price_sheet_sends s where s.sheet_id = ps.id) as sent_to
			 from nl.price_sheets ps
			 join nl.price_groups pg on pg.code = ps.price_group
			 where $1::text is null or ps.price_group = $1
			 order by ps.price_group, ps.effective_from desc`,
			[priceGroup ?? null]
		)
	);
	return rows.map((r) => ({
		id: r.id,
		code: r.code,
		name: r.name,
		priceGroup: r.price_group,
		priceGroupLabel: r.label,
		effectiveFrom: r.effective_from,
		effectiveTo: r.effective_to,
		publishedOn: r.published_on,
		note: r.note,
		lines: r.lines,
		sentTo: r.sent_to
	}));
}

/**
 * One part's price on every sheet it has ever appeared on, newest first, with
 * the published ladder for the sheet in force. This is the price history a
 * part page shows next to its cost history.
 */
export async function getSheetHistory(
	db: Db,
	userId: number,
	itemNo: string
): Promise<PriceSheetLine[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			sheet_id: number;
			code: string;
			name: string;
			price_group: string;
			effective_from: string;
			effective_to: string | null;
			is_current: boolean;
			sheet_price: number;
			list_at_publication: number;
			note: string;
			rungs: { min_quantity: number; break_price: number; note: string }[] | null;
		}>`
			select
				ps.id as sheet_id, ps.code, ps.name, ps.price_group,
				ps.effective_from, ps.effective_to, ps.effective_to is null as is_current,
				psl.sheet_price, psl.list_at_publication, psl.note,
				(select jsonb_agg(jsonb_build_object(
				          'min_quantity', pb.min_quantity, 'break_price', pb.break_price, 'note', pb.note)
				        order by pb.min_quantity)
				 from nl.price_breaks pb
				 where pb.sheet_id = ps.id and pb.item_no = psl.item_no) as rungs
			from nl.price_sheet_lines psl
			join nl.price_sheets ps on ps.id = psl.sheet_id
			where psl.item_no = ${itemNo}
			order by ps.effective_from desc, ps.price_group`
	);
	return rows.map((r) => ({
		sheetId: r.sheet_id,
		code: r.code,
		name: r.name,
		priceGroup: r.price_group,
		effectiveFrom: r.effective_from,
		effectiveTo: r.effective_to,
		isCurrent: r.is_current,
		sheetPrice: r.sheet_price,
		listAtPublication: r.list_at_publication,
		note: r.note,
		ladder: (r.rungs ?? []).map((rung) => ({
			minQuantity: rung.min_quantity,
			breakPrice: rung.break_price,
			note: rung.note
		}))
	}));
}

/** The sheet an account is holding, and how far behind the current one it is. */
export async function getAccountSheet(
	db: Db,
	userId: number,
	customerNo: string
): Promise<AccountSheet | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{
			sheet_id: number;
			sheet_code: string;
			sheet_name: string;
			price_group: string;
			effective_from: string;
			effective_to: string | null;
			is_current: boolean;
			sent_on: string;
			sent_how: AccountSheet['sentHow'];
			days_old: number;
			stale: boolean;
			generations_behind: number;
		}>`
			select sheet_id, sheet_code, sheet_name, price_group, effective_from, effective_to,
			       is_current, sent_on, sent_how, days_old, stale, generations_behind
			from nl.account_price_sheet
			where customer_no = ${customerNo}`
	);
	return row
		? {
				sheetId: row.sheet_id,
				code: row.sheet_code,
				name: row.sheet_name,
				priceGroup: row.price_group,
				effectiveFrom: row.effective_from,
				effectiveTo: row.effective_to,
				isCurrent: row.is_current,
				sentOn: row.sent_on,
				sentHow: row.sent_how,
				daysOld: row.days_old,
				stale: row.stale,
				generationsBehind: row.generations_behind
			}
		: null;
}

/**
 * What an account is used to paying for one part, or for every part it has
 * bought when `itemNo` is left out. Ordered so the numbers most likely to
 * surprise a buyer come first.
 */
export async function getPriceHistory(
	db: Db,
	userId: number,
	customerNo: string,
	itemNo?: string | null
): Promise<ItemPriceHistory[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			item_no: string;
			description: string;
			times_bought: number;
			units: number;
			first_bought: string;
			last_bought: string;
			days_since: number;
			last_price: number;
			last_quantity: number;
			last_invoice_no: string;
			avg_price_12m: number | null;
			high_price: number;
			low_price: number;
			today_price: number;
			tier_price: number;
			sheet_code: string | null;
			above_last_paid_pct: number | null;
			above_last_paid: boolean;
		}>(
			`select
			   ctx.item_no, i.description, ctx.times_bought, ctx.units, ctx.first_bought, ctx.last_bought,
			   ctx.days_since, ctx.last_price, ctx.last_quantity, ctx.last_invoice_no, ctx.avg_price_12m,
			   ctx.high_price, ctx.low_price, ctx.today_price, ctx.tier_price, ctx.sheet_code,
			   ctx.above_last_paid_pct, ctx.above_last_paid
			 from nl.customer_item_price_context ctx
			 join nl.items i on i.item_no = ctx.item_no
			 where ctx.customer_no = $1
			   and ($2::text is null or ctx.item_no = $2)
			 order by ctx.above_last_paid desc, ctx.above_last_paid_pct desc nulls last, ctx.item_no`,
			[customerNo, itemNo ?? null]
		)
	);
	return rows.map((r) => ({
		itemNo: r.item_no,
		description: r.description,
		timesBought: r.times_bought,
		units: r.units,
		firstBought: r.first_bought,
		lastBought: r.last_bought,
		daysSince: r.days_since,
		lastPrice: r.last_price,
		lastQuantity: r.last_quantity,
		lastInvoiceNo: r.last_invoice_no,
		avgPrice12m: r.avg_price_12m,
		highPrice: r.high_price,
		lowPrice: r.low_price,
		todayPrice: r.today_price,
		tierPrice: r.tier_price,
		sheetCode: r.sheet_code,
		aboveLastPaidPct: r.above_last_paid_pct,
		aboveLastPaid: r.above_last_paid
	}));
}

/**
 * Everything under one account's roof: every part they have ever bought, what
 * they spent, what they paid, whether they are still buying it, and what
 * state the part is in today. Biggest twelve month spend first.
 */
export async function getCustomerParts(
	db: Db,
	userId: number,
	customerNo: string
): Promise<CustomerPart[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			item_no: string;
			description: string;
			family: string;
			times_bought: number;
			units: number;
			revenue: number;
			units_12m: number;
			revenue_12m: number;
			times_12m: number;
			first_bought: string;
			last_bought: string;
			days_since: number;
			last_price: number;
			last_quantity: number;
			avg_price_12m: number | null;
			high_price: number;
			low_price: number;
			today_price: number;
			above_last_paid: boolean;
			buying_status: CustomerPart['buyingStatus'];
			part_status: CustomerPart['partStatus'];
			on_hand: number;
			on_order: number;
			lead_days: number;
			lead_slipped: boolean;
			lead_basis: CustomerPart['leadBasis'];
			can_promise: boolean;
			source_vendor_no: string | null;
			blocked: boolean;
			discontinued_on: string | null;
			replacement_item_no: string | null;
			replacement_description: string | null;
		}>`
			select item_no, description, family, times_bought, units, revenue, units_12m, revenue_12m,
			       times_12m, first_bought, last_bought, days_since, last_price, last_quantity,
			       avg_price_12m, high_price, low_price, today_price, above_last_paid, buying_status,
			       part_status, on_hand, on_order, lead_days, lead_slipped, lead_basis, can_promise,
			       source_vendor_no, blocked, discontinued_on,
			       replacement_item_no, replacement_description
			from nl.customer_parts(${customerNo})
			order by revenue_12m desc, revenue desc, item_no`
	);
	return rows.map((r) => ({
		itemNo: r.item_no,
		description: r.description,
		family: r.family,
		timesBought: r.times_bought,
		units: r.units,
		revenue: r.revenue,
		units12m: r.units_12m,
		revenue12m: r.revenue_12m,
		times12m: r.times_12m,
		firstBought: r.first_bought,
		lastBought: r.last_bought,
		daysSince: r.days_since,
		lastPrice: r.last_price,
		lastQuantity: r.last_quantity,
		avgPrice12m: r.avg_price_12m,
		highPrice: r.high_price,
		lowPrice: r.low_price,
		todayPrice: r.today_price,
		aboveLastPaid: r.above_last_paid,
		buyingStatus: r.buying_status,
		partStatus: r.part_status,
		onHand: r.on_hand,
		onOrder: r.on_order,
		leadDays: r.lead_days,
		leadSlipped: r.lead_slipped,
		leadBasis: r.lead_basis,
		canPromise: r.can_promise,
		sourceVendorNo: r.source_vendor_no,
		blocked: r.blocked,
		discontinuedOn: r.discontinued_on,
		replacementItemNo: r.replacement_item_no,
		replacementDescription: r.replacement_description
	}));
}

/**
 * Published exceptions, live and announced first. Narrow it to one part, one
 * account or one kind; with nothing set it is the whole exception list, which
 * is what an operations screen shows.
 */
export async function listExceptions(
	db: Db,
	userId: number,
	filter: { itemNo?: string | null; customerNo?: string | null; kind?: string | null } = {}
): Promise<TradeException[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			id: number;
			kind: TradeException['kind'];
			scope: TradeException['scope'];
			status: TradeException['status'];
			item_no: string | null;
			family: string | null;
			product_group: string | null;
			customer_no: string | null;
			price_group: string | null;
			announced_on: string;
			effective_from: string;
			effective_to: string | null;
			days_left: number | null;
			pct: number | null;
			amount: number | null;
			quantity: number | null;
			days: number | null;
			held_sheet_id: number | null;
			replacement_item_no: string | null;
			reason: string;
			wording: string;
			owner_id: number;
		}>(
			`select id, kind, scope, status, item_no, family, product_group, customer_no, price_group,
			        announced_on, effective_from, effective_to, days_left, pct, amount, quantity, days,
			        held_sheet_id, replacement_item_no, reason, wording, owner_id
			 from nl.trade_exceptions_live
			 where ($1::text is null or item_no = $1)
			   and ($2::text is null or customer_no = $2)
			   and ($3::text is null or kind = $3)
			 order by case status when 'live' then 1 when 'announced' then 2 else 3 end,
			          effective_from desc, id`,
			[filter.itemNo ?? null, filter.customerNo ?? null, filter.kind ?? null]
		)
	);
	return rows.map((r) => ({
		id: r.id,
		kind: r.kind,
		scope: r.scope,
		status: r.status,
		itemNo: r.item_no,
		family: r.family,
		productGroup: r.product_group,
		customerNo: r.customer_no,
		priceGroup: r.price_group,
		announcedOn: r.announced_on,
		effectiveFrom: r.effective_from,
		effectiveTo: r.effective_to,
		daysLeft: r.days_left,
		pct: r.pct,
		amount: r.amount,
		quantity: r.quantity,
		days: r.days,
		heldSheetId: r.held_sheet_id,
		replacementItemNo: r.replacement_item_no,
		reason: r.reason,
		wording: r.wording === '' ? null : r.wording,
		ownerId: r.owner_id
	}));
}

/**
 * The percentage above what an account last paid at which the app says so out
 * loud. A screen reads it so the threshold is stated once, in SQL.
 */
export async function getPriceJumpPct(db: Db, userId: number): Promise<number> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ pct: number }>`select nl.price_jump_pct() as pct`
	);
	return row.pct;
}

/**
 * The lead time to promise with for one part, and why: the ninetieth
 * percentile of what the vendor has actually done where there is enough
 * history, their quote where there is not, then the item card, then the vendor
 * card as a default. `canPromise` is false where no date should be given at
 * all, because the source has the part on allocation or has discontinued it.
 *
 * Null for a part that is not in the catalog.
 */
export async function getPromisedLeadTime(
	db: Db,
	userId: number,
	itemNo: string
): Promise<PromisedLeadTime | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{
			item_no: string;
			lead_days: number;
			basis: PromisedLeadTime['basis'];
			detail: string;
			can_promise: boolean;
			vendor_no: string | null;
			is_primary: boolean | null;
			receipts: number;
			median_days: number | null;
			p90_days: number | null;
			worst_days: number | null;
			late_share: number | null;
			quoted_lead_days: number | null;
			quoted_on: string | null;
			quote_reference: string;
			vendor_status: PromisedLeadTime['vendorStatus'];
			status_note: string;
			replacement_item_no: string | null;
			min_order_qty: number;
			order_multiple: number;
		}>`select * from nl.promise_lead_days(${itemNo})`
	);
	if (!row) return null;
	return {
		itemNo: row.item_no,
		leadDays: row.lead_days,
		basis: row.basis,
		detail: row.detail,
		canPromise: row.can_promise,
		vendorNo: row.vendor_no,
		isPrimary: row.is_primary,
		receipts: row.receipts,
		medianDays: row.median_days,
		p90Days: row.p90_days,
		worstDays: row.worst_days,
		lateShare: row.late_share,
		quotedLeadDays: row.quoted_lead_days,
		quotedOn: row.quoted_on,
		quoteReference: row.quote_reference,
		vendorStatus: row.vendor_status,
		statusNote: row.status_note,
		replacementItemNo: row.replacement_item_no,
		minOrderQty: row.min_order_qty,
		orderMultiple: row.order_multiple
	};
}

/**
 * Every part a vendor supplies, with what they quote next to what they
 * actually do, and their own price ladder. Sorted the way a buyer works: the
 * parts whose observed tail runs furthest past the quote first, then the ones
 * with no history to judge by, then the rest.
 *
 * This is what replaces a single lead time figure on a vendor page. A vendor
 * level lead time still exists on the vendor card, but it is a default for a
 * part with no history of its own and has to be labelled as one.
 *
 * Pass `itemNo` to narrow it to one part, for a part page that wants to show
 * every source it could come from.
 */
export async function getVendorPartLeadTimes(
	db: Db,
	userId: number,
	filter: { vendorNo?: string | null; itemNo?: string | null } = {}
): Promise<VendorPartLeadTime[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			vendor_no: string;
			item_no: string;
			description: string;
			family: string;
			is_primary: boolean;
			status: VendorPartLeadTime['status'];
			status_note: string;
			replacement_item_no: string | null;
			min_order_qty: number;
			order_multiple: number;
			unit_cost: number | null;
			quoted_lead_days: number | null;
			quoted_on: string | null;
			quote_reference: string;
			receipts: number | null;
			median_days: number | null;
			p90_days: number | null;
			worst_days: number | null;
			late_receipts: number | null;
			late_share: number | null;
			worst_days_late: number | null;
			last_received: string | null;
			tail_days: number | null;
			promise_days: number;
			promise_basis: VendorPartLeadTime['promiseBasis'];
			promise_detail: string;
			can_promise: boolean;
			history_is_enough: boolean;
			ladder: { min_quantity: number; unit_cost: number; note: string }[] | null;
		}>(
			`select
			   t.*,
			   (select jsonb_agg(jsonb_build_object(
			             'min_quantity', b.min_quantity, 'unit_cost', b.unit_cost, 'note', b.note)
			           order by b.min_quantity)
			    from nl.vendor_item_breaks b
			    where b.vendor_no = t.vendor_no and b.item_no = t.item_no) as ladder
			 from nl.vendor_part_lead_times t
			 where ($1::text is null or t.vendor_no = $1)
			   and ($2::text is null or t.item_no = $2)
			 -- The buyer's work list: the worst tail first, then the parts with
			 -- no history to judge by, then the rest.
			 order by t.tail_days desc nulls first, t.p90_days desc nulls last, t.item_no`,
			[filter.vendorNo ?? null, filter.itemNo ?? null]
		)
	);
	return rows.map((r) => ({
		vendorNo: r.vendor_no,
		itemNo: r.item_no,
		description: r.description,
		family: r.family,
		isPrimary: r.is_primary,
		status: r.status,
		statusNote: r.status_note,
		replacementItemNo: r.replacement_item_no,
		minOrderQty: r.min_order_qty,
		orderMultiple: r.order_multiple,
		unitCost: r.unit_cost,
		quotedLeadDays: r.quoted_lead_days,
		quotedOn: r.quoted_on,
		quoteReference: r.quote_reference,
		receipts: r.receipts ?? 0,
		medianDays: r.median_days,
		p90Days: r.p90_days,
		worstDays: r.worst_days,
		lateReceipts: r.late_receipts,
		lateShare: r.late_share,
		worstDaysLate: r.worst_days_late,
		lastReceived: r.last_received,
		tailDays: r.tail_days,
		promiseDays: r.promise_days,
		promiseBasis: r.promise_basis,
		promiseDetail: r.promise_detail,
		canPromise: r.can_promise,
		historyIsEnough: r.history_is_enough,
		ladder: (r.ladder ?? []).map((rung) => ({
			minQuantity: rung.min_quantity,
			unitCost: rung.unit_cost,
			note: rung.note
		}))
	}));
}

/**
 * How many receipts a vendor and part need before the observed lead time is
 * trusted over the vendor's quote. A screen reads it so the threshold it
 * prints and the rule the database follows cannot drift apart.
 */
export async function getPromiseMinReceipts(db: Db, userId: number): Promise<number> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ receipts: number }>`select nl.promise_min_receipts() as receipts`
	);
	return row.receipts;
}
