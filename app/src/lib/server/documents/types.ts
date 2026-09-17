// The shapes every document reader returns, so the rest of the app never
// cares which format a request arrived in.
//
// One idea holds this folder together: a reader turns bytes into LINES and,
// where the format has them, TABLES, and every line and every row remembers
// where it came from. That reference ("attachment 2, sheet Quote, row 14")
// is shown next to the extracted line on the page, so a person can always
// go back to the file and check.
//
// This file (like everything the RFQ workflow uses) imports with relative
// paths and .ts extensions, so plain Node scripts can load it without
// SvelteKit.

/** The formats a request can arrive in. 'paste' is the text box on the page. */
export const DOCUMENT_KINDS = ['paste', 'txt', 'eml', 'pdf', 'xlsx', 'xls', 'csv'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** The kinds that are stored as files (the paste box is not a file). */
export const STORED_KINDS = ['txt', 'eml', 'pdf', 'xlsx', 'xls', 'csv'] as const;
export type StoredKind = (typeof STORED_KINDS)[number];

/**
 * What a file of each kind is served as. The server decides this from the
 * kind it detected, never from what the browser claimed the file was.
 * Migration 0020 holds the same pairs in a check constraint.
 */
export const MEDIA_TYPES: Record<StoredKind, string> = {
	txt: 'text/plain',
	eml: 'message/rfc822',
	pdf: 'application/pdf',
	xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	xls: 'application/vnd.ms-excel',
	csv: 'text/csv'
};

/** Where one line or one row came from. */
export interface SourceRef {
	/** 1-based position in the upload; 0 means the paste box on the page. */
	attachment: number;
	/** PDF page, 1-based. */
	page?: number;
	/** Spreadsheet sheet name. */
	sheet?: string;
	/** Line within the page or the file, 1-based. */
	line?: number;
	/** Row within the sheet or the CSV, 1-based (as a spreadsheet counts them). */
	row?: number;
}

/**
 * "attachment 2, sheet Quote, row 14" or "page 1, line 8". Shown on the page
 * next to the line it produced.
 */
export function sourceLabel(ref: SourceRef): string {
	const parts: string[] = [];
	parts.push(ref.attachment === 0 ? 'pasted email' : `attachment ${ref.attachment}`);
	if (ref.page !== undefined) parts.push(`page ${ref.page}`);
	if (ref.sheet !== undefined) parts.push(`sheet ${ref.sheet}`);
	if (ref.row !== undefined) parts.push(`row ${ref.row}`);
	if (ref.line !== undefined) parts.push(`line ${ref.line}`);
	return parts.join(', ');
}

/** One line of readable text, and where it sat. */
export interface DocLine {
	text: string;
	ref: SourceRef;
}

/**
 * One cell, in every form it can be used in. A spreadsheet knows whether a
 * cell is a number or a date; a CSV and a PDF do not, so those are worked
 * out from the text. Whatever the source, a reader downstream can ask for
 * the form it needs without parsing text again.
 */
export interface DocCell {
	/** The cell as a person sees it. */
	text: string;
	/** The value as a number, when it is one. */
	number: number | null;
	/** The value as a calendar date, YYYY-MM-DD, when it is one. */
	date: string | null;
}

export interface DocRow {
	cells: DocCell[];
	ref: SourceRef;
}

/** A table: one header row and the rows under it. */
export interface DocTable {
	/** A sheet name, or the file name for a CSV, or "page 1" for a PDF. */
	name: string;
	/** The header cells as written, in order. */
	header: string[];
	rows: DocRow[];
	/** A total the file states under the table, if it states one. */
	statedTotal: number | null;
}

/** What a reader makes of one document. */
export interface ParsedDocument {
	kind: DocumentKind;
	/** The file name, or 'pasted email'. */
	name: string;
	/** 1-based position in the upload; 0 for the paste box. */
	attachment: number;
	/** Every readable line, in order, each with its source reference. */
	lines: DocLine[];
	/** The tables found in it. Empty for plain text. */
	tables: DocTable[];
	pageCount: number | null;
	sheetCount: number | null;
	/** Data rows read out of tables (not lines of text). */
	rowCount: number | null;
	/** One short line for the attachments panel: "3 sheets, 42 rows". */
	summary: string;
}

/** The lines of a document as one block of text. */
export function documentText(doc: ParsedDocument): string {
	return doc.lines.map((l) => l.text).join('\n');
}

/**
 * A file we will not read, with the reason a person sees. Thrown by the
 * readers and turned into a message at the edge (see read.ts).
 */
export class DocumentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DocumentError';
	}
}

/** The message an image-only PDF gets. Named so the test and the code agree. */
export const SCANNED_PDF_MESSAGE =
	'This PDF has no text in it; it is probably a scan. Paste the request as text, or ask for the spreadsheet.';

/** Caps, from the brief: four files a draft, ten megabytes a file. */
export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
