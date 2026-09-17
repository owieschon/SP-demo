// The shapes the warehouse page and its components pass around. The server
// reads them out of the database (lib/server/warehouse/read.ts) and nothing
// below this file talks SQL.

/** The six figures nl.warehouse_today returns, always all six. */
export type Bucket =
	| 'to_pick'
	| 'packed'
	| 'awaiting_carrier'
	| 'shipped_today'
	| 'in_transit'
	| 'counts_due';

export const BUCKET_ORDER: Bucket[] = [
	'to_pick',
	'packed',
	'awaiting_carrier',
	'shipped_today',
	'in_transit',
	'counts_due'
];

export const BUCKET_LABEL: Record<Bucket, string> = {
	to_pick: 'To pick',
	packed: 'Packed',
	awaiting_carrier: 'Awaiting carrier',
	shipped_today: 'Shipped today',
	in_transit: 'In transit',
	counts_due: 'Counts due'
};

export const BUCKET_HINT: Record<Bucket, string> = {
	to_pick: 'On the pick list, not touched yet',
	packed: 'Boxed and labelled, waiting on paperwork',
	awaiting_carrier: 'On the dock, waiting for the truck',
	shipped_today: 'Gone today, off the shelf',
	in_transit: 'Between our own buildings',
	counts_due: 'Counted or waiting to be counted'
};

export interface BucketTotal {
	bucket: Bucket;
	/** Shipments, transfers or count sessions, depending on the bucket. */
	documents: number;
	lines: number;
	quantity: number;
	/** Inventory value at standard cost: one rule for all six buckets. */
	value: number;
}

// ---------------------------------------------------------------------------
// Shipments
// ---------------------------------------------------------------------------

export type ShipmentStatus = 'picking' | 'packed' | 'awaiting carrier' | 'shipped';

export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
	picking: 'Picking',
	packed: 'Packed',
	'awaiting carrier': 'Awaiting carrier',
	shipped: 'Shipped'
};

/** The one step a shipment may take next, or null when it has gone. */
export const NEXT_SHIPMENT_STATUS: Record<ShipmentStatus, ShipmentStatus | null> = {
	picking: 'packed',
	packed: 'awaiting carrier',
	'awaiting carrier': 'shipped',
	shipped: null
};

/** What the button that takes that step says. */
export const ADVANCE_LABEL: Record<ShipmentStatus, string> = {
	picking: 'Mark packed',
	packed: 'On the dock',
	'awaiting carrier': 'Ship it',
	shipped: 'Shipped'
};

export interface PickLine {
	lineNo: number;
	itemNo: string;
	description: string;
	quantity: number;
	bin: string;
	documentNo: string;
	orderLineNo: number | null;
}

export interface PickShipment {
	shipmentNo: string;
	customerNo: string;
	customerName: string;
	locationCode: string;
	locationName: string;
	carrier: string;
	status: ShipmentStatus;
	promisedOn: string | null;
	packedBy: string | null;
	packedAt: string | null;
	tracking: string;
	note: string;
	/** The row version the Advance form sends back. */
	updatedAt: string;
	pieces: number;
	lines: PickLine[];
}

// ---------------------------------------------------------------------------
// Cycle counts
// ---------------------------------------------------------------------------

export interface CountLine {
	lineNo: number;
	itemNo: string;
	description: string;
	bin: string;
	expectedQty: number;
	countedQty: number | null;
	variance: number | null;
	reason: string | null;
	note: string;
}

export interface OpenCount {
	id: number;
	sessionNo: string;
	locationCode: string;
	locationName: string;
	zone: string;
	dueOn: string;
	countedOn: string | null;
	countedBy: string | null;
	note: string;
	updatedAt: string;
	lines: CountLine[];
	counted: number;
	notCounted: number;
	withVariance: number;
	/** What posting it would do to the on-hand figure, in pieces. */
	netChange: number;
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export type MoveKind = 'receipt' | 'shipment' | 'adjustment' | 'transfer_out' | 'transfer_in' | 'count';

export const MOVE_LABEL: Record<MoveKind, string> = {
	receipt: 'Receipt',
	shipment: 'Shipment',
	adjustment: 'Adjustment',
	transfer_out: 'Transfer out',
	transfer_in: 'Transfer in',
	count: 'Count'
};

export interface MoveRow {
	id: number;
	itemNo: string;
	description: string;
	locationCode: string;
	locationName: string;
	movedAt: string;
	kind: MoveKind;
	quantity: number;
	reference: string;
	reason: string | null;
	actorName: string | null;
	note: string;
}

export interface BinRow {
	locationCode: string;
	locationName: string;
	zone: string;
	aisle: string;
	shelf: string;
	bin: string;
	quantity: number;
	countedOn: string | null;
	/** The row version an adjustment on this bin sends back. */
	updatedAt: string;
}

export interface KindTotal {
	kind: MoveKind;
	moves: number;
	quantity: number;
}

/** "Explain this number" for one part: opening, what happened, closing. */
export interface PartLedger {
	itemNo: string;
	description: string;
	openedOn: string | null;
	opening: number;
	byKind: KindTotal[];
	moveCount: number;
	moved: number;
	/** opening + moved. Equal to onHand, or the ledger has drifted. */
	closing: number;
	onHand: number;
	allocated: number;
	available: number;
	agrees: boolean;
	bins: BinRow[];
	moves: MoveRow[];
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export interface TransitTransfer {
	transferNo: string;
	fromLocation: string;
	fromName: string;
	toLocation: string;
	toName: string;
	sentOn: string;
	expectedOn: string;
	sentBy: string | null;
	note: string;
	lines: number;
	pieces: number;
	late: boolean;
	updatedAt: string;
}

/** Everything the page streams in after the shell has arrived. */
export interface WarehouseBoard {
	today: string;
	buckets: BucketTotal[];
	pickQueue: PickShipment[];
	pickQueueTotal: number;
	openCount: OpenCount | null;
	transit: TransitTransfer[];
	recentMoves: MoveRow[];
}

/** The reasons nl.post_stock_adjustment accepts, in the order the form offers them. */
export const ADJUSTMENT_REASONS = ['damaged', 'scrap', 'found', 'miscount', 'returned to stock'] as const;

export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
