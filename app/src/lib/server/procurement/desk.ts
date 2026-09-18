// What the /procurement page reads.
//
// All of it is derived in SQL (migration 0022) and only reshaped here, so the
// page, the tests and anything else asking the same question get the same
// answer. Nothing in this file works out a quantity, a date or a price in
// JavaScript.
import type { Db, Row } from '../db/types.ts';
import type {
	DemandShape,
	ProcurementDesk,
	ProcurementSources,
	PurchaseRequest,
	ReplenishmentLine,
	RequestLine,
	RequestStatus,
	SignalKind,
	SignalRow,
	TriggerReason,
	VendorEmailDraft,
	VendorGroup
} from '$lib/components/procurement/types';

/** How many parts the list shows before it asks the reader to filter. */
export const PART_LIMIT = 200;

/** How many signals the log shows. */
export const SIGNAL_LIMIT = 60;

interface ReplenishmentDb extends Row {
	item_no: string;
	description: string;
	family: string;
	blocked: boolean;
	vendor_no: string | null;
	vendor_name: string | null;
	vendor_terms: string | null;
	vendor_freight_terms: string | null;
	vendor_min_order: number | null;
	vendor_free_freight_at: number | null;
	reorder_point: number | null;
	safety_stock: number | null;
	policy_level: number | null;
	lead_time_formula: string;
	lead_time_days: number;
	horizon_on: string;
	on_hand: number;
	unit_cost: number;
	pack: number;
	per_day: number;
	per_week: number;
	units_90d: number;
	units_365d: number;
	demand_shape: DemandShape;
	demand_cv: number | null;
	revenue_90d: number;
	last_sold_on: string | null;
	promised_total: number;
	promised_before_horizon: number;
	promised_past_due: number;
	incoming_before_horizon: number;
	on_order_total: number;
	on_order_later: number;
	projected_available: number;
	target_qty: number;
	days_of_cover: number | null;
	runs_out_on: string | null;
	order_by_on: string | null;
	requested_on: string;
	suggested_qty: number;
	suggested_cost: number;
	value_at_risk: number;
	trigger_reason: TriggerReason;
	reason: string;
	replenishment: string;
	made_here: boolean;
	buyable: boolean;
	item_card_incomplete: boolean;
	has_draft: boolean;
}

/** The figures for the whole list, which ride along on every row of it. */
interface TotalsDb extends Row {
	t_parts: number;
	t_vendors: number;
	t_subtotal: number;
	t_value_at_risk: number;
	t_made_here: number;
	t_item_card_incomplete: number;
}

function toLine(r: ReplenishmentDb): ReplenishmentLine {
	return {
		itemNo: r.item_no,
		description: r.description,
		family: r.family,
		blocked: r.blocked,
		vendorNo: r.vendor_no,
		vendorName: r.vendor_name,
		reorderPoint: r.reorder_point,
		safetyStock: r.safety_stock,
		policyLevel: r.policy_level,
		leadTimeFormula: r.lead_time_formula,
		leadTimeDays: r.lead_time_days,
		horizonOn: r.horizon_on,
		onHand: r.on_hand,
		unitCost: r.unit_cost,
		pack: r.pack,
		perDay: r.per_day,
		perWeek: r.per_week,
		units90d: r.units_90d,
		units365d: r.units_365d,
		demandShape: r.demand_shape,
		demandCv: r.demand_cv,
		revenue90d: r.revenue_90d,
		lastSoldOn: r.last_sold_on,
		promisedTotal: r.promised_total,
		promisedBeforeHorizon: r.promised_before_horizon,
		promisedPastDue: r.promised_past_due,
		incomingBeforeHorizon: r.incoming_before_horizon,
		onOrderTotal: r.on_order_total,
		onOrderLater: r.on_order_later,
		projectedAvailable: r.projected_available,
		targetQty: r.target_qty,
		daysOfCover: r.days_of_cover,
		runsOutOn: r.runs_out_on,
		orderByOn: r.order_by_on,
		requestedOn: r.requested_on,
		suggestedQty: r.suggested_qty,
		suggestedCost: r.suggested_cost,
		valueAtRisk: r.value_at_risk,
		triggerReason: r.trigger_reason,
		reason: r.reason,
		replenishment: r.replenishment,
		madeHere: r.made_here,
		buyable: r.buyable,
		itemCardIncomplete: r.item_card_incomplete
	};
}

/**
 * Group the parts that need buying by vendor. The grouping is done here
 * rather than in SQL because the page needs both the group's figures and
 * every line inside it, and one round trip that returns the lines is cheaper
 * than two that return the lines and then the totals of the same lines.
 *
 * Parts with no vendor still get a group, because they are the most important
 * thing on the page and hiding them would be the wrong kind of tidy. There
 * are two kinds of them and they are NOT the same problem:
 *
 *   made    we make these here, so they are short of a production order and
 *           were never going to have a vendor
 *   orphan  these are bought in, and there is nobody to buy them from, or no
 *           cost to buy them at: the item card needs fixing
 */
function group(rows: ReplenishmentDb[]): VendorGroup[] {
	const byVendor = new Map<string, VendorGroup>();

	for (const r of rows) {
		const kind: VendorGroup['kind'] = r.vendor_no
			? 'vendor'
			: r.made_here
				? 'made'
				: 'orphan';
		const key = r.vendor_no ?? kind;
		let g = byVendor.get(key);
		if (!g) {
			g = {
				kind,
				vendorNo: r.vendor_no,
				vendorName:
					r.vendor_name ??
					(kind === 'made' ? 'Made here, no vendor needed' : 'Bought in, but no vendor on the item card'),
				terms: r.vendor_terms ?? '',
				freightTerms: r.vendor_freight_terms ?? '',
				minOrder: r.vendor_min_order,
				freeFreightAt: r.vendor_free_freight_at,
				subtotal: 0,
				valueAtRisk: 0,
				revenue90d: 0,
				meetsMinimum: true,
				clearsFreight: true,
				neededBy: null,
				hasDraft: r.has_draft,
				lines: []
			};
			byVendor.set(key, g);
		}
		g.lines.push(toLine(r));
		g.subtotal = Math.round((g.subtotal + r.suggested_cost) * 100) / 100;
		g.valueAtRisk = Math.round((g.valueAtRisk + r.value_at_risk) * 100) / 100;
		g.revenue90d = Math.round((g.revenue90d + r.revenue_90d) * 100) / 100;
		if (g.neededBy === null || r.requested_on < g.neededBy) g.neededBy = r.requested_on;
	}

	for (const g of byVendor.values()) {
		g.meetsMinimum = g.minOrder === null || g.subtotal >= g.minOrder;
		g.clearsFreight = g.freeFreightAt === null || g.subtotal >= g.freeFreightAt;
	}

	// Worst first: a group with parts that already cannot ship, then by money.
	// The two vendorless groups go last whatever their figures, because
	// nothing on the page can act on them until somebody else has acted.
	const rank = (g: VendorGroup) => (g.kind === 'vendor' ? 0 : g.kind === 'orphan' ? 1 : 2);
	return [...byVendor.values()].sort(
		(a, b) => rank(a) - rank(b) || b.valueAtRisk - a.valueAtRisk || b.subtotal - a.subtotal
	);
}

interface RequestDb extends Row {
	id: number;
	vendor_no: string;
	vendor_name: string;
	status: RequestStatus;
	needed_by: string | null;
	terms: string;
	freight_note: string;
	subtotal: number;
	min_order: number | null;
	free_freight_at: number | null;
	meets_minimum: boolean;
	created_by: string;
	created_at: Date;
	decided_by: string | null;
	decided_at: Date | null;
	order_no: string | null;
	mirrored: boolean;
	updated_at: Date;
}

interface RequestLineDb extends Row {
	request_id: number;
	id: number;
	line_no: number;
	item_no: string;
	description: string;
	quantity: number;
	suggested_qty: number;
	edited: boolean;
	unit_cost: number;
	line_total: number;
	requested_on: string;
	reason: string;
}

function toRequestLine(r: RequestLineDb): RequestLine {
	return {
		id: r.id,
		lineNo: r.line_no,
		itemNo: r.item_no,
		description: r.description,
		quantity: r.quantity,
		suggestedQty: r.suggested_qty,
		edited: r.edited,
		unitCost: r.unit_cost,
		lineTotal: r.line_total,
		requestedOn: r.requested_on,
		reason: r.reason
	};
}

/**
 * The whole desk in one call: what needs buying, the drafts waiting to be
 * approved, the vendor emails waiting to be sent, and the signal log.
 *
 * Returned as a promise the page does not await, so SvelteKit sends the page
 * first and streams this in (see +page.server.ts).
 */
export async function getProcurementDesk(db: Db, userId: number): Promise<ProcurementDesk> {
	return db.asUser(userId, async (tx) => {
		const [clock] = await tx.sql<{ today: string; cover: number; sources: ProcurementSourcesDb }>`
			select nl.today() as today, nl.target_cover_days() as cover,
			       nl.procurement_sources() as sources`;

		// The list and the figures for the WHOLE list in one query.
		//
		// nl.part_replenishment is the expensive read on this page (1.3 s for
		// 2,716 parts), so it is read once: the CTE is materialized because it
		// is referenced twice, and the totals ride along on every row. The
		// list itself is capped, so the totals could not be added up from the
		// rows that come back.
		const parts = await tx.sql<ReplenishmentDb & TotalsDb>`
			with needed as materialized (
				select * from nl.part_replenishment where needs_buying
			),
			totals as (
				select
					count(*)::int                    as t_parts,
					count(distinct vendor_no)::int   as t_vendors,
					coalesce(sum(suggested_cost), 0) as t_subtotal,
					coalesce(sum(value_at_risk), 0)  as t_value_at_risk,
					-- Only the ones with nobody to order from. A part we make
					-- can still have a vendor (plating and other outside
					-- operations), and those go in that vendor's group like
					-- anything else.
					count(*) filter (where made_here and vendor_no is null)::int as t_made_here,
					count(*) filter (where item_card_incomplete)::int            as t_item_card_incomplete
				from needed
			)
			select n.*, t.*,
			       exists (select 1 from nl.purchase_requests pr
			               where pr.vendor_no = n.vendor_no and pr.status = 'draft') as has_draft
			from needed n
			cross join totals t
			order by n.value_at_risk desc, n.suggested_cost desc, n.item_no
			limit ${PART_LIMIT}`;

		// Nothing needs buying, so every figure is zero. The totals ride on
		// the rows, so with no rows there is nothing to read them off.
		const totals = parts[0] ?? {
			t_parts: 0,
			t_vendors: 0,
			t_subtotal: 0,
			t_value_at_risk: 0,
			t_made_here: 0,
			t_item_card_incomplete: 0
		};

		const requests = await tx.sql<RequestDb>`
			select pr.id, pr.vendor_no, v.name as vendor_name, pr.status, pr.needed_by, pr.terms,
			       pr.freight_note, pr.subtotal, pr.min_order, pr.free_freight_at, pr.meets_minimum,
			       cu.full_name as created_by, pr.created_at,
			       du.full_name as decided_by, pr.decided_at,
			       o.order_no, coalesce(o.mirrored, false) as mirrored,
			       pr.updated_at
			from nl.purchase_requests pr
			join nl.vendors v on v.vendor_no = pr.vendor_no
			join nl.users cu on cu.id = pr.created_by
			left join nl.users du on du.id = pr.decided_by
			left join nl.procurement_orders o on o.id = pr.order_id
			where pr.status <> 'dismissed'
			order by (pr.status = 'draft') desc, pr.id desc
			limit 40`;

		const lines = requests.length
			? await tx.query<RequestLineDb>(
					`select l.request_id, l.id, l.line_no, l.item_no, i.description, l.quantity,
					        l.suggested_qty, l.edited, l.unit_cost,
					        round(l.quantity * l.unit_cost, 2) as line_total,
					        l.requested_on, l.reason
					 from nl.purchase_request_lines l
					 join nl.items i on i.item_no = l.item_no
					 where l.request_id = any($1::bigint[])
					 order by l.request_id, l.line_no`,
					[`{${requests.map((r) => r.id).join(',')}}`]
				)
			: [];

		const drafts = await tx.sql<{
			id: number;
			request_id: number;
			vendor_name: string;
			order_no: string | null;
			to_email: string;
			to_name: string;
			subject: string;
			body: string;
			queued_by: string;
			queued_at: Date;
			mail_draft_id: number | null;
		}>`
			select d.id, d.request_id, v.name as vendor_name, o.order_no, d.to_email, d.to_name,
			       d.subject, d.body, u.full_name as queued_by, d.queued_at, d.mail_draft_id
			from nl.purchase_request_drafts d
			join nl.purchase_requests pr on pr.id = d.request_id
			join nl.vendors v on v.vendor_no = pr.vendor_no
			join nl.users u on u.id = d.queued_by
			left join nl.procurement_orders o on o.id = pr.order_id
			order by d.id desc
			limit 20`;

		const signals = await tx.sql<{
			id: number;
			signal: SignalKind;
			subject: string;
			item_no: string | null;
			vendor_no: string | null;
			vendor_name: string | null;
			headline: string;
			value_at_risk: number;
			raised_on: string;
			raised_at: Date;
			cleared_at: Date | null;
		}>`
			select s.id, s.signal, s.subject, s.item_no, s.vendor_no, v.name as vendor_name,
			       s.headline, s.value_at_risk, s.raised_on, s.raised_at, s.cleared_at
			from nl.procurement_signals s
			left join nl.vendors v on v.vendor_no = s.vendor_no
			order by (s.cleared_at is null) desc, s.raised_at desc, s.id desc
			limit ${SIGNAL_LIMIT}`;

		const [open] = await tx.sql<{ n: number }>`
			select count(*)::int as n from nl.procurement_signals where cleared_at is null`;

		const linesByRequest = new Map<number, RequestLine[]>();
		for (const line of lines) {
			const list = linesByRequest.get(line.request_id) ?? [];
			list.push(toRequestLine(line));
			linesByRequest.set(line.request_id, list);
		}

		return {
			today: clock.today,
			coverDays: clock.cover,
			sources: toSources(clock.sources),
			groups: group(parts),
			totals: {
				parts: totals.t_parts,
				vendors: totals.t_vendors,
				subtotal: totals.t_subtotal,
				valueAtRisk: totals.t_value_at_risk,
				madeHere: totals.t_made_here,
				itemCardIncomplete: totals.t_item_card_incomplete
			},
			requests: requests.map(
				(r): PurchaseRequest => ({
					id: r.id,
					vendorNo: r.vendor_no,
					vendorName: r.vendor_name,
					status: r.status,
					neededBy: r.needed_by,
					terms: r.terms,
					freightNote: r.freight_note,
					subtotal: r.subtotal,
					minOrder: r.min_order,
					freeFreightAt: r.free_freight_at,
					meetsMinimum: r.meets_minimum,
					createdBy: r.created_by,
					createdAt: r.created_at.toISOString(),
					decidedBy: r.decided_by,
					decidedAt: r.decided_at ? r.decided_at.toISOString() : null,
					orderNo: r.order_no,
					mirrored: r.mirrored,
					lines: linesByRequest.get(r.id) ?? [],
					updatedAt: r.updated_at.toISOString()
				})
			),
			drafts: drafts.map(
				(d): VendorEmailDraft => ({
					id: d.id,
					requestId: d.request_id,
					vendorName: d.vendor_name,
					orderNo: d.order_no,
					toEmail: d.to_email,
					toName: d.to_name,
					subject: d.subject,
					body: d.body,
					queuedBy: d.queued_by,
					queuedAt: d.queued_at.toISOString(),
					mailDraftId: d.mail_draft_id
				})
			),
			signals: signals.map(
				(s): SignalRow => ({
					id: s.id,
					signal: s.signal,
					subject: s.subject,
					itemNo: s.item_no,
					vendorNo: s.vendor_no,
					vendorName: s.vendor_name,
					headline: s.headline,
					valueAtRisk: s.value_at_risk,
					raisedOn: s.raised_on,
					raisedAt: s.raised_at.toISOString(),
					clearedAt: s.cleared_at ? s.cleared_at.toISOString() : null
				})
			),
			openSignalCount: open.n
		};
	});
}

interface ProcurementSourcesDb {
	open_purchase_lines: boolean;
	production_orders: boolean;
	available_to_promise: boolean;
	mail_drafts: boolean;
}

function toSources(s: ProcurementSourcesDb): ProcurementSources {
	return {
		openPurchaseLines: s.open_purchase_lines,
		productionOrders: s.production_orders,
		availableToPromise: s.available_to_promise,
		mailDrafts: s.mail_drafts
	};
}
