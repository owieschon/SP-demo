// Formatting shared by every page. Dates arrive as 'YYYY-MM-DD' text and are
// formatted as calendar dates, never shifted through a time zone.

const dollars = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	maximumFractionDigits: 0
});

const cents = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

const whole = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/*
  Every one of these snaps a value that rounds to zero to a real zero first.
  Intl keeps the sign, so -0.4 formatted in whole dollars came out as "-$0",
  which on a sales screen reads as a credit that is not there, and count(-0)
  came out as "-0".
*/

/** $12,003 */
export function money(value: number): string {
	return dollars.format(Math.abs(value) < 0.5 ? 0 : value);
}

/** $12,003.40 */
export function moneyExact(value: number): string {
	return cents.format(Math.abs(value) < 0.005 ? 0 : value);
}

export function count(value: number): string {
	return whole.format(Math.abs(value) < 0.5 ? 0 : value);
}

/** 0.7412 -> 74% */
export function percent(ratio: number): string {
	const rounded = Math.abs(ratio) < 0.005 ? 0 : ratio;
	return `${Math.round(rounded * 100)}%`;
}

/**
 * 0.9461 -> 94%. Rounds down, for a figure being compared with a threshold.
 * percent() rounds, so 94.61% printed as "95%" next to a status that was not
 * yet kept and a bar sitting left of the 95% line.
 */
export function percentFloor(ratio: number): string {
	const floored = Math.abs(ratio) < 0.005 ? 0 : ratio;
	return `${Math.floor(floored * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * '2026-09-17' -> 'Sep 17' when the year is thisYear, 'Sep 17, 2025' otherwise.
 *
 * Leaving thisYear out prints the year, always. It used to mean the opposite,
 * which is how five dates on the ship-check screen and a rule's due date came
 * to render as a bare "Mar 3": on the one screen whose job is telling a
 * customer a date, next March looked exactly like this March.
 */
export function day(iso: string, thisYear?: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const base = `${MONTHS[m - 1]} ${d}`;
	return y === thisYear ? base : `${base}, ${y}`;
}

/** 'Aug 1 to Oct 15' */
export function windowRange(startsOn: string, endsOn: string, thisYear?: number): string {
	return `${day(startsOn, thisYear)} to ${day(endsOn, thisYear)}`;
}

/** 'Sep 17, 3:05 PM' in the company's time zone. */
export function moment(value: Date | string): string {
	return new Date(value).toLocaleString('en-US', {
		timeZone: 'America/Chicago',
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

// Country names in English, from the browser's or server's own data.
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * Where a customer is.
 *   US:    'Tulsa, OK'
 *   CA:    'Regina, SK, Canada'
 *   other: 'Monterrey, Mexico'
 * Country is a two-letter code; a blank country is read as US.
 */
export function place(city: string | null, state: string | null, country: string | null): string {
	const town = (city ?? '').trim();
	const region = (state ?? '').trim();
	const code = (country ?? '').trim().toUpperCase() || 'US';
	const join = (...parts: string[]) => parts.filter(Boolean).join(', ');

	if (code === 'US' || code === 'USA') return join(town, region);
	if (code === 'CA' || code === 'CAN') return join(town, region, 'Canada');
	return join(town, countryName(code));
}

function countryName(code: string): string {
	// DisplayNames throws on anything that is not a region code; show it as is.
	try {
		return countryNames.of(code) ?? code;
	} catch {
		return code;
	}
}
