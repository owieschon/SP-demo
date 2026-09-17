// A CSV parts list.
//
// The splitting is the ERP reader's (../exports/csv.ts): one CSV reader for
// the whole app, already tested against byte order marks, quoted fields that
// hold commas and line breaks, and mixed line endings. This file only turns
// its records into the grid of cells the table finder works on.
import { parseCsv } from '../exports/csv.ts';
import { cellFromText } from './cells.ts';
import { findGridTable } from './tables.ts';
import { DocumentError, type DocCell, type DocLine, type ParsedDocument, type SourceRef } from './types.ts';
import { normalizeText, refuseBinary } from './text.ts';

export interface CsvDocumentInput {
	name: string;
	attachment: number;
	text: string;
}

export function readCsvDocument(input: CsvDocumentInput): ParsedDocument {
	const text = normalizeText(input.text);
	refuseBinary(text, input.name);

	const records = parseCsv(text);
	if (records.length === 0) {
		throw new DocumentError(`${input.name} has no rows in it.`);
	}

	const grid: DocCell[][] = records.map((record) => record.map(cellFromText));
	// A spreadsheet counts the first record as row 1, and so does a person
	// looking at the file, so the row number is the index plus one.
	const refFor = (rowIndex: number): SourceRef => ({ attachment: input.attachment, row: rowIndex + 1 });
	const table = findGridTable(grid, input.name, refFor);

	// Every record also travels as a line of text, so the text reader can fall
	// back to it when no header row was recognized.
	const lines: DocLine[] = records.map((record, i) => ({
		text: record.join(' | '),
		ref: refFor(i)
	}));

	const rowCount = table ? table.rows.length : 0;
	return {
		kind: 'csv',
		name: input.name,
		attachment: input.attachment,
		lines,
		tables: table ? [table] : [],
		pageCount: null,
		sheetCount: null,
		rowCount,
		summary: table
			? `${rowCount} ${rowCount === 1 ? 'row' : 'rows'} under ${table.header.filter(Boolean).length} columns`
			: `${records.length} ${records.length === 1 ? 'row' : 'rows'}, no header row recognized`
	};
}
