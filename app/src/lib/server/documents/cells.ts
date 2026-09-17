// Turning what a cell holds into the three forms a reader may want: its
// text, its number and its date (see DocCell in types.ts).
//
// A spreadsheet tells us the type of every cell, so xlsx cells are built
// from that. A CSV and a PDF hand us text only, so the number and the date
// are worked out here, conservatively: something is only a number when the
// whole cell is one, and only a date when the whole cell is one.
import type { DocCell } from './types.ts';

export function emptyCell(): DocCell {
	return { text: '', number: null, date: null };
}

/** A money or count value written as text: "1,250", "$1,250.00", "(120)" for negative. */
export function numberFromText(raw: string): number | null {
	const text = raw.trim();
	if (text === '') return null;
	// Accounting style wraps a negative in brackets.
	const negative = /^\(.*\)$/.test(text);
	const bare = text
		.replace(/^\(|\)$/g, '')
		.replace(/[$\s]/g, '')
		.replace(/,/g, '');
	// Only a plain number counts. "4 ea" is not a number; it is text.
	if (!/^[+-]?\d+(\.\d+)?$/.test(bare)) return null;
	const value = Number(bare);
	if (!Number.isFinite(value)) return null;
	return negative ? -value : value;
}

const MONTHS: Record<string, number> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9,
	sept: 9, oct: 10, nov: 11, dec: 12
};

function iso(year: number, month: number, day: number): string | null {
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	const full = year < 100 ? 2000 + year : year;
	return `${full}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A calendar date written as text. US order for all-numeric dates
 * ("10/17/2026"), because the customers in this world write that way, plus
 * ISO and the written-out month forms.
 */
export function dateFromText(raw: string): string | null {
	const text = raw.trim();
	if (text === '') return null;

	const isoMatch = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
	if (isoMatch) return iso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));

	const slashed = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
	if (slashed) return iso(Number(slashed[3]), Number(slashed[1]), Number(slashed[2]));

	// "Oct 17, 2026" and "17 Oct 2026".
	const monthFirst = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
	if (monthFirst) {
		const month = MONTHS[monthFirst[1].slice(0, 3).toLowerCase()];
		if (month) return iso(Number(monthFirst[3]), month, Number(monthFirst[2]));
	}
	const dayFirst = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/);
	if (dayFirst) {
		const month = MONTHS[dayFirst[2].slice(0, 3).toLowerCase()];
		if (month) return iso(Number(dayFirst[3]), month, Number(dayFirst[1]));
	}
	return null;
}

/** A cell that arrived as text only (CSV, PDF). */
export function cellFromText(raw: string): DocCell {
	const text = raw.trim();
	return { text, number: numberFromText(text), date: dateFromText(text) };
}

/**
 * A cell from a spreadsheet, where the type is already known.
 * `serialDate` is the date a numeric cell formatted as a date stands for
 * (Excel counts days from 1899-12-30); the caller works it out from the
 * cell's number format, because 45000 is a date or a price depending only
 * on how the sheet formats it.
 */
export function cellFromValue(value: unknown, serialDate: string | null = null): DocCell {
	if (value === null || value === undefined) return emptyCell();
	if (typeof value === 'number') {
		return {
			// A date cell shows its date, not its serial number.
			text: serialDate ?? String(value),
			number: serialDate ? null : value,
			date: serialDate
		};
	}
	if (typeof value === 'boolean') return { text: value ? 'TRUE' : 'FALSE', number: null, date: null };
	const text = String(value).trim();
	return { text, number: numberFromText(text), date: dateFromText(text) };
}

/**
 * The date an Excel serial number stands for. Excel counts days from
 * 1900-01-01 as day 1 but also believes 1900 was a leap year, which is why
 * the epoch used here is 1899-12-30. Whole days only: a time of day on a
 * needed-by date is noise.
 */
export function dateFromSerial(serial: number): string | null {
	if (!Number.isFinite(serial) || serial < 1 || serial > 2958465) return null;
	const days = Math.floor(serial);
	const ms = Date.UTC(1899, 11, 30) + days * 86400000;
	return new Date(ms).toISOString().slice(0, 10);
}
