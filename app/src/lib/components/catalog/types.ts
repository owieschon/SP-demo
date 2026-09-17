// Types shared by the catalog server code (lib/server/catalog) and the
// parts, vendors and search pages. Field names are camelCase; the server
// turns the database's snake_case rows into these.

/** The open-line buckets from nl.open_line_allocation (migration 0010). */
export type OpenBucket = 'past_due' | 'at_risk' | 'on_pace' | 'later';

export const BUCKET_LABEL: Record<OpenBucket, string> = {
	past_due: 'Past due',
	at_risk: 'At risk',
	on_pace: 'On pace',
	later: 'Later'
};

// ---------------------------------------------------------------------------
// Parts list
// ---------------------------------------------------------------------------

export const PART_SORTS = ['revenue', 'margin', 'on_hand'] as const;
export type PartSort = (typeof PART_SORTS)[number];

export const PART_SORT_LABEL: Record<PartSort, string> = {
	revenue: '12-month revenue',
	margin: 'Gross margin',
	on_hand: 'On hand'
};

/** What the parts list was asked for, read from the URL. */
export interface PartListQuery {
	q: string;
	family: string | null;
	short: boolean;
	belowReorder: boolean;
	sort: PartSort;
}

/** The flags every part row can carry. */
export interface PartFlags {
	madeToOrder: boolean;
	proprietary: boolean;
	blocked: boolean;
	belowReorderPoint: boolean;
	shortQty: number;
}

export interface PartRow extends PartFlags {
	itemNo: string;
	description: string;
	family: string;
	onHand: number;
	units12m: number;
	revenue12m: number;
	/** Null when nothing sold in the last 12 months. */
	margin12m: number | null;
	lastSoldOn: string | null;
}

export interface PartList {
	rows: PartRow[];
	/** Every part that matched, before the cap. */
	total: number;
	limit: number;
}

export interface FamilyOption {
	family: string;
	items: number;
}

// ---------------------------------------------------------------------------
// One part
// ---------------------------------------------------------------------------

export interface PartDetail extends PartFlags {
	itemNo: string;
	description: string;
	category: string;
	family: string;
	productGroup: string;
	replenishment: string;
	workCenter: string;
	leadTime: string;
	unitCost: number;
	listPrice: number;
	listMargin: number | null;
	vendorNo: string | null;
	vendorName: string | null;
	vendorLeadTime: string | null;
	shelf: string;
	bin: string;
	stockAsOf: string | null;
	onHand: number;
	onProductionOrder: number;
	onPurchaseOrder: number;
	openLines: number;
	openQty: number;
	openValue: number;
	projectedAvailable: number;
	reorderPoint: number | null;
	safetyStock: number | null;
	units12m: number;
	revenue12m: number;
	margin12m: number | null;
	buyers12m: number;
	unitsPrior12m: number;
	revenuePrior12m: number;
	lastSoldOn: string | null;
}

export interface MonthUnits {
	/** First day of the month, 'YYYY-MM-DD'. */
	month: string;
	units: number;
	revenue: number;
}

export interface TopBuyer {
	customerNo: string;
	name: string;
	city: string;
	state: string;
	country: string;
	units: number;
	revenue: number;
	lastPrice: number | null;
	lastOn: string | null;
}

export interface PartInvoiceLine {
	invoiceNo: string;
	lineNo: number;
	postedOn: string;
	isCreditMemo: boolean;
	customerNo: string;
	customerName: string;
	quantity: number;
	unitPrice: number;
	amount: number;
}

export interface PartSales {
	months: MonthUnits[];
	topBuyers: TopBuyer[];
	recentLines: PartInvoiceLine[];
}

export interface PartOpenLine {
	documentNo: string;
	lineNo: number;
	customerNo: string;
	customerName: string;
	shipDate: string;
	quantity: number;
	allocated: number;
	short: number;
	openValue: number;
	bucket: OpenBucket;
}

export interface PartCommitment {
	id: number;
	title: string;
	customerNo: string;
	customerName: string;
	ownerName: string;
	status: 'promised' | 'quoted' | 'delivering' | 'kept' | 'pushed' | 'broken';
	isSettled: boolean;
	startsOn: string;
	endsOn: string;
	committedValue: number;
	deliveredRatio: number;
	/** What the buyer said for this part, when they said it. */
	quantity: number | null;
}

export interface PartQuote {
	id: number;
	lineNo: number;
	customerNo: string;
	customerName: string;
	quotedOn: string;
	validUntil: string | null;
	commitmentId: number | null;
	quantity: number;
	unitPrice: number;
	createdBy: string;
}

export interface PartDemand {
	openLines: PartOpenLine[];
	/** All open lines for the part; the list above is capped. */
	openLineCount: number;
	commitments: PartCommitment[];
	quotes: PartQuote[];
}

export interface SiblingPart {
	itemNo: string;
	description: string;
	onHand: number;
	revenue12m: number;
	blocked: boolean;
	madeToOrder: boolean;
}

export interface Siblings {
	/** The size the siblings share, as printed: '5"'. Null when the part has none. */
	size: string | null;
	parts: SiblingPart[];
}

// ---------------------------------------------------------------------------
// Vendors
// ---------------------------------------------------------------------------

export interface VendorRow {
	vendorNo: string;
	name: string;
	city: string;
	state: string;
	leadTime: string;
	terms: string;
	activeItems: number;
	itemsShort: number;
	itemsBelowReorder: number;
	revenue12m: number;
}

export interface VendorList {
	rows: VendorRow[];
	total: number;
	limit: number;
}

export const VENDOR_CONTACT_TITLES = [
	'Inside Sales',
	'Account Manager',
	'Customer Service',
	'Quality',
	'Accounts Receivable'
] as const;
export type VendorContactTitle = (typeof VENDOR_CONTACT_TITLES)[number];

export interface VendorContact {
	id: number;
	fullName: string;
	title: VendorContactTitle;
	email: string | null;
	phone: string | null;
	isPrimary: boolean;
	active: boolean;
}

export interface VendorDetail extends VendorRow {
	freightTerms: string;
	minOrder: number | null;
	shipsFrom: string;
	items: number;
	shortQty: number;
	units12m: number;
	/** The row version the Add contact form sends back (ISO text, milliseconds). */
	updatedAt: string;
	contacts: VendorContact[];
}

export interface VendorPart extends PartFlags {
	itemNo: string;
	description: string;
	family: string;
	leadTime: string;
	unitCost: number;
	onHand: number;
	onPurchaseOrder: number;
	reorderPoint: number | null;
	units12m: number;
	revenue12m: number;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchAccount {
	customerNo: string;
	name: string;
	city: string;
	state: string;
	country: string;
	closed: boolean;
}

export interface SearchPart {
	itemNo: string;
	description: string;
	blocked: boolean;
}

export interface SearchVendor {
	vendorNo: string;
	name: string;
	city: string;
	state: string;
}

export interface SearchGroup<T> {
	rows: T[];
	/** Every match, before the cap. */
	total: number;
}

export interface SearchResults {
	q: string;
	accounts: SearchGroup<SearchAccount>;
	parts: SearchGroup<SearchPart>;
	vendors: SearchGroup<SearchVendor>;
}

/** Links shared by every page that shows an item or a vendor number. */
export function partHref(itemNo: string): string {
	return `/parts/${encodeURIComponent(itemNo)}`;
}

export function vendorHref(vendorNo: string): string {
	return `/vendors/${encodeURIComponent(vendorNo)}`;
}

export function accountHref(customerNo: string): string {
	return `/accounts/${encodeURIComponent(customerNo)}`;
}
