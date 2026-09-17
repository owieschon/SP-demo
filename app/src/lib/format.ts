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
  Negative zero.

  Intl prints the sign before it rounds, so a figure that rounds to zero
  from below comes out as "-$0", "-$0.00" or "-0", which reads as a credit
  that is not there. A small credit memo or a rounding remainder in a
  rollup produces one. Snap anything that would round to zero to zero
  first, at the precision that formatter is about to use.
*/
const zeroed = (value: number, smallestShown: number): number =>
	Math.abs(value) < smallestShown / 2 ? 0 : value;

/** $12,003 */
export function money(value: number): string {
	return dollars.format(zeroed(value, 1));
}

/** $12,003.40 */
export function moneyExact(value: number): string {
	return cents.format(zeroed(value, 0.01));
}

export function count(value: number): string {
	return whole.format(zeroed(value, 1));
}

/** 0.7412 -> 74% */
export function percent(ratio: number): string {
	return `${Math.round(zeroed(ratio, 0.01) * 100)}%`;
}

/**
 * 0.9461 -> 94%
 *
 * Rounds down, for a figure that is about to be compared with a threshold.
 * `percent` rounds to nearest, which printed "95%" next to a commitment
 * that had not reached the 95% mark and so was not kept: the figure and
 * the status disagreed on screen.
 */
export function percentFloor(ratio: number): string {
	return `${Math.floor(zeroed(ratio, 0.01) * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-09-17' -> 'Sep 17' (or 'Sep 17, 2025' when the year differs from thisYear) */
export function day(iso: string, thisYear?: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const base = `${MONTHS[m - 1]} ${d}`;
	return thisYear === undefined || y === thisYear ? base : `${base}, ${y}`;
}

/**
 * 'Sep 17, 2026'. Always says the year, for a date with nothing around it to
 * say which year is meant: a figure's as-of stamp, or an availability date
 * read off a panel on its own. day() drops the year when it matches
 * `thisYear`, which is right inside a table of this year's rows and wrong
 * for a date standing by itself.
 */
export function dayFull(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	return `${MONTHS[m - 1]} ${d}, ${y}`;
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
