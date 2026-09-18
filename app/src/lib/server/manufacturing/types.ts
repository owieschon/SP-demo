// The shapes the manufacturing pages read. Every one of them comes straight
// out of a view or a function in migrations 0031 to 0034; nothing is worked
// out in TypeScript, because the same figures have to be available to the
// assistant and the order desk, which do not run this code.

/** The nine cost elements, in the order the breakdown shows them. */
export const COST_ELEMENTS = [
	'material',
	'component',
	'labor',
	'machine',
	'overhead',
	'outside',
	'scrap',
	'packaging',
	'expedite'
] as const;

export type CostElement = (typeof COST_ELEMENTS)[number];

/** How a part is actually made, derived from what it has rather than stored. */
export type SupplyShape = 'manufactured' | 'assembled' | 'kitted' | 'processed' | 'purchased';

export interface ShapeSummary {
	shape: SupplyShape;
	sentence: string;
	bomLines: number;
	operations: number;
	outsideSteps: number;
	cells: string | null;
	erpReplenishment: string;
	erpAgrees: boolean;
}

export interface CostSummary {
	rolled: number;
	card: number | null;
	difference: number | null;
	levels: number;
	measuredAt: string;
	elements: Record<CostElement, number>;
	top: { element: CostElement; amount: number; share: number | null }[];
	listPrice: number;
	rolledMargin: number | null;
}

export interface LeadSummary {
	days: number;
	ownDays: number;
	basis: string;
	levels: number;
	criticalChild: string | null;
	criticalPath: string[];
	readyOn: string;
}

export interface PromiseSummary {
	quantity: number;
	onHand: number;
	promisedEarlier: number;
	freeNow: number;
	earliestDate: string;
	earliestBasis: 'stock' | 'supply' | 'lead_time';
	canMeet: boolean;
	leadDays: number;
}

/** One line of the cost breakdown, at the level of the tree it came from. */
export interface CostLine {
	level: number;
	itemNo: string;
	parentItem: string | null;
	description: string;
	element: CostElement;
	source: string;
	detail: string;
	quantityPer: number;
	unitAmount: number;
	amount: number;
}

/** One node of the bill of materials tree, with its rolled cost. */
export interface BomNode {
	level: number;
	itemNo: string;
	parentItem: string | null;
	description: string;
	kind: string;
	shape: SupplyShape | null;
	quantityPer: number;
	uom: string;
	scrapPct: number;
	isSubstitute: boolean;
	isPhantom: boolean;
	rolledCost: number | null;
	extendedCost: number | null;
	leadDays: number | null;
	onHand: number;
	lineNo: number | null;
	referenceNote: string;
}

export interface WhereUsedRow {
	parentItem: string;
	description: string;
	depth: number;
	quantityPer: number;
	shape: SupplyShape | null;
	openLines: number;
	openQty: number;
	openOrderValue: number;
}

export interface LeadNode {
	level: number;
	itemNo: string;
	parentItem: string | null;
	description: string;
	basis: string;
	ownDays: number;
	leadDays: number;
	isCritical: boolean;
}

export interface OperationRow {
	seq: number;
	workCenter: string | null;
	description: string;
	setupMinutes: number;
	runMinutes: number;
	queueMinutes: number;
	moveMinutes: number;
	yieldPct: number;
	laborClass: string | null;
	machine: string | null;
	isOutside: boolean;
	isInspection: boolean;
	vendorNo: string | null;
	outsidePrice: number | null;
	requiresQual: string | null;
	requiresGauge: string | null;
	ready: boolean;
	blockedReason: string;
}

export interface SourceRow {
	sourceKind: string;
	priority: number;
	vendorNo: string | null;
	workCenter: string | null;
	fromLocation: string | null;
	minQty: number | null;
	maxQty: number | null;
	unitPrice: number | null;
	leadTime: string;
	note: string;
}

export interface LotRow {
	lotNo: string;
	itemNo: string;
	description: string;
	heatNo: string;
	mill: string;
	countryOfMelt: string;
	vendorNo: string | null;
	receivedOn: string;
	quantityReceived: number;
	quantityRemaining: number;
	status: string;
	// Built as JSON in the database, so these keys keep the database's
	// spelling rather than being renamed on the way through.
	certificates: { kind: string; reference_no: string; expired: boolean }[];
}

export interface PartManufacturing {
	itemNo: string;
	description: string;
	family: string;
	kind: string;
	blocked: boolean;
	today: string;
	shape: ShapeSummary;
	cost: CostSummary;
	lead: LeadSummary;
	promise: PromiseSummary;
	onHand: number;
	available: number;
	byLocation: Record<string, number>;
	bom: BomNode[];
	costLines: CostLine[];
	leadTree: LeadNode[];
	whereUsed: WhereUsedRow[];
	operations: OperationRow[];
	sources: SourceRow[];
	lots: LotRow[];
	planning: {
		demandPolicy: string;
		lotSizing: string;
		minOrderQty: number | null;
		orderMultiple: number | null;
		maxOrderQty: number | null;
		reorderPoint: number | null;
		safetyStock: number | null;
	} | null;
	skus: { skuCode: string; packQuantity: number; uom: string; isDefault: boolean; weightLb: number | null }[];
}

export interface LoadRow {
	code: string;
	name: string;
	department: string;
	shifts: number;
	hoursPerWeek: number;
	orders: number;
	overdueOrders: number;
	hoursRequired: number;
	hoursOverdue: number;
	hoursAvailable4w: number;
	loadRatio: number | null;
	state: 'clear' | 'tight' | 'over' | 'no capacity set';
	firstDue: string | null;
	lastDue: string | null;
}

export interface LoadWeek {
	workCenter: string;
	dueWeek: string;
	orders: number;
	hoursRequired: number;
	hoursAvailable: number;
	loadRatio: number | null;
	state: string;
}

export interface ShortageRow {
	documentNo: string;
	lineNo: number;
	customerNo: string;
	customerName: string;
	itemNo: string;
	description: string;
	shipDate: string;
	short: number;
	valueShort: number;
	blockingItem: string | null;
	blockingDescription: string | null;
	blockingKind: string | null;
	blockingDepth: number | null;
	blockingShort: number | null;
	blockingCoveringSource: string | null;
	blockingCoveringDocument: string | null;
	blockingCoveringDate: string | null;
	blockingLeadDays: number | null;
}

export interface PackageRow {
	shipmentNo: string;
	customerNo: string;
	customerName: string;
	status: string;
	promisedOn: string | null;
	gaps: number;
	missing: string;
	complete: boolean;
}

export interface TraceBackRow {
	depth: number;
	lotNo: string;
	parentLot: string | null;
	itemNo: string;
	description: string;
	heatNo: string;
	mill: string;
	countryOfMelt: string;
	vendorNo: string | null;
	receivedOn: string;
	quantityUsed: number;
	certificates: { kind: string; reference_no: string; issued_by: string; expired: boolean }[];
}

export interface RecallRow {
	customerNo: string;
	customerName: string;
	ownerId: number | null;
	shipments: number;
	parts: number;
	quantity: number;
	firstShipped: string | null;
	lastShipped: string | null;
	itemNumbers: string[];
}

export interface LotTrace {
	lot: LotRow;
	back: TraceBackRow[];
	forward: {
		depth: number;
		lotNo: string;
		itemNo: string;
		description: string;
		shipmentNo: string | null;
		customerNo: string | null;
		customerName: string | null;
		shippedQuantity: number | null;
	}[];
	customers: RecallRow[];
}

export interface ManufacturingBoard {
	today: string;
	load: LoadRow[];
	weeks: LoadWeek[];
	shortages: ShortageRow[];
	packages: PackageRow[];
	notReady: { itemNo: string; seq: number; workCenter: string | null; description: string; reason: string }[];
	counts: {
		parts: number;
		madeParts: number;
		bomLines: number;
		operations: number;
		lots: number;
		certificates: number;
		disagreements: number;
	};
}
