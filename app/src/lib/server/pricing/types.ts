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

// ---------------------------------------------------------------------------
// Published price sheets, ladders, history and exceptions (migration 0027)
// ---------------------------------------------------------------------------

/**
 * Which rule produced a quote level price. The order is the precedence order.
 * Two of these are new in 0027: 'sheet' is the page price on the sheet in
 * force for the account's tier, and 'held sheet' is an older sheet the
 * account keeps by a written exception.
 */
export type QuoteRule =
	| 'agreement'
	| 'held sheet'
	| 'last paid'
	| 'sheet'
	| 'group discount'
	| 'list';

/** One rung of a published volume ladder. */
export interface LadderRung {
	minQuantity: number;
	breakPrice: number;
	note: string;
}

/** A priced quote line at its quantity, with the ladder around it. */
export interface QuotedLine {
	lineNo: number;
	customerNo: string;
	itemNo: string;
	onDate: string;
	quantity: number;
	/** The price before any rung: what the base rule alone said. */
	basePrice: number;
	rule: QuoteRule;
	/** One short sentence naming the document the price came from. */
	detail: string;
	sheetId: number | null;
	sheetCode: string | null;
	sheetName: string | null;
	/** The page price on the sheet in force, null when the part is not on it. */
	sheetPrice: number | null;
	agreementNet: number | null;
	agreementFrom: string | null;
	agreementTo: string | null;
	/** 'better of' lets a rung go under the agreed price, 'agreement only' does not. */
	breakPolicy: 'better of' | 'agreement only' | null;
	/** The rung that set the price, null when none did. */
	breakQuantity: number | null;
	breakPrice: number | null;
	breakNote: string | null;
	/** Whether that rung is printed on the sheet or is the tier's own ladder. */
	breakOwner: 'sheet' | 'tier' | null;
	/** What to quote: the base price, or the rung when the rung is lower. */
	unitPrice: number;
	/** quantity x unitPrice, rounded to the cent. */
	extended: number;
	nextQuantity: number | null;
	/** What they would actually pay at that quantity, not the printed rung. */
	nextPrice: number | null;
	listPrice: number;
	discount: number;
	unitCost: number;
	floorPrice: number;
	marginPct: number | null;
	belowFloor: boolean;
}

export interface QuotedLines {
	lines: QuotedLine[];
	total: number;
	/** How many lines are priced under the margin floor. */
	belowFloor: number;
	/** Item numbers that are not in the catalog, so they could not be priced. */
	unknownItems: string[];
}

/** A published price sheet generation. */
export interface PriceSheet {
	id: number;
	code: string;
	name: string;
	priceGroup: string;
	priceGroupLabel: string;
	effectiveFrom: string;
	/** null while this is the generation in force. */
	effectiveTo: string | null;
	publishedOn: string;
	note: string;
	lines: number;
	/** How many accounts were sent this generation. */
	sentTo: number;
}

/** One part's price on one sheet, with that sheet's ladder for it. */
export interface PriceSheetLine {
	sheetId: number;
	code: string;
	name: string;
	priceGroup: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	isCurrent: boolean;
	sheetPrice: number;
	/** The list price the page price was worked out from. */
	listAtPublication: number;
	note: string;
	ladder: LadderRung[];
}

/** The sheet an account is holding. */
export interface AccountSheet {
	sheetId: number;
	code: string;
	name: string;
	priceGroup: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	isCurrent: boolean;
	sentOn: string;
	sentHow: 'email' | 'mail' | 'rep visit' | 'portal';
	daysOld: number;
	/** Old enough that a reply should say which sheet they are reading from. */
	stale: boolean;
	generationsBehind: number;
}

/** What an account is used to paying for one part. */
export interface ItemPriceHistory {
	itemNo: string;
	description: string;
	timesBought: number;
	units: number;
	firstBought: string;
	lastBought: string;
	daysSince: number;
	lastPrice: number;
	lastQuantity: number;
	lastInvoiceNo: string;
	/** Weighted by quantity, null when they have not bought it in a year. */
	avgPrice12m: number | null;
	highPrice: number;
	lowPrice: number;
	/** The sheet price if the part is on their sheet, else their tier price. */
	todayPrice: number;
	tierPrice: number;
	sheetCode: string | null;
	aboveLastPaidPct: number | null;
	/** Today's price is more than nl.price_jump_pct() above what they paid. */
	aboveLastPaid: boolean;
}

/** One part under a customer's roof. */
export interface CustomerPart {
	itemNo: string;
	description: string;
	family: string;
	timesBought: number;
	units: number;
	revenue: number;
	units12m: number;
	revenue12m: number;
	times12m: number;
	firstBought: string;
	lastBought: string;
	daysSince: number;
	lastPrice: number;
	lastQuantity: number;
	avgPrice12m: number | null;
	highPrice: number;
	lowPrice: number;
	todayPrice: number;
	aboveLastPaid: boolean;
	/** Their habit with this part: inside 180 days, inside a year, or longer. */
	buyingStatus: 'active' | 'slowing' | 'quiet';
	/** The part's own state, discontinued first. */
	partStatus: 'discontinued' | 'available' | 'on order' | 'short';
	onHand: number;
	onOrder: number;
	leadDays: number;
	leadSlipped: boolean;
	/** Where the lead time came from, so a screen can say "vendor default". */
	leadBasis: PromiseBasis;
	/** False where a date should not be given at all. */
	canPromise: boolean;
	/** The vendor the promise rests on, null for a part we make. */
	sourceVendorNo: string | null;
	blocked: boolean;
	discontinuedOn: string | null;
	replacementItemNo: string | null;
	replacementDescription: string | null;
}

/** What kind of exception a row is. */
export type ExceptionKind =
	| 'price increase'
	| 'surcharge'
	| 'customer exception'
	| 'lead time'
	| 'allocation'
	| 'discontinued'
	| 'order minimum';

/** A published exception to normal price, lead time or ordering. */
export interface TradeException {
	id: number;
	kind: ExceptionKind;
	scope: 'item' | 'family' | 'product_group' | 'catalog';
	/** 'announced' has gone out to customers but has not started yet. */
	status: 'announced' | 'live' | 'expired';
	itemNo: string | null;
	family: string | null;
	productGroup: string | null;
	/** null when it applies to everyone. */
	customerNo: string | null;
	/** null when it applies to every tier. */
	priceGroup: string | null;
	announcedOn: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	daysLeft: number | null;
	/** A price increase or a surcharge, as a share. */
	pct: number | null;
	/** An order minimum, in dollars. */
	amount: number | null;
	/** A pack size, or an allocation limit per order. */
	quantity: number | null;
	/** The lead time now, in days. */
	days: number | null;
	heldSheetId: number | null;
	replacementItemNo: string | null;
	reason: string;
	/** What the letter said, or what to say on the phone. */
	wording: string | null;
	/**
	 * Who owns it, as a user id rather than a name: the read-only role the
	 * assistant uses has no grant on nl.users, so a page resolves the name.
	 */
	ownerId: number;
}

/**
 * What `nl.explain_price()` returns, passed through with the database's own
 * key names.
 *
 * This is the one place in the app that does not rename columns to
 * camelCase, and it is deliberate. The whole point of `explain_price` is that
 * a page, the desk agent and the assistant read one answer; giving the same
 * facts a second set of names would be the start of them disagreeing, and the
 * agents hand this straight to a model, which reads the SQL names perfectly
 * well. `nl.available_to_promise` is passed around the same way.
 */
export interface PriceExplanation {
	customer_no: string;
	customer_name: string | null;
	price_group: string | null;
	item_no: string;
	description: string | null;
	family: string | null;
	quantity: number;
	on_date: string;
	unit_price: number;
	extended: number;
	quote: {
		rule: QuoteRule;
		detail: string;
		base_price: number;
		list_price: number;
		tier_discount: number;
		tier_price: number;
		break_quantity: number | null;
		break_price: number | null;
		break_note: string | null;
		break_owner: 'sheet' | 'tier' | null;
		next_quantity: number | null;
		next_price: number | null;
		ladder: { min_quantity: number; break_price: number; note: string; owner: 'sheet' | 'tier' }[];
	};
	sheet: { id: number; code: string; name: string; sheet_price: number } | null;
	/** The sheet the buyer is holding, and their price on it. */
	customer_sheet: {
		id: number;
		code: string;
		name: string;
		sent_on: string;
		sent_how: string;
		days_old: number;
		stale: boolean;
		is_current: boolean;
		generations_behind: number;
		their_price: number | null;
		difference: number | null;
		difference_pct: number | null;
	} | null;
	agreement: {
		net_price: number;
		valid_from: string;
		valid_to: string | null;
		break_policy: 'better of' | 'agreement only';
	} | null;
	history: {
		times_bought: number;
		units: number;
		first_bought: string;
		last_bought: string;
		last_price: number;
		last_quantity: number;
		last_invoice_no: string;
		avg_price_12m: number | null;
		high_price: number;
		low_price: number;
		days_since: number;
		above_last_paid_pct: number | null;
		above_last_paid: boolean;
	} | null;
	never_bought: boolean;
	cost: {
		unit_cost: number;
		floor_price: number;
		min_margin: number;
		margin_pct: number | null;
		below_floor: boolean;
	};
	lead_time: {
		days: number;
		/** The figure before any published slip. */
		card_days: number;
		slipped: boolean;
		/** Where the figure came from. See `PromiseBasis`. */
		basis: PromiseBasis;
		basis_detail: string;
		/** False where a date should not be given at all (allocation, discontinued). */
		can_promise: boolean;
		vendor_no: string | null;
		receipts: number;
		median_days: number | null;
		p90_days: number | null;
		late_share: number | null;
		reason: string | null;
		wording: string | null;
		owner_id: number | null;
		since: string | null;
		until: string | null;
		earliest_ship: string;
	};
	next_increase: {
		pct: number;
		effective_from: string;
		scope: string;
		reason: string;
		wording: string | null;
		owner_id: number;
		price_after: number;
	} | null;
	surcharges: { pct: number; reason: string; owner_id: number }[];
	surcharge_pct: number | null;
	surcharge_amount: number | null;
	exceptions: Record<string, unknown>[];
	/** Plain sentences a person could say, in the order to say them. */
	talking_points: string[];
}

/**
 * What `nl.answer_for()` returns: the explanation plus the supply side, with
 * the database's own key names for the same reason.
 */
export interface PriceAnswer {
	customer_no: string;
	customer_name: string | null;
	item_no: string;
	description: string | null;
	quantity: number;
	needed_by: string;
	on_date: string;
	unit_price: number;
	extended: number;
	price: PriceExplanation['quote'];
	sheet: PriceExplanation['sheet'];
	customer_sheet: PriceExplanation['customer_sheet'];
	agreement: PriceExplanation['agreement'];
	history: PriceExplanation['history'];
	never_bought: boolean;
	cost: PriceExplanation['cost'];
	lead_time: PriceExplanation['lead_time'];
	next_increase: PriceExplanation['next_increase'];
	surcharges: PriceExplanation['surcharges'];
	surcharge_amount: number | null;
	exceptions: Record<string, unknown>[];
	availability: {
		on_hand: number;
		promised_earlier: number;
		free_now: number;
		can_meet: boolean;
		/** False where the part must not be promised at all. */
		can_promise: boolean;
		/** Null where the part must not be promised. */
		earliest_ship: string | null;
		/**
		 * Where the date came from. 'stock' and 'supply' are what available to
		 * promise already said; 'rolled' is the manufacturing model's own
		 * answer; where the date rests on a lead time it says WHICH lead time,
		 * using the `PromiseBasis` vocabulary; 'not promisable' where no date
		 * should be given.
		 */
		earliest_basis: 'stock' | 'supply' | 'rolled' | 'not promisable' | PromiseBasis;
		covering: Record<string, unknown> | null;
		incoming: Record<string, unknown>[];
	};
	/** nl.item_truth() when the manufacturing model is installed, else null. */
	rolled: Record<string, unknown> | null;
	replacement: {
		item_no: string;
		description: string;
		since: string;
		reason: string;
		owner_id: number;
	} | null;
	talking_points: string[];
	/** One or two sentences a person can paste into an email. */
	reply: string[];
}

// ---------------------------------------------------------------------------
// Lead time per vendor and part (migration 0027)
// ---------------------------------------------------------------------------

/**
 * Where a lead time came from, best first. This is the vocabulary that has to
 * appear next to every date the app shows:
 *
 *   observed        the ninetieth percentile of what this vendor has actually
 *                   done on this part
 *   quoted          what the vendor says, because the history is too thin
 *   item card       the part's own ERP date formula
 *   vendor default  the vendor card figure, which covers every part they
 *                   supply and is not a figure for this one
 *   default         the house default for the replenishment method
 *   exception       a published slip has moved the date out past all of those
 */
export type PromiseBasis =
	| 'observed'
	| 'quoted'
	| 'item card'
	| 'vendor default'
	| 'default'
	| 'exception';

/** Whether a vendor can supply a part today. */
export type VendorItemStatus = 'active' | 'allocation' | 'discontinued';

/** One rung of a vendor's own price ladder. */
export interface VendorCostRung {
	minQuantity: number;
	unitCost: number;
	note: string;
}

/**
 * One vendor and part: what they quote against what they do, with everything
 * a buyer needs before placing an order. This is the row that replaces a
 * single lead time figure on a vendor page.
 */
export interface VendorPartLeadTime {
	vendorNo: string;
	itemNo: string;
	description: string;
	family: string;
	/** Whether this is where the part normally comes from. */
	isPrimary: boolean;
	status: VendorItemStatus;
	statusNote: string;
	replacementItemNo: string | null;
	minOrderQty: number;
	orderMultiple: number;
	unitCost: number | null;
	/** Quoted: what they say, and when they said it. */
	quotedLeadDays: number | null;
	quotedOn: string | null;
	quoteReference: string;
	/** Observed: from receipts, never stored. */
	receipts: number;
	medianDays: number | null;
	p90Days: number | null;
	worstDays: number | null;
	lateReceipts: number | null;
	lateShare: number | null;
	worstDaysLate: number | null;
	lastReceived: string | null;
	/**
	 * How far the ninetieth percentile runs past the quote: the days a plan
	 * built on the quote would be short by, one order in ten. Null while there
	 * is no history to compare, which is itself worth showing.
	 */
	tailDays: number | null;
	/** What the app would promise with, and which of the three it used. */
	promiseDays: number;
	promiseBasis: PromiseBasis;
	promiseDetail: string;
	canPromise: boolean;
	/** Whether there are enough receipts for the observed figure to be trusted. */
	historyIsEnough: boolean;
	ladder: VendorCostRung[];
}

/** What `nl.promise_lead_days()` returns for one part. */
export interface PromisedLeadTime {
	itemNo: string;
	leadDays: number;
	basis: PromiseBasis;
	detail: string;
	canPromise: boolean;
	vendorNo: string | null;
	isPrimary: boolean | null;
	receipts: number;
	medianDays: number | null;
	p90Days: number | null;
	worstDays: number | null;
	lateShare: number | null;
	quotedLeadDays: number | null;
	quotedOn: string | null;
	quoteReference: string;
	vendorStatus: VendorItemStatus;
	statusNote: string;
	replacementItemNo: string | null;
	minOrderQty: number;
	orderMultiple: number;
}
