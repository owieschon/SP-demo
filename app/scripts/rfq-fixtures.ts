// Build the sample request files in fixtures/rfq/.
//
//   node scripts/rfq-fixtures.ts        (from app/)
//
// The files are committed, so the tests do not run this. It exists so they
// can be rebuilt, changed and explained: a fixture nobody can regenerate is
// a fixture nobody trusts.
//
// What it writes:
//   emailed-spreadsheet-request.xlsx  three sheets, a header merged over two
//                                     rows, real date cells, a stated total
//   emailed-spreadsheet-request.txt   the same request written out as text,
//                                     so a test can prove both read the same
//   pdf-request.pdf                   a two-page printed purchase order
//   parts-list.csv                    a parts list with a preamble and a note
//   scanned-request.pdf               one page holding an image and no text,
//                                     which must be refused
//
// Every customer, contact and part named here exists in the eval world
// (evals/rfq/world.json), and the prices are worked out from that world's
// list prices and the customer's price group, so the figures in the files
// are the figures the app would quote.
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PDFDocument, StandardFonts, rgb, type PDFPage } from 'pdf-lib';
import * as XLSX from 'xlsx';
import { toCsv } from '../src/lib/server/exports/csv.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUT = join(ROOT, 'fixtures', 'rfq');

interface World {
	items: { item_no: string; description: string; list_price: number }[];
}

const world = JSON.parse(readFileSync(join(ROOT, 'evals', 'rfq', 'world.json'), 'utf8')) as World;
const catalog = new Map(world.items.map((item) => [item.item_no, item]));

function item(itemNo: string): { description: string; listPrice: number } {
	const found = catalog.get(itemNo);
	if (!found) throw new Error(`${itemNo} is not in evals/rfq/world.json; pick a part that exists.`);
	return { description: found.description.toLowerCase(), listPrice: found.list_price };
}

/** What this customer pays: list less their price group's discount. */
function netPrice(itemNo: string, discount: number): number {
	return Math.round(item(itemNo).listPrice * (1 - discount) * 100) / 100;
}

// The discounts these price groups give (db/seed.sql).
const ELITE = 0.5;
const MASTER = 0.57;

interface Ask {
	itemNo: string;
	quantity: number;
	neededBy: string;
}

interface Line extends Ask {
	description: string;
	unitPrice: number;
}

function priced(asks: Ask[], discount: number): Line[] {
	return asks.map((ask) => ({
		...ask,
		description: item(ask.itemNo).description,
		unitPrice: netPrice(ask.itemNo, discount)
	}));
}

const money = (value: number) => value.toFixed(2);
const totalOf = (lines: Line[]) =>
	lines.reduce((sum, line) => sum + Math.round(line.unitPrice * 100) * line.quantity, 0) / 100;

// ---------------------------------------------------------------------------
// The three requests
// ---------------------------------------------------------------------------

/** Coastal Parts Depot (account 10072, Houston TX, Elite), Cameron Kowalski. */
const SPREADSHEET = priced(
	[
		{ itemNo: 'S6-96BC', quantity: 4, neededBy: '2026-10-09' },
		{ itemNo: 'CL6SZ', quantity: 12, neededBy: '2026-10-09' },
		{ itemNo: 'FL6-36SS', quantity: 2, neededBy: '2026-10-16' },
		{ itemNo: 'L660-1018SC', quantity: 6, neededBy: '2026-10-16' },
		{ itemNo: 'HS6-30S', quantity: 3, neededBy: '2026-10-16' }
	],
	ELITE
);

/** Driftless Machine & Fab (account 10012, Charleston WV), Micah Crowley. */
const CSV_ASKS: Ask[] = [
	{ itemNo: 'P6-60CX', quantity: 10, neededBy: '2026-10-02' },
	{ itemNo: 'CL7BZ', quantity: 24, neededBy: '2026-10-02' },
	{ itemNo: 'HS8-36C', quantity: 3, neededBy: '2026-10-23' }
];

/** Canyon Parts Warehouse (account 10146, Greenville SC, Master), Parker Reyes. */
const PDF_PAGE_ONE = priced(
	[
		{ itemNo: 'S7-96SA', quantity: 2, neededBy: '2026-10-12' },
		{ itemNo: 'S8-36BS', quantity: 4, neededBy: '2026-10-12' },
		{ itemNo: 'M-4164', quantity: 1, neededBy: '2026-10-12' },
		{ itemNo: 'RBRC10B3', quantity: 6, neededBy: '2026-10-12' },
		{ itemNo: 'CL4WZ', quantity: 18, neededBy: '2026-10-12' }
	],
	MASTER
);

const PDF_PAGE_TWO = priced(
	[
		{ itemNo: 'L490-810C', quantity: 5, neededBy: '2026-10-30' },
		{ itemNo: 'FL5-14SS', quantity: 3, neededBy: '2026-10-30' },
		{ itemNo: 'HS5-30C', quantity: 4, neededBy: '2026-10-30' }
	],
	MASTER
);

// ---------------------------------------------------------------------------
// The spreadsheet
// ---------------------------------------------------------------------------

/** The number Excel stores for a date: whole days since 1899-12-30. */
function serialOf(iso: string): number {
	const ms = Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30);
	return Math.round(ms / 86400000);
}

type DateCell = { date: string };
type Cell = string | number | null | DateCell;

const isDateCell = (cell: Cell): cell is DateCell => cell !== null && typeof cell === 'object';

function sheetOf(rows: Cell[][]): XLSX.WorkSheet {
	// aoa_to_sheet writes plain values, then the date cells are written over
	// it with a date number format. That format is the only thing that makes
	// 46314 a date rather than a price, in Excel and in the reader.
	const plain = rows.map((row) => row.map((cell) => (isDateCell(cell) ? serialOf(cell.date) : cell)));
	const sheet = XLSX.utils.aoa_to_sheet(plain);
	rows.forEach((row, r) => {
		row.forEach((cell, c) => {
			if (isDateCell(cell)) {
				sheet[XLSX.utils.encode_cell({ r, c })] = { t: 'n', v: serialOf(cell.date), z: 'mm/dd/yyyy' };
			}
		});
	});
	return sheet;
}

function writeSpreadsheet(): void {
	const book = XLSX.utils.book_new();

	XLSX.utils.book_append_sheet(
		book,
		sheetOf([
			['Coastal Parts Depot'],
			['Purchasing, Houston TX'],
			[],
			['Northline quote request'],
			['Prepared by Cameron Kowalski, cameron.kowalski@coastalpartsdepot.example'],
			['Please quote the parts on the Quote Request sheet. Two builds, dates on the sheet.']
		]),
		'Cover'
	);

	// A title across the top, and a header split over two rows: "Quantity" is
	// merged down C3:C4, which is how a person makes a header look tidy and
	// exactly what a reader has to cope with.
	const rows: Cell[][] = [
		['Quote request 2026-09-16', null, null, null, null],
		[null, null, null, null, null],
		[null, null, 'Quantity', null, null],
		['Item No', 'Description', null, 'Unit price', 'Need by']
	];
	for (const line of SPREADSHEET) {
		rows.push([line.itemNo, line.description, line.quantity, line.unitPrice, { date: line.neededBy }]);
	}
	rows.push([null, null, null, 'Total', totalOf(SPREADSHEET)]);

	const quote = sheetOf(rows);
	quote['!merges'] = [XLSX.utils.decode_range('A1:E1'), XLSX.utils.decode_range('C3:C4')];
	XLSX.utils.book_append_sheet(book, quote, 'Quote Request');

	XLSX.utils.book_append_sheet(
		book,
		sheetOf([
			['Shipping'],
			['Ship to our Houston counter, dock hours 7 to 3.'],
			['Our carrier account, freight collect.'],
			['Call Cameron at (713) 555-0148 before the truck leaves.']
		]),
		'Shipping'
	);

	writeFileSync(join(OUT, 'emailed-spreadsheet-request.xlsx'), XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}

/** The same request as plain text, for the test that compares the two. */
function writeSpreadsheetTwin(): void {
	const text = [
		'Item No | Description | Quantity | Unit price | Need by',
		...SPREADSHEET.map(
			(line) =>
				`${line.itemNo} | ${line.description} | ${line.quantity} | ${money(line.unitPrice)} | ${line.neededBy}`
		),
		`Total | | | | ${money(totalOf(SPREADSHEET))}`,
		''
	].join('\n');
	writeFileSync(join(OUT, 'emailed-spreadsheet-request.txt'), text, 'utf8');
}

// ---------------------------------------------------------------------------
// The CSV: a parts list, with no prices on it
// ---------------------------------------------------------------------------

function writeCsv(): void {
	// toCsv quotes and escapes what needs it. The descriptions are full of
	// inch marks, and a double quote inside a quoted field has to be doubled,
	// which is exactly the sort of thing to get wrong by hand.
	const rows: (string | number | null)[][] = [
		['Driftless Machine & Fab', null, null, null, null],
		['Parts list for Northline', null, null, null, null],
		[null, null, null, null, null],
		['Part Number', 'Description', 'Qty', 'UOM', 'Need By'],
		...CSV_ASKS.map((ask) => [ask.itemNo, item(ask.itemNo).description, ask.quantity, 'ea', ask.neededBy]),
		[null, null, null, null, null],
		['Notes', 'Hold for one release, call Micah first', null, null, null]
	];
	writeFileSync(join(OUT, 'parts-list.csv'), toCsv(rows), 'utf8');
}

// ---------------------------------------------------------------------------
// The PDFs
// ---------------------------------------------------------------------------

const PAGE = { width: 612, height: 792 };
const MARGIN = 54;
/** Where each column of the printed purchase order starts. */
const COLUMNS = { line: 0, item: 30, description: 120, qty: 330, price: 380, needBy: 460 };

async function writePdfRequest(): Promise<void> {
	const pdf = await PDFDocument.create();
	const regular = await pdf.embedFont(StandardFonts.Helvetica);
	const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
	const ink = rgb(0.1, 0.11, 0.12);
	const grey = rgb(0.45, 0.46, 0.48);

	pdf.setTitle('Purchase order 88214 (invented sample)');
	pdf.setAuthor('Canyon Parts Warehouse (invented)');

	const drawTable = (page: PDFPage, startY: number, lines: Line[], firstLineNo: number): number => {
		let y = startY;
		const header: [string, number][] = [
			['Line', COLUMNS.line],
			['Item No', COLUMNS.item],
			['Description', COLUMNS.description],
			['Qty', COLUMNS.qty],
			['Unit Price', COLUMNS.price],
			['Need By', COLUMNS.needBy]
		];
		for (const [label, x] of header) {
			page.drawText(label, { x: MARGIN + x, y, size: 8.5, font: bold, color: grey });
		}
		page.drawLine({
			start: { x: MARGIN, y: y - 5 },
			end: { x: PAGE.width - MARGIN, y: y - 5 },
			thickness: 0.7,
			color: grey
		});
		y -= 20;
		lines.forEach((line, i) => {
			const cells: [string, number][] = [
				[String(firstLineNo + i), COLUMNS.line],
				[line.itemNo, COLUMNS.item],
				[line.description, COLUMNS.description],
				[String(line.quantity), COLUMNS.qty],
				[money(line.unitPrice), COLUMNS.price],
				[line.neededBy, COLUMNS.needBy]
			];
			for (const [value, x] of cells) {
				page.drawText(value, { x: MARGIN + x, y, size: 9, font: regular, color: ink });
			}
			y -= 16;
		});
		return y;
	};

	const first = pdf.addPage([PAGE.width, PAGE.height]);
	const top = PAGE.height - MARGIN;
	first.drawText('Canyon Parts Warehouse', { x: MARGIN, y: top - 14, size: 16, font: bold, color: ink });
	first.drawText('Greenville, SC 29601', { x: MARGIN, y: top - 28, size: 9, font: regular, color: grey });
	first.drawText('Purchase order 88214', { x: MARGIN + 340, y: top - 14, size: 13, font: bold, color: ink });
	first.drawText('Dated September 16, 2026', { x: MARGIN + 340, y: top - 28, size: 9, font: regular, color: grey });
	first.drawText('To: Northline Exhaust Co.', { x: MARGIN, y: top - 56, size: 10, font: regular, color: ink });
	first.drawText('Please quote and confirm lead times. Page 1 of 2.', {
		x: MARGIN,
		y: top - 70,
		size: 9,
		font: regular,
		color: grey
	});
	const afterOne = drawTable(first, top - 104, PDF_PAGE_ONE, 1);
	first.drawText('Continued on page 2', { x: MARGIN, y: afterOne - 8, size: 9, font: regular, color: grey });

	const second = pdf.addPage([PAGE.width, PAGE.height]);
	second.drawText('Purchase order 88214, page 2 of 2', {
		x: MARGIN,
		y: top - 14,
		size: 11,
		font: bold,
		color: ink
	});
	const afterTwo = drawTable(second, top - 48, PDF_PAGE_TWO, PDF_PAGE_ONE.length + 1);
	const total = totalOf([...PDF_PAGE_ONE, ...PDF_PAGE_TWO]);
	second.drawText('Order total', { x: MARGIN + COLUMNS.price - 40, y: afterTwo - 6, size: 9, font: bold, color: ink });
	second.drawText(money(total), { x: MARGIN + COLUMNS.needBy, y: afterTwo - 6, size: 9, font: bold, color: ink });
	const signature = [
		'Thanks,',
		'Parker Reyes',
		'Parts Manager, Canyon Parts Warehouse',
		'parker.reyes@canyonpartswarehouse.example'
	];
	signature.forEach((sline, i) => {
		second.drawText(sline, { x: MARGIN, y: afterTwo - 50 - i * 13, size: 9, font: regular, color: grey });
	});

	writeFileSync(join(OUT, 'pdf-request.pdf'), await pdf.save());
}

// ---------------------------------------------------------------------------
// A scan: an image, and not one character of text
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Buffer): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/**
 * A small greyscale PNG, written by hand so the fixture needs no image
 * library: the signature, a header chunk, one deflated block of pixels and
 * the end marker. The pattern is faint diagonal streaks, which is roughly
 * what a page of scanned paper looks like to a computer that cannot read it.
 */
function greyPng(width: number, height: number): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bits per sample
	header[9] = 0; // greyscale
	const raw = Buffer.alloc((width + 1) * height);
	for (let y = 0; y < height; y++) {
		const start = y * (width + 1);
		raw[start] = 0; // no filter on this row
		for (let x = 0; x < width; x++) {
			raw[start + 1 + x] = (x + y) % 17 === 0 ? 40 : 232;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw)),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

async function writeScannedPdf(): Promise<void> {
	const pdf = await PDFDocument.create();
	pdf.setTitle('Scanned request (invented sample, no text layer)');
	const page = pdf.addPage([PAGE.width, PAGE.height]);
	const image = await pdf.embedPng(greyPng(160, 200));
	page.drawImage(image, {
		x: MARGIN,
		y: MARGIN,
		width: PAGE.width - MARGIN * 2,
		height: PAGE.height - MARGIN * 2
	});
	writeFileSync(join(OUT, 'scanned-request.pdf'), await pdf.save());
}

// ---------------------------------------------------------------------------

mkdirSync(OUT, { recursive: true });
writeSpreadsheet();
writeSpreadsheetTwin();
writeCsv();
await writePdfRequest();
await writeScannedPdf();
console.log(`Wrote the RFQ fixtures to ${OUT}`);
