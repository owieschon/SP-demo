// Workflow C, the parts that need no database: reading emails, dates, part
// numbers, units and the live-mode gate.
import { describe, expect, it } from 'vitest';
import { findNeededBy } from './dates.ts';
import { headerDate, parseEmail } from './email.ts';
import { LIVE_MINUTES, passphraseMatches, signLiveCookie, verifyLiveCookie } from './live.ts';
import { editDistance, normalizePart, parsePart, rankSiblings } from './parts.ts';
import { extractWithRules } from './rules.ts';
import { rfqDraftSchema } from './schema.ts';
import { piecesPerUnit } from './validate.ts';

const TODAY = '2026-09-17'; // a Thursday

function email(body: string, headers = 'From: Pat Doe <pat@shop.example>\nSubject: quote\nDate: Wed, 16 Sep 2026 09:00:00 -0500') {
	return `${headers}\n\n${body}`;
}

/** The (item, quantity, unit) triples the rules extractor read. */
function linesOf(body: string) {
	return extractWithRules(email(body), TODAY).lines.map((l) => [l.item_no.value, l.quantity.value, l.unit.value]);
}

describe('the rules extractor', () => {
	it('always returns a draft in the shared shape', () => {
		const draft = extractWithRules(email('Please quote 2 S6-96BC.'), TODAY);
		expect(rfqDraftSchema.safeParse(draft).success).toBe(true);
	});

	it('reads quantities written before or after a part, in several styles', () => {
		expect(linesOf('4 x S6-96BC')).toEqual([['S6-96BC', 4, null]]);
		expect(linesOf('S6-96BC x 4')).toEqual([['S6-96BC', 4, null]]);
		expect(linesOf('S6-96BC - 4 pcs')).toEqual([['S6-96BC', 4, 'pcs']]);
		expect(linesOf('(2) S6-96BC')).toEqual([['S6-96BC', 2, null]]);
		expect(linesOf('CL6SZ qty: 8')).toEqual([['CL6SZ', 8, null]]);
		expect(linesOf('need 2 of S6-96BC')).toEqual([['S6-96BC', 2, null]]);
	});

	it('keeps units as written for the validator to convert', () => {
		expect(linesOf('two dozen CL6SZ')).toEqual([['CL6SZ', 2, 'dozen']]);
		expect(linesOf('2 pair S6-96BC')).toEqual([['S6-96BC', 2, 'pair']]);
		expect(linesOf('a box of 10 CL3SZ')).toEqual([['CL3SZ', 1, 'box of 10']]);
		expect(linesOf('CL45UZ (box of 10) x 3')).toEqual([['CL45UZ', 3, 'box of 10']]);
		expect(linesOf('half a dozen CL4WZ')).toEqual([['CL4WZ', 6, 'ea']]);
	});

	it('splits several parts on one line', () => {
		expect(linesOf('Need S8-36BS x2, HS8-36C x2, CL6VSS x4 and 1 M-4514.')).toEqual([
			['S8-36BS', 2, null],
			['HS8-36C', 2, null],
			['CL6VSS', 4, null],
			['M-4514', 1, null]
		]);
	});

	it('does not read sizes or phone numbers as quantities', () => {
		expect(linesOf('S6-96BC 6" x 96" bull hauler')).toEqual([['S6-96BC', null, null]]);
		const draft = extractWithRules(
			email('Quote please:\nS7-96SA qty 2\n\nThanks,\nPat Doe\nShop Co\nCell (304) 555-0187\nFax 304 555 0111 x 12'),
			TODAY
		);
		expect(draft.lines.map((l) => [l.item_no.value, l.quantity.value])).toEqual([['S7-96SA', 2]]);
	});

	it('keeps part numbers as written, typos and all', () => {
		expect(linesOf('4 pcs s696bc')).toEqual([['s696bc', 4, 'pcs']]);
	});

	it('reads a table in any column order, with prices and a subtotal', () => {
		const draft = extractWithRules(
			email('| Qty | Part | Price | Total |\n|---|---|---|---|\n| 4 | S6-96BC | $157.73 | $630.92 |\n| | | Subtotal | $1,052.78 |'),
			TODAY
		);
		expect(draft.lines).toHaveLength(1);
		expect(draft.lines[0].quantity.value).toBe(4);
		expect(draft.lines[0].unit_price.value).toBe(157.73);
		expect(draft.lines[0].line_total.value).toBe(630.92);
		expect(draft.stated_subtotal.value).toBe(1052.78);

		const spaced = extractWithRules(email('QTY   PART NUMBER   UOM\n2     S6-96BC       EA\n12    CL6SZ         EA'), TODAY);
		expect(spaced.lines.map((l) => [l.item_no.value, l.quantity.value])).toEqual([
			['S6-96BC', 2],
			['CL6SZ', 12]
		]);
	});

	it('finds nothing in an email that asks for no parts', () => {
		const draft = extractWithRules(
			email('Thanks for the delivery, all arrived fine. Call me at 555-0100.', 'From: Pat Doe <pat@shop.example>\nSubject: thanks'),
			TODAY
		);
		expect(draft.lines).toEqual([]);
		expect(draft.is_request).toBe(false);
	});

	it('takes the company and branch from the signature', () => {
		const draft = extractWithRules(
			email('Please quote 3 S6-48BC.\n\nThanks,\nJordan Mills\nParts Counter\nBulldog Truck Centers - Waco\n254-555-0143'),
			TODAY
		);
		expect(draft.customer_name.value).toBe('Bulldog Truck Centers');
		expect(draft.branch_hint.value).toBe('Waco');
	});
});

describe('reading an email', () => {
	it('reads the Date header as written', () => {
		expect(headerDate('Wed, 16 Sep 2026 23:59:00 -0800')).toBe('2026-09-16');
		expect(headerDate('Tue, Sep 15, 2026 at 3:41 PM')).toBe('2026-09-15');
	});

	it('uses the forwarded email: its sender, its date, the request below the forward line', () => {
		const parsed = parseEmail(
			[
				'From: Dana <dana@northline.example>',
				'Date: Wed, 16 Sep 2026 09:05:00 -0500',
				'',
				'See below.',
				'',
				'---------- Forwarded message ---------',
				'From: Morgan Navarro <morgan@truckshop.example>',
				'Date: Tue, Sep 15, 2026 at 3:41 PM',
				'',
				'Please price 2 S7-144BC.',
				'',
				'Thanks,',
				'Morgan'
			].join('\n')
		);
		expect(parsed.forwarded).toBe(true);
		expect(parsed.headers.fromEmail).toBe('morgan@truckshop.example');
		expect(parsed.headers.date).toBe('2026-09-15');
		expect(parsed.request).toContain('Please price 2 S7-144BC.');
		expect(parsed.signature).toBe('Morgan');
	});

	it('drops the quoted thread under a reply', () => {
		const draft = extractWithRules(
			email('Quote 3 S6-42SS please.\n\nOn Mon, Aug 3, 2026 at 9:02 AM Casey <c@x.example> wrote:\n> Please quote 10 S6-42SS and 20 CL6SZ'),
			TODAY
		);
		expect(draft.lines.map((l) => l.item_no.value)).toEqual(['S6-42SS']);
	});

	it('drops an Outlook-style quoted message', () => {
		const draft = extractWithRules(
			email('Add 2 FL5-14SS please.\n\nFrom: Dana <dana@northline.example>\nSent: Monday, September 14, 2026 10:03 AM\n\nS7-96SA qty 2'),
			TODAY
		);
		expect(draft.lines.map((l) => l.item_no.value)).toEqual(['FL5-14SS']);
	});
});

describe('needed-by dates', () => {
	const anchor = '2026-09-16'; // a Wednesday
	const date = (text: string) => findNeededBy(text, anchor)?.date;

	it('reads written dates, filling in the year', () => {
		expect(date('needed by 10/2')).toBe('2026-10-02');
		expect(date('Ship date: 10/5/26')).toBe('2026-10-05');
		expect(date('by Oct 2')).toBe('2026-10-02');
		expect(date('in hand by October 1st')).toBe('2026-10-01');
		expect(date('due 2026-11-03')).toBe('2026-11-03');
	});

	it('keeps a recent past date in this year, so validation can flag it', () => {
		expect(date('needed by 9/10')).toBe('2026-09-10');
		// Months back means next year.
		expect(findNeededBy('by 1/15', '2026-12-01')?.date).toBe('2027-01-15');
	});

	it('reads weekdays and relative phrases from the anchor', () => {
		expect(date('by Friday')).toBe('2026-09-18');
		expect(date('by next Friday')).toBe('2026-09-25');
		// Written on a Saturday, next Friday is the coming one.
		expect(findNeededBy('by next Friday', '2026-09-19')?.date).toBe('2026-09-25');
		expect(date('by end of month')).toBe('2026-09-30');
		expect(date('by the end of next month')).toBe('2026-10-31');
		expect(date('within 2 weeks')).toBe('2026-09-30');
	});

	it('needs a lead word, and reports ASAP without a date', () => {
		expect(findNeededBy('the 3/4 inch clamps', anchor)).toBeNull();
		expect(findNeededBy('ASAP please', anchor)).toEqual({ text: 'ASAP', date: null, confidence: 0.5 });
	});

	it('refuses impossible dates', () => {
		expect(date('by 2/30/2027')).toBeNull();
	});
});

describe('part numbers', () => {
	it('normalizes case, spaces and dashes', () => {
		expect(normalizePart(' l3515-630 sc ')).toBe('L3515630SC');
	});

	it('reads what a part number encodes, with or without the dash', () => {
		expect(parsePart('L3515-630SC')).toMatchObject({ family: 'elbow', diameter: 3.5, angle: 15, legs: [6, 30], finish: 'SC' });
		expect(parsePart('l490168b')).toMatchObject({ family: 'elbow', diameter: 4, angle: 90, legs: [16, 8], finish: 'B' });
		expect(parsePart('S7-144BC')).toMatchObject({ family: 'stack', diameter: 7, length: 144, style: 'B', finish: 'C' });
		expect(parsePart('S696BC')).toMatchObject({ family: 'stack', diameter: 6, length: 96 });
		expect(parsePart('CL45UZ')).toMatchObject({ family: 'clamp', diameter: 4.5, style: 'U', finish: 'Z' });
		expect(parsePart('FL6-36SS')).toMatchObject({ family: 'flex', diameter: 6, length: 36 });
		expect(parsePart('M-4164')).toMatchObject({ family: 'muffler' });
		expect(parsePart('S6-96BX')).toBeNull();
	});

	it('measures edit distance', () => {
		expect(editDistance('S696BC', 'S696BX')).toBe(1);
		expect(editDistance('ABC', 'ABC')).toBe(0);
		expect(editDistance('', 'AB')).toBe(2);
	});

	const catalog = [
		{ item_no: 'S6-96BC', description: '6" X 96" BULL HAULER STACK CHROME', list_price: 366.81 },
		{ item_no: 'S6-48BC', description: '6" X 48" BULL HAULER STACK CHROME', list_price: 313.41 },
		{ item_no: 'S6-96SS', description: '6" X 96" STRAIGHT CUT STACK STAINLESS', list_price: 300 },
		{ item_no: 'S8-96BS', description: '8" X 96" BULL HAULER STACK STAINLESS', list_price: 400 },
		{ item_no: 'S5-96BS', description: '5" X 96" BULL HAULER STACK STAINLESS', list_price: 350 },
		{ item_no: 'CL6SZ', description: '6" SADDLE CLAMP ZINC', list_price: 39.32 }
	];

	it('ranks siblings: diameter, then style, then length, then finish', () => {
		// 6" x 96" bull hauler in stainless does not exist.
		expect(rankSiblings('S6-96BS', catalog).map((s) => s.item_no)).toEqual(['S6-96BC', 'S6-48BC', 'S6-96SS']);
		// Only a 5" or 8" stainless bull hauler would be the wrong size.
		expect(rankSiblings('S7-96BS', catalog).map((s) => s.item_no).slice(0, 2)).toEqual(['S8-96BS', 'S6-96BC']);
	});

	it('puts a one-character slip first when the number cannot be read', () => {
		const ranked = rankSiblings('S6-96BX', catalog);
		expect(ranked[0].item_no).toBe('S6-96BC');
		expect(ranked[0].why).toMatch(/one character/);
	});

	it('says why a sibling was suggested', () => {
		const [, , third] = rankSiblings('S6-96BS', catalog);
		expect(third.why).toMatch(/different style/);
	});
});

describe('units', () => {
	it('knows how many pieces a unit holds', () => {
		expect(piecesPerUnit(null)).toBe(1);
		expect(piecesPerUnit('pcs')).toBe(1);
		expect(piecesPerUnit('EA.')).toBe(1);
		expect(piecesPerUnit('pair')).toBe(2);
		expect(piecesPerUnit('dozen')).toBe(12);
		expect(piecesPerUnit('box of 10')).toBe(10);
		expect(piecesPerUnit('ft')).toBeNull();
		expect(piecesPerUnit('set')).toBeNull();
	});
});

describe('the live-mode gate', () => {
	const secret = 'test-secret';

	it('compares passphrases exactly', () => {
		expect(passphraseMatches('open sesame', 'open sesame')).toBe(true);
		expect(passphraseMatches('open sesame ', 'open sesame')).toBe(false);
		expect(passphraseMatches('', 'open sesame')).toBe(false);
		expect(passphraseMatches('anything', undefined)).toBe(false);
	});

	it('issues a cookie that only works for the same user, until it expires', () => {
		const now = Date.UTC(2026, 8, 17, 12);
		const cookie = signLiveCookie(2, secret, now);
		expect(verifyLiveCookie(cookie, 2, secret, now + 1000)).toBe(true);
		expect(verifyLiveCookie(cookie, 3, secret, now + 1000)).toBe(false);
		expect(verifyLiveCookie(cookie, 2, 'another-secret', now + 1000)).toBe(false);
		expect(verifyLiveCookie(cookie, 2, secret, now + LIVE_MINUTES * 60 * 1000 + 1)).toBe(false);
		// A stretched expiry breaks the signature.
		const [id, , sig] = cookie.split('.');
		expect(verifyLiveCookie(`${id}.${now + 999_999_999}.${sig}`, 2, secret, now)).toBe(false);
	});
});
