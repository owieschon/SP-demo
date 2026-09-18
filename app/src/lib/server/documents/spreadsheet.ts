// Spreadsheets: .xlsx and the old .xls.
//
// Read with SheetJS, then walked cell by cell rather than through
// sheet_to_json. Walking gives three things that matter here:
//   * every sheet, not just the first,
//   * merged headers flattened, because a merged cell's value only sits in
//     the top-left cell of the merge and is blank everywhere else,
//   * a source reference for every row (sheet name and row number), which
//     sheet_to_json throws away.
// It also means no object is ever built out of names taken from an untrusted
// file. The SheetJS version and source are pinned in package.json and the
// lockfile; see docs/documents.md.
//
// Numbers stay numbers. Dates are the interesting case: a spreadsheet
// stores 2026-10-17 as the number 46312, and only the cell's number format
// says which of the two it is, so that is what decides here.
import * as XLSX from 'xlsx';
import { cellFromValue, dateFromSerial, emptyCell } from './cells.ts';
import { findGridTable } from './tables.ts';
import { DocumentError, type DocCell, type DocLine, type DocTable, type ParsedDocument } from './types.ts';

/** Post-parse extraction bounds: a larger grid is not a parts request. */
const MAX_SHEETS = 20;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 80;

/**
 * True when a cell's number format makes it a date or a time.
 *
 * Number format strings mix in pieces that are not the format itself: colour
 * and condition sections in square brackets, literal text in quotes, escaped
 * characters after a backslash, and padding after an underscore or an
 * asterisk. Those come out first, because "[Red]0.00" holds a "d" that has
 * nothing to do with days. What is left is a date format when it still uses
 * one of the date or time letters.
 */
export function isDateFormat(format: string | number | undefined): boolean {
	// A cell can carry a built-in format by its number instead of its text.
	// The built-in date and time formats are 14 to 22 and 45 to 47.
	if (typeof format === 'number') {
		return (format >= 14 && format <= 22) || (format >= 45 && format <= 47);
	}
	if (!format) return false;
	const bare = format
		.replace(/\[[^\]]*\]/g, '')
		.replace(/"[^"]*"/g, '')
		.replace(/\\./g, '')
		.replace(/[_*]./g, '');
	return /[ymdhs]/i.test(bare);
}

function cellAt(sheet: XLSX.WorkSheet, row: number, column: number): XLSX.CellObject | undefined {
	return sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
}

/** One cell as a DocCell, with a numeric date cell turned into a real date. */
function readCell(cell: XLSX.CellObject | undefined): DocCell {
	if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) return emptyCell();
	if (cell.t === 'e') return emptyCell(); // a formula error shows as blank
	if (cell.t === 'd' && cell.v instanceof Date) {
		// SheetJS builds these in local time, so the local parts are the date
		// the sheet shows.
		const y = cell.v.getFullYear();
		const m = String(cell.v.getMonth() + 1).padStart(2, '0');
		const d = String(cell.v.getDate()).padStart(2, '0');
		return { text: `${y}-${m}-${d}`, number: null, date: `${y}-${m}-${d}` };
	}
	if (cell.t === 'n' && typeof cell.v === 'number' && isDateFormat(cell.z)) {
		return cellFromValue(cell.v, dateFromSerial(cell.v));
	}
	return cellFromValue(cell.v);
}

/**
 * A sheet as a dense grid, with merged ranges filled in: every cell a merge
 * covers gets the merge's value, so a header that spans three columns reads
 * as that header over all three.
 */
function gridOf(sheet: XLSX.WorkSheet): DocCell[][] {
	const reference = sheet['!ref'];
	if (!reference) return [];
	const range = XLSX.utils.decode_range(reference);
	const lastRow = Math.min(range.e.r, range.s.r + MAX_ROWS - 1);
	const lastColumn = Math.min(range.e.c, range.s.c + MAX_COLUMNS - 1);

	const grid: DocCell[][] = [];
	for (let r = range.s.r; r <= lastRow; r++) {
		const row: DocCell[] = [];
		for (let c = range.s.c; c <= lastColumn; c++) row.push(readCell(cellAt(sheet, r, c)));
		grid.push(row);
	}

	for (const merge of sheet['!merges'] ?? []) {
		const source = grid[merge.s.r - range.s.r]?.[merge.s.c - range.s.c];
		if (!source || source.text === '') continue;
		for (let r = merge.s.r; r <= merge.e.r; r++) {
			for (let c = merge.s.c; c <= merge.e.c; c++) {
				const target = grid[r - range.s.r]?.[c - range.s.c];
				if (target && target.text === '') Object.assign(target, source);
			}
		}
	}
	// The grid's first row is spreadsheet row range.s.r + 1.
	return grid;
}

export interface SpreadsheetInput {
	kind: 'xlsx' | 'xls';
	name: string;
	attachment: number;
	bytes: Uint8Array;
}

export function readSpreadsheetDocument(input: SpreadsheetInput): ParsedDocument {
	let book: XLSX.WorkBook;
	try {
		// cellNF gives every cell its number format, which is the only way to
		// tell a date from a plain number. cellDates is left off so the serial
		// number is converted here, by date-only arithmetic, in no time zone.
		book = XLSX.read(input.bytes, { type: 'array', cellNF: true, cellDates: false, cellText: false });
	} catch {
		throw new DocumentError(`${input.name} could not be read as a spreadsheet. Save it again as .xlsx and try once more.`);
	}

	const sheetNames = book.SheetNames.slice(0, MAX_SHEETS);
	if (sheetNames.length === 0) {
		throw new DocumentError(`${input.name} has no sheets in it.`);
	}

	const tables: DocTable[] = [];
	const lines: DocLine[] = [];
	let rowCount = 0;

	for (const sheetName of sheetNames) {
		const sheet = book.Sheets[sheetName];
		if (!sheet) continue;
		const grid = gridOf(sheet);
		const reference = sheet['!ref'];
		const firstRow = reference ? XLSX.utils.decode_range(reference).s.r : 0;
		const refFor = (rowIndex: number) => ({
			attachment: input.attachment,
			sheet: sheetName,
			row: firstRow + rowIndex + 1
		});

		// Every row also travels as a line of text, so a sheet with no header
		// row still gives the text reader something to work with.
		grid.forEach((row, i) => {
			const text = row
				.map((c) => c.text)
				.join('  ')
				.trimEnd();
			if (text.trim() !== '') lines.push({ text, ref: refFor(i) });
		});

		const table = findGridTable(grid, sheetName, refFor);
		if (table && table.rows.length > 0) {
			tables.push(table);
			rowCount += table.rows.length;
		}
	}

	if (lines.length === 0) {
		throw new DocumentError(`${input.name} is empty: every sheet in it is blank.`);
	}

	const sheetCount = sheetNames.length;
	const sheetWord = sheetCount === 1 ? 'sheet' : 'sheets';
	const rowWord = rowCount === 1 ? 'row' : 'rows';
	return {
		kind: input.kind,
		name: input.name,
		attachment: input.attachment,
		lines,
		tables,
		pageCount: null,
		sheetCount,
		rowCount,
		summary:
			tables.length > 0
				? `${sheetCount} ${sheetWord}, ${rowCount} ${rowWord}`
				: `${sheetCount} ${sheetWord}, no header row recognized`
	};
}
