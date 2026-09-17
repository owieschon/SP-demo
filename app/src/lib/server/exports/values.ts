// Reading single cells the way ERP exports write them. Each reader returns
// the value, or null when the text is not a valid value of that kind, so the
// caller can say which row and which column was wrong. The accepted formats
// come from the source profile (profile.ts).
import { US_NUMBERS, type DateFormat, type NumberFormat } from './profile.ts';

/**
 * 'Sell-to Customer No.' -> 'selltocustomerno'. Headers are matched on this
 * form, so case, spaces and punctuation never matter.
 */
export function headerKey(header: string): string {
	return header.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Excel counts days from 1899-12-30 (it pretends 1900 was a leap year).
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;
// Serial numbers outside roughly 1955 to 2118 are not dates anyone exports.
const MIN_SERIAL = 20_000;
const MAX_SERIAL = 80_000;

const ALL_DATE_FORMATS: DateFormat[] = ['us', 'iso', 'excel_serial'];

function isoFromParts(year: number, month: number, day: number): string | null {
	if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2200) return null;
	const date = new Date(Date.UTC(year, month - 1, day));
	// Date.UTC rolls 02/30 over into March; a real date comes back unchanged.
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
		return null;
	}
	return date.toISOString().slice(0, 10);
}

/** The Excel serial number for a 'YYYY-MM-DD' date (used to write messy sample files). */
export function excelSerial(iso: string): number {
	const [y, m, d] = iso.split('-').map(Number);
	return Math.round((Date.UTC(y, m - 1, d) - EXCEL_EPOCH_MS) / DAY_MS);
}

/**
 * A date as 'YYYY-MM-DD', from any of the given formats:
 *   us            09/17/2026 or 9/17/2026 (month first, as the ERP writes it)
 *   iso           2026-09-17
 *   excel_serial  46282 or 46282.0 (days since 1899-12-30)
 */
export function parseDate(raw: string, formats: DateFormat[] = ALL_DATE_FORMATS): string | null {
	const text = raw.trim();
	let m: RegExpExecArray | null;

	if (formats.includes('iso') && (m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) {
		return isoFromParts(Number(m[1]), Number(m[2]), Number(m[3]));
	}
	if (formats.includes('us') && (m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text))) {
		return isoFromParts(Number(m[3]), Number(m[1]), Number(m[2]));
	}
	if (formats.includes('excel_serial') && (m = /^(\d{5})(?:\.0+)?$/.exec(text))) {
		const serial = Number(m[1]);
		if (serial < MIN_SERIAL || serial > MAX_SERIAL) return null;
		return new Date(EXCEL_EPOCH_MS + serial * DAY_MS).toISOString().slice(0, 10);
	}
	return null;
}

// A character used literally inside a regular expression.
function literal(ch: string): string {
	return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A number from accounting-style text (US format shown):
 *   '1,234.50' -> 1234.5     '$ 12.00' -> 12     '(12.00)' -> -12     ' -3 ' -> -3
 * Anything else (letters, two decimal points, an empty cell) is null.
 */
export function parseNumber(raw: string, format: NumberFormat = US_NUMBERS): number | null {
	let text = raw.trim().replace(/\s+/g, '');
	let negative = false;

	// Accountants write negatives in parentheses.
	const wrapped = format.parenthesesNegative ? /^\((.*)\)$/.exec(text) : null;
	if (wrapped) {
		negative = true;
		text = wrapped[1];
	}
	if (text.startsWith('-')) {
		if (negative) return null; // (-5) is not a thing
		negative = true;
		text = text.slice(1);
	}
	if (format.currency && text.startsWith(format.currency)) text = text.slice(format.currency.length);

	// Thousands separators only in the right places: 1,234,567.89
	const t = literal(format.thousands);
	const d = literal(format.decimal);
	const shape = new RegExp(`^(\\d{1,3}(${t}\\d{3})+|\\d+)(${d}\\d+)?$|^${d}\\d+$`);
	if (!shape.test(text)) return null;
	const value = Number(text.split(format.thousands).join('').replace(format.decimal, '.'));
	if (!Number.isFinite(value)) return null;
	return negative ? -value : value;
}

/** Round to cents without the 1.005 -> 1.00 surprise. */
export function cents(value: number): number {
	return Math.round((value + Number.EPSILON) * 100) / 100;
}
