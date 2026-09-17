// Types for workflow D (the daily ERP export), shared by the server code in
// $lib/server/exports and the components in this folder. They live here,
// not under $lib/server, because pages in the browser may not import from
// $lib/server.

export type SnapshotStatus = 'staged' | 'held' | 'applied' | 'discarded';

/** The three ERP reports the morning import knows (nl.export_snapshots.kind). */
export type ExportKind = 'open_sales_lines' | 'open_purchase_lines' | 'open_production_orders';

export const EXPORT_KINDS: ExportKind[] = ['open_sales_lines', 'open_purchase_lines', 'open_production_orders'];

/** Short names for the reports, for tables and chips. */
export const EXPORT_KIND_LABEL: Record<ExportKind, string> = {
	open_sales_lines: 'Sales lines',
	open_purchase_lines: 'Purchase lines',
	open_production_orders: 'Production orders'
};

/** What each report is, in a sentence, for the upload form and the review panel. */
export const EXPORT_KIND_NAME: Record<ExportKind, string> = {
	open_sales_lines: 'open sales lines export',
	open_purchase_lines: 'open purchase lines export',
	open_production_orders: 'open production orders export'
};

export type Bucket = 'past_due' | 'at_risk' | 'on_pace' | 'later';

export const BUCKET_ORDER: Bucket[] = ['past_due', 'at_risk', 'on_pace', 'later'];

export const BUCKET_LABEL: Record<Bucket, string> = {
	past_due: 'Past due',
	at_risk: 'At risk',
	on_pace: 'On pace',
	later: 'Later'
};

/** A reason a staged file waits for a person, in plain English. */
export interface HoldReason {
	code: 'partial' | 'stale' | 'row_errors';
	message: string;
}

/** Why a file was turned away before anything was written. */
export interface Refusal {
	fileName: string;
	message: string;
	/** Required columns the file does not have, by their ERP names. */
	missing: string[];
	/** The headers the file does have. */
	headers: string[];
	/** A guess at which report this is instead, when it looks like one we know. */
	looksLike: string | null;
}

/** What happened to an upload. */
export type UploadOutcome =
	| { kind: 'refused'; refusal: Refusal }
	| {
			kind: 'duplicate';
			fileName: string;
			snapshotId: number;
			stagedOn: string;
			stagedBy: string;
			status: SnapshotStatus;
			/** Which report the file turned out to be. */
			report: ExportKind;
	  }
	| { kind: 'staged'; snapshotId: number; status: SnapshotStatus; replayed: boolean; report: ExportKind };

export interface RowProblemView {
	rowNo: number;
	documentNo: string;
	lineNo: string;
	reasons: string[];
}

/** A staged (or decided) snapshot, as the review panel shows it. */
export interface SnapshotReview {
	id: number;
	/** Which of the three reports this file is. */
	kind: ExportKind;
	fileName: string;
	status: SnapshotStatus;
	isCurrent: boolean;
	/** Staged or held, but a newer snapshot is already live, so it can only be discarded. */
	olderThanCurrent: boolean;
	rowCount: number;
	lineCount: number;
	errorCount: number;
	totalQuantity: number;
	totalValue: number;
	ignoredColumns: string[];
	holdReasons: HoldReason[];
	stagedBy: string;
	stagedAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
	decisionNote: string | null;
	/** Against the live table right now (before applying). */
	diff: { added: number; changed: number; removed: number; unchanged: number };
	/** What applying did, once it has been applied. */
	applySummary: { added: number; changed: number; removed: number } | null;
	errors: RowProblemView[];
	updatedAt: string;
}

export interface BucketTotal {
	bucket: Bucket;
	lines: number;
	quantity: number;
	short: number;
	value: number;
}

export interface OpenLineView {
	documentNo: string;
	lineNo: number;
	customerNo: string;
	customerName: string;
	itemNo: string;
	description: string;
	shipDate: string;
	quantity: number;
	allocated: number;
	short: number;
	openValue: number;
	bucket: Bucket;
}

export type LineChange = 'new' | 'shipped' | 'newly_short';

export interface ChangeLineView {
	change: LineChange;
	documentNo: string;
	lineNo: number;
	customerName: string;
	itemNo: string;
	shipDate: string;
	quantity: number;
	shortNow: number | null;
	shortBefore: number | null;
}

export interface SnapshotHistoryRow {
	id: number;
	kind: ExportKind;
	fileName: string;
	status: SnapshotStatus;
	isCurrent: boolean;
	rowCount: number;
	errorCount: number;
	holdCodes: HoldReason['code'][];
	stagedBy: string;
	stagedAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
	decisionNote: string | null;
}

/** Everything the operations board shows under the upload form. */
export interface OperationsBoard {
	/** The snapshot the live table mirrors, or null before the first apply. */
	current: { id: number; fileName: string; appliedAt: string; appliedBy: string } | null;
	today: string;
	horizonDays: number;
	buckets: BucketTotal[];
	totals: { lines: number; quantity: number; value: number; short: number };
	/** Past-due and at-risk lines, worst first, capped (see riskLineCount). */
	riskLines: OpenLineView[];
	riskLineCount: number;
	dayOverDay: {
		previousId: number | null;
		counts: Record<LineChange, number>;
		lines: ChangeLineView[];
	};
	history: SnapshotHistoryRow[];
}

/**
 * The sample files anyone can download from the operations page. The world is
 * seeded with yesterday's three exports already applied, so today's three are
 * the ones to upload; the rest show what the checks do.
 */
export type SampleKind =
	| 'yesterday'
	| 'today'
	| 'wrong-report'
	| 'partial'
	| 'stale'
	| 'messy'
	| 'purchase-yesterday'
	| 'purchase-today'
	| 'production-yesterday'
	| 'production-today';

export const SAMPLE_KINDS: { kind: SampleKind; label: string; hint: string; report: ExportKind }[] = [
	{ kind: 'today', label: "Today's sales lines", hint: 'The one to upload: yesterday is already applied.', report: 'open_sales_lines' },
	{ kind: 'purchase-today', label: "Today's purchase lines", hint: 'What vendors owe us.', report: 'open_purchase_lines' },
	{ kind: 'production-today', label: "Today's production orders", hint: 'What the shop floor owes us.', report: 'open_production_orders' },
	{ kind: 'yesterday', label: "Yesterday's sales lines", hint: 'Already applied: recognized as loaded.', report: 'open_sales_lines' },
	{ kind: 'purchase-yesterday', label: "Yesterday's purchase lines", hint: 'Already applied.', report: 'open_purchase_lines' },
	{ kind: 'production-yesterday', label: "Yesterday's production orders", hint: 'Already applied.', report: 'open_production_orders' },
	{ kind: 'messy', label: 'Messy copy of today', hint: 'Same data after a spreadsheet saved it.', report: 'open_sales_lines' },
	{ kind: 'partial', label: 'Partial export', hint: 'Cut short: held.', report: 'open_sales_lines' },
	{ kind: 'stale', label: 'Stale export', hint: 'Every ship date has passed: held.', report: 'open_sales_lines' },
	{ kind: 'wrong-report', label: 'Wrong report', hint: 'Posted invoices: refused.', report: 'open_sales_lines' }
];
