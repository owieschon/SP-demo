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
import { describe, readOpenLines, type OpenLine, type OpenLinesFile, type RowProblem } from './openLines.ts';

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
	const read = readOpenLines(file.name, file.text);
	if (!read.ok) return { kind: 'refused', refusal: read.refusal };

	return guarded(() =>
		db.asUser(userId, async (tx) => {
			// The same form sent twice: hand back what the first one did.
			const [prior] = await tx.sql<{ result: { snapshot_id: number; status: SnapshotStatus } | null }>`
				select result from nl.request_log where request_id = ${rid} and action = 'stage_export'`;
			if (prior?.result) {
				return { kind: 'staged', snapshotId: prior.result.snapshot_id, status: prior.result.status, replayed: true };
			}

			// The same data, whatever the file is called.
			const [existing] = await tx.sql<{ id: number; staged_on: string; staged_by: string; status: SnapshotStatus }>`
				select s.id, (s.staged_at at time zone 'America/Chicago')::date as staged_on,
				       u.full_name as staged_by, s.status
				from nl.export_snapshots s
				join nl.users u on u.id = s.staged_by
				where s.kind = 'open_sales_lines' and s.content_hash = ${read.file.hash}`;
			if (existing) {
				return {
					kind: 'duplicate',
					fileName: file.name,
					snapshotId: existing.id,
					stagedOn: existing.staged_on,
					stagedBy: existing.staged_by,
					status: existing.status
				};
			}

			const checked = await checkReferences(tx, read.file);
			const [row] = await tx.sql<{ result: { snapshot_id: number; status: SnapshotStatus; replayed?: boolean } }>`
				select nl.stage_export(
					${file.name},
					${read.file.hash},
					(select coalesce(array_agg(value), '{}') from jsonb_array_elements_text(${JSON.stringify(read.file.ignoredColumns)}::jsonb)),
					${JSON.stringify(checked.lines.map(lineJson))}::jsonb,
					${JSON.stringify(checked.problems.map(problemJson))}::jsonb,
					${rid}
				) as result`;
			return {
				kind: 'staged',
				snapshotId: row.result.snapshot_id,
				status: row.result.status,
				replayed: row.result.replayed === true
			};
		})
	);
}

/**
 * The checks a file cannot make on its own: every customer and item must
 * exist. A row naming an unknown one becomes a problem.
 */
async function checkReferences(tx: Tx, file: OpenLinesFile): Promise<{ lines: OpenLine[]; problems: RowProblem[] }> {
	const customers = [...new Set(file.lines.map((l) => l.customerNo))];
	const items = [...new Set(file.lines.map((l) => l.itemNo))];
	const known = await tx.sql<{ kind: 'customer' | 'item'; code: string }>`
		select 'customer' as kind, c.customer_no as code
		from nl.customers c
		where c.customer_no in (select jsonb_array_elements_text(${JSON.stringify(customers)}::jsonb))
		union all
		select 'item', i.item_no
		from nl.items i
		where i.item_no in (select jsonb_array_elements_text(${JSON.stringify(items)}::jsonb))`;
	const knownCustomers = new Set(known.filter((k) => k.kind === 'customer').map((k) => k.code));
	const knownItems = new Set(known.filter((k) => k.kind === 'item').map((k) => k.code));

	const lines: OpenLine[] = [];
	const problems = [...file.problems];
	for (const line of file.lines) {
		const reasons: string[] = [];
		if (!knownCustomers.has(line.customerNo)) reasons.push(`Customer ${line.customerNo} is not in the customer list.`);
		if (!knownItems.has(line.itemNo)) reasons.push(`Item ${line.itemNo} is not in the item list.`);
		if (reasons.length === 0) {
			lines.push(line);
		} else {
			problems.push({ rowNo: line.rowNo, key: [line.documentNo, String(line.lineNo)], reasons, raw: describe(line) });
		}
	}
	return { lines, problems: problems.sort((a, b) => a.rowNo - b.rowNo) };
}

// The JSON shapes nl.stage_export reads (snake_case, as the SQL names them).
function lineJson(l: OpenLine) {
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

function problemJson(p: RowProblem) {
	// The key is [document, line], as the profile names it.
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
			where s.kind = 'open_sales_lines'
			  and s.status in ('staged', 'held')
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
			select s.id, s.file_name, s.status, s.is_current,
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

		// The staged lines against the live table as it is right now.
		const [diff] = await tx.sql<{ added: number; changed: number; unchanged: number; removed: number }>`
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

		const errors = await tx.sql<{ row_no: number; document_no: string; line_no: string; reasons: string[] }>`
			select row_no, document_no, line_no, reasons
			from nl.export_snapshot_errors
			where snapshot_id = ${id}
			order by row_no
			limit 100`;

		return {
			id: s.id,
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
			where s.status = 'applied' and s.id < c.id`;

		const history = await tx.sql<{
			id: number;
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
			select s.id, s.file_name, s.status, s.is_current, s.row_count, s.error_count,
			       array(select r->>'code' from jsonb_array_elements(s.hold_reasons) r) as hold_codes,
			       st.full_name as staged_by, s.staged_at,
			       de.full_name as decided_by, s.decided_at, s.decision_note
			from nl.export_snapshots s
			join nl.users st on st.id = s.staged_by
			left join nl.users de on de.id = s.decided_by
			where s.kind = 'open_sales_lines'
			order by s.id desc
			limit 8`;

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
