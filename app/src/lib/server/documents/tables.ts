// Finding a table in a document, and working out what its columns mean.
//
// A spreadsheet and a CSV arrive as a grid of cells. A PDF and a plain text
// email arrive as lines, which become a grid by splitting on pipes, tabs or
// runs of two or more spaces. Either way the job is the same: find the
// header row, decide what each column is, and read the rows under it.
//
// Column names are matched with punctuation and case thrown away, so
// "Item #", "ITEM NO." and "item number" are one thing. A header is only a
// header when it names a part column and at least one of quantity, price or
// amount: a stray line reading "Notes | Thanks" is not a table.
import { cellFromText, emptyCell } from './cells.ts';
import type { DocCell, DocLine, DocRow, DocTable, SourceRef } from './types.ts';

/** What a column holds. Everything else in a table is ignored. */
export type TableField = 'item' | 'quantity' | 'unit' | 'price' | 'total' | 'description' | 'needed_by';

// Column names as customers write them. Compared after normalizing, so only
// the words matter.
const ALIASES: Record<TableField, string[]> = {
	item: [
		'item', 'item no', 'item number', 'item code', 'part', 'part no', 'part number', 'parts',
		'sku', 'pn', 'p n', 'mfr part', 'mfr part no', 'manufacturer part', 'northline no',
		'northline part', 'product', 'product code', 'catalog no', 'stock no'
	],
	quantity: [
		'qty', 'quantity', 'qty req', 'qty required', 'qty requested', 'qty needed', 'order qty',
		'qty ordered', 'count', 'pieces', 'pcs', 'ea'
	],
	unit: ['uom', 'unit', 'units', 'u m', 'unit of measure', 'per'],
	price: [
		'price', 'unit price', 'price ea', 'price each', 'unit cost', 'cost', 'your price',
		'net', 'net price', 'list price', 'quoted price'
	],
	total: [
		'total', 'ext', 'ext price', 'ext total', 'extended', 'extended price', 'extension',
		'amount', 'line total', 'line amount'
	],
	description: ['description', 'desc', 'item description', 'part description', 'details', 'notes'],
	needed_by: [
		'need by', 'needed by', 'need date', 'date needed', 'required by', 'required date',
		'want date', 'due', 'due date', 'ship date', 'requested date', 'delivery date'
	]
};

/** Lower case, punctuation to spaces, spaces collapsed: "Item #" -> "item". */
export function normalizeHeader(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

const BY_NAME = new Map<string, TableField>();
for (const [field, names] of Object.entries(ALIASES) as [TableField, string[]][]) {
	for (const name of names) {
		// The first field to claim a name keeps it, so the order above decides
		// ties ("notes" is a description, not a needed-by date).
		if (!BY_NAME.has(name)) BY_NAME.set(name, field);
	}
}

/** Which field a header cell names, or null when it names nothing we use. */
export function headerField(label: string): TableField | null {
	return BY_NAME.get(normalizeHeader(label)) ?? null;
}

/** What each column of a header row holds. */
export function mapHeader(header: string[]): (TableField | null)[] {
	return header.map(headerField);
}

/**
 * True when a row of labels really is a table header: it names a part and at
 * least one number worth reading.
 */
export function looksLikeHeader(fields: (TableField | null)[]): boolean {
	if (!fields.includes('item')) return false;
	return fields.some((f) => f === 'quantity' || f === 'price' || f === 'total');
}

/** Read one column out of a row, by what the column holds. */
export function pick(table: DocTable, row: DocRow, field: TableField): DocCell | null {
	const index = mapHeader(table.header).indexOf(field);
	if (index === -1) return null;
	return row.cells[index] ?? null;
}

const isBlank = (cells: DocCell[]) => cells.every((c) => c.text === '');
const TOTAL_ROW = /\b(sub-?total|grand total|total|order total)\b/i;

/** The largest number in a row, which is what a totals row states. */
function largestNumber(cells: DocCell[]): number | null {
	const numbers = cells.map((c) => c.number).filter((n): n is number => n !== null);
	return numbers.length === 0 ? null : Math.max(...numbers);
}

/**
 * Find a table in a grid of cells (a spreadsheet sheet, or a CSV).
 *
 * The header row is the first row whose labels pass looksLikeHeader. A label
 * may be split over two rows, as a merged header often is ("Part" above
 * "Number"), so a blank label borrows the text from the cell above it.
 *
 * `refFor` turns a row index in the grid into the source reference a person
 * sees, which is why this function never has to know whether it is reading a
 * sheet, a CSV or a page.
 */
export function findGridTable(
	grid: DocCell[][],
	name: string,
	refFor: (rowIndex: number) => SourceRef
): DocTable | null {
	const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
	const at = (r: number, c: number) => grid[r]?.[c] ?? emptyCell();

	for (let h = 0; h < grid.length; h++) {
		// A blank header cell takes the label above it: that is how a header
		// spread over two rows reads to a person.
		const labels: string[] = [];
		for (let c = 0; c < width; c++) {
			labels.push(at(h, c).text || (h > 0 ? at(h - 1, c).text : ''));
		}
		const fields = mapHeader(labels);
		if (!looksLikeHeader(fields)) continue;

		const itemColumn = fields.indexOf('item');
		const rows: DocRow[] = [];
		let statedTotal: number | null = null;
		let blanks = 0;

		for (let r = h + 1; r < grid.length; r++) {
			const cells: DocCell[] = [];
			for (let c = 0; c < width; c++) cells.push(at(r, c));

			if (isBlank(cells)) {
				// One blank row inside a table happens; two means it ended.
				blanks += 1;
				if (blanks >= 2) break;
				continue;
			}
			blanks = 0;

			if (cells[itemColumn].text === '') {
				// A totals row under the table, or a note. Either way it is not
				// a part, and a total is worth keeping.
				const line = cells.map((c) => c.text).join(' ');
				if (TOTAL_ROW.test(line)) statedTotal = largestNumber(cells) ?? statedTotal;
				continue;
			}
			rows.push({ cells, ref: refFor(r) });
		}

		return { name, header: labels, rows, statedTotal };
	}
	return null;
}

// ---------------------------------------------------------------------------
// Tables inside lines of text (a PDF page, a pasted email)
// ---------------------------------------------------------------------------

type Style = 'pipe' | 'tab' | 'space';

function styleOf(line: string): Style {
	if (line.includes('|')) return 'pipe';
	if (line.includes('\t')) return 'tab';
	return 'space';
}

/** Split one line into cells. Two or more spaces is a column gap. */
export function cellsOf(line: string, style: Style): string[] {
	if (style === 'pipe') {
		return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
	}
	if (style === 'tab') return line.split('\t').map((c) => c.trim());
	return line.trim().split(/\s{2,}/).map((c) => c.trim());
}

/** A markdown-style divider under a header row: |---|---|. */
const DIVIDER = /^[\s|:+-]+$/;

/**
 * Find the tables in lines of text. A PDF page keeps its columns as runs of
 * spaces (see pdf.ts), so the same splitting works for a PDF and for a
 * pasted email that used a pipe table.
 */
export function findTextTables(lines: DocLine[], name: string): DocTable[] {
	const tables: DocTable[] = [];

	for (let h = 0; h < lines.length; h++) {
		const style = styleOf(lines[h].text);
		const header = cellsOf(lines[h].text, style);
		if (header.length < 2) continue;
		const fields = mapHeader(header);
		if (!looksLikeHeader(fields)) continue;

		const itemColumn = fields.indexOf('item');
		const rows: DocRow[] = [];
		let statedTotal: number | null = null;
		let r = h + 1;

		for (; r < lines.length; r++) {
			const text = lines[r].text;
			if (text.trim() === '') break;
			if (DIVIDER.test(text)) continue;

			const cells = cellsOf(text, style).map(cellFromText);
			while (cells.length < header.length) cells.push(emptyCell());

			if ((cells[itemColumn]?.text ?? '') === '') {
				if (TOTAL_ROW.test(text)) {
					statedTotal = largestNumber(cells) ?? statedTotal;
					continue;
				}
				break; // the table ended
			}
			rows.push({ cells, ref: lines[r].ref });
		}

		if (rows.length > 0) tables.push({ name, header, rows, statedTotal });
		// Carry on after this table rather than inside it.
		h = r;
	}
	return tables;
}
