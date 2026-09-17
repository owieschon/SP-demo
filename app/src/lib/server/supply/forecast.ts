// The late-order forecast: reads for /operations/forecast.
//
// Every number on the page comes from migration 0016's views, which do the
// work in one set-based pass per question:
//
//   nl.open_line_projection      one row per open sales line: when the parts
//                                are there, when it ships, how late that is,
//                                and which supply order decides it
//   nl.forecast_by_vendor        a buyer's call sheet
//   nl.forecast_by_work_center   the production backlog
//   nl.forecast_by_customer      who to call, and who owns the account
//   nl.promise_moves             ship dates that moved across applied exports
//   nl.supply_changes            supply dates that moved, per report
//
// Nothing here writes. The one function that is not a read, "can we ship
// this", calls nl.available_to_promise, which is also read-only.
import { z } from 'zod';
import type {
	AtpAnswer,
	CustomerCall,
	FilterOption,
	Forecast,
	ForecastFilters,
	ForecastLine,
	ForecastTotals,
	LineStatus,
	PromiseMove,
	SnapshotHead,
	SupplyMove,
	SupplySource,
	VendorCall,
	WorkCenterLoad
} from '$lib/components/supply/types';
import { LINE_STATUS_ORDER } from '$lib/components/supply/types';
import type { Db, Tx } from '../db/types.ts';

/** How many late lines the table lists (lineCount says how many there are). */
export const FORECAST_LINE_LIMIT = 150;

/** How many rows each side panel lists. */
const PANEL_LIMIT = 8;

const statusValues = ['all', 'late', ...LINE_STATUS_ORDER] as const;

/** The filters, as they arrive in the query string. */
export const forecastFilters = z.object({
	status: z.enum(statusValues).default('late'),
	vendor: z.string().trim().max(40).nullable().default(null),
	workCenter: z.string().trim().max(20).nullable().default(null),
	customer: z.string().trim().max(40).nullable().default(null),
	who: z.enum(['mine', 'all']).default('all')
});

/** Read the filters off a URL, leaving out the empty ones. */
export function readFilters(url: URL): ForecastFilters {
	return forecastFilters.parse({
		status: url.searchParams.get('status') ?? undefined,
		vendor: url.searchParams.get('vendor') || null,
		workCenter: url.searchParams.get('wc') || null,
		customer: url.searchParams.get('customer') || null,
		who: url.searchParams.get('who') ?? undefined
	});
}

interface LineRow {
	document_no: string;
	line_no: number;
	customer_no: string;
	customer_name: string;
	owner_name: string | null;
	item_no: string;
	description: string;
	ship_date: string;
	availability_date: string | null;
	projected_ship_date: string;
	days_late: number;
	status: LineStatus;
	quantity: number;
	open_value: number;
	covered_now: boolean;
	earliest_if_ordered_today: string;
	supply_source: SupplySource | null;
	supply_document: string | null;
	supply_vendor_no: string | null;
	supply_vendor_name: string | null;
	supply_work_center: string | null;
	supply_due_date: string | null;
	supply_overdue: boolean;
}

function toLine(r: LineRow): ForecastLine {
	return {
		documentNo: r.document_no,
		lineNo: r.line_no,
		customerNo: r.customer_no,
		customerName: r.customer_name,
		ownerName: r.owner_name,
		itemNo: r.item_no,
		description: r.description,
		shipDate: r.ship_date,
		availabilityDate: r.availability_date,
		projectedDate: r.projected_ship_date,
		daysLate: r.days_late,
		status: r.status,
		quantity: r.quantity,
		openValue: r.open_value,
		coveredNow: r.covered_now,
		earliestIfOrderedToday: r.earliest_if_ordered_today,
		supplySource: r.supply_source,
		supplyDocument: r.supply_document,
		supplyVendorNo: r.supply_vendor_no,
		supplyVendorName: r.supply_vendor_name,
		supplyWorkCenter: r.supply_work_center,
		supplyDueDate: r.supply_due_date,
		supplyOverdue: r.supply_overdue
	};
}

/**
 * Everything the forecast page shows, for one set of filters. The queries run
 * in one transaction as the signed-in user, so row-level security decides
 * what they see, and the page streams the whole thing (see +page.server.ts).
 */
export async function getForecast(
	db: Db,
	userId: number,
	filters: ForecastFilters,
	ownerId: number | null
): Promise<Forecast> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{ today: string; overdue_supply_days: number }>`
			select nl.today() as today, nl.overdue_supply_days() as overdue_supply_days`;

		// The filters, as parameters. Null means "no filter on this".
		const status = filters.status;
		const vendor = filters.vendor;
		const workCenter = filters.workCenter;
		const customer = filters.customer;
		const owner = filters.who === 'mine' ? ownerId : null;

		const [totals] = await tx.sql<{
			open_lines: number;
			open_value: number;
			late_lines: number;
			late_value: number;
			no_supply_lines: number;
			no_supply_value: number;
			worst_days_late: number;
		}>`
			select count(*)::int as open_lines,
			       coalesce(sum(p.open_value), 0) as open_value,
			       count(*) filter (where p.days_late > 0)::int as late_lines,
			       coalesce(sum(p.open_value) filter (where p.days_late > 0), 0) as late_value,
			       count(*) filter (where p.status = 'no_supply')::int as no_supply_lines,
			       coalesce(sum(p.open_value) filter (where p.status = 'no_supply'), 0) as no_supply_value,
			       coalesce(max(p.days_late), 0)::int as worst_days_late
			from nl.open_line_projection p`;

		// Supply orders that are late themselves, whoever is waiting for them.
		const [supply] = await tx.sql<{ overdue_supply_orders: number }>`
			select (select count(*) from nl.open_purchase_lines where due_date < nl.today())::int
			       + (select count(*) from nl.open_production_orders where due_date < nl.today())::int
			       as overdue_supply_orders`;

		const lines = await tx.sql<LineRow>`
			select p.document_no, p.line_no, p.customer_no, cu.name as customer_name,
			       u.full_name as owner_name,
			       p.item_no, p.description, p.ship_date, p.availability_date, p.projected_ship_date,
			       p.days_late, p.status, p.quantity, p.open_value, p.covered_now,
			       p.earliest_if_ordered_today, p.supply_source, p.supply_document,
			       p.supply_vendor_no, ve.name as supply_vendor_name, p.supply_work_center,
			       p.supply_due_date, p.supply_overdue
			from nl.open_line_projection p
			join nl.customers cu on cu.customer_no = p.customer_no
			left join nl.users u on u.id = p.customer_owner_id
			left join nl.vendors ve on ve.vendor_no = p.supply_vendor_no
			where (${status} = 'all'
			       or (${status} = 'late' and p.days_late > 0)
			       or p.status = ${status})
			  and (${vendor}::text is null or p.supply_vendor_no = ${vendor})
			  and (${workCenter}::text is null or p.supply_work_center = ${workCenter})
			  and (${customer}::text is null or p.customer_no = ${customer})
			  and (${owner}::int is null or p.customer_owner_id = ${owner})
			order by p.days_late desc, p.open_value desc, p.document_no, p.line_no
			limit ${FORECAST_LINE_LIMIT}`;

		const [count] = await tx.sql<{ lines: number }>`
			select count(*)::int as lines
			from nl.open_line_projection p
			where (${status} = 'all'
			       or (${status} = 'late' and p.days_late > 0)
			       or p.status = ${status})
			  and (${vendor}::text is null or p.supply_vendor_no = ${vendor})
			  and (${workCenter}::text is null or p.supply_work_center = ${workCenter})
			  and (${customer}::text is null or p.customer_no = ${customer})
			  and (${owner}::int is null or p.customer_owner_id = ${owner})`;

		const [vendors, workCenters, customers] = await Promise.all([
			vendorCallSheet(tx),
			tx.sql<{
				work_center: string;
				late_lines: number;
				customers: number;
				production_orders: number;
				overdue_production_orders: number;
				value_waiting: number;
				first_due: string | null;
				worst_days_late: number;
			}>`
				select work_center, late_lines, customers, production_orders, overdue_production_orders,
				       value_waiting, first_due, worst_days_late
				from nl.forecast_by_work_center
				order by value_waiting desc
				limit ${PANEL_LIMIT}`,
			tx.sql<{
				customer_no: string;
				customer_name: string;
				owner_name: string | null;
				late_lines: number;
				no_supply_lines: number;
				value_late: number;
				worst_days_late: number;
				earliest_promise: string;
			}>`
				select c.customer_no, c.customer_name, u.full_name as owner_name, c.late_lines,
				       c.no_supply_lines, c.value_late, c.worst_days_late, c.earliest_promise
				from nl.forecast_by_customer c
				left join nl.users u on u.id = c.owner_id
				where (${owner}::int is null or c.owner_id = ${owner})
				order by c.value_late desc
				limit ${PANEL_LIMIT}`
		]);

		const promiseMoves = await tx.sql<{
			document_no: string;
			line_no: number;
			customer_no: string;
			customer_name: string;
			item_no: string;
			current_promise: string;
			first_promised: string;
			moves: number;
			biggest_move_days: number;
			days_moved: number;
			open_value: number;
		}>`
			select document_no, line_no, customer_no, customer_name, item_no, current_promise,
			       first_promised, moves, biggest_move_days, days_moved, open_value
			from nl.promise_moves
			where (${owner}::int is null or owner_id = ${owner})
			order by days_moved desc, open_value desc
			limit 10`;

		const supplyMoves = await tx.sql<{
			kind: SupplyMove['kind'];
			change: SupplyMove['change'];
			document_no: string;
			line_no: number | null;
			item_no: string;
			party: string;
			party_name: string | null;
			quantity: number;
			due_now: string | null;
			due_before: string | null;
			days_moved: number | null;
		}>`
			select c.kind, c.change, c.document_no, c.line_no, c.item_no, c.party,
			       ve.name as party_name, c.quantity, c.due_now, c.due_before, c.days_moved
			from nl.supply_changes c
			left join nl.vendors ve on ve.vendor_no = c.party
			order by array_position(array['due_later', 'new', 'received', 'due_sooner'], c.change),
			         coalesce(c.days_moved, 0) desc, c.document_no
			limit 12`;

		// The filter lists: only the vendors, work centers and customers that
		// actually hold something up, with how many lines each one has.
		const options = await tx.sql<{
			group_name: 'vendor' | 'work_center' | 'customer';
			value: string;
			label: string;
			lines: number;
		}>`
			select 'vendor' as group_name, v.vendor_no as value, v.vendor_name as label, v.late_lines as lines
			from nl.forecast_by_vendor v
			union all
			select 'work_center', w.work_center, w.work_center, w.late_lines
			from nl.forecast_by_work_center w
			union all
			select 'customer', c.customer_no, c.customer_name, c.late_lines
			from nl.forecast_by_customer c
			order by 4 desc, 3
			limit 120`;

		const sources = await tx.sql<{
			kind: SnapshotHead['kind'];
			id: number;
			file_name: string;
			decided_at: Date;
			decided_by: string;
			row_count: number;
		}>`
			select s.kind, s.id, s.file_name, s.decided_at, u.full_name as decided_by, s.row_count
			from nl.export_snapshots s
			join nl.users u on u.id = s.decided_by
			where s.is_current
			order by s.kind`;

		const totalsView: ForecastTotals = {
			openLines: totals.open_lines,
			openValue: totals.open_value,
			lateLines: totals.late_lines,
			lateValue: totals.late_value,
			noSupplyLines: totals.no_supply_lines,
			noSupplyValue: totals.no_supply_value,
			overdueSupplyOrders: supply.overdue_supply_orders,
			worstDaysLate: totals.worst_days_late
		};

		const option = (group: 'vendor' | 'work_center' | 'customer'): FilterOption[] =>
			options.filter((o) => o.group_name === group).map((o) => ({ value: o.value, label: o.label, lines: o.lines }));

		return {
			today: head.today,
			overdueSupplyDays: head.overdue_supply_days,
			filters,
			totals: totalsView,
			lines: lines.map(toLine),
			lineCount: count.lines,
			vendors,
			workCenters: workCenters.map(
				(w): WorkCenterLoad => ({
					workCenter: w.work_center,
					lateLines: w.late_lines,
					customers: w.customers,
					productionOrders: w.production_orders,
					overdueProductionOrders: w.overdue_production_orders,
					valueWaiting: w.value_waiting,
					firstDue: w.first_due,
					worstDaysLate: w.worst_days_late
				})
			),
			customers: customers.map(
				(c): CustomerCall => ({
					customerNo: c.customer_no,
					customerName: c.customer_name,
					ownerName: c.owner_name,
					lateLines: c.late_lines,
					noSupplyLines: c.no_supply_lines,
					valueLate: c.value_late,
					worstDaysLate: c.worst_days_late,
					earliestPromise: c.earliest_promise
				})
			),
			promiseMoves: promiseMoves.map(
				(m): PromiseMove => ({
					documentNo: m.document_no,
					lineNo: m.line_no,
					customerNo: m.customer_no,
					customerName: m.customer_name,
					itemNo: m.item_no,
					currentPromise: m.current_promise,
					firstPromised: m.first_promised,
					moves: m.moves,
					biggestMoveDays: m.biggest_move_days,
					daysMoved: m.days_moved,
					openValue: m.open_value
				})
			),
			supplyMoves: supplyMoves.map(
				(m): SupplyMove => ({
					kind: m.kind,
					change: m.change,
					documentNo: m.document_no,
					lineNo: m.line_no,
					itemNo: m.item_no,
					party: m.party,
					partyName: m.party_name,
					quantity: m.quantity,
					dueNow: m.due_now,
					dueBefore: m.due_before,
					daysMoved: m.days_moved
				})
			),
			options: { vendors: option('vendor'), workCenters: option('work_center'), customers: option('customer') },
			sources: sources.map(
				(s): SnapshotHead => ({
					kind: s.kind,
					id: s.id,
					fileName: s.file_name,
					appliedAt: s.decided_at.toISOString(),
					appliedBy: s.decided_by,
					rowCount: s.row_count
				})
			)
		};
	});
}

/**
 * The vendor call sheet. The contact column comes from nl.vendor_contacts,
 * which another part of the app owns, so this asks the database whether that
 * table is there and leaves the column out when it is not.
 */
async function vendorCallSheet(tx: Tx): Promise<VendorCall[]> {
	const [{ has_contacts: hasContacts }] = await tx.sql<{ has_contacts: boolean }>`
		select to_regclass('nl.vendor_contacts') is not null as has_contacts`;

	interface VendorRow {
		vendor_no: string;
		vendor_name: string;
		city: string;
		state: string;
		lead_time: string;
		late_lines: number;
		customers: number;
		purchase_orders: number;
		overdue_purchase_orders: number;
		value_waiting: number;
		first_due: string | null;
		last_due: string | null;
		worst_days_late: number;
		contact_name: string | null;
		contact_email: string | null;
		contact_phone: string | null;
	}

	const rows = hasContacts
		? await tx.sql<VendorRow>`
			select v.vendor_no, v.vendor_name, v.city, v.state, v.lead_time, v.late_lines, v.customers,
			       v.purchase_orders, v.overdue_purchase_orders, v.value_waiting, v.first_due, v.last_due,
			       v.worst_days_late,
			       c.full_name as contact_name, c.email as contact_email, c.phone as contact_phone
			from nl.forecast_by_vendor v
			left join lateral (
			  select full_name, email, phone
			  from nl.vendor_contacts
			  where vendor_no = v.vendor_no and active
			  order by is_primary desc, id
			  limit 1
			) c on true
			order by v.value_waiting desc
			limit ${PANEL_LIMIT}`
		: await tx.sql<VendorRow>`
			select v.vendor_no, v.vendor_name, v.city, v.state, v.lead_time, v.late_lines, v.customers,
			       v.purchase_orders, v.overdue_purchase_orders, v.value_waiting, v.first_due, v.last_due,
			       v.worst_days_late,
			       null::text as contact_name, null::text as contact_email, null::text as contact_phone
			from nl.forecast_by_vendor v
			order by v.value_waiting desc
			limit ${PANEL_LIMIT}`;

	return rows.map((v) => ({
		vendorNo: v.vendor_no,
		vendorName: v.vendor_name,
		place: [v.city, v.state].filter(Boolean).join(', '),
		leadTime: v.lead_time,
		contactName: v.contact_name,
		contactEmail: v.contact_email,
		contactPhone: v.contact_phone,
		lateLines: v.late_lines,
		customers: v.customers,
		purchaseOrders: v.purchase_orders,
		overduePurchaseOrders: v.overdue_purchase_orders,
		valueWaiting: v.value_waiting,
		firstDue: v.first_due,
		lastDue: v.last_due,
		worstDaysLate: v.worst_days_late
	}));
}

// ---------------------------------------------------------------------------
// Can we ship it?
// ---------------------------------------------------------------------------

export const atpInput = z.object({
	itemNo: z.string().trim().min(1).max(40),
	quantity: z.coerce.number().int().min(1).max(1_000_000),
	neededBy: z.iso.date()
});

export type AtpInput = z.infer<typeof atpInput>;

/**
 * Available to promise for one part: nl.available_to_promise does the
 * netting. Null when the part number is not in the item list.
 */
export async function availableToPromise(db: Db, userId: number, input: AtpInput): Promise<AtpAnswer | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ answer: AtpRow | null }>`
			select nl.available_to_promise(${input.itemNo.toUpperCase()}, ${input.quantity}, ${input.neededBy}) as answer`
	);
	const a = row?.answer;
	if (!a) return null;
	return {
		itemNo: a.item_no,
		description: a.description,
		quantity: a.quantity,
		neededBy: a.needed_by,
		today: a.today,
		onHand: a.on_hand,
		promisedEarlier: a.promised_earlier,
		freeNow: a.free_now,
		neededThrough: a.needed_through,
		leadDays: a.lead_days,
		replenishment: a.replenishment,
		canMeet: a.can_meet,
		earliestDate: a.earliest_date,
		earliestBasis: a.earliest_basis,
		covering: a.covering
			? {
					source: a.covering.source,
					documentNo: a.covering.document_no,
					party: a.covering.party,
					dueDate: a.covering.due_date,
					availableOn: a.covering.available_on,
					overdue: a.covering.overdue,
					quantity: a.covering.quantity
				}
			: null,
		incoming: a.incoming.map((i) => ({
			source: i.source,
			documentNo: i.document_no,
			party: i.party,
			dueDate: i.due_date,
			availableOn: i.available_on,
			quantity: i.quantity,
			overdue: i.overdue,
			coversTo: i.covers_to
		}))
	};
}

// The JSON nl.available_to_promise returns (snake_case, as the SQL names it).
interface AtpRow {
	item_no: string;
	description: string;
	quantity: number;
	needed_by: string;
	today: string;
	on_hand: number;
	promised_earlier: number;
	free_now: number;
	needed_through: number;
	lead_days: number;
	replenishment: string;
	can_meet: boolean;
	earliest_date: string;
	earliest_basis: AtpAnswer['earliestBasis'];
	covering: {
		source: SupplySource;
		document_no: string | null;
		party: string | null;
		due_date: string | null;
		available_on: string;
		overdue: boolean;
		quantity: number;
	} | null;
	incoming: {
		source: SupplySource;
		document_no: string;
		party: string | null;
		due_date: string;
		available_on: string;
		quantity: number;
		overdue: boolean;
		covers_to: number;
	}[];
}
