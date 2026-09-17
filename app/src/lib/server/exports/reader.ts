// Reading any ERP export described by a source profile (profile.ts): match
// the headers, read and check every cell, find duplicate keys, and
// fingerprint the data. It knows nothing about any particular report.
//
// Plain TypeScript with no database, so it is quick to test. Checks that
// need the database (does this customer exist?) come afterwards.
import { createHash } from 'node:crypto';
import type { Refusal } from '$lib/components/exports/types';
import { parseCsv } from './csv.ts';
import { headersOf, type FieldSpec, type SourceProfile } from './profile.ts';
import { cents, headerKey, parseDate, parseNumber } from './values.ts';

/** A cell's value after reading: text for text, codes and dates, a number for numbers. */
export type CellValue = string | number | null;

/** A row that passed every check, keyed by the profile's field names. */
export interface ReadRow {
	rowNo: number;
	values: Record<string, CellValue>;
}

/** A row that did not, with every reason and its cells as they were. */
export interface RowProblem {
	rowNo: number;
	/** The key fields' cells, as text, so the row can be found in the file. */
	key: string[];
	reasons: string[];
	/** The row's cells by ERP header name. */
	raw: Record<string, string>;
}

export interface ReadFile {
	fileName: string;
	/** SHA-256 of the normalized rows (see fingerprint()). */
	hash: string;
	rowCount: number;
	rows: ReadRow[];
	problems: RowProblem[];
	/** Headers in the file that the profile does not use. */
	ignoredColumns: string[];
}

export type ReadResult = { ok: true; file: ReadFile } | { ok: false; refusal: Refusal };

/** Which column holds each of a profile's fields, and which of them are missing. */
interface HeaderMatch {
	/** Field name to column index. The first matching header wins. */
	columnOf: Map<string, number>;
	/** Required fields with no column, by field name. */
	missing: string[];
}

function matchHeaders(profile: SourceProfile, header: string[]): HeaderMatch {
	const fieldNames = Object.keys(profile.fields);
	const columnOf = new Map<string, number>();
	header.forEach((name, index) => {
		const key = headerKey(name);
		const field = fieldNames.find((f) => !columnOf.has(f) && profile.fields[f].aliases.includes(key));
		if (field) columnOf.set(field, index);
	});
	return { columnOf, missing: fieldNames.filter((f) => profile.fields[f].required && !columnOf.has(f)) };
}

/**
 * Which report an uploaded file is. A profile is a candidate when every
 * column it needs is there; with more than one candidate (they do not
 * overlap today, but a future report might), the one that recognizes the
 * most columns wins. When nothing matches, the closest profile is the one
 * missing the fewest columns, and its refusal is what the person sees.
 */
export function detectReport(
	profiles: SourceProfile[],
	fileName: string,
	text: string
): { ok: true; profile: SourceProfile; file: ReadFile } | { ok: false; refusal: Refusal } {
	const [header = [], ...records] = parseCsv(text);
	const headers = header.map((h) => h.trim()).filter(Boolean);
	const matches = profiles.map((profile) => ({ profile, ...matchHeaders(profile, header) }));

	const candidates = matches
		.filter((m) => m.missing.length === 0)
		.sort((a, b) => b.columnOf.size - a.columnOf.size);
	const chosen = candidates[0];
	if (headers.length > 0 && chosen) {
		const result = readRows(chosen.profile, fileName, chosen.columnOf, headers, header, records);
		return result.ok ? { ok: true, profile: chosen.profile, file: result.file } : result;
	}

	// Nothing matched: say what the file is closest to and what it lacks.
	const closest = [...matches].sort((a, b) => a.missing.length - b.missing.length)[0];
	const labels = closest.missing.map((f) => closest.profile.fields[f].label);
	return {
		ok: false,
		refusal: {
			fileName,
			message:
				headers.length === 0
					? 'The file is empty.'
					: `This is not the ${closest.profile.name}: it has no ${labels.join(', ')} column${labels.length > 1 ? 's' : ''}.`,
			missing: headers.length === 0 ? headersOf(closest.profile) : labels,
			headers,
			// The guess is about the file, so it looks through what every
			// profile knows people upload by mistake, not only the closest one.
			looksLike: profiles.map((p) => guessReport(p, headers)).find((name) => name !== null) ?? null
		}
	};
}

/**
 * Read an export that is known to be of one report. Refuses the file
 * (nothing will be written) when it is empty, has no data rows, or lacks a
 * required column. Otherwise splits the rows into good rows and problems.
 */
export function readExport(profile: SourceProfile, fileName: string, text: string): ReadResult {
	const [header = [], ...records] = parseCsv(text);
	const headers = header.map((h) => h.trim()).filter(Boolean);
	const { columnOf, missing } = matchHeaders(profile, header);

	if (headers.length === 0 || missing.length > 0) {
		const labels = missing.map((f) => profile.fields[f].label);
		return {
			ok: false,
			refusal: {
				fileName,
				message:
					headers.length === 0
						? 'The file is empty.'
						: `This is not the ${profile.name}: it has no ${labels.join(', ')} column${labels.length > 1 ? 's' : ''}.`,
				missing: headers.length === 0 ? headersOf(profile) : labels,
				headers,
				looksLike: guessReport(profile, headers)
			}
		};
	}
	return readRows(profile, fileName, columnOf, headers, header, records);
}

/** The rows of a file whose report is known and whose columns are all there. */
function readRows(
	profile: SourceProfile,
	fileName: string,
	columnOf: Map<string, number>,
	headers: string[],
	header: string[],
	records: string[][]
): ReadResult {
	const fieldNames = Object.keys(profile.fields);
	const usedColumns = new Set(columnOf.values());

	if (records.length === 0) {
		return {
			ok: false,
			refusal: {
				fileName,
				message: 'The file has the right columns but no data rows. Was the export filtered to nothing?',
				missing: [],
				headers,
				looksLike: null
			}
		};
	}

	const rows: ReadRow[] = [];
	const problems: RowProblem[] = [];
	const canonical: string[][] = [];

	records.forEach((cells, index) => {
		// Row 1 is the header, as a spreadsheet would number it.
		const rowNo = index + 2;
		const cellOf = (field: string) => {
			const column = columnOf.get(field);
			return column === undefined ? '' : (cells[column] ?? '').trim();
		};

		const values: Record<string, CellValue> = {};
		const reasons: string[] = [];
		const normalized: string[] = [];
		for (const field of fieldNames) {
			const cell = cellOf(field);
			const read = readCell(profile, profile.fields[field], cell, columnOf.has(field));
			values[field] = read.value;
			if (read.problem) reasons.push(read.problem);
			// The fingerprint uses the normalized value when there is one, and
			// the cell's text when there is not, so a corrected cell changes it.
			normalized.push(read.canonical ?? cell);
		}
		canonical.push(normalized);

		if (reasons.length > 0) {
			const raw = Object.fromEntries(
				fieldNames.filter((f) => columnOf.has(f)).map((f) => [profile.fields[f].label, cellOf(f)])
			);
			problems.push({ rowNo, key: profile.key.map(cellOf), reasons, raw });
		} else {
			rows.push({ rowNo, values });
		}
	});

	const duplicates = removeDuplicateKeys(profile, rows);

	return {
		ok: true,
		file: {
			fileName,
			hash: fingerprint(profile, canonical),
			rowCount: records.length,
			rows,
			problems: [...problems, ...duplicates].sort((a, b) => a.rowNo - b.rowNo),
			ignoredColumns: header.map((h, i) => (usedColumns.has(i) ? '' : h.trim())).filter(Boolean)
		}
	};
}

interface CellRead {
	value: CellValue;
	/** The value in canonical text form, or null when it could not be read. */
	canonical: string | null;
	problem: string | null;
}

/** Read and check one cell against its field's spec. */
function readCell(profile: SourceProfile, spec: FieldSpec, cell: string, present: boolean): CellRead {
	const bad = (problem: string): CellRead => ({ value: null, canonical: null, problem });

	if (cell === '') {
		// An optional column that is missing or blank reads as empty text or null.
		if (!spec.required || spec.blankAllowed) {
			const value = spec.kind === 'text' || spec.kind === 'code' ? '' : null;
			return { value, canonical: '', problem: null };
		}
		return bad(present ? `${spec.label} is blank.` : `${spec.label} is missing.`);
	}

	if (spec.kind === 'text' || spec.kind === 'code') {
		const value = spec.kind === 'code' ? cell.toUpperCase() : cell;
		if (spec.maxLength !== undefined && value.length > spec.maxLength) {
			return bad(`${spec.label} is longer than ${spec.maxLength} characters.`);
		}
		return { value, canonical: value, problem: null };
	}

	if (spec.kind === 'date') {
		const value = parseDate(cell, profile.dates);
		return value ? { value, canonical: value, problem: null } : bad(`${spec.label} "${cell}" is not a date.`);
	}

	const number = parseNumber(cell, profile.numbers);
	if (number === null) return bad(`${spec.label} "${cell}" is not a number.`);
	if (spec.kind === 'whole' && !Number.isInteger(number)) {
		return bad(`${spec.label} ${number} is not a whole number.`);
	}
	const value = spec.kind === 'money' ? cents(number) : number;
	const canonical = spec.kind === 'money' ? value.toFixed(2) : String(value);
	const limit = (problem: string): CellRead => ({ value: null, canonical, problem });

	if (spec.above !== undefined && value <= spec.above) {
		return limit(`${spec.label} is ${value}; it must be more than ${spec.above === 0 ? 'zero' : spec.above}.`);
	}
	if (spec.atLeast !== undefined && value < spec.atLeast) {
		return limit(
			spec.atLeast === 0
				? `${spec.label} is negative (${value}).`
				: `${spec.label} is ${value}; it cannot be below ${spec.atLeast}.`
		);
	}
	if (spec.atMost !== undefined && value > spec.atMost) {
		return limit(`${spec.label} is ${value}; it cannot be above ${spec.atMost}.`);
	}
	return { value, canonical, problem: null };
}

/**
 * The key fields identify a row. When a key appears twice, no one can say
 * which row is right, so every row with that key becomes a problem and none
 * of them go live. Returns those problems and takes the rows out of `rows`.
 */
function removeDuplicateKeys(profile: SourceProfile, rows: ReadRow[]): RowProblem[] {
	const rowsByKey = new Map<string, ReadRow[]>();
	for (const row of rows) {
		const key = JSON.stringify(profile.key.map((f) => row.values[f]));
		rowsByKey.set(key, [...(rowsByKey.get(key) ?? []), row]);
	}

	const problems: RowProblem[] = [];
	for (const group of rowsByKey.values()) {
		if (group.length < 2) continue;
		const keyText = profile.key.map((f) => `${profile.fields[f].label} ${group[0].values[f]}`).join(', ');
		const rowList = group.map((r) => r.rowNo).join(', ');
		for (const row of group) {
			problems.push({
				rowNo: row.rowNo,
				key: profile.key.map((f) => String(row.values[f] ?? '')),
				reasons: [`${keyText} appears more than once (rows ${rowList}).`],
				raw: Object.fromEntries(
					Object.entries(profile.fields).map(([f, spec]) => [spec.label, String(row.values[f] ?? '')])
				)
			});
			rows.splice(rows.indexOf(row), 1);
		}
	}
	return problems;
}

/**
 * The file's identity: a SHA-256 of its rows in canonical form, sorted by
 * the key fields. The file name, the column order, the row order, quoting,
 * and date and number formats all drop out; any changed value does not.
 */
export function fingerprint(profile: SourceProfile, rows: string[][]): string {
	const fieldNames = Object.keys(profile.fields);
	const keyColumns = profile.key.map((f) => fieldNames.indexOf(f));
	const sorted = [...rows].sort((a, b) => {
		for (const column of keyColumns) {
			const order = compareText(a[column], b[column]);
			if (order !== 0) return order;
		}
		// Two rows with the same key (a duplicate) still need a fixed order.
		return compareText(JSON.stringify(a), JSON.stringify(b));
	});
	return createHash('sha256')
		.update(JSON.stringify({ profile: profile.id, fields: fieldNames, rows: sorted }))
		.digest('hex');
}

// Numbers sort as numbers (10000 after 9000) and before any text; text sorts
// as text. A fixed total order, so the input's row order never matters.
function compareText(a: string, b: string): number {
	const na = a.trim() === '' ? NaN : Number(a);
	const nb = b.trim() === '' ? NaN : Number(b);
	const aIsNumber = Number.isFinite(na);
	const bIsNumber = Number.isFinite(nb);
	if (aIsNumber && bIsNumber) return na - nb;
	if (aIsNumber !== bIsNumber) return aIsNumber ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
}

function guessReport(profile: SourceProfile, headers: string[]): string | null {
	const keys = new Set(headers.map(headerKey));
	return profile.otherReports.find((report) => report.keys.every((k) => keys.has(k)))?.name ?? null;
}
