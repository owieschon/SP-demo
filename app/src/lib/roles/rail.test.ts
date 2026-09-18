/*
  nav.ts and rail.ts are two halves of one thing, and nothing was holding them
  together.

  The rail is derived: `railFor` returns the hrefs a principal has a reason to
  see, and the layout keeps only the nav entries in that list. So an entry with
  no rule is not greyed out or shown to admins only. It is **deleted, for
  everybody, silently**. Today, Open orders, the procurement desk, Policies and
  the Dictionary were all missing from every rail in the app on that account,
  and the way it was found was somebody taking a screenshot.

  These tests are cheap and hold the two files together in both directions.
*/
import { describe, expect, it } from 'vitest';
import { NAV, UNRAILED } from './../nav.ts';
import { RAIL_RULES, railAllows, railFor } from './rail.ts';
import type { PrincipalPolicy } from './types.ts';

const ruleHrefs = new Set(RAIL_RULES.map((rule) => rule.href));
const navHrefs = NAV.flatMap((section) => section.items).map((item) => item.href);

/** A principal holding nothing at all: no scope, no authority. */
const nobody: PrincipalPolicy = {
	id: 999,
	email: 'nobody@northline.example',
	fullName: 'Nobody',
	title: '',
	preset: 'account_manager',
	kind: 'person',
	responsibility: '',
	active: true,
	disclosure: 'customer',
	scope: [],
	authority: [],
	authorityAhead: []
};

describe('every rail entry has a rule', () => {
	it('so that no screen disappears from the app by omission', () => {
		const missing = navHrefs.filter((href) => !ruleHrefs.has(href));
		expect(missing, `nav entries with no rule in RAIL_RULES: ${missing.join(', ')}`).toEqual([]);
	});

	it('and every rule points at something the rail or the palette can reach', () => {
		const reachable = new Set([...navHrefs, ...UNRAILED.map((item) => item.href)]);
		const orphans = RAIL_RULES.map((r) => r.href).filter((href) => !reachable.has(href));
		expect(orphans, `rules for hrefs nothing links to: ${orphans.join(', ')}`).toEqual([]);
	});
});

describe('what somebody who holds nothing still sees', () => {
	it('includes the home page, because everybody has one', () => {
		const rail = railFor(nobody);
		expect(rail).toContain('/');
	});

	it('is only the entries marked for everybody', () => {
		const rail = railFor(nobody);
		const always = RAIL_RULES.filter((rule) => rule.always).map((rule) => rule.href);
		expect([...rail].sort()).toEqual([...always].sort());
	});

	it('never includes a desk, a queue or the settings', () => {
		const rail = railFor(nobody);
		for (const href of ['/desk', '/workspace', '/settings', '/procurement', '/policies']) {
			expect(rail, href).not.toContain(href);
		}
	});
});

describe('a rule reads the two things it is allowed to read', () => {
	it('lets an authority in', () => {
		const buyer: PrincipalPolicy = {
			...nobody,
			authority: [
				{ authority: 'release_purchase_order', limit: 50000, startsOn: '2026-01-01', endsOn: null, note: '' }
			]
		};
		const rule = RAIL_RULES.find((r) => r.href === '/procurement')!;
		expect(railAllows(buyer, rule)).toBe(true);
		expect(railAllows(nobody, rule)).toBe(false);
	});

	it('lets a claim on a dimension in', () => {
		const rep: PrincipalPolicy = {
			...nobody,
			scope: [{ dimension: 'account', all: false, values: ['9185'] }]
		};
		const rule = RAIL_RULES.find((r) => r.href === '/accounts')!;
		expect(railAllows(rep, rule)).toBe(true);
		expect(railAllows(nobody, rule)).toBe(false);
	});

	it('does not let an empty dimension in, because holding nothing is not holding some', () => {
		const empty: PrincipalPolicy = {
			...nobody,
			scope: [{ dimension: 'account', all: false, values: [] }]
		};
		const rule = RAIL_RULES.find((r) => r.href === '/accounts')!;
		expect(railAllows(empty, rule)).toBe(false);
	});
});
