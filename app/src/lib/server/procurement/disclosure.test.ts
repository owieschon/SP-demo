// What a vendor may hear. These tests are pure: no database, because the
// policy is a judgement about English text and should be readable as one.
import { describe, expect, it } from 'vitest';
import { buildVendorEmail } from './email.ts';
import { findDisclosureProblems, assertVendorSafe, type VendorDisclosureContext } from './disclosure.ts';

/** A realistic order: two parts, quantities, our purchase prices, dates. */
const ORDER = {
	vendorName: 'Harbor Plating Works',
	contactName: 'Jesse Okafor',
	orderNo: 'PD-8042',
	terms: 'Net 30',
	freightNote: 'Prepaid over $1,500 (this order clears the free-freight threshold)',
	lines: [
		{
			itemNo: 'EL5-90CH',
			description: 'ELBOW 5IN 90DEG CHROME',
			quantity: 40,
			unitCost: 42.5,
			requestedOn: '2026-10-08'
		},
		{
			itemNo: 'CL5BZ',
			description: 'CLAMP 5IN BAND ZINC',
			quantity: 200,
			unitCost: 3.15,
			requestedOn: '2026-10-08'
		}
	],
	fromName: 'Rowan Keller',
	fromTitle: 'Operations',
	fromEmail: 'rowan.keller@northline.example'
};

/**
 * What this order must not mention. The selling prices are well above the
 * purchase prices, the margins are the usual ratios, and there is one rival
 * vendor with its own price.
 */
const CONTEXT: VendorDisclosureContext = {
	vendorNo: 'V10230',
	vendorName: 'Harbor Plating Works',
	customerNames: ['Elk Ridge Diesel Supply Inc.', 'Twin Rivers Truck Center'],
	sellingPrices: [118.75, 9.4],
	marginPcts: [0.642, 0.665],
	otherVendorPrices: [46.9, 3.62],
	otherVendorNames: ['Riverbend Coating Corp.', 'Harbor Plating Works']
};

describe('the email a vendor gets', () => {
	it('says the parts, the quantities, our purchase prices, the dates and our terms', () => {
		const { subject, body } = buildVendorEmail(ORDER);
		expect(subject).toBe('Purchase order PD-8042 from Northline Exhaust');
		expect(body).toContain('EL5-90CH');
		expect(body).toContain('ELBOW 5IN 90DEG CHROME');
		expect(body).toContain('40');
		expect(body).toContain('$42.50'); // what we pay them: allowed
		expect(body).toContain('Oct 8, 2026');
		expect(body).toContain('Net 30');
		expect(body).toContain('Rowan Keller');
		// 40 x 42.50 + 200 x 3.15 = 2,330
		expect(body).toContain('$2,330.00');
	});

	it('passes the policy as built', () => {
		const { subject, body } = buildVendorEmail(ORDER);
		expect(findDisclosureProblems(`${subject}\n${body}`, CONTEXT)).toEqual([]);
		expect(() => assertVendorSafe(`${subject}\n${body}`, CONTEXT)).not.toThrow();
	});

	it('is not tripped up by a quantity that happens to look like a price', () => {
		// 40 is a quantity on this order AND, as a whole number, could look
		// like a dollar figure. It must not be read as one.
		const problems = findDisclosureProblems('We would like 40 of EL5-90CH.', {
			...CONTEXT,
			sellingPrices: [40],
			marginPcts: [0.4]
		});
		expect(problems).toEqual([]);
	});
});

describe('a vendor never hears', () => {
	function problems(text: string, context: Partial<VendorDisclosureContext> = {}) {
		return findDisclosureProblems(text, { ...CONTEXT, ...context });
	}

	it('a customer name', () => {
		const found = problems('These are for Elk Ridge Diesel Supply Inc., please ship direct.');
		expect(found.map((p) => p.kind)).toEqual(['customer']);
		expect(found[0].message).toContain('Elk Ridge Diesel Supply');
	});

	it('a customer name with the company ending left off', () => {
		expect(problems('For Elk Ridge Diesel Supply in Tulsa.').map((p) => p.kind)).toEqual(['customer']);
	});

	it('a customer name typed with a curly apostrophe', () => {
		expect(
			problems('For Keller’s Truck Parts.', { customerNames: ["Keller's Truck Parts"] }).map(
				(p) => p.kind
			)
		).toEqual(['customer']);
	});

	it('our selling price', () => {
		expect(problems('We sell these at $118.75 each.').map((p) => p.kind)).toContain('selling_price');
		// And with no dollar sign, because two decimal places is money.
		expect(problems('Ours goes out at 118.75.').map((p) => p.kind)).toContain('selling_price');
	});

	it('our margin, written as a percentage or as a ratio', () => {
		expect(problems('We make 64.2% on this one.').map((p) => p.kind)).toContain('margin');
		expect(problems('We make 64 percent on this one.').map((p) => p.kind)).toContain('margin');
		expect(problems('Our ratio here is 0.64.').map((p) => p.kind)).toContain('margin');
	});

	it('the word margin at all, whatever number is next to it', () => {
		const found = problems('Your price has to work with our margin.');
		expect(found.map((p) => p.kind)).toEqual(['margin']);
		expect(found[0].found).toBe('margin');
	});

	it('another vendor’s price', () => {
		expect(problems('Somebody else quoted $46.90.').map((p) => p.kind)).toContain(
			'other_vendor_price'
		);
		expect(problems('We have 46.90 on the table already.').map((p) => p.kind)).toContain(
			'other_vendor_price'
		);
	});

	it('another vendor’s name, while still allowing its own', () => {
		expect(problems('Riverbend Coating Corp. came in lower.').map((p) => p.kind)).toContain(
			'other_vendor'
		);
		// The vendor being written to is in otherVendorNames too, and is fine.
		expect(problems('Thank you, Harbor Plating Works.').map((p) => p.kind)).not.toContain(
			'other_vendor'
		);
	});

	it('a list price, a resale price or a markup, however it is phrased', () => {
		for (const phrase of ['list price', 'resale', 'markup', 'gross profit', 'selling price']) {
			expect(problems(`Note our ${phrase} on these.`).length, phrase).toBeGreaterThan(0);
		}
	});

	it('several of them at once, each named separately', () => {
		const found = problems(
			'For Twin Rivers Truck Center: we sell at $118.75, our margin is 64.2%, and Riverbend Coating Corp. quoted $46.90.'
		);
		expect(new Set(found.map((p) => p.kind))).toEqual(
			new Set(['customer', 'selling_price', 'margin', 'other_vendor_price', 'other_vendor'])
		);
	});
});

describe('the gate', () => {
	it('refuses with a 422 and says what the problem was', () => {
		let thrown: unknown;
		try {
			assertVendorSafe('These are for Elk Ridge Diesel Supply Inc.', CONTEXT);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ status: 422 });
		expect((thrown as Error).message).toContain('Elk Ridge Diesel Supply');
		expect((thrown as Error).message).toContain('never hears which customer');
	});

	it('lets a clean email through', () => {
		expect(() =>
			assertVendorSafe('Please confirm 40 of EL5-90CH at $42.50 by Oct 8.', CONTEXT)
		).not.toThrow();
	});
});
