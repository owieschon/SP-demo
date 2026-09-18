// Turning what somebody wrote into a typed value the dictionary recognizes.
//
// This is the VALUE third of a parse. The other two thirds are the subject
// (entity resolution) and the attribute (a dictionary lookup), and each is
// scored separately, because a perfectly parsed number about the wrong
// customer is worth nothing.
//
// The rule: a value is normalized onto the type the dictionary names, or the
// parse fails and says why. "Net 45" becomes payment_terms_days 45 with the
// unit days. "3 to 4 weeks" becomes a range of 21 to 28 days. "Collect"
// becomes the freight_terms enum. Anything that does not land on a type is a
// failure, not a guess, and a failure keeps its snippet.
//
// Everything here is pure: no database, no clock except the reference date a
// caller passes in. That is what makes it testable on its own.
import type { AttributeMeta, NormalizeResult, NormalizedValue } from './types';

/** Round-trip safe money and numbers: two decimals, no trailing noise. */
function tidyNumber(value: number): string {
	return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function ok(value: Partial<NormalizedValue> & { display: string; unit?: string }): NormalizedValue {
	return {
		text: value.text ?? null,
		number: value.number ?? null,
		date: value.date ?? null,
		bool: value.bool ?? null,
		json: value.json ?? null,
		unit: value.unit ?? '',
		display: value.display
	};
}

// ---------------------------------------------------------------------------
// The pieces, each for one shape that has a shape
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
	jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
	may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
	september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const NUMBER_WORDS: Record<string, number> = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
	nine: 9, ten: 10, eleven: 11, twelve: 12
};

/** "45", "forty five" is not supported on purpose; "twelve" is. */
function readNumberWord(word: string): number | null {
	const key = word.trim().toLowerCase();
	if (/^\d+(\.\d+)?$/.test(key)) return Number(key);
	return NUMBER_WORDS[key] ?? null;
}

/** "net 45", "net 45 days", "45 days net", "2% 10 net 30" (the net part). */
export function readPaymentTermsDays(raw: string): number | null {
	const text = raw.toLowerCase();
	const net = text.match(/net\s*(\d{1,3})/);
	if (net) return Number(net[1]);
	const days = text.match(/(\d{1,3})\s*days?\s*(net|from invoice|from the invoice)/);
	if (days) return Number(days[1]);
	// "due on receipt" is real and is zero days, not a missing value.
	if (/due on receipt|cash on delivery|\bcod\b|prepaid in full/.test(text)) return 0;
	return null;
}

/**
 * "3 to 4 weeks", "10-14 days", "about six weeks", "12 week lead time".
 * A single figure becomes a range with the same low and high, because a
 * supplier saying "six weeks" means six weeks and not "at least six".
 */
export function readDayRange(raw: string): { low: number; high: number } | null {
	const text = raw.toLowerCase().replace(/[‐-―]/g, '-');
	const unit = /week/.test(text) ? 7 : /month/.test(text) ? 30 : 1;
	if (unit === 1 && !/day/.test(text)) return null;

	const span = text.match(/(\d+|[a-z]+)\s*(?:to|-|through|and)\s*(\d+|[a-z]+)\s*(day|week|month)/);
	if (span) {
		const low = readNumberWord(span[1]);
		const high = readNumberWord(span[2]);
		if (low !== null && high !== null) {
			const factor = span[3] === 'week' ? 7 : span[3] === 'month' ? 30 : 1;
			return low <= high ? { low: low * factor, high: high * factor } : null;
		}
		return null;
	}

	const single = text.match(/(\d+|[a-z]+)\s*(day|week|month)/);
	if (single) {
		const value = readNumberWord(single[1]);
		if (value !== null) {
			const factor = single[2] === 'week' ? 7 : single[2] === 'month' ? 30 : 1;
			return { low: value * factor, high: value * factor };
		}
	}
	return null;
}

/** "collect", "prepaid and add", "FOB origin, freight collect", "third party". */
export function readFreightTerms(raw: string): string | null {
	const text = raw.toLowerCase();
	if (/prepaid\s*(and|&)\s*add|prepay and add/.test(text)) return 'prepaid_and_add';
	// A customer's own carrier account is what the paperwork calls third party:
	// the carrier bills them directly and nothing appears on our invoice.
	if (/third\s*party|3rd\s*party|(their|our) own (carrier|account)|own carrier account/.test(text)) {
		return 'third_party';
	}
	if (/\bcollect\b/.test(text)) return 'collect';
	if (/\bprepaid\b|\bprepay\b|freight allowed|we pay the freight/.test(text)) return 'prepaid';
	return null;
}

/** Who actually pays, which is a different question from how it is billed. */
export function readFreightPayer(raw: string): string | null {
	const text = raw.toLowerCase();
	if (/their own (carrier|account)|on their account|bill(ed)? to their (carrier|account)|third\s*party/.test(text)) {
		return 'third_party';
	}
	if (/we pay|freight allowed|prepaid by us|freight prepaid by northline/.test(text)) return 'northline';
	if (/they pay|customer pays|freight collect|\bcollect\b/.test(text)) return 'customer';
	return null;
}

/** "certificate of conformance", "C of C", "mill test report", "MTR", "none". */
export function readCertificate(raw: string): string | null {
	const text = raw.toLowerCase();
	const conformance = /certificate of conformance|\bc of c\b|\bcoc\b/.test(text);
	const mill = /mill test report|mill cert|\bmtr\b/.test(text);
	if (conformance && mill) return 'both';
	if (conformance) return 'certificate_of_conformance';
	if (mill) return 'mill_test_report';
	if (/no cert|certificates? (are )?not required|no paperwork/.test(text)) return 'none';
	return null;
}

/** "$2,500", "2500.00", "USD 2,500". */
export function readMoney(raw: string): number | null {
	const match = raw.replace(/,/g, '').match(/(?:\$|usd\s*)?(\d+(?:\.\d{1,2})?)/i);
	return match ? Number(match[1]) : null;
}

/** "yes", "required", "we always need one", "no", "not required". */
export function readBool(raw: string): boolean | null {
	const text = raw.toLowerCase();
	if (/\bno\b|not required|never|do not|don't|without/.test(text)) return false;
	if (/\byes\b|required|always|must|we need|need one|mandatory/.test(text)) return true;
	return null;
}

/**
 * "2026-12-31", "31 December 2026", "December 31", "end of the year".
 * A date with no year takes the reference year, and rolls forward a year when
 * that would put it more than six months in the past: "December 31" written
 * in January means the December that is coming.
 */
export function readDate(raw: string, referenceDate: string): string | null {
	const iso = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

	const ref = new Date(`${referenceDate}T00:00:00Z`);
	const refYear = ref.getUTCFullYear();

	const text = raw.toLowerCase();
	if (/end of (the )?year|year end|year-end/.test(text)) return `${refYear}-12-31`;

	// "the end of December", "end of Q-none-of-your-business" is not a date but
	// the end of a named month is, and it is how a price hold is usually
	// written. The last day is worked out from the month, leap years included.
	const monthEnd = text.match(/end of (?:the )?([a-z]{3,9})/);
	if (monthEnd && MONTHS[monthEnd[1]]) {
		const month = MONTHS[monthEnd[1]];
		let year = refYear;
		// A month that has already gone by means the one coming, the same way a
		// bare day does below.
		if (Date.UTC(year, month, 0) < ref.getTime() - 183 * 86_400_000) year += 1;
		const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
		return `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
	}

	// "December 31" or "31 December", with an optional year.
	const named =
		text.match(/\b([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(\d{4}))?/) ??
		text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?:,?\s*(\d{4}))?/);
	if (!named) return null;

	const monthName = MONTHS[named[1]] ? named[1] : named[2];
	const dayPart = MONTHS[named[1]] ? named[2] : named[1];
	const month = MONTHS[monthName];
	const day = Number(dayPart);
	if (!month || !Number.isInteger(day) || day < 1 || day > 31) return null;

	let year = named[3] ? Number(named[3]) : refYear;
	if (!named[3]) {
		const candidate = Date.UTC(year, month - 1, day);
		if (candidate < ref.getTime() - 183 * 86_400_000) year += 1;
	}
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${year}-${pad(month)}-${pad(day)}`;
}

// ---------------------------------------------------------------------------
// The one entry point
// ---------------------------------------------------------------------------

/**
 * Normalize `raw` onto the attribute's type, or fail with a reason.
 *
 * The attribute decides which reader runs, not the shape of the text, so
 * "45" written against a date attribute fails rather than becoming a number
 * somewhere it does not belong.
 */
export function normalizeValue(
	attribute: AttributeMeta,
	raw: string,
	options: { referenceDate: string } = { referenceDate: '2026-09-17' }
): NormalizeResult {
	const text = raw.trim();
	if (!text) return { failed: 'There is nothing to read.' };

	switch (attribute.valueType) {
		case 'integer': {
			// The one integer attribute in the dictionary is payment terms, and
			// "net 45" is the way it is written, so try that reader first and
			// fall back to a bare number with the right unit beside it.
			const terms = attribute.key === 'payment_terms_days' ? readPaymentTermsDays(text) : null;
			const bare = terms ?? (text.match(/\b(\d{1,4})\b/) ? Number(text.match(/\b(\d{1,4})\b/)![1]) : null);
			if (bare === null) {
				return { failed: `Could not read a whole number out of "${text}".` };
			}
			return ok({
				number: bare,
				unit: attribute.unit,
				display: attribute.unit ? `${bare} ${attribute.unit}` : String(bare)
			});
		}
		case 'number':
		case 'money': {
			const value = readMoney(text);
			if (value === null) return { failed: `Could not read an amount out of "${text}".` };
			return ok({
				number: value,
				unit: attribute.unit,
				display:
					attribute.unit === 'USD'
						? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
						: `${tidyNumber(value)}${attribute.unit ? ` ${attribute.unit}` : ''}`
			});
		}
		case 'range_days': {
			const range = readDayRange(text);
			if (!range) return { failed: `Could not read a lead time out of "${text}".` };
			return ok({
				json: range,
				unit: attribute.unit || 'days',
				display:
					range.low === range.high
						? `${range.low} days`
						: `${range.low} to ${range.high} days`
			});
		}
		case 'date': {
			const date = readDate(text, options.referenceDate);
			if (!date) return { failed: `Could not read a date out of "${text}".` };
			return ok({ date, display: date });
		}
		case 'bool': {
			const value = readBool(text);
			if (value === null) return { failed: `Could not read yes or no out of "${text}".` };
			return ok({ bool: value, display: value ? 'yes' : 'no' });
		}
		case 'enum': {
			const reader =
				attribute.key === 'freight_terms'
					? readFreightTerms
					: attribute.key === 'freight_payer'
						? readFreightPayer
						: attribute.key === 'certificate_required'
							? readCertificate
							: null;
			// An enum with no reader of its own still accepts a value written
			// exactly as the dictionary spells it.
			const value =
				(reader ? reader(text) : null) ??
				attribute.allowedValues.find((allowed) => allowed === text.toLowerCase().replace(/\s+/g, '_')) ??
				null;
			if (value === null) {
				return {
					failed: `"${text}" is not one of ${attribute.allowedValues.join(', ')}.`
				};
			}
			if (!attribute.allowedValues.includes(value)) {
				return { failed: `"${value}" is not one of ${attribute.allowedValues.join(', ')}.` };
			}
			return ok({ text: value, display: value.replace(/_/g, ' ') });
		}
		default: {
			// Text. Collapse the whitespace a PDF reader leaves behind, and cap
			// it, because a paragraph is not a value.
			const tidy = text.replace(/\s+/g, ' ').slice(0, 200);
			if (tidy.length < 2) return { failed: 'Too short to be a value.' };
			return ok({ text: tidy, display: tidy });
		}
	}
}

/** The display string the database would derive, for a test to compare with. */
export function displayOf(value: NormalizedValue): string {
	return value.display;
}
