// Needed-by dates as people write them, turned into calendar dates.
//
// Everything is plain YYYY-MM-DD arithmetic in UTC, so a time zone can never
// move a date by a day. Relative dates ("by Friday", "end of month") count
// from an anchor: the day the customer sent the email when we know it,
// otherwise today.

export interface ParsedDate {
	/** The words that were read, e.g. "by next Friday". */
	text: string;
	/** YYYY-MM-DD, or null when the words name no date we can work out (ASAP). */
	date: string | null;
	/** 0.9 for a written date, less for relative ones. */
	confidence: number;
}

const MONTHS: Record<string, number> = {
	jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
	jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
	oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const NUMBER_WORDS: Record<string, number> = {
	a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

export function toDate(iso: string): Date {
	return new Date(`${iso}T00:00:00Z`);
}

export function toIso(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
	const d = toDate(iso);
	d.setUTCDate(d.getUTCDate() + days);
	return toIso(d);
}

function lastDayOfMonth(year: number, month: number): string {
	// Day 0 of the next month is the last day of this one.
	return toIso(new Date(Date.UTC(year, month, 0)));
}

/** A real calendar date? (Rejects 2026-02-30.) */
export function isRealDate(year: number, month: number, day: number): boolean {
	const d = new Date(Date.UTC(year, month - 1, day));
	return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

function iso(year: number, month: number, day: number): string | null {
	if (!isRealDate(year, month, day)) return null;
	return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A month and day without a year. People mean the next time that date comes
 * around, but a date a little in the past is far more likely a mistake than
 * a request for next year, so it keeps this year (and validation flags it).
 * More than 60 days back rolls to next year ("1/15" written in December).
 */
function withoutYear(month: number, day: number, anchor: string): string | null {
	const year = Number(anchor.slice(0, 4));
	const thisYear = iso(year, month, day);
	if (!thisYear) return null;
	const daysBack = (toDate(anchor).getTime() - toDate(thisYear).getTime()) / 86_400_000;
	return daysBack > 60 ? iso(year + 1, month, day) : thisYear;
}

/**
 * The next given weekday after the anchor. "next Friday" means the Friday of
 * the following week when this week still has a Friday coming; weeks start
 * on Monday.
 */
function weekday(name: string, anchor: string, next: boolean): string {
	const target = WEEKDAYS.indexOf(name);
	const start = toDate(anchor);
	const today = start.getUTCDay();
	let ahead = (target - today + 7) % 7;
	if (ahead === 0) ahead = 7; // "by Friday" written on a Friday means next week's
	const coming = addDays(anchor, ahead);
	if (!next) return coming;
	// Monday-based week numbers: Sunday counts as the end of the week.
	const mondayOf = (isoDay: string) => {
		const d = toDate(isoDay);
		return addDays(isoDay, -((d.getUTCDay() + 6) % 7));
	};
	return mondayOf(coming) === mondayOf(anchor) ? addDays(coming, 7) : coming;
}

function yearOf(text: string | undefined, anchor: string): number {
	if (!text) return Number(anchor.slice(0, 4));
	const n = Number(text);
	return n < 100 ? 2000 + n : n;
}

// Words that introduce a needed-by date.
const LEAD =
	'(?:needed\\s+by|need(?:s|ed)?\\s+(?:it|them|these|this|everything|all)?\\s*(?:by|before|no later than)|' +
	'deliver(?:ed|y)?\\s+by|ship(?:ped)?\\s+by|in\\s+hand\\s+by|on\\s+site\\s+by|arrive\\s+by|required\\s+by|' +
	'due(?:\\s+date)?:?|need\\s+date:?|needed:?|delivery\\s+date:?|ship\\s+date:?|' +
	'by|before|no\\s+later\\s+than|NLT)';

// The date expressions we can read, most specific first. Each returns a date
// (or null) given the regex match and the anchor.
const EXPRESSIONS: {
	pattern: string;
	confidence: number;
	read: (m: RegExpMatchArray, anchor: string) => string | null;
}[] = [
	{
		// 2026-10-02
		pattern: '(\\d{4})-(\\d{1,2})-(\\d{1,2})',
		confidence: 0.95,
		read: (m) => iso(Number(m[1]), Number(m[2]), Number(m[3]))
	},
	{
		// 10/2/2026, 10-2-26, 10/2
		pattern: '(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2}|\\d{4}))?(?![\\d/])',
		confidence: 0.9,
		read: (m, anchor) =>
			m[3] ? iso(yearOf(m[3], anchor), Number(m[1]), Number(m[2])) : withoutYear(Number(m[1]), Number(m[2]), anchor)
	},
	{
		// Oct 2, October 2nd, Oct. 2, 2026
		pattern:
			'(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b',
		confidence: 0.9,
		read: (m, anchor) => {
			const month = MONTHS[m[1].toLowerCase()];
			return m[3] ? iso(Number(m[3]), month, Number(m[2])) : withoutYear(month, Number(m[2]), anchor);
		}
	},
	{
		// 2 Oct, 2nd of October
		pattern:
			'(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b(?:,?\\s+(\\d{4}))?',
		confidence: 0.85,
		read: (m, anchor) => {
			const month = MONTHS[m[2].toLowerCase()];
			return m[3] ? iso(Number(m[3]), month, Number(m[1])) : withoutYear(month, Number(m[1]), anchor);
		}
	},
	{
		// (this|next) Friday
		pattern: '(?:(this|next|the)\\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\b',
		confidence: 0.7,
		read: (m, anchor) => weekday(m[2].toLowerCase(), anchor, m[1]?.toLowerCase() === 'next')
	},
	{
		// end of (the|this|next) month / week
		pattern: '(?:the\\s+)?end\\s+of\\s+(?:the\\s+|this\\s+)?(next\\s+)?(month|week)',
		confidence: 0.6,
		read: (m, anchor) => {
			const year = Number(anchor.slice(0, 4));
			const month = Number(anchor.slice(5, 7));
			if (m[2].toLowerCase() === 'month') {
				return m[1] ? lastDayOfMonth(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1) : lastDayOfMonth(year, month);
			}
			// End of the week is its Friday.
			const friday = weekday('friday', addDays(anchor, -1), false);
			return m[1] ? addDays(friday, 7) : friday;
		}
	},
	{
		// in 2 weeks, within 10 days, two weeks
		pattern: '(?:in|within)\\s+(\\d{1,2}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(day|week)s?',
		confidence: 0.6,
		read: (m, anchor) => {
			const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()];
			return addDays(anchor, m[2].toLowerCase() === 'week' ? n * 7 : n);
		}
	},
	{
		// tomorrow
		pattern: '(tomorrow)',
		confidence: 0.7,
		read: (_m, anchor) => addDays(anchor, 1)
	}
];

const COMBINED = EXPRESSIONS.map((e) => `(?:${e.pattern})`).join('|');
const LEAD_AND_DATE = new RegExp(`\\b${LEAD}\\s*(?:the\\s+)?(${COMBINED})`, 'i');
const URGENT = /\b(asap|a\.s\.a\.p\.|expedite|expedited|urgent|right away|as soon as possible)\b/i;

/** Read one date expression (no lead word needed). */
export function readDateExpression(text: string, anchor: string): ParsedDate | null {
	for (const expression of EXPRESSIONS) {
		const m = text.match(new RegExp(`^\\s*(?:${expression.pattern})`, 'i'));
		if (m) {
			return { text: m[0].trim(), date: expression.read(m, anchor), confidence: expression.confidence };
		}
	}
	return null;
}

/**
 * Find the needed-by date in a request. Only dates introduced by a lead word
 * count ("by Oct 2", "Need date: 10/2"), so a stray "3/4 inch" or an order
 * date in the text is not mistaken for one. Returns the ASAP wording (with no
 * date) when that is all the email says, and null when it says nothing.
 */
export function findNeededBy(text: string, anchor: string): ParsedDate | null {
	const m = text.match(LEAD_AND_DATE);
	if (m && m.index !== undefined) {
		const start = m.index + m[0].length - m[1].length;
		const parsed = readDateExpression(text.slice(start), anchor);
		if (parsed) return { ...parsed, text: m[0].trim() };
	}
	// "in 2 weeks" and "within 10 days" carry their own lead word.
	const span = text.match(/\b(?:with)?in\s+(?:\d{1,2}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:days?|weeks?)\b/i);
	if (span && span.index !== undefined) {
		const parsed = readDateExpression(text.slice(span.index), anchor);
		if (parsed) return parsed;
	}
	const urgent = text.match(URGENT);
	if (urgent) return { text: urgent[0], date: null, confidence: 0.5 };
	return null;
}
