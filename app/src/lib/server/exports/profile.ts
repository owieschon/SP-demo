// A source profile describes one ERP report as plain data: which headers
// mean which field, which fields are required, what kind of value each one
// holds, which fields identify a row, and how the ERP writes dates and
// numbers. The reader (reader.ts) takes a profile as an argument, so a
// second report later means a second profile, not new parser code.

/** How a cell is read and checked. */
export type FieldKind =
	| 'text' // trimmed as is
	| 'code' // trimmed and upper-cased (customer, item and document numbers)
	| 'whole' // a whole number; the ERP may print 5 as 5.00
	| 'money'; // a number rounded to cents

export type DateFormat =
	| 'us' // 09/17/2026 or 9/17/2026
	| 'iso' // 2026-09-17
	| 'excel_serial'; // 46282, what a spreadsheet leaves after saving the file

export interface FieldSpec {
	/** The header as the ERP writes it, used in messages. */
	label: string;
	/** Header names that mean this field, in headerKey() form (lowercase letters and digits only). */
	aliases: string[];
	/** A file without this column is refused. */
	required: boolean;
	kind: FieldKind | 'date';
	/** A blank cell is allowed (and read as null). Required columns can still hold optional values. */
	blankAllowed?: boolean;
	/** The value must be greater than this. */
	above?: number;
	/** The value may not be below this. */
	atLeast?: number;
	/** The value may not be above this. */
	atMost?: number;
	maxLength?: number;
}

export interface NumberFormat {
	thousands: string; // ',' in 1,234.50
	decimal: string; // '.' in 1,234.50
	currency: string; // '$', allowed in front of the digits
	/** Accountants write -12 as (12.00). */
	parenthesesNegative: boolean;
}

export interface SourceProfile {
	/** Stored with every fingerprint, so two reports never share one. */
	id: string;
	/** What people call it, for messages. */
	name: string;
	fields: Record<string, FieldSpec>;
	/** The fields that identify a row (its natural key), in sort order. */
	key: string[];
	dates: DateFormat[];
	numbers: NumberFormat;
	/** Reports people upload by mistake, recognized by a few headers each. */
	otherReports: { name: string; keys: string[] }[];
}

export const US_NUMBERS: NumberFormat = {
	thousands: ',',
	decimal: '.',
	currency: '$',
	parenthesesNegative: true
};

/** The ERP's "open sales lines" export: every order line not yet shipped. */
export const OPEN_SALES_LINES_PROFILE = {
	id: 'open_sales_lines',
	name: 'open sales lines export',
	fields: {
		documentNo: {
			label: 'Document No.',
			aliases: ['documentno', 'documentnumber', 'orderno'],
			required: true,
			kind: 'code',
			maxLength: 40
		},
		lineNo: {
			label: 'Line No.',
			aliases: ['lineno', 'linenumber'],
			required: true,
			kind: 'whole',
			above: 0,
			atMost: 2_000_000_000
		},
		customerNo: {
			label: 'Sell-to Customer No.',
			aliases: ['selltocustomerno', 'selltocustno', 'customerno'],
			required: true,
			kind: 'code',
			maxLength: 40
		},
		itemNo: { label: 'No.', aliases: ['no', 'itemno', 'itemnumber'], required: true, kind: 'code', maxLength: 40 },
		description: { label: 'Description', aliases: ['description'], required: false, kind: 'text', maxLength: 200 },
		shipDate: { label: 'Shipment Date', aliases: ['shipmentdate', 'shipdate'], required: true, kind: 'date' },
		quantity: {
			label: 'Outstanding Quantity',
			aliases: ['outstandingquantity', 'outstandingqty', 'qtyoutstanding'],
			required: true,
			kind: 'whole',
			above: 0,
			atMost: 1_000_000
		},
		unitPrice: {
			label: 'Unit Price',
			aliases: ['unitprice', 'unitpriceexclvat'],
			required: true,
			kind: 'money',
			atLeast: 0,
			atMost: 10_000_000
		},
		lineAmount: {
			label: 'Line Amount',
			aliases: ['lineamount', 'lineamountexclvat'],
			required: false,
			kind: 'money',
			blankAllowed: true,
			atMost: 1_000_000_000
		},
		locationCode: {
			label: 'Location Code',
			aliases: ['locationcode', 'location'],
			required: false,
			kind: 'code',
			maxLength: 20
		}
	},
	key: ['documentNo', 'lineNo'],
	dates: ['us', 'iso', 'excel_serial'],
	numbers: US_NUMBERS,
	otherReports: [
		{ name: 'a posted sales invoice lines export', keys: ['postingdate', 'documentno', 'quantity'] },
		{ name: 'a posted sales invoices export', keys: ['postingdate', 'no', 'amount'] },
		{ name: 'a customer list', keys: ['no', 'name', 'city'] },
		{ name: 'an item list', keys: ['no', 'description', 'inventory'] },
		{ name: 'a sales order list (headers only, no lines)', keys: ['no', 'selltocustomerno', 'orderdate'] }
	]
} satisfies SourceProfile;

/**
 * The ERP's "open purchase lines" export: every part still outstanding on a
 * purchase order. Expected Receipt Date is what the vendor says now; Promised
 * Receipt Date is what they said when the order was placed, so a date that
 * moved can be seen without any history.
 */
export const OPEN_PURCHASE_LINES_PROFILE = {
	id: 'open_purchase_lines',
	name: 'open purchase lines export',
	fields: {
		documentNo: {
			label: 'Document No.',
			aliases: ['documentno', 'documentnumber', 'purchaseorderno', 'orderno'],
			required: true,
			kind: 'code',
			maxLength: 40
		},
		lineNo: {
			label: 'Line No.',
			aliases: ['lineno', 'linenumber'],
			required: true,
			kind: 'whole',
			above: 0,
			atMost: 2_000_000_000
		},
		vendorNo: {
			label: 'Buy-from Vendor No.',
			aliases: ['buyfromvendorno', 'buyfromvendor', 'vendorno', 'paytovendorno'],
			required: true,
			kind: 'code',
			maxLength: 40
		},
		itemNo: { label: 'No.', aliases: ['no', 'itemno', 'itemnumber'], required: true, kind: 'code', maxLength: 40 },
		description: { label: 'Description', aliases: ['description'], required: false, kind: 'text', maxLength: 200 },
		dueDate: {
			label: 'Expected Receipt Date',
			aliases: ['expectedreceiptdate', 'expectedreceipt', 'duedate'],
			required: true,
			kind: 'date'
		},
		promisedDate: {
			label: 'Promised Receipt Date',
			aliases: ['promisedreceiptdate', 'promisedreceipt', 'orderdate'],
			required: false,
			kind: 'date',
			blankAllowed: true
		},
		quantity: {
			label: 'Outstanding Quantity',
			aliases: ['outstandingquantity', 'outstandingqty', 'qtyoutstanding'],
			required: true,
			kind: 'whole',
			above: 0,
			atMost: 1_000_000
		},
		locationCode: {
			label: 'Location Code',
			aliases: ['locationcode', 'location'],
			required: false,
			kind: 'code',
			maxLength: 20
		}
	},
	key: ['documentNo', 'lineNo'],
	dates: ['us', 'iso', 'excel_serial'],
	numbers: US_NUMBERS,
	otherReports: [
		{ name: 'a posted purchase receipt lines export', keys: ['postingdate', 'documentno', 'quantity'] },
		{ name: 'a vendor list', keys: ['no', 'name', 'city'] }
	]
} satisfies SourceProfile;

/**
 * The ERP's "open production orders" export: what the shop floor still owes.
 * One row per order, with the work center it runs on and the quantity left.
 */
export const OPEN_PRODUCTION_ORDERS_PROFILE = {
	id: 'open_production_orders',
	name: 'open production orders export',
	fields: {
		orderNo: {
			label: 'Prod. Order No.',
			aliases: ['prodorderno', 'productionorderno', 'prodordernumber', 'orderno'],
			required: true,
			kind: 'code',
			maxLength: 40
		},
		itemNo: {
			label: 'Source No.',
			aliases: ['sourceno', 'itemno', 'no', 'itemnumber'],
			required: true,
			kind: 'code',
			maxLength: 40
		},
		workCenter: {
			label: 'Work Center No.',
			aliases: ['workcenterno', 'workcenter', 'workcentergroupcode', 'routingno'],
			required: true,
			kind: 'code',
			maxLength: 20
		},
		status: { label: 'Status', aliases: ['status'], required: false, kind: 'text', maxLength: 20 },
		dueDate: {
			label: 'Due Date',
			aliases: ['duedate', 'endingdate'],
			required: true,
			kind: 'date'
		},
		quantity: {
			label: 'Remaining Quantity',
			aliases: ['remainingquantity', 'remainingqty', 'quantityremaining'],
			required: true,
			kind: 'whole',
			above: 0,
			atMost: 1_000_000
		}
	},
	key: ['orderNo'],
	dates: ['us', 'iso', 'excel_serial'],
	numbers: US_NUMBERS,
	otherReports: [
		{ name: 'a production order line list', keys: ['prodorderno', 'linenoo', 'quantity'] },
		{ name: 'a work center list', keys: ['no', 'name', 'capacity'] }
	]
} satisfies SourceProfile;

/**
 * The three reports the workflow knows, in the order a file is compared with
 * them. The reader works out which one an uploaded file is (reader.ts,
 * detectReport) and refuses a file that is none of them.
 */
export const PROFILES: SourceProfile[] = [
	OPEN_SALES_LINES_PROFILE,
	OPEN_PURCHASE_LINES_PROFILE,
	OPEN_PRODUCTION_ORDERS_PROFILE
];

/** The header row of a correct file, in the profile's order. */
export function headersOf(profile: SourceProfile): string[] {
	return Object.values(profile.fields).map((f) => f.label);
}
