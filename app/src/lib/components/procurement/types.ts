// Types for the procurement desk, shared by the server code in
// $lib/server/procurement and the components in this folder. They live here,
// not under $lib/server, because a page running in the browser may not import
// anything from $lib/server.

/** How erratic a part's demand is (nl.part_usage.demand_shape). */
export type DemandShape = 'none' | 'steady' | 'lumpy' | 'erratic';

/** Why a part is on the list (nl.part_replenishment.trigger_reason). */
export type TriggerReason =
	| 'promised more than we will have'
	| 'below reorder point'
	| 'below safety stock'
	| 'on pace';

export type SignalKind =
	| 'below_reorder_point'
	| 'purchase_order_late'
	| 'vendor_cost_moved'
	| 'demand_jumped'
	| 'no_vendor'
	| 'no_cost'
	| 'under_vendor_minimum';

export const SIGNAL_LABEL: Record<SignalKind, string> = {
	below_reorder_point: 'Below reorder point',
	purchase_order_late: 'Purchase order late',
	vendor_cost_moved: 'Vendor cost moved',
	demand_jumped: 'Demand jumped',
	no_vendor: 'No vendor',
	no_cost: 'No cost',
	under_vendor_minimum: 'Under vendor minimum'
};

/** What each signal is telling the desk to do about it. */
export const SIGNAL_HINT: Record<SignalKind, string> = {
	below_reorder_point: 'Buy it',
	purchase_order_late: 'Chase the vendor',
	vendor_cost_moved: 'Check the selling price still works',
	demand_jumped: 'Buy it, and tell the account manager what is possible',
	no_vendor: 'Fix the item card',
	no_cost: 'Fix the item card',
	under_vendor_minimum: 'Group the order, or wait'
};

/** One part that needs buying. */
export interface ReplenishmentLine {
	itemNo: string;
	description: string;
	family: string;
	blocked: boolean;
	vendorNo: string | null;
	vendorName: string | null;
	reorderPoint: number | null;
	safetyStock: number | null;
	policyLevel: number | null;
	leadTimeFormula: string;
	leadTimeDays: number;
	horizonOn: string;
	onHand: number;
	unitCost: number;
	pack: number;
	perDay: number;
	perWeek: number;
	units90d: number;
	units365d: number;
	demandShape: DemandShape;
	demandCv: number | null;
	revenue90d: number;
	lastSoldOn: string | null;
	promisedTotal: number;
	promisedBeforeHorizon: number;
	promisedPastDue: number;
	incomingBeforeHorizon: number;
	onOrderTotal: number;
	onOrderLater: number;
	projectedAvailable: number;
	targetQty: number;
	daysOfCover: number | null;
	runsOutOn: string | null;
	orderByOn: string | null;
	requestedOn: string;
	suggestedQty: number;
	suggestedCost: number;
	/** Open sales lines for this part that already cannot ship, in dollars. */
	valueAtRisk: number;
	triggerReason: TriggerReason;
	reason: string;
	replenishment: string;
	/** True for a part we make, which wants a production order and not a vendor. */
	madeHere: boolean;
	/** True when this part can be ordered today: a vendor and a cost. */
	buyable: boolean;
	/** True when the item card is missing what buying needs. */
	itemCardIncomplete: boolean;
}

/**
 * What a group of parts is, which decides what the desk can do about it.
 *
 *   vendor  parts to buy from a named vendor
 *   made    parts we make here: short of a production order, not a purchase
 *   orphan  bought-in parts with nobody to buy them from, or no cost
 */
export type GroupKind = 'vendor' | 'made' | 'orphan';

/** One vendor's worth of parts that need buying. */
export interface VendorGroup {
	kind: GroupKind;
	vendorNo: string | null;
	vendorName: string;
	terms: string;
	freightTerms: string;
	minOrder: number | null;
	freeFreightAt: number | null;
	subtotal: number;
	valueAtRisk: number;
	revenue90d: number;
	/** False when the group does not reach the vendor's minimum order. */
	meetsMinimum: boolean;
	/** False when the group does not reach the vendor's free-freight threshold. */
	clearsFreight: boolean;
	/** The earliest date any part in the group is wanted. */
	neededBy: string | null;
	/** True when there is already an open draft for this vendor. */
	hasDraft: boolean;
	lines: ReplenishmentLine[];
}

export interface RequestLine {
	id: number;
	lineNo: number;
	itemNo: string;
	description: string;
	quantity: number;
	suggestedQty: number;
	edited: boolean;
	unitCost: number;
	lineTotal: number;
	requestedOn: string;
	reason: string;
}

export type RequestStatus = 'draft' | 'approved' | 'dismissed';

/** A suggested order waiting for a person. */
export interface PurchaseRequest {
	id: number;
	vendorNo: string;
	vendorName: string;
	status: RequestStatus;
	neededBy: string | null;
	terms: string;
	freightNote: string;
	subtotal: number;
	minOrder: number | null;
	freeFreightAt: number | null;
	meetsMinimum: boolean;
	createdBy: string;
	createdAt: string;
	decidedBy: string | null;
	decidedAt: string | null;
	orderNo: string | null;
	/** True when the order was also written into the supply forecast's tables. */
	mirrored: boolean;
	lines: RequestLine[];
	/** The row version the page sends back with any change to this request. */
	updatedAt: string;
}

/** A vendor email waiting for a person to send it. */
export interface VendorEmailDraft {
	id: number;
	requestId: number;
	vendorName: string;
	orderNo: string | null;
	toEmail: string;
	toName: string;
	subject: string;
	body: string;
	queuedBy: string;
	queuedAt: string;
	/** Set when the draft was mirrored into the mail queue (migration 0021). */
	mailDraftId: number | null;
}

export interface SignalRow {
	id: number;
	signal: SignalKind;
	subject: string;
	itemNo: string | null;
	vendorNo: string | null;
	vendorName: string | null;
	headline: string;
	valueAtRisk: number;
	raisedOn: string;
	raisedAt: string;
	clearedAt: string | null;
}

/** Which neighbouring migrations the desk found (nl.procurement_sources). */
export interface ProcurementSources {
	openPurchaseLines: boolean;
	productionOrders: boolean;
	availableToPromise: boolean;
	mailDrafts: boolean;
}

/** Everything the /procurement page shows once the data has arrived. */
export interface ProcurementDesk {
	today: string;
	coverDays: number;
	sources: ProcurementSources;
	groups: VendorGroup[];
	totals: {
		parts: number;
		vendors: number;
		subtotal: number;
		valueAtRisk: number;
		/** Parts we make that are short: a production order, not a purchase. */
		madeHere: number;
		/** Parts whose item card is missing a vendor or a cost. */
		itemCardIncomplete: number;
	};
	requests: PurchaseRequest[];
	drafts: VendorEmailDraft[];
	signals: SignalRow[];
	openSignalCount: number;
}
