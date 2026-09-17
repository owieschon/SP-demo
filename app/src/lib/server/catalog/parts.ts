// Parts: the list and the part page.
//
// Every figure comes from the database: nl.part_summary (migration 0015)
// adds up stock, sales, margin and open-order demand per part. The part
// page's sections are separate reads, so the page can show its header at
// once and stream the rest.
import type { Db } from '../db/types.ts';
import {
	PART_SORTS,
	type FamilyOption,
	type OpenBucket,
	type PartCommitment,
	type PartDemand,
	type PartDetail,
	type PartList,
	type PartListQuery,
	type PartQuote,
	type PartRow,
	type PartSales,
	type PartSort,
	type Siblings
} from '$lib/components/catalog/types';
import { cleanQuery, containsPattern, prefixPattern } from './search.ts';

/** How many rows the parts list shows. */
export const PART_LIST_LIMIT = 100;
/** How many open lines a part page lists. */
export const PART_OPEN_LINE_LIMIT = 40;
/** How many sibling parts a part page lists. */
export const SIBLING_LIMIT = 12;

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/** Read the list's filters from the URL. Anything unexpected falls back to the default. */
export function readPartListQuery(params: URLSearchParams): PartListQuery {
	const sort = params.get('sort');
	const family = params.get('family')?.trim();
	return {
		q: cleanQuery(params.get('q')),
		family: family ? family.toLowerCase() : null,
		short: params.get('short') === '1',
		belowReorder: params.get('reorder') === '1',
		sort: PART_SORTS.includes(sort as PartSort) ? (sort as PartSort) : 'revenue'
	};
}

// Sort orders, written out in full so no text from the URL ever reaches the SQL.
const ORDER_BY: Record<PartSort, string> = {
	revenue: 'p.revenue_12m desc, p.item_no',
	margin: 'p.margin_12m desc nulls last, p.revenue_12m desc, p.item_no',
	on_hand: 'p.on_hand desc, p.item_no'
};

interface PartRowDb {
	item_no: string;
	description: string;
	family: string;
	on_hand: number;
	units_12m: number;
	revenue_12m: number;
	margin_12m: number | null;
	last_sold_on: string | null;
	made_to_order: boolean;
	proprietary: boolean;
	blocked: boolean;
	below_reorder_point: boolean;
	short_qty: number;
	total: number;
}

export async function listParts(db: Db, userId: number, query: PartListQuery): Promise<PartList> {
	// Each word must start the part number or appear in the description.
	const words = query.q
		.split(' ')
		.filter(Boolean)
		.slice(0, 6)
		.map((word) => ({ prefix: prefixPattern(word), contains: containsPattern(word) }));

	const rows = await db.asUser(userId, (tx) =>
		tx.query<PartRowDb>(
			`select p.item_no, p.description, p.family, p.on_hand, p.units_12m, p.revenue_12m, p.margin_12m,
			        p.last_sold_on, p.made_to_order, p.proprietary, p.blocked, p.below_reorder_point, p.short_qty,
			        count(*) over ()::int as total
			 from nl.part_summary p
			 where not exists (
			         select 1
			         from jsonb_to_recordset($1::jsonb) as w (prefix text, contains text)
			         where not (lower(p.item_no) like w.prefix or p.description ilike w.contains))
			   and ($2::text is null or p.family = $2)
			   and (not $3::boolean or p.short_qty > 0)
			   and (not $4::boolean or p.below_reorder_point)
			 order by ${ORDER_BY[query.sort]}
			 limit $5`,
			[JSON.stringify(words), query.family, query.short, query.belowReorder, PART_LIST_LIMIT]
		)
	);
	return {
		rows: rows.map(toPartRow),
		total: rows[0]?.total ?? 0,
		limit: PART_LIST_LIMIT
	};
}

function toPartRow(r: PartRowDb): PartRow {
	return {
		itemNo: r.item_no,
		description: r.description,
		family: r.family,
		onHand: r.on_hand,
		units12m: r.units_12m,
		revenue12m: r.revenue_12m,
		margin12m: r.margin_12m,
		lastSoldOn: r.last_sold_on,
		madeToOrder: r.made_to_order,
		proprietary: r.proprietary,
		blocked: r.blocked,
		belowReorderPoint: r.below_reorder_point,
		shortQty: r.short_qty
	};
}

/** The families for the list's filter, with how many parts each has. */
export async function listFamilies(db: Db, userId: number): Promise<FamilyOption[]> {
	return db.asUser(userId, (tx) =>
		tx.sql<FamilyOption>`
			select family, count(*)::int as items
			from nl.items
			group by family
			order by family`
	);
}

// ---------------------------------------------------------------------------
// One part
// ---------------------------------------------------------------------------

/**
 * Which item number a URL means. Item numbers are upper case; a link typed
 * in lower case finds the part too, and the page redirects to the real number.
 */
export async function resolveItemNo(db: Db, userId: number, asked: string): Promise<string | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ item_no: string }>`
			select item_no from nl.items
			where item_no = ${asked} or item_no = ${asked.toUpperCase()}
			order by item_no = ${asked} desc
			limit 1`
	);
	return row?.item_no ?? null;
}

export async function getPart(db: Db, userId: number, itemNo: string): Promise<PartDetail | null> {
	const [r] = await db.asUser(userId, (tx) =>
		tx.sql<Record<string, unknown>>`
			select p.*, v.name as vendor_name, v.lead_time as vendor_lead_time
			from nl.part_summary p
			left join nl.vendors v on v.vendor_no = p.vendor_no
			where p.item_no = ${itemNo}`
	);
	if (!r) return null;
	return {
		itemNo: r.item_no as string,
		description: r.description as string,
		category: r.category as string,
		family: r.family as string,
		productGroup: r.product_group as string,
		replenishment: r.replenishment as string,
		workCenter: r.work_center as string,
		leadTime: r.lead_time as string,
		unitCost: r.unit_cost as number,
		listPrice: r.list_price as number,
		listMargin: r.list_margin as number | null,
		vendorNo: r.vendor_no as string | null,
		vendorName: r.vendor_name as string | null,
		vendorLeadTime: r.vendor_lead_time as string | null,
		shelf: (r.shelf as string | null) ?? '',
		bin: (r.bin as string | null) ?? '',
		stockAsOf: r.stock_as_of as string | null,
		onHand: r.on_hand as number,
		onProductionOrder: r.on_production_order as number,
		onPurchaseOrder: r.on_purchase_order as number,
		openLines: r.open_lines as number,
		openQty: r.open_qty as number,
		openValue: r.open_value as number,
		shortQty: r.short_qty as number,
		projectedAvailable: r.projected_available as number,
		belowReorderPoint: r.below_reorder_point as boolean,
		reorderPoint: r.reorder_point as number | null,
		safetyStock: r.safety_stock as number | null,
		units12m: r.units_12m as number,
		revenue12m: r.revenue_12m as number,
		margin12m: r.margin_12m as number | null,
		buyers12m: r.buyers_12m as number,
		unitsPrior12m: r.units_prior_12m as number,
		revenuePrior12m: r.revenue_prior_12m as number,
		lastSoldOn: r.last_sold_on as string | null,
		madeToOrder: r.made_to_order as boolean,
		proprietary: r.proprietary as boolean,
		blocked: r.blocked as boolean
	};
}

/** The part's sales: 24 months of units, its top buyers this year, and its latest lines. */
export async function getPartSales(db: Db, userId: number, itemNo: string): Promise<PartSales> {
	return db.asUser(userId, async (tx) => {
		// Every month of the last 24, including the empty ones, so the chart
		// has no gaps. The lines come from invoice_lines_item_posted_idx.
		const months = await tx.sql<{ month: string; units: number; revenue: number }>`
			with months as (
				select m::date as month
				from generate_series(
					date_trunc('month', (select nl.today())::timestamp) - interval '23 months',
					date_trunc('month', (select nl.today())::timestamp),
					interval '1 month') as m
			)
			select m.month,
			       coalesce(sum(il.quantity), 0)::int as units,
			       coalesce(sum(il.amount), 0) as revenue
			from months m
			left join nl.invoice_lines il
			  on il.item_no = ${itemNo}
			 and il.posted_on >= m.month
			 and il.posted_on < (m.month + interval '1 month')::date
			 and il.posted_on <= (select nl.today())
			group by m.month
			order by m.month`;

		// Who bought it in the last 12 months, biggest first, with the price
		// they paid on their latest order.
		const buyers = await tx.sql<{
			customer_no: string;
			name: string;
			city: string;
			state: string;
			country: string;
			units: number;
			revenue: number;
			last_price: number | null;
			last_on: string | null;
		}>`
			with lines as (
				select il.customer_no, il.invoice_no, il.line_no, il.posted_on, il.quantity, il.unit_price, il.amount
				from nl.invoice_lines il
				where il.item_no = ${itemNo}
				  and il.posted_on > (select (nl.today() - interval '1 year')::date)
				  and il.posted_on <= (select nl.today())
			),
			totals as (
				select customer_no, sum(quantity)::int as units, sum(amount) as revenue
				from lines
				group by customer_no
			),
			latest as (
				select distinct on (customer_no) customer_no, unit_price, posted_on
				from lines
				where quantity > 0
				order by customer_no, posted_on desc, invoice_no desc, line_no desc
			)
			select t.customer_no, c.name, c.city, c.state, c.country, t.units, t.revenue,
			       l.unit_price as last_price, l.posted_on as last_on
			from totals t
			join nl.customers c on c.customer_no = t.customer_no
			left join latest l on l.customer_no = t.customer_no
			where t.units > 0
			order by t.revenue desc, t.customer_no
			limit 10`;

		const lines = await tx.sql<{
			invoice_no: string;
			line_no: number;
			posted_on: string;
			doc_type: string;
			customer_no: string;
			customer_name: string;
			quantity: number;
			unit_price: number;
			amount: number;
		}>`
			select il.invoice_no, il.line_no, il.posted_on, inv.doc_type, il.customer_no, c.name as customer_name,
			       il.quantity, il.unit_price, il.amount
			from nl.invoice_lines il
			join nl.invoices inv on inv.invoice_no = il.invoice_no
			join nl.customers c on c.customer_no = il.customer_no
			where il.item_no = ${itemNo}
			order by il.posted_on desc, il.invoice_no desc, il.line_no desc
			limit 15`;

		return {
			months,
			topBuyers: buyers.map((b) => ({
				customerNo: b.customer_no,
				name: b.name,
				city: b.city,
				state: b.state,
				country: b.country,
				units: b.units,
				revenue: b.revenue,
				lastPrice: b.last_price,
				lastOn: b.last_on
			})),
			recentLines: lines.map((l) => ({
				invoiceNo: l.invoice_no,
				lineNo: l.line_no,
				postedOn: l.posted_on,
				isCreditMemo: l.doc_type === 'credit_memo',
				customerNo: l.customer_no,
				customerName: l.customer_name,
				quantity: l.quantity,
				unitPrice: l.unit_price,
				amount: l.amount
			}))
		};
	});
}

/** What is asked of the part: open order lines, commitments and open quotes. */
export async function getPartDemand(db: Db, userId: number, itemNo: string): Promise<PartDemand> {
	return db.asUser(userId, async (tx) => {
		const open = await tx.sql<{
			document_no: string;
			line_no: number;
			customer_no: string;
			customer_name: string;
			ship_date: string;
			quantity: number;
			allocated: number;
			short: number;
			open_value: number;
			bucket: OpenBucket;
			total: number;
		}>`
			select a.document_no, a.line_no, a.customer_no, c.name as customer_name, a.ship_date,
			       a.quantity, a.allocated, a.short, a.open_value, a.bucket,
			       count(*) over ()::int as total
			from nl.open_line_allocation a
			join nl.customers c on c.customer_no = a.customer_no
			where a.item_no = ${itemNo}
			order by a.ship_date, a.document_no, a.line_no
			limit ${PART_OPEN_LINE_LIMIT}`;

		// Open commitments first, then the most recently closed.
		const commitments = await tx.sql<{
			id: number;
			title: string;
			customer_no: string;
			customer_name: string;
			owner_name: string;
			status: PartCommitment['status'];
			is_settled: boolean;
			starts_on: string;
			ends_on: string;
			committed_value: number;
			delivered_ratio: number;
			quantity: number | null;
		}>`
			select p.id, p.title, p.customer_no, c.name as customer_name, u.full_name as owner_name,
			       p.status, p.is_settled, p.starts_on, p.ends_on, p.committed_value, p.delivered_ratio,
			       ci.quantity
			from nl.commitment_items ci
			join nl.commitment_progress p on p.id = ci.commitment_id
			join nl.customers c on c.customer_no = p.customer_no
			join nl.users u on u.id = p.owner_id
			where ci.item_no = ${itemNo}
			order by p.is_settled, p.ends_on desc, p.id desc
			limit 20`;

		// A quote is open until its valid-until date passes.
		const quotes = await tx.sql<{
			id: number;
			line_no: number;
			customer_no: string;
			customer_name: string;
			quoted_on: string;
			valid_until: string | null;
			commitment_id: number | null;
			quantity: number;
			unit_price: number;
			created_by: string;
		}>`
			select q.id, ql.line_no, q.customer_no, c.name as customer_name, q.quoted_on, q.valid_until,
			       q.commitment_id, ql.quantity, ql.unit_price, u.full_name as created_by
			from nl.quote_lines ql
			join nl.quotes q on q.id = ql.quote_id
			join nl.customers c on c.customer_no = q.customer_no
			join nl.users u on u.id = q.created_by
			where ql.item_no = ${itemNo}
			  and (q.valid_until is null or q.valid_until >= (select nl.today()))
			order by q.quoted_on desc, q.id desc, ql.line_no
			limit 20`;

		return {
			openLineCount: open[0]?.total ?? 0,
			openLines: open.map((l) => ({
				documentNo: l.document_no,
				lineNo: l.line_no,
				customerNo: l.customer_no,
				customerName: l.customer_name,
				shipDate: l.ship_date,
				quantity: l.quantity,
				allocated: l.allocated,
				short: l.short,
				openValue: l.open_value,
				bucket: l.bucket
			})),
			commitments: commitments.map((c) => ({
				id: c.id,
				title: c.title,
				customerNo: c.customer_no,
				customerName: c.customer_name,
				ownerName: c.owner_name,
				status: c.status,
				isSettled: c.is_settled,
				startsOn: c.starts_on,
				endsOn: c.ends_on,
				committedValue: c.committed_value,
				deliveredRatio: c.delivered_ratio,
				quantity: c.quantity
			})),
			quotes: quotes.map(
				(q): PartQuote => ({
					id: q.id,
					lineNo: q.line_no,
					customerNo: q.customer_no,
					customerName: q.customer_name,
					quotedOn: q.quoted_on,
					validUntil: q.valid_until,
					commitmentId: q.commitment_id,
					quantity: q.quantity,
					unitPrice: q.unit_price,
					createdBy: q.created_by
				})
			)
		};
	});
}

/**
 * The size a part's description prints first: '5" X 48" ...' -> '5'.
 * Descriptions are printed from the same grammar as part numbers, and they
 * are unambiguous where a number is not (L3515 is 3.5" at 15 degrees).
 */
const SIZE_PATTERN = '(\\d+(?:\\.\\d+)?)"';

/**
 * Parts from the same family and size, best sellers first. A part with no
 * size in its description (custom and proprietary parts, mufflers by
 * number) has no siblings.
 */
export async function getSiblings(db: Db, userId: number, itemNo: string): Promise<Siblings> {
	return db.asUser(userId, async (tx) => {
		const [me] = await tx.sql<{ family: string; size: string | null }>`
			select family, substring(description from ${SIZE_PATTERN}) as size
			from nl.items
			where item_no = ${itemNo}`;
		if (!me?.size || me.family === 'custom' || me.family === 'proprietary') {
			return { size: null, parts: [] };
		}
		const rows = await tx.sql<{
			item_no: string;
			description: string;
			on_hand: number;
			revenue_12m: number;
			blocked: boolean;
			made_to_order: boolean;
		}>`
			select p.item_no, p.description, p.on_hand, p.revenue_12m, p.blocked, p.made_to_order
			from nl.part_summary p
			where p.family = ${me.family}
			  and p.item_no <> ${itemNo}
			  and substring(p.description from ${SIZE_PATTERN}) = ${me.size}
			order by p.blocked, p.revenue_12m desc, p.item_no
			limit ${SIBLING_LIMIT}`;
		return {
			size: `${me.size}"`,
			parts: rows.map((r) => ({
				itemNo: r.item_no,
				description: r.description,
				onHand: r.on_hand,
				revenue12m: r.revenue_12m,
				blocked: r.blocked,
				madeToOrder: r.made_to_order
			}))
		};
	});
}
