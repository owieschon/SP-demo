// The document readers, on the real sample files in fixtures/rfq/, plus the
// quote that goes back out.
//
// No database in this file: everything here is bytes in, shapes out. The
// database side (storing attachments, who may read them, the quote a draft
// becomes) is in attachments.test.ts.
//
// The fixtures are built by `node scripts/rfq-fixtures.ts` and committed, so
// a failure here is a change in the readers, not a change in the files.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractText } from 'unpdf';
import { version as sheetJsVersion } from 'xlsx';
import { findDbDir } from '../db/files.ts';
import { cellFromText, dateFromSerial, numberFromText } from './cells.ts';
import { readCsvDocument } from './csv.ts';
import { contentDisposition, safeFileName } from './http.ts';
import { mailBody, mailSubject, quoteMail } from './mailto.ts';
import { readPdfDocument } from './pdf.ts';
import { extend, subtotalOf, type QuoteDoc } from './quote.ts';
import { quoteFileName, quotePdf, sanitize } from './quotePdf.ts';
import { kindOfFile, readRequest, readUploadedFile } from './read.ts';
import { isDateFormat, readSpreadsheetDocument } from './spreadsheet.ts';
import { findTextTables, headerField, mapHeader, pick } from './tables.ts';
import { readTextDocument } from './text.ts';
import { lineFromRow } from './request.ts';
import { DocumentError, MEDIA_TYPES, SCANNED_PDF_MESSAGE, sourceLabel, type DocTable } from './types.ts';

const FIXTURES = resolve(findDbDir(), '..', 'fixtures', 'rfq');
const bytesOf = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const textOf = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

/** A File the way the intake form's FormData hands one over. */
function upload(name: string, bytes: Uint8Array): File {
	// A copy in its own ArrayBuffer: the File constructor will not take a view
	// that might sit on shared memory.
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return new File([buffer], name);
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

describe('cells', () => {
	it('reads numbers, money and brackets, and refuses what is not a number', () => {
		expect(numberFromText('1,250')).toBe(1250);
		expect(numberFromText('$1,250.00')).toBe(1250);
		expect(numberFromText('(120)')).toBe(-120);
		expect(numberFromText('4 ea')).toBeNull();
		expect(numberFromText('')).toBeNull();
	});

	it('reads dates in the forms customers write them in', () => {
		expect(cellFromText('2026-10-17').date).toBe('2026-10-17');
		expect(cellFromText('10/17/2026').date).toBe('2026-10-17');
		expect(cellFromText('Oct 17, 2026').date).toBe('2026-10-17');
		expect(cellFromText('17 Oct 2026').date).toBe('2026-10-17');
		expect(cellFromText('six weeks out').date).toBeNull();
	});

	it('turns an Excel serial into the date it stands for', () => {
		// 46304 is 2026-10-09 counted from 1899-12-30, the epoch Excel uses.
		expect(dateFromSerial(46304)).toBe('2026-10-09');
		expect(dateFromSerial(46312)).toBe('2026-10-17');
		expect(dateFromSerial(0)).toBeNull();
	});

	it('knows a date number format from a money one', () => {
		expect(isDateFormat('mm/dd/yyyy')).toBe(true);
		expect(isDateFormat('d-mmm-yy')).toBe(true);
		expect(isDateFormat(14)).toBe(true); // a built-in date format, by number
		expect(isDateFormat('#,##0.00')).toBe(false);
		// [Red] holds a "d" that has nothing to do with days.
		expect(isDateFormat('0.00;[Red]-0.00')).toBe(false);
		expect(isDateFormat(undefined)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

describe('column names', () => {
	it('matches a column however it is punctuated or capitalized', () => {
		for (const label of ['Item #', 'ITEM NO.', 'item number', 'Part No', 'p/n', 'SKU']) {
			expect(headerField(label), label).toBe('item');
		}
		for (const label of ['Qty', 'QTY REQ', 'quantity', 'Order Qty']) {
			expect(headerField(label), label).toBe('quantity');
		}
		expect(headerField('Unit Price')).toBe('price');
		expect(headerField('Ext. Price')).toBe('total');
		expect(headerField('Need By')).toBe('needed_by');
		expect(headerField('UOM')).toBe('unit');
		expect(headerField('Buyer')).toBeNull();
	});

	it('only calls a row a header when it names a part and a figure', () => {
		const lines = [
			{ text: 'Notes | Thanks', ref: { attachment: 0, line: 1 } },
			{ text: 'Part | Qty', ref: { attachment: 0, line: 2 } },
			{ text: 'S6-96BC | 4', ref: { attachment: 0, line: 3 } }
		];
		const tables = findTextTables(lines, 'pasted');
		expect(tables).toHaveLength(1);
		expect(tables[0].header).toEqual(['Part', 'Qty']);
		expect(tables[0].rows).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// The spreadsheet
// ---------------------------------------------------------------------------

describe('a spreadsheet request', () => {
	const doc = readSpreadsheetDocument({
		kind: 'xlsx',
		name: 'emailed-spreadsheet-request.xlsx',
		attachment: 1,
		bytes: bytesOf('emailed-spreadsheet-request.xlsx')
	});

	it('reads every sheet and says what it found', () => {
		expect(doc.sheetCount).toBe(3);
		expect(doc.rowCount).toBe(5);
		expect(doc.summary).toBe('3 sheets, 5 rows');
		expect(doc.pageCount).toBeNull();
	});

	it('loads SheetJS 0.20.3', () => {
		expect(sheetJsVersion).toBe('0.20.3');
	});

	it('still reads a legacy .xls upload', async () => {
		// This checked-in synthetic BIFF8 file was written by the prior
		// SheetJS 0.18.5 install, so the compatibility check does not use the
		// same library version to write and read its own fixture.
		const bytes = bytesOf('legacy-spreadsheet-request.xls');
		const { doc: legacy, stored } = await readUploadedFile(upload('legacy-request.xls', bytes), 2);

		expect(legacy.kind).toBe('xls');
		expect(legacy.tables[0].header).toEqual(['Item No', 'Qty']);
		expect(legacy.tables[0].rows[0].cells.map((cell) => cell.text)).toEqual(['SYNTH-001', '4']);
		expect(legacy.tables[0].rows[0].ref).toEqual({ attachment: 2, sheet: 'Quote', row: 2 });
		expect(stored.mediaType).toBe(MEDIA_TYPES.xls);
	});

	it('flattens a header merged over two rows', () => {
		// "Quantity" sits in a cell merged down C3:C4, so C4 is blank in the
		// file and has to read as "Quantity" all the same.
		const table = doc.tables[0];
		expect(table.name).toBe('Quote Request');
		expect(table.header).toEqual(['Item No', 'Description', 'Quantity', 'Unit price', 'Need by']);
		expect(mapHeader(table.header)).toEqual(['item', 'description', 'quantity', 'price', 'needed_by']);
	});

	it('keeps numbers as numbers and dates as dates', () => {
		const table = doc.tables[0];
		const first = table.rows[0];
		expect(pick(table, first, 'item')?.text).toBe('S6-96BC');
		expect(pick(table, first, 'quantity')?.number).toBe(4);
		expect(pick(table, first, 'price')?.number).toBe(183.41);
		// The cell holds the serial number 46312; its format makes it a date.
		expect(pick(table, first, 'needed_by')?.date).toBe('2026-10-09');
		expect(pick(table, first, 'needed_by')?.number).toBeNull();
	});

	it('records the sheet and the row every line came from', () => {
		const refs = doc.tables[0].rows.map((row) => sourceLabel(row.ref));
		expect(refs[0]).toBe('attachment 1, sheet Quote Request, row 5');
		expect(refs[4]).toBe('attachment 1, sheet Quote Request, row 9');
	});

	it('keeps the total the sheet states, and leaves it out of the lines', () => {
		expect(doc.tables[0].statedTotal).toBe(1898.04);
		expect(doc.tables[0].rows).toHaveLength(5);
		expect(doc.tables[0].rows.some((row) => pick(doc.tables[0], row, 'item')?.text === 'Total')).toBe(false);
	});

	it('turns a row into a draft line with its source', () => {
		const table = doc.tables[0];
		const line = lineFromRow(table, table.rows[1]);
		expect(line).not.toBeNull();
		expect(line!.item_no.value).toBe('CL6SZ');
		expect(line!.quantity.value).toBe(12);
		expect(line!.unit_price.value).toBe(19.66);
		expect(line!.source).toBe('attachment 1, sheet Quote Request, row 6');
	});
});

// ---------------------------------------------------------------------------
// The CSV
// ---------------------------------------------------------------------------

describe('a CSV parts list', () => {
	const doc = readCsvDocument({ name: 'parts-list.csv', attachment: 2, text: textOf('parts-list.csv') });

	it('finds the header under the preamble and reads the rows', () => {
		expect(doc.tables).toHaveLength(1);
		const table = doc.tables[0];
		expect(table.header).toEqual(['Part Number', 'Description', 'Qty', 'UOM', 'Need By']);
		expect(table.rows.map((row) => pick(table, row, 'item')?.text)).toEqual(['P6-60CX', 'CL7BZ', 'HS8-36C']);
		expect(table.rows.map((row) => pick(table, row, 'quantity')?.number)).toEqual([10, 24, 3]);
	});

	it('leaves the note under the table out of the lines', () => {
		// "Notes | Hold for one release" sits in the part column but says
		// nothing about how many, so it is not a line of the request.
		expect(doc.rowCount).toBe(3);
	});

	it('numbers rows the way the file does', () => {
		expect(sourceLabel(doc.tables[0].rows[0].ref)).toBe('attachment 2, row 4');
	});

	it('reads a quoted field that holds inch marks', () => {
		const table = doc.tables[0];
		expect(pick(table, table.rows[0], 'description')?.text).toContain('6" x 60"');
	});
});

// ---------------------------------------------------------------------------
// The PDFs
// ---------------------------------------------------------------------------

describe('a PDF request', () => {
	it('reads both pages, row by row, with the page and line each came from', async () => {
		const doc = await readPdfDocument({ name: 'pdf-request.pdf', attachment: 3, bytes: bytesOf('pdf-request.pdf') });
		expect(doc.pageCount).toBe(2);
		expect(doc.summary).toBe('2 pages, 8 rows');
		expect(doc.tables.map((t) => t.name)).toEqual(['page 1', 'page 2']);

		const first = doc.tables[0];
		expect(first.header).toEqual(['Line', 'Item No', 'Description', 'Qty', 'Unit Price', 'Need By']);
		expect(first.rows.map((row) => pick(first, row, 'item')?.text)).toEqual([
			'S7-96SA',
			'S8-36BS',
			'M-4164',
			'RBRC10B3',
			'CL4WZ'
		]);
		expect(pick(first, first.rows[0], 'quantity')?.number).toBe(2);
		expect(pick(first, first.rows[0], 'needed_by')?.date).toBe('2026-10-12');
		expect(sourceLabel(first.rows[0].ref)).toBe('attachment 3, page 1, line 6');

		const second = doc.tables[1];
		expect(second.rows).toHaveLength(3);
		expect(sourceLabel(second.rows[0].ref)).toBe('attachment 3, page 2, line 3');
		// The order total printed under the last line.
		expect(second.statedTotal).toBe(2000.94);
	});

	it('refuses a PDF that is only a scan, and says why', async () => {
		await expect(
			readPdfDocument({ name: 'scanned-request.pdf', attachment: 1, bytes: bytesOf('scanned-request.pdf') })
		).rejects.toThrow(SCANNED_PDF_MESSAGE);
	});
});

// ---------------------------------------------------------------------------
// What is read, and what is not
// ---------------------------------------------------------------------------

describe('deciding what a file is', () => {
	it('goes by the first bytes, not by the name', () => {
		expect(kindOfFile('order.pdf', bytesOf('pdf-request.pdf'))).toBe('pdf');
		expect(kindOfFile('quote.xlsx', bytesOf('emailed-spreadsheet-request.xlsx'))).toBe('xlsx');
		expect(kindOfFile('list.csv', new TextEncoder().encode('a,b\n1,2\n'))).toBe('csv');
		// A PDF renamed .txt is refused rather than read as text.
		expect(() => kindOfFile('order.txt', bytesOf('pdf-request.pdf'))).toThrow(DocumentError);
	});

	it('refuses a program outright', () => {
		const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]);
		expect(() => kindOfFile('order.txt', exe)).toThrow(/is a program/);
	});

	it('says .msg is not supported, and what to do instead', () => {
		const msg = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
		expect(() => kindOfFile('request.msg', msg)).toThrow(/Outlook \.msg/);
	});

	it('refuses a format it does not read', () => {
		expect(() => kindOfFile('drawing.dwg', new TextEncoder().encode('x'))).toThrow(/not a kind of file/);
	});

	it('serves each kind as its own media type, never the one the browser claimed', async () => {
		const { stored } = await readUploadedFile(upload('parts-list.csv', bytesOf('parts-list.csv')), 1);
		expect(stored.mediaType).toBe(MEDIA_TYPES.csv);
		expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(stored.byteSize).toBe(bytesOf('parts-list.csv').byteLength);
	});

	it('refuses a file larger than ten megabytes', async () => {
		const twelveMb = new Uint8Array(12 * 1024 * 1024);
		// Make it look like a real CSV, so size is the only thing wrong.
		twelveMb.set(new TextEncoder().encode('Part,Qty\n'), 0);
		await expect(readUploadedFile(upload('huge.csv', twelveMb), 1)).rejects.toThrow(/10 MB/);
	});
});

describe('reading a whole request', () => {
	it('reads the paste box and its attachments, in order', async () => {
		const read = await readRequest({
			paste: 'From: Cameron Kowalski <cameron.kowalski@coastalpartsdepot.example>\n\nQuote the attached please.',
			files: [
				upload('emailed-spreadsheet-request.xlsx', bytesOf('emailed-spreadsheet-request.xlsx')),
				upload('parts-list.csv', bytesOf('parts-list.csv'))
			]
		});
		expect(read.problems).toEqual([]);
		expect(read.documents.map((d) => d.attachment)).toEqual([0, 1, 2]);
		expect(read.documents.map((d) => d.kind)).toEqual(['paste', 'xlsx', 'csv']);
		expect(read.stored.map((f) => f.ordinal)).toEqual([1, 2]);
	});

	it('refuses the fifth file and names it', async () => {
		const csv = bytesOf('parts-list.csv');
		// Five files, each different by one byte so they are not duplicates.
		const files = [0, 1, 2, 3, 4].map((n) => {
			const copy = new Uint8Array(csv);
			copy[copy.length - 1] = 0x20 + n;
			return upload(`list-${n}.csv`, copy);
		});
		const read = await readRequest({ files });
		expect(read.stored).toHaveLength(4);
		expect(read.problems).toHaveLength(1);
		expect(read.problems[0]).toContain('list-4.csv');
		expect(read.problems[0]).toContain('4 files at most');
	});

	it('recognizes the same file attached twice and reads it once', async () => {
		const csv = bytesOf('parts-list.csv');
		const read = await readRequest({ files: [upload('parts-list.csv', csv), upload('parts-list.csv', csv)] });
		expect(read.stored).toHaveLength(1);
		expect(read.problems).toEqual(['parts-list.csv was attached twice. It only needs to be read once.']);
	});

	it('collects every reason at once rather than stopping at the first', async () => {
		const read = await readRequest({
			paste: 'Quote these please.',
			files: [
				upload('scanned-request.pdf', bytesOf('scanned-request.pdf')),
				upload('notes.msg', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
			]
		});
		expect(read.problems).toHaveLength(2);
		expect(read.problems[0]).toBe(SCANNED_PDF_MESSAGE);
		expect(read.problems[1]).toMatch(/Outlook \.msg/);
		// The paste still came through; the caller decides what to do.
		expect(read.documents).toHaveLength(1);
	});

	it('refuses text that is not text', () => {
		expect(() =>
			readTextDocument({ kind: 'txt', name: 'order.txt', attachment: 1, text: 'S6-96BC\0\0' })
		).toThrow(/binary/);
	});
});

// ---------------------------------------------------------------------------
// Download headers
// ---------------------------------------------------------------------------

describe('download headers', () => {
	it('cleans a file name that would break the header', () => {
		expect(safeFileName('quote"; drop.csv', 'download')).toBe('quote; drop.csv');
		expect(safeFileName('../../etc/passwd', 'download')).toBe('..-..-etc-passwd');
		expect(safeFileName('   ', 'download')).toBe('download');
	});

	it('always says attachment, and repeats the name in UTF-8 form', () => {
		const header = contentDisposition('parts-list.csv');
		expect(header.startsWith('attachment; ')).toBe(true);
		expect(header).toContain('filename="parts-list.csv"');
		expect(header).toContain("filename*=UTF-8''parts-list.csv");
	});
});

// ---------------------------------------------------------------------------
// The quote that goes out
// ---------------------------------------------------------------------------

/** A quote with the shape of a real one, for the drawing and the email. */
function sampleQuote(): QuoteDoc {
	const lines = [
		{ lineNo: 1, itemNo: 'S6-96BC', description: '6" X 96" BULL HAULER STACK CHROME', quantity: 4, unitPrice: 183.41, extended: extend(4, 183.41) },
		{ lineNo: 2, itemNo: 'CL6SZ', description: '6" SADDLE CLAMP ZINC', quantity: 12, unitPrice: 19.66, extended: extend(12, 19.66) },
		{ lineNo: 3, itemNo: 'L660-1018SC', description: '6" 60 DEG ELBOW 10" X 18" CHROME SLIP', quantity: 6, unitPrice: 79.94, extended: extend(6, 79.94) }
	];
	return {
		kind: 'quote',
		reference: '448123',
		title: 'Quote 448123',
		quoteId: 448123,
		draftId: null,
		commitmentId: 9012,
		quotedOn: '2026-09-17',
		validUntil: '2026-10-17',
		customerNo: '10072',
		customerName: 'Coastal Parts Depot',
		customerCity: 'Houston',
		customerState: 'TX',
		customerCountry: 'US',
		priceGroupLabel: 'Elite',
		buyerName: 'Cameron Kowalski',
		buyerTitle: 'Purchasing Agent',
		buyerEmail: 'cameron.kowalski@coastalpartsdepot.example',
		preparedBy: 'Dana Whitfield',
		lines,
		subtotal: subtotalOf(lines),
		freightNote: 'Freight collect on your own carrier account. Nothing for freight is added below.',
		terms: 'Net 30 on approved credit.'
	};
}

describe('the quote PDF', () => {
	it('adds up the lines to the cent', () => {
		const quote = sampleQuote();
		expect(quote.lines.map((l) => l.extended)).toEqual([733.64, 235.92, 479.64]);
		expect(quote.subtotal).toBe(1449.2);
	});

	it('is a real PDF, and reads back with its parts, quantities and total', async () => {
		const quote = sampleQuote();
		const bytes = await quotePdf(quote);

		// A PDF starts with %PDF- and ends with its end-of-file marker.
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
		expect(new TextDecoder().decode(bytes.slice(-1024))).toContain('%%EOF');

		const { totalPages, text } = await extractText(new Uint8Array(bytes), { mergePages: true });
		expect(totalPages).toBe(1);
		// Whitespace in a PDF is a matter of where things were drawn, not of
		// what was written, so compare against a single-spaced copy.
		const flat = text.replace(/\s+/g, ' ');

		expect(flat).toContain('Northline Exhaust Co.');
		expect(flat).toContain('QUOTE');
		expect(flat).toContain('448123');
		expect(flat).toContain('Coastal Parts Depot');
		expect(flat).toContain('Cameron Kowalski');
		for (const line of quote.lines) {
			expect(flat, line.itemNo).toContain(line.itemNo);
			expect(flat, `${line.itemNo} quantity`).toContain(String(line.quantity));
		}
		expect(flat).toContain('$1,449.20');
		expect(flat).toContain('Oct 17, 2026');
		expect(flat).toContain('portfolio demo');
		expect(flat).toContain('Page 1 of 1');
	});

	it('marks a draft quote as a draft, and runs onto a second page when it is long', async () => {
		const quote = sampleQuote();
		const long: QuoteDoc = {
			...quote,
			kind: 'draft',
			reference: 'R-7001',
			title: 'Draft quote for request R-7001',
			quoteId: null,
			draftId: 7001,
			lines: Array.from({ length: 60 }, (_, i) => ({ ...quote.lines[0], lineNo: i + 1 }))
		};
		const { totalPages, text } = await extractText(new Uint8Array(await quotePdf(long)), { mergePages: true });
		const flat = text.replace(/\s+/g, ' ');
		expect(totalPages).toBeGreaterThan(1);
		expect(flat).toContain('DRAFT QUOTE');
		expect(flat).toContain('has not been approved');
		expect(flat).toContain('continued');
		expect(flat).toContain(`Page ${totalPages} of ${totalPages}`);
	});

	it('names the file after the quote', () => {
		expect(quoteFileName(sampleQuote())).toBe('northline-quote-448123.pdf');
	});

	it('drops characters the standard fonts cannot write', () => {
		const curly = String.fromCharCode(0x201d);
		const dash = String.fromCharCode(0x2014);
		expect(sanitize(`6${curly} x 96${curly} ${dash} chrome`)).toBe('6" x 96" - chrome');
		// A character no standard font can write is dropped, not guessed at.
		expect(sanitize(`stack ${String.fromCharCode(0x4e2d)}`)).toBe('stack ');
	});
});

describe('the mail draft', () => {
	it('says what it is, how much of it, and how long it holds', () => {
		expect(mailSubject(sampleQuote())).toBe('Quote 448123 for 3 parts, valid to Oct 17');
	});

	it('summarizes the lines and the total, and says the PDF is attached', () => {
		const body = mailBody(sampleQuote());
		expect(body).toContain('Hello Cameron,');
		expect(body).toContain('S6-96BC');
		expect(body).toContain('4 at $183.41 = $733.64');
		expect(body).toContain('Subtotal: $1,449.20');
		expect(body).toContain('The quote PDF is attached.');
		expect(body).toContain('portfolio demo');
	});

	it('escapes the subject and the body into the link', () => {
		const quote = sampleQuote();
		quote.customerName = 'Hobbs & Vance Truck Parts';
		const mail = quoteMail(quote);

		expect(mail.href.startsWith('mailto:cameron.kowalski@coastalpartsdepot.example?')).toBe(true);
		// Newlines, spaces and ampersands cannot travel as themselves: an
		// ampersand would end the body and start a header of its own.
		expect(mail.href).toContain('%0A');
		expect(mail.href).toContain('%20');
		expect(mail.href).toContain('Hobbs%20%26%20Vance');
		expect(mail.href).not.toMatch(/body=[^&]*&(?!$)/);
		// Decoding it gives exactly the body back.
		const body = new URLSearchParams(mail.href.slice(mail.href.indexOf('?') + 1)).get('body');
		expect(body).toBe(mail.body);
	});

	it('has no address when nobody is named, and the page says so', () => {
		const quote = sampleQuote();
		quote.buyerName = null;
		quote.buyerEmail = null;
		const mail = quoteMail(quote);
		expect(mail.to).toBeNull();
		expect(mail.href.startsWith('mailto:?')).toBe(true);
		expect(mail.body).toContain('Hello,');
	});
});

describe('source references', () => {
	it('reads the way a person would say it', () => {
		expect(sourceLabel({ attachment: 2, sheet: 'Quote', row: 14 })).toBe('attachment 2, sheet Quote, row 14');
		expect(sourceLabel({ attachment: 1, page: 1, line: 8 })).toBe('attachment 1, page 1, line 8');
		expect(sourceLabel({ attachment: 0, line: 3 })).toBe('pasted email, line 3');
	});
});

describe('a table with no rows', () => {
	it('is not reported as a table', () => {
		const empty: DocTable[] = findTextTables(
			[{ text: 'Item No | Qty', ref: { attachment: 0, line: 1 } }],
			'pasted'
		);
		expect(empty).toEqual([]);
	});
});
