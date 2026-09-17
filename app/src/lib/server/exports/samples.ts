// Sample export files, made from whichever world the database holds, so the
// workflow can be tried on any copy of the app. The same world and the same
// day always give byte-identical files: every random choice is a hash of a
// label (like the world generator's keyed draws), never Math.random().
//
// The model: every weekday some orders are entered. Each order has a few
// lines, and ships on a promised date some days later. Most orders leave on
// that date; some run late. An order is in the "open lines" export of day D
// when it was entered by D and has not left yet. Because an order's facts
// depend only on its own labels, not on D, yesterday's file and today's file
// describe the same orders: today's has lost the ones that shipped, gained
// the ones entered today, and shows the few lines changed today.
import { createHash } from 'node:crypto';
import type { SampleKind } from '$lib/components/exports/types';
import type { Tx } from '../db/types.ts';
import { toCsv } from './csv.ts';
import { OPEN_LINES_HEADERS } from './openLines.ts';
import { cents, excelSerial } from './values.ts';

/** A number in [0, 1) from a label: the same label, the same number, everywhere. */
function draw(label: string): number {
	const hash = createHash('sha256').update(label).digest();
	// 48 bits is plenty and stays an exact JavaScript number.
	return hash.readUIntBE(0, 6) / 2 ** 48;
}

function between(min: number, max: number, label: string): number {
	return min + Math.floor(draw(label) * (max - min + 1));
}

function pick<T>(list: readonly T[], label: string): T {
	return list[Math.floor(draw(label) * list.length)];
}

// Dates as 'YYYY-MM-DD' text, moved in whole days (UTC, so no clock changes).
function addDays(iso: string, days: number): string {
	const date = new Date(`${iso}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function isWeekend(iso: string): boolean {
	const weekday = new Date(`${iso}T00:00:00Z`).getUTCDay();
	return weekday === 0 || weekday === 6;
}

/** The next weekday on or after a date: the warehouse does not ship on weekends. */
function weekdayFrom(iso: string): string {
	let day = iso;
	while (isWeekend(day)) day = addDays(day, 1);
	return day;
}

/** 'YYYY-MM-DD' -> 'MM/DD/YYYY', the way the ERP prints dates. */
function usDate(iso: string): string {
	const [y, m, d] = iso.split('-');
	return `${m}/${d}/${y}`;
}

interface BookCustomer {
	customerNo: string;
	discount: number;
	items: { itemNo: string; description: string; family: string; listPrice: number }[];
}

interface SampleLine {
	documentNo: string;
	lineNo: number;
	customerNo: string;
	itemNo: string;
	description: string;
	shipDate: string;
	quantity: number;
	unitPrice: number;
	locationCode: string;
}

/**
 * Customers who bought in the last six months and can still order, with the
 * parts each one bought in the last year. Sorted, so picks are stable.
 */
async function loadBook(tx: Tx): Promise<{ today: string; customers: BookCustomer[] }> {
	const rows = await tx.sql<{
		today: string;
		customer_no: string;
		discount: number;
		items: { item_no: string; description: string; family: string; list_price: number }[];
	}>`
		with recent as (
			select distinct i.customer_no
			from nl.invoices i
			where i.posted_on >= (select nl.today()) - 180 and i.doc_type = 'invoice'
		)
		select (select nl.today()) as today, c.customer_no, pg.discount,
		       (select jsonb_agg(jsonb_build_object('item_no', it.item_no, 'description', it.description,
		                                            'family', it.family, 'list_price', it.list_price)
		                         order by it.item_no)
		        from nl.items it
		        where not it.blocked and it.list_price > 0
		          and it.item_no in (select l.item_no from nl.invoice_lines l
		                             where l.customer_no = c.customer_no
		                               and l.posted_on >= (select nl.today()) - 365
		                               and l.quantity > 0)) as items
		from nl.customers c
		join recent r on r.customer_no = c.customer_no
		join nl.price_groups pg on pg.code = c.price_group
		where not c.blocked and not c.closed
		order by c.customer_no`;
	return {
		today: rows[0]?.today ?? '',
		customers: rows
			.filter((r) => r.items && r.items.length > 0)
			.map((r) => ({
				customerNo: r.customer_no,
				discount: r.discount,
				items: r.items.map((i) => ({
					itemNo: i.item_no,
					description: i.description,
					family: i.family,
					listPrice: i.list_price
				}))
			}))
	};
}

// How many pieces a line asks for, by kind of part.
const QUANTITY_RANGE: Record<string, [number, number]> = {
	clamp: [10, 100],
	bracket: [4, 40],
	flex: [2, 20],
	pipe: [2, 24],
	raw: [5, 50],
	elbow: [1, 8],
	stack: [1, 6],
	muffler: [1, 6],
	shield: [1, 8],
	kit: [1, 3],
	proprietary: [1, 10],
	custom: [1, 4]
};

const HISTORY_DAYS = 150; // late orders can stay open this long
const LINES_PER_CUSTOMER = 3; // open lines per recently active customer
const MIN_LINES = 60;
const MAX_LINES = 1500;

/**
 * Every order line open on the given day. Orders are keyed by the day they
 * were entered and their number that day, so the same order has the same
 * customer, parts and dates whichever day is asked about.
 */
function openLinesOn(day: string, customers: BookCustomer[], anchor: string): SampleLine[] {
	if (customers.length === 0) return [];
	// The book's size sets the order rate: about three open lines per active
	// customer, with orders open about 25 days on average and 2.5 lines each.
	const targetLines = Math.min(MAX_LINES, Math.max(MIN_LINES, customers.length * LINES_PER_CUSTOMER));
	const ordersPerDay = targetLines / (2.5 * 25) / (5 / 7);

	const lines: SampleLine[] = [];
	for (let back = HISTORY_DAYS; back >= 0; back--) {
		const entered = addDays(day, -back);
		if (isWeekend(entered)) continue;
		// A whole number of orders per day: the fraction decides one more or not.
		const count = Math.floor(ordersPerDay) + (draw(`orders|${entered}`) < ordersPerDay % 1 ? 1 : 0);

		for (let n = 1; n <= count; n++) {
			const key = `order|${entered}|${n}`;
			// Document numbers grow with the entry date, as the ERP's do.
			const dayIndex = Math.round((Date.parse(entered) - Date.parse(anchor)) / 86_400_000);
			const documentNo = `SO${String(300000 + dayIndex * 100 + n).padStart(6, '0')}`;
			const customer = pick(customers, `${key}|customer`);
			let promised = weekdayFrom(addDays(entered, between(3, 45, `${key}|lead`)));

			// One order in five is pushed out a few days before it was due to
			// ship; from that day on, every file shows the new date. The push is
			// always decided before the old date, so an earlier file never
			// thinks the order already left.
			if (draw(`${key}|push`) < 0.2) {
				const pushedOn = addDays(promised, -between(1, 3, `${key}|push.day`));
				if (pushedOn <= day) {
					promised = weekdayFrom(addDays(promised, between(3, 14, `${key}|push.days`)));
				}
			}

			// One order in six runs late, by up to three weeks.
			const late = draw(`${key}|late`) < 1 / 6 ? between(2, 21, `${key}|late.days`) : 0;
			const leaves = addDays(promised, late);
			// Open on `day` when it was entered by then and has not left before it.
			if (leaves < day) continue;

			const lineCount = between(1, 4, `${key}|lines`);
			const used = new Set<string>();
			for (let l = 1; l <= lineCount; l++) {
				const item = pick(customer.items, `${key}|${l}|item`);
				if (used.has(item.itemNo)) continue;
				used.add(item.itemNo);
				const [lo, hi] = QUANTITY_RANGE[item.family] ?? [1, 10];
				let quantity = between(lo, hi, `${key}|${l}|qty`);

				// Buyers change quantities in the first days after ordering. From
				// the day of the change on, every file shows the new quantity.
				const changedOn = addDays(entered, between(1, 3, `${key}|${l}|change.day`));
				if (changedOn <= day && draw(`${key}|${l}|change`) < 0.3) {
					quantity = Math.max(1, quantity + between(-3, 6, `${key}|${l}|change.qty`));
				}

				lines.push({
					documentNo,
					lineNo: l * 10000,
					customerNo: customer.customerNo,
					itemNo: item.itemNo,
					description: item.description,
					shipDate: promised,
					quantity,
					unitPrice: cents(item.listPrice * (1 - customer.discount)),
					locationCode: draw(`${key}|loc`) < 0.8 ? 'MAIN' : 'EAST'
				});
			}
		}
	}
	return lines.sort((a, b) => (a.documentNo < b.documentNo ? -1 : a.documentNo > b.documentNo ? 1 : a.lineNo - b.lineNo));
}

function cleanRows(lines: SampleLine[]): (string | number)[][] {
	return [
		OPEN_LINES_HEADERS,
		...lines.map((l) => [
			l.documentNo,
			l.lineNo,
			l.customerNo,
			l.itemNo,
			l.description,
			usDate(l.shipDate),
			l.quantity,
			l.unitPrice.toFixed(2),
			cents(l.quantity * l.unitPrice).toFixed(2),
			l.locationCode
		])
	];
}

// The invisible first character a spreadsheet writes into a UTF-8 file.
const BOM = String.fromCharCode(0xfeff);

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * The same lines as a spreadsheet would save them: a byte order mark, the
 * columns in another order plus two the workflow ignores, Excel serial dates
 * for some rows, $ and thousands separators, padded cells, quoted text
 * with commas and quotes in it, and a blank line at the end. Same data, so
 * the same fingerprint as the clean file.
 */
function messyCsv(lines: SampleLine[]): string {
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
		`${l.lineNo}`,
		` ${l.documentNo}`,
		i % 3 === 0 ? String(excelSerial(l.shipDate)) : i % 3 === 1 ? l.shipDate : usDate(l.shipDate),
		l.customerNo,
		'Item',
		l.itemNo,
		l.description,
		`${l.quantity}.00`,
		`$${money.format(l.unitPrice)}`,
		money.format(cents(l.quantity * l.unitPrice)),
		l.locationCode,
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

/**
 * One sample file for the database's today. The first line of a few orders
 * gets a description with a comma and quotes, in every kind, so the clean
 * and messy files carry the same data.
 */
export async function sampleFile(tx: Tx, kind: SampleKind): Promise<SampleFile> {
	const { today, customers } = await loadBook(tx);
	// Document numbers count from a fixed day, so they never depend on "today".
	const anchor = '2020-01-01';
	const yesterday = addDays(today, -1);
	const decorate = (lines: SampleLine[]) =>
		lines.map((l) =>
			l.lineNo === 10000 && draw(`note|${l.documentNo}`) < 0.1
				? { ...l, description: `${l.description}, "EXPEDITE" per buyer` }
				: l
		);
	const todays = () => decorate(openLinesOn(today, customers, anchor));

	switch (kind) {
		case 'yesterday':
			return {
				fileName: `open-sales-lines-${yesterday}.csv`,
				text: toCsv(cleanRows(decorate(openLinesOn(yesterday, customers, anchor))))
			};
		case 'today':
			return { fileName: `open-sales-lines-${today}.csv`, text: toCsv(cleanRows(todays())) };
		case 'messy':
			return { fileName: `open-sales-lines-${today}-messy.csv`, text: messyCsv(todays()) };
		case 'partial': {
			// The export stopped a quarter of the way through.
			const lines = todays();
			return { fileName: 'partial-export.csv', text: toCsv(cleanRows(lines.slice(0, Math.floor(lines.length / 4)))) };
		}
		case 'stale': {
			// An old export found in a download folder: what was open two months
			// ago, every ship date now in the past.
			const lines = decorate(openLinesOn(addDays(today, -60), customers, anchor)).filter((l) => l.shipDate < today);
			return { fileName: 'stale-export.csv', text: toCsv(cleanRows(lines)) };
		}
		case 'wrong-report':
			return { fileName: 'wrong-report.csv', text: await wrongReportCsv(tx) };
	}
}

export const FIXTURE_FILE_NAMES: Record<SampleKind, (today: string) => string> = {
	yesterday: (today) => `open-sales-lines-${addDays(today, -1)}.csv`,
	today: (today) => `open-sales-lines-${today}.csv`,
	messy: () => 'messy-export.csv',
	partial: () => 'partial-export.csv',
	stale: () => 'stale-export.csv',
	'wrong-report': () => 'wrong-report.csv'
};
