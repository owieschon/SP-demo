// The three ERP reports the morning import knows, as typed rows.
//
// All the reading rules live in the profiles (profile.ts) and the generic
// reader (reader.ts). This file only says which of the three a file turned
// out to be and gives its rows names and types, the way openLines.ts does
// for the sales export on its own.
import type { ExportKind, Refusal } from '$lib/components/exports/types';
import type { OpenLine } from './openLines.ts';
import {
	headersOf,
	OPEN_PRODUCTION_ORDERS_PROFILE,
	OPEN_PURCHASE_LINES_PROFILE,
	OPEN_SALES_LINES_PROFILE,
	PROFILES
} from './profile.ts';
import { detectReport, type ReadRow, type RowProblem } from './reader.ts';

export type { RowProblem } from './reader.ts';

/** A purchase order line that passed every check the file can make on its own. */
export interface PurchaseLine {
	rowNo: number;
	documentNo: string;
	lineNo: number;
	vendorNo: string;
	itemNo: string;
	description: string;
	dueDate: string;
	/** What the vendor promised first. Blank in some exports. */
	promisedDate: string | null;
	quantity: number;
	locationCode: string;
}

/** A production order that passed every check the file can make on its own. */
export interface ProductionOrder {
	rowNo: number;
	orderNo: string;
	itemNo: string;
	workCenter: string;
	status: string;
	dueDate: string;
	quantity: number;
}

/** What a file held, once the reader worked out which report it is. */
export type ReportFile = {
	fileName: string;
	hash: string;
	rowCount: number;
	problems: RowProblem[];
	ignoredColumns: string[];
} & (
	| { kind: 'open_sales_lines'; salesLines: OpenLine[] }
	| { kind: 'open_purchase_lines'; purchaseLines: PurchaseLine[] }
	| { kind: 'open_production_orders'; productionOrders: ProductionOrder[] }
);

export type ReportResult = { ok: true; file: ReportFile } | { ok: false; refusal: Refusal };

/** What people call each report, for messages and for the review panel. */
export const REPORT_NAME: Record<ExportKind, string> = {
	open_sales_lines: OPEN_SALES_LINES_PROFILE.name,
	open_purchase_lines: OPEN_PURCHASE_LINES_PROFILE.name,
	open_production_orders: OPEN_PRODUCTION_ORDERS_PROFILE.name
};

/** The header row of a correct file of each report, in the ERP's order. */
export const REPORT_HEADERS: Record<ExportKind, string[]> = {
	open_sales_lines: headersOf(OPEN_SALES_LINES_PROFILE),
	open_purchase_lines: headersOf(OPEN_PURCHASE_LINES_PROFILE),
	open_production_orders: headersOf(OPEN_PRODUCTION_ORDERS_PROFILE)
};

/**
 * Read an uploaded file: work out which of the three reports it is, or refuse
 * it. The reader has already checked every value against the profile, so the
 * casts below only name what is there.
 */
export function readReport(fileName: string, text: string): ReportResult {
	const read = detectReport(PROFILES, fileName, text);
	if (!read.ok) return read;

	const { rows, ...rest } = read.file;
	const kind = read.profile.id as ExportKind;
	if (kind === 'open_purchase_lines') {
		return { ok: true, file: { ...rest, kind, purchaseLines: rows.map(toPurchaseLine) } };
	}
	if (kind === 'open_production_orders') {
		return { ok: true, file: { ...rest, kind, productionOrders: rows.map(toProductionOrder) } };
	}
	return { ok: true, file: { ...rest, kind: 'open_sales_lines', salesLines: rows.map(toSalesLine) } };
}

function toSalesLine({ rowNo, values: v }: ReadRow): OpenLine {
	return {
		rowNo,
		documentNo: v.documentNo as string,
		lineNo: v.lineNo as number,
		customerNo: v.customerNo as string,
		itemNo: v.itemNo as string,
		description: v.description as string,
		shipDate: v.shipDate as string,
		quantity: v.quantity as number,
		unitPrice: v.unitPrice as number,
		lineAmount: v.lineAmount as number | null,
		locationCode: v.locationCode as string
	};
}

function toPurchaseLine({ rowNo, values: v }: ReadRow): PurchaseLine {
	return {
		rowNo,
		documentNo: v.documentNo as string,
		lineNo: v.lineNo as number,
		vendorNo: v.vendorNo as string,
		itemNo: v.itemNo as string,
		description: v.description as string,
		dueDate: v.dueDate as string,
		promisedDate: (v.promisedDate as string) || null,
		quantity: v.quantity as number,
		locationCode: v.locationCode as string
	};
}

function toProductionOrder({ rowNo, values: v }: ReadRow): ProductionOrder {
	return {
		rowNo,
		orderNo: v.orderNo as string,
		itemNo: v.itemNo as string,
		workCenter: v.workCenter as string,
		status: v.status as string,
		dueDate: v.dueDate as string,
		quantity: v.quantity as number
	};
}

/** A good purchase line back in the file's words, for a row that turns out to be a problem. */
export function describePurchaseLine(line: PurchaseLine): Record<string, string> {
	const f = OPEN_PURCHASE_LINES_PROFILE.fields;
	return {
		[f.documentNo.label]: line.documentNo,
		[f.lineNo.label]: String(line.lineNo),
		[f.vendorNo.label]: line.vendorNo,
		[f.itemNo.label]: line.itemNo,
		[f.description.label]: line.description,
		[f.dueDate.label]: line.dueDate,
		[f.promisedDate.label]: line.promisedDate ?? '',
		[f.quantity.label]: String(line.quantity),
		[f.locationCode.label]: line.locationCode
	};
}

/** The same for a production order. */
export function describeProductionOrder(order: ProductionOrder): Record<string, string> {
	const f = OPEN_PRODUCTION_ORDERS_PROFILE.fields;
	return {
		[f.orderNo.label]: order.orderNo,
		[f.itemNo.label]: order.itemNo,
		[f.workCenter.label]: order.workCenter,
		[f.status.label]: order.status,
		[f.dueDate.label]: order.dueDate,
		[f.quantity.label]: String(order.quantity)
	};
}
