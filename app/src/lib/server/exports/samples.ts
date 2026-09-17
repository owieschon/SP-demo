// Sample export files, made from whichever world the database holds, so the
// workflow can be tried on any copy of the app.
//
// The rows themselves come from the database (nl.sample_open_sales_lines,
// nl.sample_open_purchase_lines, nl.sample_open_production_orders in
// migration 0016), because the seed applies exactly the same rows for
// yesterday and the day before (db/seed.d/40_supply.sql). One generator, two
// callers: that is why uploading yesterday's file on a fresh world is
// recognized as data already loaded, and today's file is a real day's change.
//
// This file only turns those rows into the files a person would have: the
// clean export, the same data after a spreadsheet saved it, a partial one, a
// stale one, and the report people grab by mistake.
import type { SampleKind } from '$lib/components/exports/types';
import type { Tx } from '../db/types.ts';
import { toCsv } from './csv.ts';
import { REPORT_HEADERS } from './reports.ts';
import { cents, excelSerial } from './values.ts';

// Dates as 'YYYY-MM-DD' text, moved in whole days (UTC, so no clock changes).
function addDays(iso: string, days: number): string {
	const date = new Date(`${iso}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' -> 'MM/DD/YYYY', the way the ERP prints dates. */
function usDate(iso: string): string {
	const [y, m, d] = iso.split('-');
	return `${m}/${d}/${y}`;
}

interface SalesLine {
	document_no: string;
	line_no: number;
	customer_no: string;
	item_no: string;
	description: string;
	ship_date: string;
	quantity: number;
	unit_price: number;
	location_code: string;
}

interface PurchaseLine {
	document_no: string;
	line_no: number;
	vendor_no: string;
	item_no: string;
	description: string;
	due_date: string;
	promised_date: string;
	quantity: number;
	location_code: string;
}

interface ProductionOrder {
	order_no: string;
	item_no: string;
	work_center: string;
	status: string;
	due_date: string;
	quantity: number;
}

async function today(tx: Tx): Promise<string> {
	const [row] = await tx.sql<{ today: string }>`select nl.today() as today`;
	return row.today;
}

function salesLines(tx: Tx, day: string): Promise<SalesLine[]> {
	return tx.sql<SalesLine>`select * from nl.sample_open_sales_lines(${day}) order by row_no`;
}

function purchaseLines(tx: Tx, day: string): Promise<PurchaseLine[]> {
	return tx.sql<PurchaseLine>`select * from nl.sample_open_purchase_lines(${day}) order by row_no`;
}

function productionOrders(tx: Tx, day: string): Promise<ProductionOrder[]> {
	return tx.sql<ProductionOrder>`select * from nl.sample_open_production_orders(${day}) order by row_no`;
}

// ---------------------------------------------------------------------------
// The files
// ---------------------------------------------------------------------------

function salesCsv(lines: SalesLine[]): string {
	return toCsv([
		REPORT_HEADERS.open_sales_lines,
		...lines.map((l) => [
			l.document_no,
			l.line_no,
			l.customer_no,
			l.item_no,
			l.description,
			usDate(l.ship_date),
			l.quantity,
			l.unit_price.toFixed(2),
			cents(l.quantity * l.unit_price).toFixed(2),
			l.location_code
		])
	]);
}

function purchaseCsv(lines: PurchaseLine[]): string {
	return toCsv([
		REPORT_HEADERS.open_purchase_lines,
		...lines.map((l) => [
			l.document_no,
			l.line_no,
			l.vendor_no,
			l.item_no,
			l.description,
			usDate(l.due_date),
			usDate(l.promised_date),
			l.quantity,
			l.location_code
		])
	]);
}

function productionCsv(orders: ProductionOrder[]): string {
	return toCsv([
		REPORT_HEADERS.open_production_orders,
		...orders.map((o) => [
			o.order_no,
			o.item_no,
			o.work_center,
			o.status,
			usDate(o.due_date),
			o.quantity
		])
	]);
}

// The invisible first character a spreadsheet writes into a UTF-8 file.
const BOM = String.fromCharCode(0xfeff);

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The same sales lines as a spreadsheet would save them: a byte order mark,
 * the columns in another order plus two the workflow ignores, Excel serial
 * dates for some rows, $ and thousands separators, padded cells, quoted text
 * with commas and quotes in it, and a blank line at the end. Same data, so
 * the same fingerprint as the clean file.
 */
function messyCsv(lines: SalesLine[]): string {
	const header = [
		'Line No.',
		' document no ',
		'Shipment Date',
		'Sell-to Customer No.',
		'Type',
		'No.',
		'Description',
		'Outstanding Quantity',
		'Unit Price Excl. VAT',
		'Line Amount Excl. VAT',
		'Location Code',
		'Reserved Qty. (Base)'
	];
	const rows = lines.map((l, i) => [
		`${l.line_no}`,
		` ${l.document_no}`,
		i % 3 === 0 ? String(excelSerial(l.ship_date)) : i % 3 === 1 ? l.ship_date : usDate(l.ship_date),
		l.customer_no,
		'Item',
		l.item_no,
		l.description,
		`${l.quantity}.00`,
		`$${money.format(l.unit_price)}`,
		money.format(cents(l.quantity * l.unit_price)),
		l.location_code,
		'0'
	]);
	// toCsv quotes the cells that need it (commas, quotes, padding). The byte
	// order mark goes first; the extra line break leaves a blank line at the end.
	return BOM + toCsv([header, ...rows]) + '\r\n';
}

/** A posted sales invoice lines export: the report people grab by mistake. */
async function wrongReportCsv(tx: Tx): Promise<string> {
	const rows = await tx.sql<{
		invoice_no: string;
		line_no: number;
		customer_no: string;
		posted_on: string;
		item_no: string;
		description: string;
		quantity: number;
		unit_price: number;
		amount: number;
	}>`
		select l.invoice_no, l.line_no, l.customer_no, l.posted_on, l.item_no, i.description,
		       l.quantity, l.unit_price, l.amount
		from nl.invoice_lines l
		join nl.items i on i.item_no = l.item_no
		where l.posted_on >= (select nl.today()) - 14
		order by l.posted_on desc, l.invoice_no, l.line_no
		limit 120`;
	return toCsv([
		['Document No.', 'Line No.', 'Sell-to Customer No.', 'Posting Date', 'Type', 'No.', 'Description', 'Quantity', 'Unit Price', 'Amount'],
		...rows.map((r) => [
			r.invoice_no,
			r.line_no,
			r.customer_no,
			usDate(r.posted_on),
			'Item',
			r.item_no,
			r.description,
			r.quantity,
			r.unit_price.toFixed(2),
			r.amount.toFixed(2)
		])
	]);
}

export interface SampleFile {
	fileName: string;
	text: string;
}

/** One sample file for the database's today. */
export async function sampleFile(tx: Tx, kind: SampleKind): Promise<SampleFile> {
	const now = await today(tx);
	const yesterday = addDays(now, -1);

	switch (kind) {
		case 'yesterday':
			return { fileName: `open-sales-lines-${yesterday}.csv`, text: salesCsv(await salesLines(tx, yesterday)) };
		case 'today':
			return { fileName: `open-sales-lines-${now}.csv`, text: salesCsv(await salesLines(tx, now)) };
		case 'purchase-yesterday':
			return {
				fileName: `open-purchase-lines-${yesterday}.csv`,
				text: purchaseCsv(await purchaseLines(tx, yesterday))
			};
		case 'purchase-today':
			return { fileName: `open-purchase-lines-${now}.csv`, text: purchaseCsv(await purchaseLines(tx, now)) };
		case 'production-yesterday':
			return {
				fileName: `open-production-orders-${yesterday}.csv`,
				text: productionCsv(await productionOrders(tx, yesterday))
			};
		case 'production-today':
			return {
				fileName: `open-production-orders-${now}.csv`,
				text: productionCsv(await productionOrders(tx, now))
			};
		case 'messy':
			return { fileName: `open-sales-lines-${now}-messy.csv`, text: messyCsv(await salesLines(tx, now)) };
		case 'partial': {
			// The export stopped a quarter of the way through.
			const lines = await salesLines(tx, now);
			return { fileName: 'partial-export.csv', text: salesCsv(lines.slice(0, Math.floor(lines.length / 4))) };
		}
		case 'stale': {
			// An old export found in a download folder: what was open two months
			// ago, every ship date now in the past.
			const lines = await salesLines(tx, addDays(now, -60));
			return { fileName: 'stale-export.csv', text: salesCsv(lines.filter((l) => l.ship_date < now)) };
		}
		case 'wrong-report':
			return { fileName: 'wrong-report.csv', text: await wrongReportCsv(tx) };
	}
}

/** The names the same files have in fixtures/exports (see app/scripts/exports.ts). */
export const FIXTURE_FILE_NAMES: Record<SampleKind, (today: string) => string> = {
	yesterday: (today) => `open-sales-lines-${addDays(today, -1)}.csv`,
	today: (today) => `open-sales-lines-${today}.csv`,
	'purchase-yesterday': (today) => `open-purchase-lines-${addDays(today, -1)}.csv`,
	'purchase-today': (today) => `open-purchase-lines-${today}.csv`,
	'production-yesterday': (today) => `open-production-orders-${addDays(today, -1)}.csv`,
	'production-today': (today) => `open-production-orders-${today}.csv`,
	messy: () => 'messy-export.csv',
	partial: () => 'partial-export.csv',
	stale: () => 'stale-export.csv',
	'wrong-report': () => 'wrong-report.csv'
};
