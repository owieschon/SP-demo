/*
  The shared component layer's behaviour, where it is arithmetic rather than
  markup: which URL a sortable header points at, what a truncated table's
  footer says, how the command palette ranks what a person typed, and where
  the highlight goes on an arrow key.

  A modal <dialog>'s focus trap is the platform's and is checked in a real
  browser; see docs/design-system.md. Its Escape key was assumed to be the
  platform's too, and that assumption shipped a palette nobody could put
  down, so the two invariants behind that bug are held here instead.
*/
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ariaSortValue, nextSortValue, rowCountLine, sortSearch } from './table';
import { isBackdropClick, moveHighlight } from './dialog';
import { groupEntries, matchEntries, scoreEntry, type PaletteEntry } from './palette';

describe('a sortable header link', () => {
	it('keeps every other filter and goes back to page one', () => {
		expect(sortSearch('?q=chrome&state=OK&page=4', 'sort', 'revenue')).toBe(
			'?q=chrome&state=OK&sort=revenue'
		);
	});

	it('replaces a sort that is already set', () => {
		expect(sortSearch('?sort=name', 'sort', 'revenue')).toBe('?sort=revenue');
	});

	it('is a bare question mark when the sort is the only parameter to drop', () => {
		// A page with no other state still needs an href that navigates.
		expect(sortSearch('', 'sort', 'name')).toBe('?sort=name');
	});

	it('asks for the other direction once a column is sorted', () => {
		const revenue = { asc: 'revenue', desc: 'revenue-low' };
		expect(nextSortValue(revenue, null)).toBe('revenue');
		expect(nextSortValue(revenue, 'name')).toBe('revenue');
		expect(nextSortValue(revenue, 'revenue')).toBe('revenue-low');
		// And back again, so a person is never stuck in one direction.
		expect(nextSortValue(revenue, 'revenue-low')).toBe('revenue');
	});

	it('stays put when a column only sorts one way', () => {
		const name = { asc: 'name' };
		expect(nextSortValue(name, 'name')).toBe('name');
	});

	it('tells a screen reader which column is sorted and which way', () => {
		const revenue = { asc: 'revenue', desc: 'revenue-low' };
		expect(ariaSortValue(revenue, 'revenue')).toBe('ascending');
		expect(ariaSortValue(revenue, 'revenue-low')).toBe('descending');
		expect(ariaSortValue(revenue, 'name')).toBe('none');
		// A column that cannot be sorted says nothing at all, rather than "none".
		expect(ariaSortValue(undefined, 'name')).toBeUndefined();
	});
});

describe("a table's footer count", () => {
	it('says how many rows are hidden', () => {
		expect(rowCountLine({ shown: 50, total: 5412, noun: 'parts' })).toBe('50 of 5,412 parts');
	});

	it('says how the visible rows were chosen', () => {
		expect(
			rowCountLine({ shown: 10, total: 41, noun: 'buyers', order: 'by 12-month revenue' })
		).toBe('10 of 41 buyers, by 12-month revenue');
	});

	it('is a plain count when nothing is hidden', () => {
		expect(rowCountLine({ shown: 8, total: 8, noun: 'lines' })).toBe('8 lines');
		expect(rowCountLine({ shown: 0, total: 0, noun: 'lines' })).toBe('0 lines');
	});

	it('does not claim rows are hidden when the page has more than the server said', () => {
		// A caller that passes the array length as the total must still read right.
		expect(rowCountLine({ shown: 12, total: 5, noun: 'rows' })).toBe('5 rows');
	});
});

describe('a modal', () => {
	it('treats a click on the dialog box itself as the backdrop', () => {
		const dialog = { name: 'dialog' } as unknown as Element;
		const inside = { name: 'button' } as unknown as EventTarget;
		expect(isBackdropClick(dialog, dialog)).toBe(true);
		expect(isBackdropClick(inside, dialog)).toBe(false);
		expect(isBackdropClick(dialog, null)).toBe(false);
	});

	it('stops the highlight at both ends instead of wrapping', () => {
		expect(moveHighlight(0, 5, 1)).toBe(1);
		expect(moveHighlight(4, 5, 1)).toBe(4);
		expect(moveHighlight(0, 5, -1)).toBe(0);
		expect(moveHighlight(0, 0, 1)).toBe(0);
	});
});

describe('the command palette', () => {
	const entries: PaletteEntry[] = [
		{ id: 'a', kind: 'action', label: 'Approve or correct the drafts the order desk wrote', hint: 'The email queue', href: '/workspace?source=mail', keywords: 'draft email reply' },
		{ id: 'b', kind: 'screen', label: 'Accounts', hint: 'The book', href: '/accounts' },
		{ id: 'c', kind: 'screen', label: 'Order desk', hint: 'Customer email', href: '/desk' },
		{ id: 'd', kind: 'account', label: 'Driftless Machine Fab', hint: 'Tulsa, OK', href: '/accounts/10012', keywords: '10012' },
		{ id: 'e', kind: 'part', label: 'L3515-630SC', hint: '8 inch chrome stack', href: '/parts/L3515-630SC', keywords: '8 inch chrome stack' }
	];

	it('puts an exact name above everything else', () => {
		expect(matchEntries('Accounts', entries)[0].id).toBe('b');
	});

	it('ranks the start of a name above the middle of one', () => {
		const order = matchEntries('order', entries).map((entry) => entry.id);
		// "Order desk" starts with it; the approve action only contains it.
		expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'));
	});

	it('finds an action by a word in its description', () => {
		expect(matchEntries('email', entries).map((entry) => entry.id)).toContain('a');
	});

	it('finds a record by its number, which is never shown', () => {
		expect(matchEntries('10012', entries).map((entry) => entry.id)).toEqual(['d']);
	});

	it('finds a part by words from its description', () => {
		expect(matchEntries('chrome stack', entries).map((entry) => entry.id)).toEqual(['e']);
	});

	it('matches several words in any order', () => {
		expect(matchEntries('draft approve', entries).map((entry) => entry.id)).toContain('a');
	});

	it('returns nothing rather than everything when nothing matches', () => {
		expect(matchEntries('zzzz', entries)).toEqual([]);
		expect(scoreEntry('zzzz', entries[0])).toBeNull();
	});

	it('shows the whole list, in order, before anything is typed', () => {
		expect(matchEntries('', entries).map((entry) => entry.id)).toEqual([
			'a',
			'b',
			'c',
			'd',
			'e'
		]);
	});

	it('honours the limit', () => {
		expect(matchEntries('', entries, 2)).toHaveLength(2);
	});

	it('groups the matches with the verbs first and drops empty groups', () => {
		const groups = groupEntries(matchEntries('', entries));
		expect(groups.map((group) => group.kind)).toEqual(['action', 'screen', 'account', 'part']);
		expect(groups[1].entries.map((entry) => entry.id)).toEqual(['b', 'c']);
	});
});

/*
  Two things about Drawer that are markup and stylesheet rather than
  arithmetic, and that a person cannot see going wrong until the app is in
  front of them. Both of these were real: the palette drew itself over every
  screen, all the time, and could not be dismissed.
*/
describe('the drawer, where CSS and the platform meet', () => {
	const source = readFileSync(
		new URL('./Drawer.svelte', import.meta.url),
		'utf8'
	);

	it('never sets display on a centred dialog without scoping it to open', () => {
		// The browser hides a closed dialog with `display: none`. Any display
		// rule here outranks that, so an unscoped one leaves the panel on the
		// page forever, with no backdrop and no way to close it, because
		// closing something that was never hidden changes nothing you can see.
		const rules = source.match(/dialog\.center[^{]*\{[^}]*\}/g) ?? [];
		expect(rules.length).toBeGreaterThan(0);
		for (const rule of rules) {
			if (/(^|[^-])display\s*:/.test(rule)) {
				expect(rule, rule).toMatch(/dialog\.center\[open\]/);
			}
		}
	});

	it('closes itself on Escape rather than trusting the platform to', () => {
		// Measured in Chrome: a modal dialog does not always fire `cancel` on
		// Escape, and when it does not, the panel stays up.
		expect(source).toMatch(/onkeydown=/);
		expect(source).toMatch(/event\.key === 'Escape'/);
	});
});
