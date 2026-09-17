// One emailed request, read out of everything that arrived with it.
//
// The rule, from the brief: when a document has a table, the table wins. A
// spreadsheet, a CSV and most printed purchase orders say what they mean in
// columns, and reading columns is exact. Prose is where an extractor has to
// guess, so prose is where the extractor (rules or Claude) is used.
//
// Each document is read on its own rather than as one long block of text,
// because an email is not a spreadsheet: the email reader looks for headers
// at the top and a sign-off at the bottom (../rfq/email.ts), and gluing a
// covering note to a parts list would put the parts list under the sign-off,
// where a signature is not read as a request. One document, one reading.
//
// So, per document:
//   * tables found  -> the lines come from the table's rows, no extractor,
//   * no tables     -> the lines come from the extractor reading its text.
//
// The facts that are not lines (who sent it, which company, the needed-by
// date, the shipping notes) come from the first document, which is the
// covering email. Anything it does not say, a later document may fill in.
//
// Every line records where it came from, and the page shows it next to the
// line. A person who doubts a figure can go straight to "attachment 2,
// sheet Quote, row 14" and look.
import { extract, type ExtractOptions } from '../rfq/extract.ts';
import type { DraftLine, Extraction, RfqDraft, TextField, Usage } from '../rfq/schema.ts';
import { numberFromText } from './cells.ts';
import { pick } from './tables.ts';
import {
	documentText,
	sourceLabel,
	type DocLine,
	type DocRow,
	type DocTable,
	type ParsedDocument
} from './types.ts';

/** The draft column holds 100,000 characters; stop a little short of it. */
export const MAX_SOURCE_CHARS = 99_000;

const field = <T,>(value: T | null, confidence: number) =>
	value === null ? { value: null, confidence: 0 } : { value, confidence };

/** A quantity cell that also carries its unit: "4 ea", "2 pair", "3 dozen". */
function quantityAndUnit(text: string): { quantity: number | null; unit: string | null } {
	const match = text.trim().match(/^([\d,]+(?:\.\d+)?)\s*([A-Za-z][A-Za-z. ]*)?$/);
	if (!match) return { quantity: numberFromText(text), unit: null };
	const unit = match[2]?.trim().replace(/\.$/, '').toLowerCase() ?? '';
	return { quantity: numberFromText(match[1]), unit: unit === '' ? null : unit };
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
	const itemNo = pick(table, row, 'item')?.text.trim() ?? '';
	if (itemNo === '') return null;

	const quantityCell = pick(table, row, 'quantity');
	const fromCell = quantityCell ? quantityAndUnit(quantityCell.text) : { quantity: null, unit: null };
	const quantity = quantityCell?.number ?? fromCell.quantity;
	const unit = pick(table, row, 'unit')?.text.trim().toLowerCase() || fromCell.unit;

	return {
		raw_text: rowText(row),
		// A column said this is the part number, so there is no guesswork in
		// reading it as one. Whether the catalog has it is validation's job.
		item_no: field(itemNo, 0.95),
		quantity: field(quantity, quantity === null ? 0 : 0.95),
		unit: field(unit && unit !== '' ? unit : null, 0.9),
		unit_price: field(pick(table, row, 'price')?.number ?? null, 0.9),
		line_total: field(pick(table, row, 'total')?.number ?? null, 0.9),
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

/**
 * Which line of a document a draft line came from.
 *
 * The extractor reports each line's text as it was written, so the line it
 * came from is the first line of the document that holds that text. The
 * cursor only moves forward, which keeps two identical rows apart, and it
 * does not move past the match, because one line of text can hold two parts
 * ("4 x A and 2 x B").
 */
function withSources(lines: DraftLine[], doc: ParsedDocument): DraftLine[] {
	let cursor = 0;
	return lines.map((line) => {
		const needle = line.raw_text.split('\n')[0].trim();
		let found: DocLine | null = null;
		if (needle !== '') {
			for (let i = cursor; i < doc.lines.length; i++) {
				if (doc.lines[i].text.includes(needle)) {
					found = doc.lines[i];
					cursor = i;
					break;
				}
			}
		}
		// A model never fills this in (it cannot know where a line sat), so
		// whatever came back is replaced with what the reader knows.
		return { ...line, source: found ? sourceLabel(found.ref) : sourceLabel({ attachment: doc.attachment }) };
	});
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
 * Every document's lines, one after another, with a heading naming each
 * attachment. This is what is stored as the draft's source, so what a person
 * sees under "the request as received" is exactly what was read.
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

/** Token counts across however many extractor calls one request took. */
function addUsage(a: Usage | null, b: Usage | null): Usage | null {
	if (!a) return b;
	if (!b) return a;
	return {
		input_tokens: a.input_tokens + b.input_tokens,
		output_tokens: a.output_tokens + b.output_tokens,
		cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
		cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens
	};
}

/** Take a value from a later document only when the covering email had none. */
function orElse(first: TextField, later: TextField | undefined): TextField {
	return first.value !== null || !later ? first : later;
}

export interface RequestExtraction extends Extraction {
	/** The combined text of every document, as stored with the draft. */
	sourceText: string;
	/** How many extractor calls this request took (one per prose document). */
	extractorCalls: number;
}

/**
 * Read one request out of its documents. `options` is the same object the
 * page already builds for the rules or the Claude extractor.
 *
 * A document with a table costs no extractor call at all, which is why a
 * spreadsheet or a printed purchase order is both the cheapest and the most
 * exact thing a customer can send.
 */
export async function extractRequest(
	documents: ParsedDocument[],
	options: ExtractOptions
): Promise<RequestExtraction> {
	if (documents.length === 0) {
		throw new Error('extractRequest needs at least one document.');
	}

	// The covering email: the first document, whether that is the paste box or
	// the only file attached.
	const primary = documents[0];
	const base = await extract(documentText(primary), options);
	let usage = base.usage;
	let calls = 1;

	const lines: DraftLine[] = [];
	// What a later document can fill in when the covering email did not say.
	const spare: Extraction['draft'][] = [];

	for (const doc of documents) {
		if (doc.tables.length > 0) {
			lines.push(...linesFromTables(doc));
			continue;
		}
		if (doc === primary) {
			lines.push(...withSources(base.draft.lines, doc));
			continue;
		}
		// Prose in an attachment: read it the same way the covering email was.
		const extra = await extract(documentText(doc), options);
		usage = addUsage(usage, extra.usage);
		calls += 1;
		spare.push(extra.draft);
		lines.push(...withSources(extra.draft.lines, doc));
	}

	const draft: RfqDraft = { ...base.draft, lines };

	// Fill the gaps the covering email left, from the attachments, in order.
	for (const other of spare) {
		draft.sender_email = orElse(draft.sender_email, other.sender_email);
		draft.sender_name = orElse(draft.sender_name, other.sender_name);
		draft.customer_name = orElse(draft.customer_name, other.customer_name);
		draft.branch_hint = orElse(draft.branch_hint, other.branch_hint);
		if (draft.needed_by.value === null) {
			draft.needed_by = other.needed_by;
			draft.needed_by_text = other.needed_by_text;
		}
		if (draft.stated_subtotal.value === null) draft.stated_subtotal = other.stated_subtotal;
		if (draft.notes === '') draft.notes = other.notes;
	}

	// A table's own total and dates fill in what the prose did not say.
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
		draft,
		extractor: base.extractor,
		model: base.model,
		usage,
		sourceText: combinedText(documents),
		extractorCalls: calls
	};
}

/** What to call this draft in a list. */
export function nameOf(documents: ParsedDocument[]): string {
	const files = documents.filter((d) => d.kind !== 'paste');
	if (files.length === 0) return 'pasted email';
	if (files.length === 1) return files[0].name;
	return `${files[0].name} and ${files.length - 1} more`;
}
