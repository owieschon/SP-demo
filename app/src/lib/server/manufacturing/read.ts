// What the manufacturing pages read.
//
// Three groups:
//   * one part: what it is made of, what it truly costs, how long it truly
//     takes, where it is used, and which lots of it exist
//   * the board: work centre load in hours, shortages explained down to the
//     metal, shipments whose paperwork is short
//   * one lot: the trace backwards to the heat it came from and forwards to
//     the customers who got it
//
// Nothing here computes a figure. The roll-ups are kept current by the
// triggers in migration 0036 and read as single rows, and every other figure
// comes from a view or a function, so the assistant and the order desk get
// the same answers without going through this file.
import type { Db, Tx } from '../db/types.ts';
import type {
	BomNode,
	CostLine,
	CostSummary,
	LeadNode,
	LoadRow,
	LoadWeek,
	LotRow,
	LotTrace,
	ManufacturingBoard,
	OperationRow,
	PackageRow,
	PartManufacturing,
	ShortageRow,
	SourceRow,
	SupplyShape,
	TraceBackRow,
	WhereUsedRow
} from '$lib/manufacturing/types';

/** How many short lines the board explains. Each one costs an explosion. */
export const SHORTAGE_LIMIT = 12;

/** How many rows of the cost breakdown a part page shows before it stops. */
export const COST_LINE_LIMIT = 200;

/** The shape nl.item_truth returns, as JSON. */
interface TruthJson {
	item_no: string;
	description: string;
	family: string;
	kind: string;
	blocked: boolean;
	today: string;
	shape: {
		shape: SupplyShape;
		sentence: string;
		bom_lines: number;
		operations: number;
		outside_steps: number;
		cells: string | null;
		erp_replenishment: string;
		erp_agrees: boolean;
	} | null;
	cost: {
		rolled: number | null;
		card: number | null;
		difference: number | null;
		levels: number | null;
		measured_at: string;
		elements: Record<string, number>;
		top: { element: string; amount: number; share: number | null }[] | null;
		list_price: number;
		rolled_margin: number | null;
	};
	lead_time: {
		days: number | null;
		own_days: number | null;
		basis: string | null;
		levels: number | null;
		critical_child: string | null;
		critical_path: string[] | null;
		ready_on: string | null;
	};
	on_hand: { quantity: number; allocated: number; available: number; by_location: Record<string, number> };
	promise: {
		quantity: number;
		on_hand: number;
		promised_earlier: number;
		free_now: number;
		earliest_date: string;
		earliest_basis: 'stock' | 'supply' | 'lead_time';
		can_meet: boolean;
		lead_days: number;
	};
}

function costSummary(truth: TruthJson): CostSummary {
	const elements = truth.cost.elements ?? {};
	return {
		rolled: Number(truth.cost.rolled ?? 0),
		card: truth.cost.card === null ? null : Number(truth.cost.card),
		difference: truth.cost.difference === null ? null : Number(truth.cost.difference),
		levels: truth.cost.levels ?? 0,
		measuredAt: truth.cost.measured_at,
		elements: {
			material: Number(elements.material ?? 0),
			component: Number(elements.component ?? 0),
			labor: Number(elements.labor ?? 0),
			machine: Number(elements.machine ?? 0),
			overhead: Number(elements.overhead ?? 0),
			outside: Number(elements.outside ?? 0),
			scrap: Number(elements.scrap ?? 0),
			packaging: Number(elements.packaging ?? 0),
			expedite: Number(elements.expedite ?? 0)
		},
		top: (truth.cost.top ?? []).map((t) => ({
			element: t.element as CostSummary['top'][number]['element'],
			amount: Number(t.amount),
			share: t.share === null ? null : Number(t.share)
		})),
		listPrice: Number(truth.cost.list_price ?? 0),
		rolledMargin: truth.cost.rolled_margin === null ? null : Number(truth.cost.rolled_margin)
	};
}

/**
 * Everything one part page shows. The truth function answers in one row; the
 * trees and the lists are separate queries because a page can show them a
 * tab at a time.
 */
export async function getPartManufacturing(
	db: Db,
	userId: number,
	itemNo: string,
	quantity = 1
): Promise<PartManufacturing | null> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{ truth: TruthJson | null }>`
			select nl.item_truth(${itemNo}, ${quantity}) as truth`;
		if (!head?.truth) return null;
		const truth = head.truth;

		const bom = await readBom(tx, itemNo);
		const costLines = await readCostLines(tx, itemNo);
		const leadTree = await readLeadTree(tx, itemNo);
		const whereUsed = await readWhereUsed(tx, itemNo);
		const operations = await readOperations(tx, itemNo);
		const sources = await readSources(tx, itemNo);
		const lots = await readLots(tx, itemNo);

		const [planning] = await tx.sql<{
			demand_policy: string;
			lot_sizing: string;
			min_order_qty: number | null;
			order_multiple: number | null;
			max_order_qty: number | null;
			reorder_point: number | null;
			safety_stock: number | null;
		}>`
			select p.demand_policy, p.lot_sizing, p.min_order_qty, p.order_multiple, p.max_order_qty,
			       i.reorder_point, i.safety_stock
			from nl.items i
			left join nl.item_planning p on p.item_no = i.item_no
			where i.item_no = ${itemNo}`;

		const skus = await tx.sql<{
			sku_code: string;
			pack_quantity: number;
			uom: string;
			is_default: boolean;
			weight_lb: number | null;
		}>`
			select sku_code, pack_quantity, uom, is_default, weight_lb
			from nl.skus where item_no = ${itemNo} order by is_default desc, pack_quantity, sku_code`;

		return {
			itemNo: truth.item_no,
			description: truth.description,
			family: truth.family,
			kind: truth.kind,
			blocked: truth.blocked,
			today: truth.today,
			shape: {
				shape: truth.shape?.shape ?? 'purchased',
				sentence: truth.shape?.sentence ?? '',
				bomLines: truth.shape?.bom_lines ?? 0,
				operations: truth.shape?.operations ?? 0,
				outsideSteps: truth.shape?.outside_steps ?? 0,
				cells: truth.shape?.cells ?? null,
				erpReplenishment: truth.shape?.erp_replenishment ?? '',
				erpAgrees: truth.shape?.erp_agrees ?? true
			},
			cost: costSummary(truth),
			lead: {
				days: truth.lead_time.days ?? 0,
				ownDays: truth.lead_time.own_days ?? 0,
				basis: truth.lead_time.basis ?? '',
				levels: truth.lead_time.levels ?? 0,
				criticalChild: truth.lead_time.critical_child ?? null,
				criticalPath: truth.lead_time.critical_path ?? [],
				readyOn: truth.lead_time.ready_on ?? truth.today
			},
			promise: {
				quantity: truth.promise.quantity,
				onHand: truth.promise.on_hand,
				promisedEarlier: truth.promise.promised_earlier,
				freeNow: truth.promise.free_now,
				earliestDate: truth.promise.earliest_date,
				earliestBasis: truth.promise.earliest_basis,
				canMeet: truth.promise.can_meet,
				leadDays: truth.promise.lead_days
			},
			onHand: truth.on_hand.quantity,
			available: truth.on_hand.available,
			byLocation: truth.on_hand.by_location ?? {},
			bom,
			costLines,
			leadTree,
			whereUsed,
			operations,
			sources,
			lots,
			planning: planning
				? {
						demandPolicy: planning.demand_policy ?? '',
						lotSizing: planning.lot_sizing ?? '',
						minOrderQty: planning.min_order_qty,
						orderMultiple: planning.order_multiple,
						maxOrderQty: planning.max_order_qty,
						reorderPoint: planning.reorder_point,
						safetyStock: planning.safety_stock
					}
				: null,
			skus: skus.map((s) => ({
				skuCode: s.sku_code,
				packQuantity: s.pack_quantity,
				uom: s.uom,
				isDefault: s.is_default,
				weightLb: s.weight_lb === null ? null : Number(s.weight_lb)
			}))
		};
	});
}

/**
 * The bill of materials tree with each node's rolled cost, and what that
 * comes to for the quantity the parent needs. Substitutes are in the list,
 * marked, because a person looking at a parts list wants to see the
 * alternate even though nothing costs it.
 */
async function readBom(tx: Tx, itemNo: string): Promise<BomNode[]> {
	const rows = await tx.sql<{
		level: number;
		item_no: string;
		parent_item: string | null;
		line_no: number | null;
		description: string;
		kind: string;
		shape: SupplyShape | null;
		quantity_per: number;
		uom: string;
		scrap_pct: number;
		is_substitute: boolean;
		is_phantom: boolean;
		rolled_cost: number | null;
		extended_cost: number | null;
		lead_days: number | null;
		on_hand: number;
		reference_note: string;
	}>`
		with recursive tree (level, item_no, parent_item, line_no, quantity_per, uom, scrap_pct,
		                     is_substitute, is_phantom, reference_note, mult, path) as (
			select 0, ${itemNo}::text, null::text, null::int, 1::numeric, ''::text, 0::numeric,
			       false, false, ''::text, 1::numeric, array[${itemNo}::text]
			union all
			select
				t.level + 1,
				b.child_item,
				t.item_no,
				b.line_no,
				b.quantity_per,
				b.uom,
				b.scrap_pct,
				b.is_substitute,
				b.is_phantom or ci.phantom,
				b.reference_note,
				t.mult * b.quantity_per * (1 + b.scrap_pct),
				t.path || b.child_item
			from tree t
			join nl.bom_lines b on b.parent_item = t.item_no
			join nl.items ci on ci.item_no = b.child_item
			where not t.is_substitute
			  and t.level < 12
			  and not b.child_item = any (t.path)
		)
		select
			t.level,
			t.item_no,
			t.parent_item,
			t.line_no,
			i.description,
			i.kind,
			s.shape,
			round(t.quantity_per, 5) as quantity_per,
			t.uom,
			t.scrap_pct,
			t.is_substitute,
			t.is_phantom,
			round(c.rolled_cost, 4) as rolled_cost,
			round(c.rolled_cost * t.mult, 4) as extended_cost,
			l.lead_days,
			coalesce(st.on_hand, 0) as on_hand,
			t.reference_note
		from tree t
		join nl.items i on i.item_no = t.item_no
		left join nl.item_supply_shape s on s.item_no = t.item_no
		left join nl.item_cost_rolled c on c.item_no = t.item_no
		left join nl.item_lead_rolled l on l.item_no = t.item_no
		left join nl.stock st on st.item_no = t.item_no
		order by t.level, t.parent_item nulls first, t.line_no nulls first, t.item_no`;

	return rows.map((r) => ({
		level: r.level,
		itemNo: r.item_no,
		parentItem: r.parent_item,
		lineNo: r.line_no,
		description: r.description,
		kind: r.kind,
		shape: r.shape,
		quantityPer: Number(r.quantity_per),
		uom: r.uom,
		scrapPct: Number(r.scrap_pct),
		isSubstitute: r.is_substitute,
		isPhantom: r.is_phantom,
		rolledCost: r.rolled_cost === null ? null : Number(r.rolled_cost),
		extendedCost: r.extended_cost === null ? null : Number(r.extended_cost),
		leadDays: r.lead_days,
		onHand: r.on_hand,
		referenceNote: r.reference_note
	}));
}

async function readCostLines(tx: Tx, itemNo: string): Promise<CostLine[]> {
	const rows = await tx.sql<{
		level: number;
		item_no: string;
		parent_item: string | null;
		description: string;
		element: string;
		source: string;
		detail: string;
		quantity_per: number;
		unit_amount: number;
		amount: number;
	}>`
		select level, item_no, parent_item, description, element, source, detail,
		       quantity_per, unit_amount, amount
		from nl.item_cost_rollup(${itemNo})
		order by level, element, amount desc
		limit ${COST_LINE_LIMIT}`;
	return rows.map((r) => ({
		level: r.level,
		itemNo: r.item_no,
		parentItem: r.parent_item,
		description: r.description,
		element: r.element as CostLine['element'],
		source: r.source,
		detail: r.detail,
		quantityPer: Number(r.quantity_per),
		unitAmount: Number(r.unit_amount),
		amount: Number(r.amount)
	}));
}

async function readLeadTree(tx: Tx, itemNo: string): Promise<LeadNode[]> {
	const rows = await tx.sql<{
		level: number;
		item_no: string;
		parent_item: string | null;
		description: string;
		basis: string;
		own_days: number;
		lead_days: number;
		is_critical: boolean;
	}>`
		select level, item_no, parent_item, description, basis, own_days, lead_days, is_critical
		from nl.item_lead_time_rollup(${itemNo})
		order by is_critical desc, level, lead_days desc, item_no`;
	return rows.map((r) => ({
		level: r.level,
		itemNo: r.item_no,
		parentItem: r.parent_item,
		description: r.description,
		basis: r.basis,
		ownDays: r.own_days,
		leadDays: r.lead_days,
		isCritical: r.is_critical
	}));
}

async function readWhereUsed(tx: Tx, itemNo: string): Promise<WhereUsedRow[]> {
	const rows = await tx.sql<{
		parent_item: string;
		description: string;
		depth: number;
		quantity_per: number;
		shape: SupplyShape | null;
		open_lines: number;
		open_qty: number;
		open_order_value: number;
	}>`
		select parent_item, description, depth, quantity_per, shape, open_lines, open_qty, open_order_value
		from nl.item_where_used(${itemNo})
		order by open_order_value desc, depth, parent_item`;
	return rows.map((r) => ({
		parentItem: r.parent_item,
		description: r.description,
		depth: r.depth,
		quantityPer: Number(r.quantity_per),
		shape: r.shape,
		openLines: r.open_lines,
		openQty: r.open_qty,
		openOrderValue: Number(r.open_order_value)
	}));
}

async function readOperations(tx: Tx, itemNo: string): Promise<OperationRow[]> {
	const rows = await tx.sql<{
		seq: number;
		work_center: string | null;
		description: string;
		setup_minutes: number;
		run_minutes_per_piece: number;
		queue_minutes: number;
		move_minutes: number;
		yield_pct: number;
		labor_class: string | null;
		machine: string | null;
		is_outside: boolean;
		is_inspection: boolean;
		vendor_no: string | null;
		outside_price_per_piece: number | null;
		requires_process_qual: string | null;
		requires_gauge: string | null;
		ready: boolean | null;
		blocked_reason: string | null;
	}>`
		select o.seq, o.work_center, o.description, o.setup_minutes, o.run_minutes_per_piece,
		       o.queue_minutes, o.move_minutes, o.yield_pct, o.labor_class, o.machine,
		       o.is_outside, o.is_inspection, o.vendor_no, o.outside_price_per_piece,
		       o.requires_process_qual, o.requires_gauge,
		       r.ready, r.blocked_reason
		from nl.routing_operations o
		left join nl.operation_readiness r on r.id = o.id
		where o.item_no = ${itemNo}
		order by o.seq`;
	return rows.map((r) => ({
		seq: r.seq,
		workCenter: r.work_center,
		description: r.description,
		setupMinutes: Number(r.setup_minutes),
		runMinutes: Number(r.run_minutes_per_piece),
		queueMinutes: Number(r.queue_minutes),
		moveMinutes: Number(r.move_minutes),
		yieldPct: Number(r.yield_pct),
		laborClass: r.labor_class,
		machine: r.machine,
		isOutside: r.is_outside,
		isInspection: r.is_inspection,
		vendorNo: r.vendor_no,
		outsidePrice: r.outside_price_per_piece === null ? null : Number(r.outside_price_per_piece),
		requiresQual: r.requires_process_qual,
		requiresGauge: r.requires_gauge,
		ready: r.ready ?? true,
		blockedReason: r.blocked_reason ?? ''
	}));
}

async function readSources(tx: Tx, itemNo: string): Promise<SourceRow[]> {
	const rows = await tx.sql<{
		source_kind: string;
		priority: number;
		vendor_no: string | null;
		work_center: string | null;
		from_location: string | null;
		min_qty: number | null;
		max_qty: number | null;
		unit_price: number | null;
		lead_time: string;
		note: string;
	}>`
		select source_kind, priority, vendor_no, work_center, from_location,
		       min_qty, max_qty, unit_price, lead_time, note
		from nl.item_sources
		where item_no = ${itemNo}
		  and (effective_from is null or effective_from <= nl.today())
		  and (effective_to is null or effective_to >= nl.today())
		order by priority, id`;
	return rows.map((r) => ({
		sourceKind: r.source_kind,
		priority: r.priority,
		vendorNo: r.vendor_no,
		workCenter: r.work_center,
		fromLocation: r.from_location,
		minQty: r.min_qty === null ? null : Number(r.min_qty),
		maxQty: r.max_qty === null ? null : Number(r.max_qty),
		unitPrice: r.unit_price === null ? null : Number(r.unit_price),
		leadTime: r.lead_time,
		note: r.note
	}));
}

/** The lots of one part, newest first, with the certificates each carries. */
export async function readLots(tx: Tx, itemNo: string, limit = 25): Promise<LotRow[]> {
	const rows = await tx.sql<{
		lot_no: string;
		item_no: string;
		description: string;
		heat_no: string;
		mill: string;
		country_of_melt: string;
		vendor_no: string | null;
		received_on: string;
		quantity_received: number;
		quantity_remaining: number;
		status: string;
		certificates: { kind: string; reference_no: string; expired: boolean }[] | null;
	}>`
		select
			l.lot_no, l.item_no, i.description, l.heat_no, l.mill, l.country_of_melt, l.vendor_no,
			l.received_on, l.quantity_received, l.quantity_remaining, l.status,
			(select jsonb_agg(jsonb_build_object(
			          'kind', d.kind, 'reference_no', d.reference_no,
			          'expired', d.expires_on is not null and d.expires_on < nl.today())
			        order by d.kind)
			 from nl.lot_documents ld
			 join nl.documents d on d.id = ld.document_id
			 where ld.lot_no = l.lot_no) as certificates
		from nl.lots l
		join nl.items i on i.item_no = l.item_no
		where l.item_no = ${itemNo}
		order by l.received_on desc, l.lot_no
		limit ${limit}`;
	return rows.map((r) => ({
		lotNo: r.lot_no,
		itemNo: r.item_no,
		description: r.description,
		heatNo: r.heat_no,
		mill: r.mill,
		countryOfMelt: r.country_of_melt,
		vendorNo: r.vendor_no,
		receivedOn: r.received_on,
		quantityReceived: Number(r.quantity_received),
		quantityRemaining: Number(r.quantity_remaining),
		status: r.status,
		certificates: r.certificates ?? []
	}));
}

/**
 * The board: which cell is the bottleneck, which orders are short and why,
 * and which shipments cannot go out. Each of the three is a separate
 * question and none of them is a total of the others.
 */
export async function getManufacturingBoard(db: Db, userId: number): Promise<ManufacturingBoard> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{ today: string }>`select nl.today() as today`;

		const load = await tx.sql<{
			code: string;
			name: string;
			department: string;
			shifts: number;
			effective_hours_per_week: number;
			orders: number;
			overdue_orders: number;
			hours_required: number;
			hours_overdue: number;
			hours_available_4w: number;
			load_ratio: number | null;
			state: LoadRow['state'];
			first_due: string | null;
			last_due: string | null;
		}>`
			select code, name, department, shifts, effective_hours_per_week, orders, overdue_orders,
			       hours_required, hours_overdue, hours_available_4w, load_ratio, state, first_due, last_due
			from nl.work_center_load_now
			order by coalesce(load_ratio, 0) desc, code`;

		const weeks = await tx.sql<{
			work_center: string;
			due_week: string;
			orders: number;
			hours_required: number;
			hours_available: number;
			load_ratio: number | null;
			state: string;
		}>`
			select work_center, due_week, orders, hours_required, hours_available, load_ratio, state
			from nl.work_center_load
			where due_week between date_trunc('week', nl.today())::date - 7
			                   and date_trunc('week', nl.today())::date + 35
			order by due_week, work_center`;

		const shortages = await tx.sql<Record<string, unknown>>`
			select document_no, line_no, customer_no, customer_name, item_no, description, ship_date,
			       short, value_short, blocking_item, blocking_description, blocking_kind, blocking_depth,
			       blocking_short, blocking_covering_source, blocking_covering_document,
			       blocking_covering_date, blocking_lead_days
			from nl.shortage_watch
			order by value_short desc, document_no, line_no
			limit ${SHORTAGE_LIMIT}`;

		const packages = await tx.sql<{
			shipment_no: string;
			customer_no: string;
			customer_name: string;
			status: string;
			promised_on: string | null;
			gaps: number;
			missing: string;
			complete: boolean;
		}>`
			select p.shipment_no, p.customer_no, c.name as customer_name, p.status, p.promised_on,
			       p.gaps, p.missing, p.complete
			from nl.shipment_package p
			join nl.customers c on c.customer_no = p.customer_no
			where not p.complete and p.status <> 'shipped'
			order by p.promised_on nulls last, p.shipment_no`;

		const notReady = await tx.sql<{
			item_no: string;
			seq: number;
			work_center: string | null;
			description: string;
			blocked_reason: string;
		}>`
			select item_no, seq, work_center, description, blocked_reason
			from nl.operation_readiness
			where not ready
			order by work_center, item_no, seq
			limit 8`;

		const [counts] = await tx.sql<{
			parts: number;
			made_parts: number;
			bom_lines: number;
			operations: number;
			lots: number;
			certificates: number;
			disagreements: number;
		}>`
			select
				(select count(*)::int from nl.items) as parts,
				(select count(*)::int from nl.item_supply_shape where shape <> 'purchased') as made_parts,
				(select count(*)::int from nl.bom_lines) as bom_lines,
				(select count(*)::int from nl.routing_operations) as operations,
				(select count(*)::int from nl.lots) as lots,
				(select count(*)::int from nl.documents) as certificates,
				(select count(*)::int from nl.item_supply_shape where not agrees_with_erp) as disagreements`;

		return {
			today: head.today,
			load: load.map((r) => ({
				code: r.code,
				name: r.name,
				department: r.department,
				shifts: r.shifts,
				hoursPerWeek: Number(r.effective_hours_per_week),
				orders: r.orders,
				overdueOrders: r.overdue_orders,
				hoursRequired: Number(r.hours_required),
				hoursOverdue: Number(r.hours_overdue),
				hoursAvailable4w: Number(r.hours_available_4w),
				loadRatio: r.load_ratio === null ? null : Number(r.load_ratio),
				state: r.state,
				firstDue: r.first_due,
				lastDue: r.last_due
			})),
			weeks: weeks.map((r) => ({
				workCenter: r.work_center,
				dueWeek: r.due_week,
				orders: r.orders,
				hoursRequired: Number(r.hours_required),
				hoursAvailable: Number(r.hours_available),
				loadRatio: r.load_ratio === null ? null : Number(r.load_ratio),
				state: r.state
			})),
			shortages: shortages.map(
				(r) =>
					({
						documentNo: r.document_no,
						lineNo: r.line_no,
						customerNo: r.customer_no,
						customerName: r.customer_name,
						itemNo: r.item_no,
						description: r.description,
						shipDate: r.ship_date,
						short: Number(r.short),
						valueShort: Number(r.value_short),
						blockingItem: r.blocking_item ?? null,
						blockingDescription: r.blocking_description ?? null,
						blockingKind: r.blocking_kind ?? null,
						blockingDepth: r.blocking_depth ?? null,
						blockingShort: r.blocking_short === null ? null : Number(r.blocking_short),
						blockingCoveringSource: r.blocking_covering_source ?? null,
						blockingCoveringDocument: r.blocking_covering_document ?? null,
						blockingCoveringDate: r.blocking_covering_date ?? null,
						blockingLeadDays: r.blocking_lead_days ?? null
					}) as ShortageRow
			),
			packages: packages.map(
				(r) =>
					({
						shipmentNo: r.shipment_no,
						customerNo: r.customer_no,
						customerName: r.customer_name,
						status: r.status,
						promisedOn: r.promised_on,
						gaps: r.gaps,
						missing: r.missing,
						complete: r.complete
					}) as PackageRow
			),
			notReady: notReady.map((r) => ({
				itemNo: r.item_no,
				seq: r.seq,
				workCenter: r.work_center,
				description: r.description,
				reason: r.blocked_reason
			})),
			counts: {
				parts: counts.parts,
				madeParts: counts.made_parts,
				bomLines: counts.bom_lines,
				operations: counts.operations,
				lots: counts.lots,
				certificates: counts.certificates,
				disagreements: counts.disagreements
			}
		};
	});
}

/** One lot, traced both ways. */
export async function getLotTrace(db: Db, userId: number, lotNo: string): Promise<LotTrace | null> {
	return db.asUser(userId, async (tx) => {
		const [lot] = await tx.sql<{ item_no: string }>`select item_no from nl.lots where lot_no = ${lotNo}`;
		if (!lot) return null;

		const lots = await readLots(tx, lot.item_no, 200);
		const head = lots.find((l) => l.lotNo === lotNo);
		if (!head) return null;

		const back = await tx.sql<Record<string, unknown>>`
			select depth, lot_no, parent_lot, item_no, description, heat_no, mill, country_of_melt,
			       vendor_no, received_on, quantity_used, certificates
			from nl.lot_trace_back(${lotNo})
			order by depth, lot_no`;

		const forward = await tx.sql<{
			depth: number;
			lot_no: string;
			item_no: string;
			description: string;
			shipment_no: string | null;
			customer_no: string | null;
			customer_name: string | null;
			shipped_quantity: number | null;
		}>`
			select depth, lot_no, item_no, description, shipment_no, customer_no, customer_name, shipped_quantity
			from nl.lot_trace_forward(${lotNo})
			order by depth, lot_no, shipment_no nulls last`;

		const customers = await tx.sql<{
			customer_no: string;
			customer_name: string;
			owner_id: number | null;
			shipments: number;
			parts: number;
			quantity: number;
			first_shipped: string | null;
			last_shipped: string | null;
			item_numbers: string[];
		}>`
			select customer_no, customer_name, owner_id, shipments, parts, quantity,
			       first_shipped, last_shipped, item_numbers
			from nl.lot_recall_customers(${lotNo})
			order by quantity desc, customer_no`;

		return {
			lot: head,
			back: back.map(
				(r) =>
					({
						depth: r.depth,
						lotNo: r.lot_no,
						parentLot: r.parent_lot ?? null,
						itemNo: r.item_no,
						description: r.description,
						heatNo: r.heat_no,
						mill: r.mill,
						countryOfMelt: r.country_of_melt,
						vendorNo: r.vendor_no ?? null,
						receivedOn: r.received_on,
						quantityUsed: Number(r.quantity_used),
						certificates: r.certificates ?? []
					}) as TraceBackRow
			),
			forward: forward.map((r) => ({
				depth: r.depth,
				lotNo: r.lot_no,
				itemNo: r.item_no,
				description: r.description,
				shipmentNo: r.shipment_no,
				customerNo: r.customer_no,
				customerName: r.customer_name,
				shippedQuantity: r.shipped_quantity === null ? null : Number(r.shipped_quantity)
			})),
			customers: customers.map((r) => ({
				customerNo: r.customer_no,
				customerName: r.customer_name,
				ownerId: r.owner_id,
				shipments: r.shipments,
				parts: r.parts,
				quantity: Number(r.quantity),
				firstShipped: r.first_shipped,
				lastShipped: r.last_shipped,
				itemNumbers: r.item_numbers ?? []
			}))
		};
	});
}

/** What one shipment still owes, for the package panel. */
export async function getShipmentPackage(
	db: Db,
	userId: number,
	shipmentNo: string
): Promise<{ shipmentNo: string; complete: boolean; gaps: { lineNo: number; itemNo: string; certificate: string; reason: string }[] } | null> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{ shipment_no: string }>`
			select shipment_no from nl.shipments where shipment_no = ${shipmentNo}`;
		if (!head) return null;
		const gaps = await tx.sql<{ line_no: number; item_no: string; certificate_name: string; reason: string }>`
			select line_no, item_no, certificate_name, reason
			from nl.shipment_document_gaps(${shipmentNo})
			order by line_no, certificate_type`;
		return {
			shipmentNo,
			complete: gaps.length === 0,
			gaps: gaps.map((g) => ({
				lineNo: g.line_no,
				itemNo: g.item_no,
				certificate: g.certificate_name,
				reason: g.reason
			}))
		};
	});
}
