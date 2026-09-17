// Workflow D, the file side: reading messy CSV, reading cells, telling a
// wrong report from a right one, and the data fingerprint. No database.
import { describe, expect, it } from 'vitest';
import { parseCsv, toCsv } from './csv.ts';
import { readOpenLines, type OpenLinesFile } from './openLines.ts';
import type { SourceProfile } from './profile.ts';
import { readExport } from './reader.ts';
import { excelSerial, headerKey, parseDate, parseNumber } from './values.ts';

const HEADER =
	'Document No.,Line No.,Sell-to Customer No.,No.,Description,Shipment Date,Outstanding Quantity,Unit Price,Line Amount,Location Code';

// The invisible first character a spreadsheet writes into a UTF-8 file.
const BOM = String.fromCharCode(0xfeff);

function read(text: string, name = 'open-sales-lines.csv'): OpenLinesFile {
	const result = readOpenLines(name, text);
	if (!result.ok) throw new Error(`refused: ${result.refusal.message}`);
	return result.file;
}

describe('the CSV reader', () => {
	it('drops a byte order mark, handles CRLF, quotes and blank trailing lines', () => {
		const text = BOM + 'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"two\r\nlines",\r\n\r\n\r\n';
		expect(parseCsv(text)).toEqual([
			['a', 'b', 'c'],
			['1', 'x, y', 'say "hi"'],
			['2', 'two\r\nlines', '']
		]);
	});

	it('reads a last record with no line break, LF endings and blank lines in the middle', () => {
		expect(parseCsv('a,b\n\n1,2\n , \n3,4')).toEqual([
			['a', 'b'],
			['1', '2'],
			['3', '4']
		]);
	});

	it('writes what it reads', () => {
		const rows = [
			['plain', 'with, comma', 'with "quote"', ' padded '],
			['1', '', 'line\nbreak', 'x']
		];
		expect(parseCsv(toCsv(rows))).toEqual(rows);
	});
});

describe('cell readers', () => {
	it('matches headers without case, spaces or punctuation', () => {
		expect(headerKey('Sell-to Customer No.')).toBe('selltocustomerno');
		expect(headerKey('  DOCUMENT  no ')).toBe('documentno');
	});

	it('reads US dates, ISO dates and Excel serial numbers, and nothing else', () => {
		expect(parseDate('09/17/2026')).toBe('2026-09-17');
		expect(parseDate('9/7/2026')).toBe('2026-09-07');
		expect(parseDate(' 2026-09-17 ')).toBe('2026-09-17');
		expect(parseDate('46282')).toBe('2026-09-17');
		expect(parseDate('46282.0')).toBe('2026-09-17');
		expect(excelSerial('2026-09-17')).toBe(46282);
		for (const bad of ['02/30/2026', '13/01/2026', '2026-9-31', '17.09.2026', '123', '99999', 'soon', '']) {
			expect(parseDate(bad), bad).toBeNull();
		}
	});

	it('reads accounting numbers', () => {
		expect(parseNumber('1,234.50')).toBe(1234.5);
		expect(parseNumber('$1,234.50')).toBe(1234.5);
		expect(parseNumber(' $ 12.00 ')).toBe(12);
		expect(parseNumber('(12.00)')).toBe(-12);
		expect(parseNumber('($1,000)')).toBe(-1000);
		expect(parseNumber('-3')).toBe(-3);
		expect(parseNumber('.5')).toBe(0.5);
		expect(parseNumber('1,234,567.89')).toBe(1234567.89);
		for (const bad of ['', 'abc', '1.2.3', '12,34', '(-5)', '1,2345', '$', '1e5']) {
			expect(parseNumber(bad), bad).toBeNull();
		}
	});
});

describe('reading an open sales lines export', () => {
	const good = [
		HEADER,
		'SO1001,10000,C1,ITEM-A,"PIPE 4"" X 60"", CHROME",09/20/2026,5,"1,234.50","6,172.50",main',
		'SO1001,20000,C1,ITEM-B,CLAMP,2026-09-21,12,$4.10,49.20,MAIN',
		'SO1002,10000,C2,ITEM-A,PIPE,46290,1.00,100,,EAST'
	].join('\r\n');

	it('reads every good row into typed values', () => {
		const file = read(good);
		expect(file.rowCount).toBe(3);
		expect(file.problems).toEqual([]);
		expect(file.lines[0]).toEqual({
			rowNo: 2,
			documentNo: 'SO1001',
			lineNo: 10000,
			customerNo: 'C1',
			itemNo: 'ITEM-A',
			description: 'PIPE 4" X 60", CHROME',
			shipDate: '2026-09-20',
			quantity: 5,
			unitPrice: 1234.5,
			lineAmount: 6172.5,
			locationCode: 'MAIN'
		});
		expect(file.lines[2].shipDate).toBe('2026-09-25');
		expect(file.lines[2].lineAmount).toBeNull();
	});

	it('maps headers in any order and case, and lists the columns it ignores', () => {
		const text = [
			'unit price,OUTSTANDING QUANTITY,shipment date,no,sell to customer no,line no,document no,Reserved Qty.',
			'4.10,12,2026-09-21,ITEM-B,C1,20000,SO1001,3'
		].join('\n');
		const file = read(text);
		expect(file.problems).toEqual([]);
		expect(file.lines[0]).toMatchObject({ documentNo: 'SO1001', lineNo: 20000, quantity: 12, unitPrice: 4.1 });
		expect(file.ignoredColumns).toEqual(['Reserved Qty.']);
	});

	it('lists every problem on a row, with its row number', () => {
		const text = [
			HEADER,
			'SO1,10000,C1,ITEM-A,x,02/30/2026,5,1,,',
			'SO1,20000,C1,ITEM-A,x,09/20/2026,0,1,,',
			'SO1,30000,C1,ITEM-A,x,09/20/2026,-2,1,,',
			'SO1,40000,C1,ITEM-A,x,09/20/2026,2.5,abc,,',
			',abc,,,x,,,,,',
			'SO1,50000,C1,ITEM-A,x,09/20/2026,2,(1.00),oops,'
		].join('\n');
		const file = read(text);
		expect(file.lines).toEqual([]);
		expect(file.problems.map((p) => [p.rowNo, p.reasons.length])).toEqual([
			[2, 1],
			[3, 1],
			[4, 1],
			[5, 2],
			[6, 7],
			[7, 2]
		]);
		expect(file.problems[0].reasons[0]).toMatch(/Shipment Date "02\/30\/2026" is not a date/);
		expect(file.problems[1].reasons[0]).toMatch(/more than zero/);
		expect(file.problems[3].reasons.join(' ')).toMatch(/not a whole number.*Unit Price "abc"/);
		expect(file.problems[5].reasons.join(' ')).toMatch(/negative.*Line Amount "oops"/);
		expect(file.problems[0].raw['Shipment Date']).toBe('02/30/2026');
	});

	it('treats every row of a duplicated key as a problem', () => {
		const text = [HEADER, 'SO1,10000,C1,A,x,09/20/2026,5,1,,', 'SO1,20000,C1,A,x,09/20/2026,5,1,,', 'so1,10000.00,C1,B,y,09/21/2026,1,1,,'].join('\n');
		const file = read(text);
		expect(file.lines.map((l) => l.rowNo)).toEqual([3]);
		expect(file.problems.map((p) => p.rowNo)).toEqual([2, 4]);
		expect(file.problems[0].reasons[0]).toBe('Document No. SO1, Line No. 10000 appears more than once (rows 2, 4).');
	});

	it('refuses a different report, naming what is missing and what it looks like', () => {
		const result = readOpenLines(
			'posted.csv',
			'Document No.,Line No.,Sell-to Customer No.,Posting Date,Type,No.,Description,Quantity,Unit Price,Amount\nSI1,10000,C1,09/01/2026,Item,A,x,1,2,2\n'
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.refusal.missing).toEqual(['Shipment Date', 'Outstanding Quantity']);
		expect(result.refusal.looksLike).toBe('a posted sales invoice lines export');
		expect(result.refusal.headers).toContain('Posting Date');
		expect(result.refusal.message).toMatch(/no Shipment Date, Outstanding Quantity columns/);
	});

	it('refuses an empty file and a file with headers but no rows', () => {
		const empty = readOpenLines('empty.csv', BOM + '\r\n\r\n');
		expect(empty.ok || empty.refusal.message).toBe('The file is empty.');
		const noRows = readOpenLines('header-only.csv', `${HEADER}\r\n\r\n`);
		expect(noRows.ok || noRows.refusal.message).toMatch(/no data rows/);
	});
});

describe('the fingerprint', () => {
	const rows = [
		'SO1,10000,C1,A,Pipe,09/20/2026,5,10.00,50.00,MAIN',
		'SO1,20000,C1,B,Clamp,09/21/2026,2,3.50,7.00,MAIN',
		'SO2,10000,C2,A,Pipe,09/22/2026,1,10.00,10.00,EAST'
	];
	const base = read([HEADER, ...rows].join('\n'), 'open-sales-lines-0600.csv').hash;

	it('is a SHA-256', () => {
		expect(base).toMatch(/^[0-9a-f]{64}$/);
	});

	it('ignores the file name, row order, column order and formatting', () => {
		expect(read([HEADER, ...rows].join('\n'), 'open-sales-lines-0715.csv').hash).toBe(base);
		expect(read([HEADER, rows[2], rows[0], rows[1]].join('\r\n')).hash).toBe(base);

		// Columns shuffled, an extra column, dates and numbers written differently, a BOM.
		const shuffled = [
			'Location Code,Line No.,Extra,Document No.,No.,Sell-to Customer No.,Description,Outstanding Quantity,Unit Price,Line Amount,Shipment Date',
			'main,10000.00,x,so1,a,c1,Pipe,5.00,$10,$50.00,2026-09-20',
			'EAST,10000,y, SO2 ,A,C2,Pipe,1,10.0,10,46287',
			'MAIN,20000,z,SO1,B,C1,Clamp,2,3.5,7,9/21/2026',
			''
		].join('\r\n');
		expect(read(BOM + shuffled).hash).toBe(base);
	});

	it('changes when any value changes', () => {
		const changed = [
			rows[0].replace(',5,', ',6,'),
			rows[0].replace('09/20/2026', '09/23/2026'),
			rows[0].replace('10.00,50.00', '10.01,50.00'),
			rows[0].replace('Pipe', 'Pipes'),
			rows[0].replace(',MAIN', ',EAST')
		];
		for (const row of changed) {
			expect(read([HEADER, row, rows[1], rows[2]].join('\n')).hash, row).not.toBe(base);
		}
		// A row removed is different data too.
		expect(read([HEADER, rows[0], rows[1]].join('\n')).hash).not.toBe(base);
	});

	it('changes when a bad cell is corrected, even though the row was a problem both times', () => {
		const a = read([HEADER, 'SO1,10000,C1,A,Pipe,soon,5,10,,'].join('\n')).hash;
		const b = read([HEADER, 'SO1,10000,C1,A,Pipe,later,5,10,,'].join('\n')).hash;
		expect(a).not.toBe(b);
	});
});

describe('source profiles', () => {
	// A made-up second report: a new profile, and no new reader code.
	const stockProfile: SourceProfile = {
		id: 'stock_counts',
		name: 'stock count export',
		fields: {
			itemNo: { label: 'Item', aliases: ['item'], required: true, kind: 'code' },
			counted: { label: 'Counted', aliases: ['counted'], required: true, kind: 'whole', atLeast: 0 },
			countedOn: { label: 'Count Date', aliases: ['countdate'], required: true, kind: 'date' }
		},
		key: ['itemNo'],
		dates: ['iso'],
		// Thousands with dots, decimals with commas, no currency sign.
		numbers: { thousands: '.', decimal: ',', currency: '', parenthesesNegative: false },
		otherReports: []
	};

	it('reads another report with its own number and date formats', () => {
		const text = ['Item,Counted,Count Date,Bin', 'ab-1,"1.200",2026-09-17,A1', 'ab-2,3,09/17/2026,A2'].join('\n');
		const result = readExport(stockProfile, 'counts.csv', text);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.file.rows).toEqual([{ rowNo: 2, values: { itemNo: 'AB-1', counted: 1200, countedOn: '2026-09-17' } }]);
		// A US date is not one of this profile's formats.
		expect(result.file.problems[0].reasons).toEqual(['Count Date "09/17/2026" is not a date.']);
		expect(result.file.ignoredColumns).toEqual(['Bin']);
	});

	it('refuses a file in the profile\'s own words', () => {
		const result = readExport(stockProfile, 'counts.csv', 'Item,Bin\nab-1,A1\n');
		expect(result.ok || result.refusal.message).toBe('This is not the stock count export: it has no Counted, Count Date columns.');
	});
});
