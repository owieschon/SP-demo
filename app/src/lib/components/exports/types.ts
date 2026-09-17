// Types for workflow D (the daily ERP export), shared by the server code in
// $lib/server/exports and the components in this folder. They live here,
// not under $lib/server, because pages in the browser may not import from
// $lib/server.

export type SnapshotStatus = 'staged' | 'held' | 'applied' | 'discarded';

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
	  }
	| { kind: 'staged'; snapshotId: number; status: SnapshotStatus; replayed: boolean };

export interface RowProblemView {
	rowNo: number;
	documentNo: string;
	lineNo: string;
	reasons: string[];
}

/** A staged (or decided) snapshot, as the review panel shows it. */
export interface SnapshotReview {
	id: number;
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

/** The sample files anyone can download from the operations page. */
export type SampleKind = 'yesterday' | 'today' | 'wrong-report' | 'partial' | 'stale' | 'messy';

export const SAMPLE_KINDS: { kind: SampleKind; label: string; hint: string }[] = [
	{ kind: 'yesterday', label: "Yesterday's export", hint: 'Apply this first.' },
	{ kind: 'today', label: "Today's export", hint: 'A day later: some shipped, some new, a few changed.' },
	{ kind: 'messy', label: 'Messy copy of today', hint: 'Same data after a spreadsheet saved it.' },
	{ kind: 'partial', label: 'Partial export', hint: 'Cut short: held.' },
	{ kind: 'stale', label: 'Stale export', hint: 'Every ship date has passed: held.' },
	{ kind: 'wrong-report', label: 'Wrong report', hint: 'Posted invoices: refused.' }
];
