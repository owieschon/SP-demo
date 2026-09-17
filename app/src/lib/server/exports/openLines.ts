// The "open sales lines" export, read with its source profile and turned
// into typed lines. All the reading rules live in the profile (profile.ts)
// and the generic reader (reader.ts); this file only gives the rows names
// and types.
import { headersOf, OPEN_SALES_LINES_PROFILE } from './profile.ts';
import { readExport, type ReadRow, type RowProblem } from './reader.ts';
import type { Refusal } from '$lib/components/exports/types';

export type { RowProblem } from './reader.ts';

/** The header row of a correct file, in the ERP's order. */
export const OPEN_LINES_HEADERS = headersOf(OPEN_SALES_LINES_PROFILE);

/** A row that passed every check the file can make on its own. */
export interface OpenLine {
	rowNo: number;
	documentNo: string;
	lineNo: number;
	customerNo: string;
	itemNo: string;
	description: string;
	shipDate: string;
	quantity: number;
	unitPrice: number;
	lineAmount: number | null;
	locationCode: string;
}

export interface OpenLinesFile {
	fileName: string;
	hash: string;
	rowCount: number;
	lines: OpenLine[];
	problems: RowProblem[];
	ignoredColumns: string[];
}

export type OpenLinesResult = { ok: true; file: OpenLinesFile } | { ok: false; refusal: Refusal };

export function readOpenLines(fileName: string, text: string): OpenLinesResult {
	const result = readExport(OPEN_SALES_LINES_PROFILE, fileName, text);
	if (!result.ok) return result;
	const { rows, ...rest } = result.file;
	return { ok: true, file: { ...rest, lines: rows.map(toOpenLine) } };
}

// The reader has already checked every value against the profile, so these
// casts only name what is there.
function toOpenLine({ rowNo, values: v }: ReadRow): OpenLine {
	return {
		rowNo,
		documentNo: v.documentNo as string,
		lineNo: v.lineNo as number,
		customerNo: v.customerNo as string,
		itemNo: v.itemNo as string,
		description: v.description as string,
		shipDate: v.shipDate as string,
		quantity: v.quantity as number,
		unitPrice: v.unitPrice as number,
		lineAmount: v.lineAmount as number | null,
		locationCode: v.locationCode as string
	};
}

/** A good line back in the file's words, for a row that turns out to be a problem after all. */
export function describe(line: OpenLine): Record<string, string> {
	const f = OPEN_SALES_LINES_PROFILE.fields;
	return {
		[f.documentNo.label]: line.documentNo,
		[f.lineNo.label]: String(line.lineNo),
		[f.customerNo.label]: line.customerNo,
		[f.itemNo.label]: line.itemNo,
		[f.description.label]: line.description,
		[f.shipDate.label]: line.shipDate,
		[f.quantity.label]: String(line.quantity),
		[f.unitPrice.label]: line.unitPrice.toFixed(2),
		[f.lineAmount.label]: line.lineAmount === null ? '' : line.lineAmount.toFixed(2),
		[f.locationCode.label]: line.locationCode
	};
}
