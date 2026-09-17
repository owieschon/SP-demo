// Types for the late-order forecast, shared by the server code in
// $lib/server/supply and the components in this folder. They live here, not
// under $lib/server, because pages in the browser may not import from
// $lib/server.

/**
 * What the projection says about one open sales line (nl.open_line_projection,
 * migration 0016). Exactly one per line.
 */
export type LineStatus = 'on_time' | 'late_waiting_supply' | 'late_supply_overdue' | 'no_supply' | 'past_due';

export const LINE_STATUS_ORDER: LineStatus[] = [
	'past_due',
	'no_supply',
	'late_supply_overdue',
	'late_waiting_supply',
	'on_time'
];

export const LINE_STATUS_LABEL: Record<LineStatus, string> = {
	past_due: 'Past due',
	no_supply: 'Nothing on order',
	late_supply_overdue: 'Supply order overdue',
	late_waiting_supply: 'Waiting on supply',
	on_time: 'On time'
};

/** Which supply event decides a line's date. */
export type SupplySource = 'stock' | 'purchase' | 'production';

export interface ForecastLine {
	documentNo: string;
	lineNo: number;
	customerNo: string;
	customerName: string;
	ownerName: string | null;
	itemNo: string;
	description: string;
	/** The ERP's promised ship date. */
	shipDate: string;
	/** When the parts are there (null when nothing on hand or on order covers it). */
	availabilityDate: string | null;
	projectedDate: string;
	daysLate: number;
	status: LineStatus;
	quantity: number;
	openValue: number;
	/** True for a past-due line whose parts are on the shelf right now. */
	coveredNow: boolean;
	/**
	 * Today plus the part's lead time: the earliest it could ship if it were
	 * ordered or scheduled today. What a "nothing on order" line is promised.
	 */
	earliestIfOrderedToday: string;
	supplySource: SupplySource | null;
	supplyDocument: string | null;
	supplyVendorNo: string | null;
	supplyVendorName: string | null;
	supplyWorkCenter: string | null;
	supplyDueDate: string | null;
	supplyOverdue: boolean;
}

export interface ForecastTotals {
	openLines: number;
	openValue: number;
	lateLines: number;
	lateValue: number;
	noSupplyLines: number;
	noSupplyValue: number;
	/** Open supply orders whose own due date has passed. */
	overdueSupplyOrders: number;
	worstDaysLate: number;
}

/** A buyer's call sheet: one row per vendor holding up customer orders. */
export interface VendorCall {
	vendorNo: string;
	vendorName: string;
	place: string;
	leadTime: string;
	contactName: string | null;
	contactEmail: string | null;
	contactPhone: string | null;
	lateLines: number;
	customers: number;
	purchaseOrders: number;
	overduePurchaseOrders: number;
	valueWaiting: number;
	firstDue: string | null;
	lastDue: string | null;
	worstDaysLate: number;
}

/** The production backlog: one row per work center holding up customer orders. */
export interface WorkCenterLoad {
	workCenter: string;
	lateLines: number;
	customers: number;
	productionOrders: number;
	overdueProductionOrders: number;
	valueWaiting: number;
	firstDue: string | null;
	worstDaysLate: number;
}

/** Who to call, and who owns the account. */
export interface CustomerCall {
	customerNo: string;
	customerName: string;
	ownerName: string | null;
	lateLines: number;
	noSupplyLines: number;
	valueLate: number;
	worstDaysLate: number;
	earliestPromise: string;
}

/** A promise that moved: measured from the applied snapshots, not logged. */
export interface PromiseMove {
	documentNo: string;
	lineNo: number;
	customerNo: string;
	customerName: string;
	itemNo: string;
	currentPromise: string;
	firstPromised: string;
	moves: number;
	biggestMoveDays: number;
	daysMoved: number;
	openValue: number;
}

/** A supply date that moved between the last two applied supply exports. */
export interface SupplyMove {
	kind: 'open_purchase_lines' | 'open_production_orders';
	change: 'new' | 'received' | 'due_later' | 'due_sooner';
	documentNo: string;
	lineNo: number | null;
	itemNo: string;
	/** The vendor number for a purchase line, the work center for a production order. */
	party: string;
	partyName: string | null;
	quantity: number;
	dueNow: string | null;
	dueBefore: string | null;
	daysMoved: number | null;
}

export interface ForecastFilters {
	/** 'late' is every line projected past its promised date; 'all' includes the rest. */
	status: LineStatus | 'all' | 'late';
	vendor: string | null;
	workCenter: string | null;
	customer: string | null;
	who: 'mine' | 'all';
}

export interface FilterOption {
	value: string;
	label: string;
	lines: number;
}

/** Which export each side of the forecast came from. */
export interface SnapshotHead {
	kind: 'open_sales_lines' | 'open_purchase_lines' | 'open_production_orders';
	id: number;
	fileName: string;
	appliedAt: string;
	appliedBy: string;
	rowCount: number;
}

/** Everything the forecast page shows. */
export interface Forecast {
	today: string;
	overdueSupplyDays: number;
	/** The filters these numbers were read with, so links can keep them. */
	filters: ForecastFilters;
	totals: ForecastTotals;
	lines: ForecastLine[];
	/** Lines the filters matched, before the table's limit. */
	lineCount: number;
	vendors: VendorCall[];
	workCenters: WorkCenterLoad[];
	customers: CustomerCall[];
	promiseMoves: PromiseMove[];
	supplyMoves: SupplyMove[];
	options: { vendors: FilterOption[]; workCenters: FilterOption[]; customers: FilterOption[] };
	sources: SnapshotHead[];
}

/**
 * The answer from nl.available_to_promise: can we ship this quantity of this
 * part by this date, and if not, when.
 */
export interface AtpAnswer {
	itemNo: string;
	description: string;
	quantity: number;
	neededBy: string;
	today: string;
	onHand: number;
	promisedEarlier: number;
	freeNow: number;
	neededThrough: number;
	leadDays: number;
	replenishment: string;
	canMeet: boolean;
	earliestDate: string;
	earliestBasis: 'stock' | 'supply' | 'lead_time';
	covering: {
		source: SupplySource;
		documentNo: string | null;
		party: string | null;
		dueDate: string | null;
		availableOn: string;
		overdue: boolean;
		quantity: number;
	} | null;
	incoming: {
		source: SupplySource;
		documentNo: string;
		party: string | null;
		dueDate: string;
		availableOn: string;
		quantity: number;
		overdue: boolean;
		coversTo: number;
	}[];
}
