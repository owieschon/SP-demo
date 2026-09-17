import { describe, expect, it } from 'vitest';
import { place } from './format';

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
