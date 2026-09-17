import { describe, expect, it } from 'vitest';
import { count, day, money, moneyExact, percent, percentFloor, place, windowRange } from './format';

/*
  These four are what the Money, Qty and WhenDate components render, so the
  components are tested here, where no browser is needed.
*/

describe('money', () => {
	it('shows whole dollars', () => {
		expect(money(12003.4)).toBe('$12,003');
		expect(money(0)).toBe('$0');
	});

	it('never prints a minus zero', () => {
		// -$0 on a sales screen reads as a credit that is not there.
		expect(money(-0.4)).toBe('$0');
		expect(money(-0)).toBe('$0');
		expect(moneyExact(-0.004)).toBe('$0.00');
		expect(moneyExact(-0)).toBe('$0.00');
		expect(count(-0)).toBe('0');
		expect(percent(-0.001)).toBe('0%');
	});

	it('still shows a real credit', () => {
		expect(money(-820)).toBe('-$820');
		expect(moneyExact(-0.51)).toBe('-$0.51');
	});

	it('shows cents when asked', () => {
		expect(moneyExact(12003.4)).toBe('$12,003.40');
	});
});

describe('percent', () => {
	it('rounds for a plain share', () => {
		expect(percent(0.7412)).toBe('74%');
		expect(percent(0.9461)).toBe('95%');
	});

	it('rounds down when the figure is compared with a threshold', () => {
		// 94.61% delivered is not 95% kept, and must not print as though it were.
		expect(percentFloor(0.9461)).toBe('94%');
		expect(percentFloor(0.95)).toBe('95%');
		expect(percentFloor(0)).toBe('0%');
	});
});

describe('day', () => {
	it('leaves out the year that does not need saying', () => {
		expect(day('2026-09-17', 2026)).toBe('Sep 17');
	});

	it('says the year when it differs', () => {
		expect(day('2025-03-03', 2026)).toBe('Mar 3, 2025');
	});

	it('says the year when no year was given', () => {
		// The bug this fixes: five dates on the ship-check screen printed as a
		// bare "Mar 3", so next March looked exactly like this March.
		expect(day('2027-03-03')).toBe('Mar 3, 2027');
		expect(day('2026-03-03')).toBe('Mar 3, 2026');
	});

	it('carries the same rule through a window', () => {
		expect(windowRange('2026-08-01', '2026-10-15', 2026)).toBe('Aug 1 to Oct 15');
		expect(windowRange('2026-12-01', '2027-01-15', 2026)).toBe('Dec 1 to Jan 15, 2027');
	});
});

describe('place', () => {
	it('shows US towns with their state', () => {
		expect(place('Tulsa', 'OK', 'US')).toBe('Tulsa, OK');
		expect(place('Tulsa', 'OK', '')).toBe('Tulsa, OK');
	});

	it('shows Canadian towns with province and country', () => {
		expect(place('Calgary', 'AB', 'CA')).toBe('Calgary, AB, Canada');
	});

	it('shows other towns with the country name and no region', () => {
		expect(place('Bogotá', '', 'CO')).toBe('Bogotá, Colombia');
		// A stray region code never makes a foreign town look American.
		expect(place('Bogotá', 'DC', 'CO')).toBe('Bogotá, Colombia');
		expect(place('León', '', 'MX')).toBe('León, Mexico');
	});

	it('shows an unknown country code as given', () => {
		expect(place('Somewhere', '', 'ZZZ')).toBe('Somewhere, ZZZ');
	});
});
