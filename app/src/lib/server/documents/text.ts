// Plain text: the paste box on the page, a .txt file, and a .eml file.
//
// These are handed on as lines, with no table detection, on purpose. The
// rules extractor already reads tables written in text (pipes, tabs, wide
// spaces) and it reads them better than a column mapper can, because it
// also understands the words around them ("2 dozen", "a box of 10", "@
// $201.75"). Table detection earns its keep on the formats that really have
// tables: spreadsheets, CSVs and PDFs.
//
// A .eml file keeps its headers, because the email reader downstream
// (../rfq/email.ts) wants them: it is what tells a forwarded request apart
// from a reply.
import { DocumentError, type DocLine, type ParsedDocument } from './types.ts';

/** Windows line endings and a byte order mark are both invisible; remove them. */
export function normalizeText(raw: string): string {
	return raw.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
}

/**
 * A NUL byte means this is not text, whatever the file was called. Refusing
 * here is what stops a renamed binary from being stored as a .txt.
 */
export function refuseBinary(text: string, name: string): void {
	if (text.includes('\0')) {
		throw new DocumentError(`${name} is not a text file; it holds binary data. Save it as plain text and try again.`);
	}
}

/** Lines with their line numbers, 1-based, as an editor counts them. */
export function linesOf(text: string, attachment: number): DocLine[] {
	return normalizeText(text)
		.split('\n')
		.map((line, i) => ({ text: line, ref: { attachment, line: i + 1 } }));
}

export interface TextDocumentInput {
	kind: 'paste' | 'txt' | 'eml';
	name: string;
	attachment: number;
	text: string;
}

export function readTextDocument(input: TextDocumentInput): ParsedDocument {
	const text = normalizeText(input.text);
	refuseBinary(text, input.name);
	if (text.trim() === '') {
		throw new DocumentError(`${input.name} has nothing in it.`);
	}
	const lines = linesOf(text, input.attachment);
	return {
		kind: input.kind,
		name: input.name,
		attachment: input.attachment,
		lines,
		tables: [],
		pageCount: null,
		sheetCount: null,
		rowCount: null,
		summary: `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} of text`
	};
}
