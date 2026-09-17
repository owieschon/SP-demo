// PDFs: a request that arrived as a printed purchase order or a quote form.
//
// PDF.js (through unpdf, which ships a build made for serverless functions
// and needs no native module) hands back every piece of text on a page with
// the position it was drawn at. A PDF has no idea what a "line" is, so the
// lines are rebuilt here:
//
//   * pieces drawn at about the same height are one line,
//   * within a line they are ordered left to right,
//   * the gap between two pieces becomes spaces, and a gap wide enough to be
//     a column becomes two or more of them.
//
// That last rule is the whole point: two or more spaces is what the table
// finder reads as a column break (see tables.ts), so a table in a PDF comes
// out row by row and column by column instead of as a word soup.
//
// A PDF with no text at all is a scan. There is nothing to read in it, so it
// is refused with a message that says so, rather than quietly producing an
// empty draft.
import { extractTextItems, type StructuredTextItem } from 'unpdf';
import { findTextTables } from './tables.ts';
import {
	DocumentError,
	SCANNED_PDF_MESSAGE,
	type DocLine,
	type DocTable,
	type ParsedDocument
} from './types.ts';

/** Two pieces of text within this many points of each other are on one line. */
const LINE_TOLERANCE = 2.5;
/** A gap this many spaces wide or more is a column break, not a word break. */
const COLUMN_SPACES = 2;
/** Never pad more than this, whatever the gap: a page is not a spreadsheet. */
const MAX_PAD = 12;

/** How wide a space is in a font of this size, near enough for gap counting. */
function spaceWidth(fontSize: number): number {
	return Math.max(fontSize, 6) * 0.28;
}

/** Group one page's pieces of text into lines, top to bottom. */
export function linesFromItems(items: StructuredTextItem[]): string[] {
	const real = items.filter((item) => item.str !== '');
	if (real.length === 0) return [];

	// Highest on the page first. PDF coordinates count upwards from the
	// bottom, so a bigger y is nearer the top.
	const sorted = [...real].sort((a, b) => b.y - a.y || a.x - b.x);

	const groups: StructuredTextItem[][] = [];
	let current: StructuredTextItem[] = [sorted[0]];
	let currentY = sorted[0].y;
	for (const item of sorted.slice(1)) {
		if (Math.abs(item.y - currentY) <= LINE_TOLERANCE) {
			current.push(item);
		} else {
			groups.push(current);
			current = [item];
			currentY = item.y;
		}
	}
	groups.push(current);

	return groups.map((group) => {
		const ordered = [...group].sort((a, b) => a.x - b.x);
		let text = ordered[0].str;
		let right = ordered[0].x + ordered[0].width;
		for (const item of ordered.slice(1)) {
			const space = spaceWidth(item.fontSize);
			const gap = item.x - right;
			if (gap >= space * 1.5) {
				// A real gap: as many spaces as it is wide, at least two, so the
				// table finder sees a column break here.
				const pad = Math.min(MAX_PAD, Math.max(COLUMN_SPACES, Math.round(gap / space)));
				text += ' '.repeat(pad);
			} else if (gap >= space * 0.35 && !/\s$/.test(text) && !/^\s/.test(item.str)) {
				text += ' ';
			}
			text += item.str;
			right = item.x + item.width;
		}
		return text.trimEnd();
	});
}

export interface PdfInput {
	name: string;
	attachment: number;
	bytes: Uint8Array;
}

export async function readPdfDocument(input: PdfInput): Promise<ParsedDocument> {
	let pages: StructuredTextItem[][];
	let totalPages: number;
	try {
		// A copy, because PDF.js takes ownership of the array it is given and
		// the same bytes are stored in the database afterwards.
		const result = await extractTextItems(new Uint8Array(input.bytes));
		pages = result.items;
		totalPages = result.totalPages;
	} catch (error) {
		const message = error instanceof Error ? error.message : '';
		if (/password/i.test(message)) {
			throw new DocumentError(`${input.name} is password protected. Send it without the password, or paste the text.`);
		}
		throw new DocumentError(`${input.name} could not be read as a PDF. It may be damaged; ask for it again.`);
	}

	const lines: DocLine[] = [];
	const tables: DocTable[] = [];
	let rowCount = 0;

	pages.forEach((items, index) => {
		const page = index + 1;
		const pageLines: DocLine[] = linesFromItems(items).map((text, i) => ({
			text,
			ref: { attachment: input.attachment, page, line: i + 1 }
		}));
		lines.push(...pageLines);
		for (const table of findTextTables(pageLines, `page ${page}`)) {
			tables.push(table);
			rowCount += table.rows.length;
		}
	});

	if (lines.every((line) => line.text.trim() === '')) {
		throw new DocumentError(SCANNED_PDF_MESSAGE);
	}

	const pageWord = totalPages === 1 ? 'page' : 'pages';
	const rowWord = rowCount === 1 ? 'row' : 'rows';
	return {
		kind: 'pdf',
		name: input.name,
		attachment: input.attachment,
		lines,
		tables,
		pageCount: totalPages,
		sheetCount: null,
		rowCount,
		summary:
			tables.length > 0
				? `${totalPages} ${pageWord}, ${rowCount} ${rowWord}`
				: `${totalPages} ${pageWord} of text, no table found`
	};
}
