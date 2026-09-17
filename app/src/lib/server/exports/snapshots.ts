// Workflow D: a daily ERP export that refuses bad files.
//
//   upload   read the file (openLines.ts); refuse the wrong report; recognize
//            data already loaded; check customers and items exist; then
//            stage it with nl.stage_export (held if anything looks wrong)
//   decide   apply, release (with a note) or discard, with nl.decide_export
//   read     the staged review, the buckets, day over day, the history
//
// Nothing here writes to the live table directly: the SQL functions do,
// after checking the user, the role, the row version and the order.
import { z } from 'zod';
import type {
	Bucket,
	BucketTotal,
	ChangeLineView,
	ExportKind,
	HoldReason,
	LineChange,
	OpenLineView,
	OperationsBoard,
	SnapshotHistoryRow,
	SnapshotReview,
	SnapshotStatus,
	UploadOutcome
} from '$lib/components/exports/types';
import { BUCKET_ORDER } from '$lib/components/exports/types';
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import { describe, type OpenLine } from './openLines.ts';
import {
	describeProductionOrder,
	describePurchaseLine,
	readReport,
	type ProductionOrder,
	type PurchaseLine,
	type ReportFile,
	type RowProblem
} from './reports.ts';

/** Bigger than any real open-lines export (1,500 lines is about 200 KB). */
export const MAX_FILE_BYTES = 2_000_000;

/** How many past-due and at-risk lines the board lists. */
export const RISK_LINE_LIMIT = 60;

const requestId = z.string().min(8).max(100);

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Read, check and stage one uploaded export. Returns what happened; a
 * refusal or a duplicate writes nothing at all.
 */
export async function uploadExport(
	db: Db,
	userId: number,
	file: { name: string; text: string },
	rid: string
): Promise<UploadOutcome> {
	requestId.parse(rid);
	// Which of the three reports this is, or a refusal. Nothing is written yet.
	const read = readReport(file.name, file.text);
	if (!read.ok) return { kind: 'refused', refusal: read.refusal };
	const report = read.file.kind;

	return guarded(() =>
		db.asUser(userId, async (tx) => {
			// The same form sent twice: hand back what the first one did.
			const [prior] = await tx.sql<{
				result: { snapshot_id: number; status: SnapshotStatus; kind?: ExportKind } | null;
			}>`
				select result from nl.request_log where request_id = ${rid} and action = 'stage_export'`;
			if (prior?.result) {
				return {
					kind: 'staged',
					snapshotId: prior.result.snapshot_id,
					status: prior.result.status,
					report: prior.result.kind ?? report,
					replayed: true
				};
			}

			// The same data, whatever the file is called. A fingerprint belongs
			// to one report, so the same rows under two reports are two files.
			const [existing] = await tx.sql<{ id: number; staged_on: string; staged_by: string; status: SnapshotStatus }>`
				select s.id, (s.staged_at at time zone 'America/Chicago')::date as staged_on,
				       u.full_name as staged_by, s.status
				from nl.export_snapshots s
				join nl.users u on u.id = s.staged_by
				where s.kind = ${report} and s.content_hash = ${read.file.hash}`;
			if (existing) {
				return {
					kind: 'duplicate',
					fileName: file.name,
					snapshotId: existing.id,
					stagedOn: existing.staged_on,
					stagedBy: existing.staged_by,
					status: existing.status,
					report
				};
			}

			const checked = await checkReferences(tx, read.file);
			const [row] = await tx.sql<{ result: { snapshot_id: number; status: SnapshotStatus; replayed?: boolean } }>`
				select nl.stage_export(
					${file.name},
					${read.file.hash},
					(select coalesce(array_agg(value), '{}') from jsonb_array_elements_text(${JSON.stringify(read.file.ignoredColumns)}::jsonb)),
					${JSON.stringify(checked.lines)}::jsonb,
					${JSON.stringify(checked.problems.map(problemJson))}::jsonb,
					${rid},
					${report}
				) as result`;
			return {
				kind: 'staged',
				snapshotId: row.result.snapshot_id,
				status: row.result.status,
				report,
				replayed: row.result.replayed === true
			};
		})
	);
}

/**
 * The checks a file cannot make on its own: everything it names must exist in
 * the book. A sales line needs its customer and its part, a purchase line its
 * vendor and its part, a production order its part. A row naming an unknown
 * one becomes a problem, and the rest of the file still loads.
 *
 * The good rows come back in the JSON shapes nl.stage_export reads for this
 * report (snake_case, as the SQL names them).
 */
async function checkReferences(
	tx: Tx,
	file: ReportFile
): Promise<{ lines: Record<string, unknown>[]; problems: RowProblem[] }> {
	const problems = [...file.problems];
	const lines: Record<string, unknown>[] = [];

	// Every code the file mentions, looked up in one round trip.
	const codes = { customer: new Set<string>(), item: new Set<string>(), vendor: new Set<string>() };
	if (file.kind === 'open_sales_lines') {
		for (const l of file.salesLines) {
			codes.customer.add(l.customerNo);
			codes.item.add(l.itemNo);
		}
	} else if (file.kind === 'open_purchase_lines') {
		for (const l of file.purchaseLines) {
			codes.vendor.add(l.vendorNo);
			codes.item.add(l.itemNo);
		}
	} else {
		for (const o of file.productionOrders) codes.item.add(o.itemNo);
	}
	const known = await knownCodes(tx, codes);

	if (file.kind === 'open_sales_lines') {
		for (const line of file.salesLines) {
			const reasons: string[] = [];
			if (!known.customer.has(line.customerNo)) reasons.push(`Customer ${line.customerNo} is not in the customer list.`);
			if (!known.item.has(line.itemNo)) reasons.push(`Item ${line.itemNo} is not in the item list.`);
			if (reasons.length === 0) {
				lines.push(salesLineJson(line));
			} else {
				problems.push({ rowNo: line.rowNo, key: [line.documentNo, String(line.lineNo)], reasons, raw: describe(line) });
			}
		}
	} else if (file.kind === 'open_purchase_lines') {
		for (const line of file.purchaseLines) {
			const reasons: string[] = [];
			if (!known.vendor.has(line.vendorNo)) reasons.push(`Vendor ${line.vendorNo} is not in the vendor list.`);
			if (!known.item.has(line.itemNo)) reasons.push(`Item ${line.itemNo} is not in the item list.`);
			if (reasons.length === 0) {
				lines.push(purchaseLineJson(line));
			} else {
				problems.push({
					rowNo: line.rowNo,
					key: [line.documentNo, String(line.lineNo)],
					reasons,
					raw: describePurchaseLine(line)
				});
			}
		}
	} else {
		for (const order of file.productionOrders) {
			if (known.item.has(order.itemNo)) {
				lines.push(productionOrderJson(order));
			} else {
				problems.push({
					rowNo: order.rowNo,
					key: [order.orderNo, ''],
					reasons: [`Item ${order.itemNo} is not in the item list.`],
					raw: describeProductionOrder(order)
				});
			}
		}
	}

	return { lines, problems: problems.sort((a, b) => a.rowNo - b.rowNo) };
}

/** Which of the codes a file mentions exist in the book. */
async function knownCodes(
	tx: Tx,
	codes: { customer: Set<string>; item: Set<string>; vendor: Set<string> }
): Promise<{ customer: Set<string>; item: Set<string>; vendor: Set<string> }> {
	const rows = await tx.sql<{ kind: 'customer' | 'item' | 'vendor'; code: string }>`
		select 'customer' as kind, c.customer_no as code
		from nl.customers c
		where c.customer_no in (select jsonb_array_elements_text(${JSON.stringify([...codes.customer])}::jsonb))
		union all
		select 'item', i.item_no
		from nl.items i
		where i.item_no in (select jsonb_array_elements_text(${JSON.stringify([...codes.item])}::jsonb))
		union all
		select 'vendor', v.vendor_no
		from nl.vendors v
		where v.vendor_no in (select jsonb_array_elements_text(${JSON.stringify([...codes.vendor])}::jsonb))`;
	return {
		customer: new Set(rows.filter((r) => r.kind === 'customer').map((r) => r.code)),
		item: new Set(rows.filter((r) => r.kind === 'item').map((r) => r.code)),
		vendor: new Set(rows.filter((r) => r.kind === 'vendor').map((r) => r.code))
	};
}

// The JSON shapes nl.stage_export reads, one per report.
function salesLineJson(l: OpenLine) {
	return {
		row_no: l.rowNo,
		document_no: l.documentNo,
		line_no: l.lineNo,
		customer_no: l.customerNo,
		item_no: l.itemNo,
		description: l.description,
		ship_date: l.shipDate,
		quantity: l.quantity,
		unit_price: l.unitPrice,
		line_amount: l.lineAmount,
		location_code: l.locationCode
	};
}

function purchaseLineJson(l: PurchaseLine) {
	return {
		row_no: l.rowNo,
		document_no: l.documentNo,
		line_no: l.lineNo,
		vendor_no: l.vendorNo,
		item_no: l.itemNo,
		description: l.description,
		due_date: l.dueDate,
		promised_date: l.promisedDate,
		quantity: l.quantity,
		location_code: l.locationCode
	};
}

function productionOrderJson(o: ProductionOrder) {
	return {
		row_no: o.rowNo,
		order_no: o.orderNo,
		item_no: o.itemNo,
		work_center: o.workCenter,
		status: o.status,
		due_date: o.dueDate,
		quantity: o.quantity
	};
}

function problemJson(p: RowProblem) {
	// The key is [document, line] for the line reports and [order, ''] for
	// production orders, as each profile names it.
	return { row_no: p.rowNo, document_no: p.key[0] ?? '', line_no: p.key[1] ?? '', reasons: p.reasons, raw: p.raw };
}

// ---------------------------------------------------------------------------
// Decide: apply, release, discard
// ---------------------------------------------------------------------------

export const decisionInput = z
	.object({
		snapshotId: z.coerce.number().int().positive(),
		decision: z.enum(['apply', 'release', 'discard']),
		note: z.string().trim().max(500).default(''),
		expectedUpdatedAt: z.iso.datetime({ offset: true }),
		requestId
	})
	// Say it here too, so the page can answer before asking the database.
	.refine((v) => v.decision !== 'release' || v.note.length >= 3, {
		message: 'Releasing a held snapshot needs a note saying why.',
		path: ['note']
	});

export type DecisionInput = z.infer<typeof decisionInput>;

export interface DecisionResult {
	snapshotId: number;
	decision: DecisionInput['decision'];
	summary: { added: number; changed: number; removed: number } | null;
	updatedAt: string;
	replayed: boolean;
}

export async function decideExport(
	db: Db,
	userId: number,
	input: DecisionInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<DecisionResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{
				result: {
					snapshot_id: number;
					decision: DecisionInput['decision'];
					summary: DecisionResult['summary'];
					updated_at: string;
					replayed?: boolean;
				};
			}>`
				select nl.decide_export(${input.snapshotId}, ${input.decision}, ${input.expectedUpdatedAt}::timestamptz,
				                        ${input.requestId}, ${input.note || null}, ${via}) as result`
		)
	);
	return {
		snapshotId: row.result.snapshot_id,
		decision: row.result.decision,
		summary: row.result.summary,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The snapshot waiting for a decision that the page should open by default, if any. */
export async function latestPendingSnapshotId(db: Db, userId: number): Promise<number | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ id: number }>`
			select s.id
			from nl.export_snapshots s
			where s.status in ('staged', 'held')
			  and s.id > coalesce((select c.id from nl.export_snapshots c where c.kind = s.kind and c.is_current), 0)
			order by s.id desc
			limit 1`
	);
	return row?.id ?? null;
}

/** One snapshot with everything the review panel shows. Null when it does not exist. */
export async function getSnapshotReview(db: Db, userId: number, id: number): Promise<SnapshotReview | null> {
	return db.asUser(userId, async (tx) => {
		const [s] = await tx.sql<{
			id: number;
			kind: ExportKind;
			file_name: string;
			status: SnapshotStatus;
			is_current: boolean;
			older_than_current: boolean;
			row_count: number;
			line_count: number;
			error_count: number;
			total_quantity: number;
			total_value: number;
			ignored_columns: string[];
			hold_reasons: HoldReason[];
			staged_by: string;
			staged_at: Date;
			decided_by: string | null;
			decided_at: Date | null;
			decision_note: string | null;
			apply_summary: SnapshotReview['applySummary'];
			updated_at: Date;
		}>`
			select s.id, s.kind, s.file_name, s.status, s.is_current,
			       s.status in ('staged', 'held')
			         and exists (select 1 from nl.export_snapshots c
			                     where c.kind = s.kind and c.is_current and c.id > s.id) as older_than_current,
			       s.row_count, s.line_count, s.error_count, s.total_quantity, s.total_value,
			       s.ignored_columns, s.hold_reasons,
			       st.full_name as staged_by, s.staged_at,
			       de.full_name as decided_by, s.decided_at, s.decision_note, s.apply_summary, s.updated_at
			from nl.export_snapshots s
			join nl.users st on st.id = s.staged_by
			left join nl.users de on de.id = s.decided_by
			where s.id = ${id}`;
		if (!s) return null;

		// The staged rows against the live table of this report, as it is right
		// now. Each report has its own key and its own columns, so each one
		// asks the question in its own words.
		const diff = await snapshotDiff(tx, id, s.kind);

		const errors = await tx.sql<{ row_no: number; document_no: string; line_no: string; reasons: string[] }>`
			select row_no, document_no, line_no, reasons
			from nl.export_snapshot_errors
			where snapshot_id = ${id}
			order by row_no
			limit 100`;

		return {
			id: s.id,
			kind: s.kind,
			fileName: s.file_name,
			status: s.status,
			isCurrent: s.is_current,
			olderThanCurrent: s.older_than_current,
			rowCount: s.row_count,
			lineCount: s.line_count,
			errorCount: s.error_count,
			totalQuantity: s.total_quantity,
			totalValue: s.total_value,
			ignoredColumns: s.ignored_columns,
			holdReasons: s.hold_reasons,
			stagedBy: s.staged_by,
			stagedAt: s.staged_at.toISOString(),
			decidedBy: s.decided_by,
			decidedAt: s.decided_at?.toISOString() ?? null,
			decisionNote: s.decision_note,
			diff,
			applySummary: s.apply_summary,
			errors: errors.map((e) => ({ rowNo: e.row_no, documentNo: e.document_no, lineNo: e.line_no, reasons: e.reasons })),
			// ISO text keeps the millisecond the database stored; it goes back as the row version.
			updatedAt: s.updated_at.toISOString()
		};
	});
}

type SnapshotDiff = { added: number; changed: number; unchanged: number; removed: number };

/** What applying a staged snapshot would change in the live table of its kind. */
async function snapshotDiff(tx: Tx, id: number, kind: ExportKind): Promise<SnapshotDiff> {
	if (kind === 'open_purchase_lines') {
		const [row] = await tx.sql<SnapshotDiff>`
			select
			  count(*) filter (where o.document_no is null)::int as added,
			  count(*) filter (where o.document_no is not null
			                     and (l.vendor_no, l.item_no, l.description, l.due_date, l.promised_date,
			                          l.quantity, l.location_code)
			                         is distinct from
			                         (o.vendor_no, o.item_no, o.description, o.due_date, o.promised_date,
			                          o.quantity, o.location_code))::int as changed,
			  count(*) filter (where o.document_no is not null
			                     and (l.vendor_no, l.item_no, l.description, l.due_date, l.promised_date,
			                          l.quantity, l.location_code)
			                         is not distinct from
			                         (o.vendor_no, o.item_no, o.description, o.due_date, o.promised_date,
			                          o.quantity, o.location_code))::int as unchanged,
			  (select count(*)::int from nl.open_purchase_lines g
			   where not exists (select 1 from nl.export_snapshot_purchase_lines x
			                     where x.snapshot_id = ${id} and x.document_no = g.document_no
			                       and x.line_no = g.line_no)) as removed
			from nl.export_snapshot_purchase_lines l
			left join nl.open_purchase_lines o on o.document_no = l.document_no and o.line_no = l.line_no
			where l.snapshot_id = ${id}`;
		return row;
	}
	if (kind === 'open_production_orders') {
		const [row] = await tx.sql<SnapshotDiff>`
			select
			  count(*) filter (where o.order_no is null)::int as added,
			  count(*) filter (where o.order_no is not null
			                     and (l.item_no, l.work_center, l.status, l.due_date, l.quantity)
			                         is distinct from
			                         (o.item_no, o.work_center, o.status, o.due_date, o.quantity))::int as changed,
			  count(*) filter (where o.order_no is not null
			                     and (l.item_no, l.work_center, l.status, l.due_date, l.quantity)
			                         is not distinct from
			                         (o.item_no, o.work_center, o.status, o.due_date, o.quantity))::int as unchanged,
			  (select count(*)::int from nl.open_production_orders g
			   where not exists (select 1 from nl.export_snapshot_production_orders x
			                     where x.snapshot_id = ${id} and x.order_no = g.order_no)) as removed
			from nl.export_snapshot_production_orders l
			left join nl.open_production_orders o on o.order_no = l.order_no
			where l.snapshot_id = ${id}`;
		return row;
	}
	const [row] = await tx.sql<SnapshotDiff>`
		select
		  count(*) filter (where o.document_no is null)::int as added,
		  count(*) filter (where o.document_no is not null
		                     and (l.customer_no, l.item_no, l.description, l.ship_date, l.quantity,
		                          l.unit_price, l.line_amount, l.location_code)
		                         is distinct from
		                         (o.customer_no, o.item_no, o.description, o.ship_date, o.quantity,
		                          o.unit_price, o.line_amount, o.location_code))::int as changed,
		  count(*) filter (where o.document_no is not null
		                     and (l.customer_no, l.item_no, l.description, l.ship_date, l.quantity,
		                          l.unit_price, l.line_amount, l.location_code)
		                         is not distinct from
		                         (o.customer_no, o.item_no, o.description, o.ship_date, o.quantity,
		                          o.unit_price, o.line_amount, o.location_code))::int as unchanged,
		  (select count(*)::int from nl.open_order_lines g
		   where not exists (select 1 from nl.export_snapshot_lines x
		                     where x.snapshot_id = ${id} and x.document_no = g.document_no and x.line_no = g.line_no))
		    as removed
		from nl.export_snapshot_lines l
		left join nl.open_order_lines o on o.document_no = l.document_no and o.line_no = l.line_no
		where l.snapshot_id = ${id}`;
	return row;
}

/** The buckets, the lines that need attention, day over day, and recent snapshots. */
export async function getOperationsBoard(db: Db, userId: number): Promise<OperationsBoard> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{ today: string; horizon: number }>`
			select nl.today() as today, nl.at_risk_days() as horizon`;

		const [current] = await tx.sql<{ id: number; file_name: string; decided_at: Date; decided_by: string }>`
			select s.id, s.file_name, s.decided_at, u.full_name as decided_by
			from nl.export_snapshots s
			join nl.users u on u.id = s.decided_by
			where s.kind = 'open_sales_lines' and s.is_current`;

		const bucketRows = await tx.sql<{ bucket: Bucket; lines: number; quantity: number; short: number; value: number }>`
			select bucket, count(*)::int as lines, sum(quantity)::int as quantity,
			       sum(short)::int as short, sum(open_value) as value
			from nl.open_line_allocation
			group by bucket`;
		const buckets: BucketTotal[] = BUCKET_ORDER.map(
			(bucket) => bucketRows.find((r) => r.bucket === bucket) ?? { bucket, lines: 0, quantity: 0, short: 0, value: 0 }
		);
		const totals = buckets.reduce(
			(sum, b) => ({
				lines: sum.lines + b.lines,
				quantity: sum.quantity + b.quantity,
				value: sum.value + b.value,
				short: sum.short + b.short
			}),
			{ lines: 0, quantity: 0, value: 0, short: 0 }
		);

		// Past due first (oldest first), then at risk (soonest first).
		const risk = await tx.sql<{
			document_no: string;
			line_no: number;
			customer_no: string;
			customer_name: string;
			item_no: string;
			description: string;
			ship_date: string;
			quantity: number;
			allocated: number;
			short: number;
			open_value: number;
			bucket: Bucket;
		}>`
			select a.document_no, a.line_no, a.customer_no, c.name as customer_name, a.item_no, a.description,
			       a.ship_date, a.quantity, a.allocated, a.short, a.open_value, a.bucket
			from nl.open_line_allocation a
			join nl.customers c on c.customer_no = a.customer_no
			where a.bucket in ('past_due', 'at_risk')
			order by a.bucket = 'at_risk', a.ship_date, a.document_no, a.line_no
			limit ${RISK_LINE_LIMIT}`;

		const changes = await tx.sql<{
			change: LineChange;
			document_no: string;
			line_no: number;
			customer_name: string;
			item_no: string;
			ship_date: string;
			quantity: number;
			short_now: number | null;
			short_before: number | null;
			previous_snapshot_id: number | null;
		}>`
			select ch.change, ch.document_no, ch.line_no, c.name as customer_name, ch.item_no, ch.ship_date,
			       ch.quantity, ch.short_now, ch.short_before, ch.previous_snapshot_id
			from nl.open_line_changes ch
			join nl.customers c on c.customer_no = ch.customer_no
			order by array_position(array['newly_short', 'new', 'shipped'], ch.change), ch.ship_date, ch.document_no, ch.line_no`;

		const [previous] = await tx.sql<{ id: number | null }>`
			select max(s.id) as id
			from nl.export_snapshots s
			join nl.export_snapshots c on c.kind = s.kind and c.is_current
			where s.kind = 'open_sales_lines' and s.status = 'applied' and s.id < c.id`;

		const history = await tx.sql<{
			id: number;
			kind: ExportKind;
			file_name: string;
			status: SnapshotStatus;
			is_current: boolean;
			row_count: number;
			error_count: number;
			hold_codes: HoldReason['code'][];
			staged_by: string;
			staged_at: Date;
			decided_by: string | null;
			decided_at: Date | null;
			decision_note: string | null;
		}>`
			select s.id, s.kind, s.file_name, s.status, s.is_current, s.row_count, s.error_count,
			       array(select r->>'code' from jsonb_array_elements(s.hold_reasons) r) as hold_codes,
			       st.full_name as staged_by, s.staged_at,
			       de.full_name as decided_by, s.decided_at, s.decision_note
			from nl.export_snapshots s
			join nl.users st on st.id = s.staged_by
			left join nl.users de on de.id = s.decided_by
			order by s.id desc
			limit 9`;

		const counts: Record<LineChange, number> = { new: 0, shipped: 0, newly_short: 0 };
		for (const c of changes) counts[c.change] += 1;

		return {
			current: current
				? {
						id: current.id,
						fileName: current.file_name,
						appliedAt: current.decided_at.toISOString(),
						appliedBy: current.decided_by
					}
				: null,
			today: head.today,
			horizonDays: head.horizon,
			buckets,
			totals,
			riskLines: risk.map(
				(r): OpenLineView => ({
					documentNo: r.document_no,
					lineNo: r.line_no,
					customerNo: r.customer_no,
					customerName: r.customer_name,
					itemNo: r.item_no,
					description: r.description,
					shipDate: r.ship_date,
					quantity: r.quantity,
					allocated: r.allocated,
					short: r.short,
					openValue: r.open_value,
					bucket: r.bucket
				})
			),
			riskLineCount: (buckets[0]?.lines ?? 0) + (buckets[1]?.lines ?? 0),
			dayOverDay: {
				previousId: previous?.id ?? null,
				counts,
				// The page shows a handful of each kind.
				lines: (['newly_short', 'new', 'shipped'] as LineChange[]).flatMap((kind) =>
					changes
						.filter((c) => c.change === kind)
						.slice(0, 15)
						.map(
							(c): ChangeLineView => ({
								change: c.change,
								documentNo: c.document_no,
								lineNo: c.line_no,
								customerName: c.customer_name,
								itemNo: c.item_no,
								shipDate: c.ship_date,
								quantity: c.quantity,
								shortNow: c.short_now,
								shortBefore: c.short_before
							})
						)
				)
			},
			history: history.map(
				(h): SnapshotHistoryRow => ({
					id: h.id,
					kind: h.kind,
					fileName: h.file_name,
					status: h.status,
					isCurrent: h.is_current,
					rowCount: h.row_count,
					errorCount: h.error_count,
					holdCodes: h.hold_codes,
					stagedBy: h.staged_by,
					stagedAt: h.staged_at.toISOString(),
					decidedBy: h.decided_by,
					decidedAt: h.decided_at?.toISOString() ?? null,
					decisionNote: h.decision_note
				})
			)
		};
	});
}
