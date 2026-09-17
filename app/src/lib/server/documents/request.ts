// One emailed request, read out of everything that arrived with it.
//
// The rule, from the brief: when a document has a table, the table wins. A
// spreadsheet, a CSV and most PDF purchase orders say what they mean in
// columns, and reading columns is exact. Prose is where an extractor has to
// guess, so prose is where the extractor (rules or Claude) is used.
//
// So, per document:
//   * tables found  -> the lines come from the table's rows,
//   * no tables     -> the lines come from the extractor reading its text.
//
// The non-line facts (who sent it, which company, the needed-by date, the
// shipping notes) always come from the extractor reading everything at once,
// because those live in the covering email far more often than in the
// attachment.
//
// Every line records where it came from, and the page shows it next to the
// line. A person who doubts a figure can go straight to "attachment 2,
// sheet Quote, row 14" and look.
import { extract, type ExtractOptions } from '../rfq/extract.ts';
import type { DraftLine, Extraction, RfqDraft } from '../rfq/schema.ts';
import { numberFromText } from './cells.ts';
import { pick } from './tables.ts';
import { sourceLabel, type DocLine, type DocRow, type DocTable, type ParsedDocument } from './types.ts';

/** The draft column holds 100,000 characters; stop a little short of it. */
export const MAX_SOURCE_CHARS = 99_000;

const field = <T,>(value: T | null, confidence: number) =>
	value === null ? { value: null, confidence: 0 } : { value, confidence };

/** A quantity cell that also carries its unit: "4 ea", "2 pair", "3 dozen". */
function quantityAndUnit(text: string): { quantity: number | null; unit: string | null } {
	const match = text.trim().match(/^([\d,]+(?:\.\d+)?)\s*([A-Za-z][A-Za-z. ]*)?$/);
	if (!match) return { quantity: numberFromText(text), unit: null };
	const quantity = numberFromText(match[1]);
	const unit = match[2]?.trim().replace(/\.$/, '') ?? null;
	return { quantity, unit: unit && unit !== '' ? unit.toLowerCase() : null };
}

/** How a table row reads back to a person: its filled cells, in order. */
function rowText(row: DocRow): string {
	return row.cells
		.map((c) => c.text)
		.filter((text) => text !== '')
		.join(' | ');
}

/** One table row as a draft line, or null when the row names no part. */
export function lineFromRow(table: DocTable, row: DocRow): DraftLine | null {
	const itemCell = pick(table, row, 'item');
	const itemNo = itemCell?.text.trim() ?? '';
	if (itemNo === '') return null;

	const quantityCell = pick(table, row, 'quantity');
	const fromCell = quantityCell ? quantityAndUnit(quantityCell.text) : { quantity: null, unit: null };
	const quantity = quantityCell?.number ?? fromCell.quantity;
	const unit = pick(table, row, 'unit')?.text.trim().toLowerCase() || fromCell.unit;

	const price = pick(table, row, 'price');
	const total = pick(table, row, 'total');

	return {
		raw_text: rowText(row),
		// A column said this is the part number, so there is no guesswork in
		// reading it as one. Whether the catalog has it is validation's job.
		item_no: field(itemNo, 0.95),
		quantity: field(quantity, quantity === null ? 0 : 0.95),
		unit: field(unit && unit !== '' ? unit : null, 0.9),
		unit_price: field(price?.number ?? null, 0.9),
		line_total: field(total?.number ?? null, 0.9),
		source: sourceLabel(row.ref)
	};
}

/** Every table row of one document, as draft lines. */
function linesFromTables(doc: ParsedDocument): DraftLine[] {
	const lines: DraftLine[] = [];
	for (const table of doc.tables) {
		for (const row of table.rows) {
			const line = lineFromRow(table, row);
			if (line) lines.push(line);
		}
	}
	return lines;
}

/** The earliest needed-by date any table row names. */
function neededByFromTables(documents: ParsedDocument[]): string | null {
	const dates: string[] = [];
	for (const doc of documents) {
		for (const table of doc.tables) {
			for (const row of table.rows) {
				const cell = pick(table, row, 'needed_by');
				if (cell?.date) dates.push(cell.date);
			}
		}
	}
	return dates.length === 0 ? null : dates.sort()[0];
}

/** The total a document states under its table. */
function statedTotalFromTables(documents: ParsedDocument[]): number | null {
	for (const doc of documents) {
		for (const table of doc.tables) {
			if (table.statedTotal !== null) return table.statedTotal;
		}
	}
	return null;
}

/**
 * Every document's lines, one after another, with a blank line between them
 * and a heading naming each attachment. This is what the extractor reads and
 * what is stored as the draft's source, so what a person sees under "the
 * email as received" is exactly what was read.
 */
export function combineLines(documents: ParsedDocument[]): DocLine[] {
	const lines: DocLine[] = [];
	documents.forEach((doc, i) => {
		if (i > 0) {
			lines.push({ text: '', ref: { attachment: doc.attachment } });
			lines.push({
				text: `--- attachment ${doc.attachment}: ${doc.name} (${doc.summary}) ---`,
				ref: { attachment: doc.attachment }
			});
			lines.push({ text: '', ref: { attachment: doc.attachment } });
		}
		lines.push(...doc.lines);
	});
	return lines;
}

/** The combined text, cut to what the draft column holds. */
export function combinedText(documents: ParsedDocument[]): string {
	const text = combineLines(documents)
		.map((l) => l.text)
		.join('\n');
	if (text.length <= MAX_SOURCE_CHARS) return text;
	return `${text.slice(0, MAX_SOURCE_CHARS)}\n\n[The rest was longer than this app stores and was not read.]`;
}

/**
 * Which line of the combined text a draft line came from.
 *
 * The extractor reports each line's text as it was written, so the line it
 * came from is the first combined line that holds that text. The cursor only
 * moves forward, which keeps two identical rows apart, and it does not move
 * past the match, because one line of text can hold two parts ("4 x A and 2
 * x B").
 */
function refOfText(rawText: string, lines: DocLine[], from: number): { index: number; ref: DocLine['ref'] | null } {
	const needle = rawText.split('\n')[0].trim();
	if (needle === '') return { index: from, ref: null };
	for (let i = from; i < lines.length; i++) {
		if (lines[i].text.includes(needle)) return { index: i, ref: lines[i].ref };
	}
	// Not found ahead: it may be a line the reader reordered. Look everywhere.
	for (let i = 0; i < from; i++) {
		if (lines[i].text.includes(needle)) return { index: i, ref: lines[i].ref };
	}
	return { index: from, ref: null };
}

export interface RequestExtraction extends Extraction {
	/** The combined text of every document, as stored with the draft. */
	sourceText: string;
	/** A name for the draft: "quote.xlsx and 1 more", or "pasted email". */
	sourceName: string;
}

/**
 * Read one request out of its documents. `options` is the same object the
 * page already builds for the rules or the Claude extractor.
 */
export async function extractRequest(
	documents: ParsedDocument[],
	options: ExtractOptions
): Promise<RequestExtraction> {
	if (documents.length === 0) {
		throw new Error('extractRequest needs at least one document.');
	}

	const lines = combineLines(documents);
	const sourceText = combinedText(documents);
	const base = await extract(sourceText, options);

	// Give every extracted line the source reference of the line of text it
	// came from, so a line can be traced back to its document.
	// A model never fills this in (it cannot know), so whatever came back is
	// replaced with what the readers know.
	let cursor = 0;
	const fromText = base.draft.lines.map((line) => {
		const found = refOfText(line.raw_text, lines, cursor);
		cursor = found.index;
		return {
			line: { ...line, source: found.ref ? sourceLabel(found.ref) : undefined },
			attachment: found.ref?.attachment ?? documents[0].attachment
		};
	});

	// Per document, in the order the documents arrived: its table rows when it
	// has any, otherwise the lines the extractor read out of its text.
	const combined: DraftLine[] = [];
	for (const doc of documents) {
		const tableLines = linesFromTables(doc);
		if (tableLines.length > 0) {
			combined.push(...tableLines);
		} else {
			combined.push(...fromText.filter((f) => f.attachment === doc.attachment).map((f) => f.line));
		}
	}

	const draft: RfqDraft = { ...base.draft, lines: combined };

	// A table's own total and dates fill in what the covering email did not say.
	if (draft.stated_subtotal.value === null) {
		const stated = statedTotalFromTables(documents);
		if (stated !== null) draft.stated_subtotal = { value: stated, confidence: 0.9 };
	}
	if (draft.needed_by.value === null) {
		const date = neededByFromTables(documents);
		if (date !== null) {
			draft.needed_by = { value: date, confidence: 0.9 };
			draft.needed_by_text = { value: date, confidence: 0.9 };
		}
	}
	draft.is_request = draft.is_request || draft.lines.length > 0;

	return {
		...base,
		draft,
		sourceText,
		sourceName: nameOf(documents)
	};
}

/** What to call this draft in a list. */
export function nameOf(documents: ParsedDocument[]): string {
	const files = documents.filter((d) => d.kind !== 'paste');
	if (files.length === 0) return 'pasted email';
	if (files.length === 1) return files[0].name;
	return `${files[0].name} and ${files.length - 1} more`;
}
