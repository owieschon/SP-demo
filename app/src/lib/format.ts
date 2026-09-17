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

/** $12,003 */
export function money(value: number): string {
	return dollars.format(value);
}

/** $12,003.40 */
export function moneyExact(value: number): string {
	return cents.format(value);
}

export function count(value: number): string {
	return whole.format(value);
}

/** 0.7412 -> 74% */
export function percent(ratio: number): string {
	return `${Math.round(ratio * 100)}%`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-09-17' -> 'Sep 17' (or 'Sep 17, 2025' when the year differs from thisYear) */
export function day(iso: string, thisYear?: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	const base = `${MONTHS[m - 1]} ${d}`;
	return thisYear === undefined || y === thisYear ? base : `${base}, ${y}`;
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
