// What the pricing module hands back. Every figure here is worked out in the
// database (migration 0018) and only renamed on the way through, so a screen
// and the assistant always see the same number.

/** Which rule produced a price. The order is the precedence order. */
export type PriceRule = 'agreement' | 'last paid' | 'group discount' | 'list';

export interface Price {
	customerNo: string;
	itemNo: string;
	/** The day the price was worked out for, as YYYY-MM-DD. */
	onDate: string;
	price: number;
	rule: PriceRule;
	/** One short sentence saying where the price came from. */
	detail: string;
	listPrice: number;
	/** The price group discount that applies, 0 for an account we do not know. */
	discount: number;
	/** The cost that applied on that day, from the cost timeline. */
	unitCost: number;
	/** The lowest price that clears nl.min_margin(). */
	floorPrice: number;
	/** Gross margin at this price, or null when the price is zero. */
	marginPct: number | null;
	belowFloor: boolean;
}

/** A priced quote line: a price with a quantity on it. */
export interface PricedLine extends Price {
	lineNo: number;
	quantity: number;
	/** quantity x price, rounded to the cent. */
	extended: number;
}

export interface PricedLines {
	lines: PricedLine[];
	total: number;
	/** How many lines are priced under the margin floor. */
	belowFloor: number;
	/** Item numbers that are not in the catalog, so they could not be priced. */
	unknownItems: string[];
}

/** One step on a part's cost timeline. */
export interface CostPoint {
	effectiveFrom: string;
	/** The day before the next revision, null while this is the current cost. */
	effectiveTo: string | null;
	isCurrent: boolean;
	unitCost: number;
	vendorNo: string | null;
	source: 'vendor quote' | 'purchase receipt' | 'standard revision';
	note: string;
	/** Dollars moved since the previous revision, null on the first row. */
	change: number | null;
	/** The same step as a share of the previous cost, null on the first row. */
	changePct: number | null;
}

export interface Freight {
	/** What the tariff says this shipment costs, 0 once it ships free. */
	freight: number;
	baseRate: number;
	surchargePct: number;
	freeOver: number;
	/** The bottom of the subtotal band the shipment fell in. */
	bandMin: number;
}

export interface ItemMarginMonth {
	month: string;
	lines: number;
	units: number;
	revenue: number;
	costOfGoods: number;
	grossMargin: number;
	marginPct: number | null;
}

export interface CustomerMarginYear {
	year: number;
	lines: number;
	items: number;
	units: number;
	revenue: number;
	costOfGoods: number;
	grossMargin: number;
	marginPct: number | null;
}

export interface FreightMonth {
	month: string;
	invoices: number;
	invoicesWithFreight: number;
	subtotal: number;
	freightBilled: number;
	freightAtRate: number;
	/** Billed less the tariff: negative means freight was absorbed. */
	difference: number;
	recoveryRatio: number | null;
}

/** An agreed price, as an account page lists it. */
export interface Agreement {
	customerNo: string;
	itemNo: string;
	description: string;
	netPrice: number;
	validFrom: string;
	validTo: string | null;
	agreedBy: string | null;
	note: string;
	/** in_force while it covers today, expired once it has run out, upcoming before it starts. */
	status: 'in_force' | 'expired' | 'upcoming';
	/** The tier price today, so a screen can show what the agreement is worth. */
	groupPrice: number;
	belowFloor: boolean;
}
