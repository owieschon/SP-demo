// How a claim gets its MEANING: the three parts of a parse, and the guard
// that stops a model inventing one.
//
// No database in this file. Normalization, the recognizers and the span guard
// are pure, and a test that needs Postgres to prove "net 45 is 45 days" is a
// test that will not be run often enough.
import { describe, expect, it } from 'vitest';
import {
	normalizeValue,
	readCertificate,
	readDate,
	readDayRange,
	readFreightTerms,
	readPaymentTermsDays
} from '$lib/context/normalize';
import { recognize } from '$lib/context/recognize';
import { normalizeFailed, type AttributeMeta } from '$lib/context/types';
import { extractFrom, spanIsPresent, type ProseModel } from './extract.ts';

const TODAY = '2026-09-17';

/** A dictionary entry, written out, so these tests do not need a database. */
function attribute(over: Partial<AttributeMeta> & Pick<AttributeMeta, 'key' | 'valueType'>): AttributeMeta {
	return {
		key: over.key,
		label: over.label ?? over.key,
		subjectKind: over.subjectKind ?? 'customer',
		valueType: over.valueType,
		unit: over.unit ?? '',
		allowedValues: over.allowedValues ?? [],
		minNumber: over.minNumber ?? null,
		maxNumber: over.maxNumber ?? null,
		freshnessDays: over.freshnessDays ?? 365,
		disclosure: over.disclosure ?? 'customer',
		surfaces: over.surfaces ?? ['internal_review', 'quoting'],
		needsItem: over.needsItem ?? false,
		crossCheck: over.crossCheck ?? '',
		note: over.note ?? ''
	};
}

const PAYMENT_TERMS = attribute({
	key: 'payment_terms_days',
	valueType: 'integer',
	unit: 'days',
	label: 'Payment terms'
});
const LEAD_TIME = attribute({
	key: 'vendor_lead_time_days',
	valueType: 'range_days',
	unit: 'days',
	subjectKind: 'vendor',
	maxNumber: 200
});
const FREIGHT_TERMS = attribute({
	key: 'freight_terms',
	valueType: 'enum',
	allowedValues: ['prepaid', 'collect', 'prepaid_and_add', 'third_party']
});
const CERTIFICATE = attribute({
	key: 'certificate_required',
	valueType: 'enum',
	allowedValues: ['none', 'certificate_of_conformance', 'mill_test_report', 'both']
});
const PRICE_HOLD = attribute({ key: 'price_hold_until', valueType: 'date' });
const CUSTOMER_PART = attribute({ key: 'customer_part_no', valueType: 'text', needsItem: true });
const MINIMUM = attribute({
	key: 'vendor_minimum_order_value',
	valueType: 'money',
	unit: 'USD',
	subjectKind: 'vendor',
	maxNumber: 500_000
});

const DICTIONARY = new Map(
	[PAYMENT_TERMS, LEAD_TIME, FREIGHT_TERMS, CERTIFICATE, PRICE_HOLD, CUSTOMER_PART, MINIMUM].map(
		(entry) => [entry.key, entry]
	)
);

// ---------------------------------------------------------------------------
// The value third of a parse
// ---------------------------------------------------------------------------

describe('normalizing a value onto the type the dictionary names', () => {
	it('reads "net 45" as 45 days, with the unit', () => {
		const value = normalizeValue(PAYMENT_TERMS, 'Net 45', { referenceDate: TODAY });
		expect(normalizeFailed(value)).toBe(false);
		if (normalizeFailed(value)) return;
		expect(value.number).toBe(45);
		expect(value.unit).toBe('days');
		expect(value.display).toBe('45 days');
		// And the other columns stay empty: exactly one typed column is filled.
		expect(value.text).toBeNull();
		expect(value.date).toBeNull();
		expect(value.json).toBeNull();
	});

	it('reads "3 to 4 weeks" as a range of 21 to 28 days', () => {
		const value = normalizeValue(LEAD_TIME, '3 to 4 weeks', { referenceDate: TODAY });
		expect(normalizeFailed(value)).toBe(false);
		if (normalizeFailed(value)) return;
		expect(value.json).toEqual({ low: 21, high: 28 });
		expect(value.unit).toBe('days');
		expect(value.display).toBe('21 to 28 days');
	});

	it('reads a single lead time as a range with the same ends', () => {
		const value = normalizeValue(LEAD_TIME, 'about eight weeks', { referenceDate: TODAY });
		expect(normalizeFailed(value)).toBe(false);
		if (normalizeFailed(value)) return;
		expect(value.json).toEqual({ low: 56, high: 56 });
		expect(value.display).toBe('56 days');
	});

	it('reads freight words onto the enum, and refuses one that is not on it', () => {
		for (const [written, expected] of [
			['freight collect', 'collect'],
			['Freight prepaid and add is fine with us.', 'prepaid_and_add'],
			['bill their own carrier account', 'third_party'],
			['we pay the freight', 'prepaid']
		] as const) {
			const value = normalizeValue(FREIGHT_TERMS, written, { referenceDate: TODAY });
			expect(normalizeFailed(value)).toBe(false);
			if (normalizeFailed(value)) return;
			expect(value.text).toBe(expected);
		}
		const bad = normalizeValue(FREIGHT_TERMS, 'whatever is cheapest', { referenceDate: TODAY });
		expect(normalizeFailed(bad)).toBe(true);
	});

	it('tells a certificate of conformance from a mill test report, and from both', () => {
		expect(readCertificate('we need a C of C with every shipment')).toBe('certificate_of_conformance');
		expect(readCertificate('send the MTR for the heat')).toBe('mill_test_report');
		expect(readCertificate('a certificate of conformance and the mill test report')).toBe('both');
		expect(readCertificate('nothing about paperwork here')).toBeNull();
	});

	it('reads a date with no year as the one that is coming', () => {
		// Written in September, "December 31" is this year.
		expect(readDate('through December 31', '2026-09-17')).toBe('2026-12-31');
		// Written in November, "January 5" is next year, not ten months ago.
		expect(readDate('until January 5', '2026-11-20')).toBe('2027-01-05');
		expect(readDate('2026-10-31', '2026-09-17')).toBe('2026-10-31');
		expect(readDate('end of the year', '2026-09-17')).toBe('2026-12-31');
	});

	it('reads money with its unit and refuses prose', () => {
		const value = normalizeValue(MINIMUM, 'Our minimum order is $2,500', { referenceDate: TODAY });
		expect(normalizeFailed(value)).toBe(false);
		if (normalizeFailed(value)) return;
		expect(value.number).toBe(2500);
		expect(value.unit).toBe('USD');
		expect(value.display).toBe('$2,500.00');
		expect(normalizeFailed(normalizeValue(MINIMUM, 'quite a lot', { referenceDate: TODAY }))).toBe(true);
	});

	it('reads "due on receipt" as zero days rather than as nothing', () => {
		expect(readPaymentTermsDays('terms are due on receipt')).toBe(0);
		expect(readPaymentTermsDays('no terms mentioned')).toBeNull();
	});

	it('refuses a range written backwards', () => {
		expect(readDayRange('8 to 3 weeks')).toBeNull();
	});

	it('refuses a date attribute given a number', () => {
		const value = normalizeValue(PRICE_HOLD, '45', { referenceDate: TODAY });
		expect(normalizeFailed(value)).toBe(true);
		if (!normalizeFailed(value)) return;
		expect(value.failed).toMatch(/date/i);
	});

	it('reads freight terms from a whole sentence the way a recognizer hands it over', () => {
		expect(readFreightTerms('FOB origin, freight collect on our account')).toBe('collect');
	});
});

// ---------------------------------------------------------------------------
// Stage one: the shapes that have a shape
// ---------------------------------------------------------------------------

describe('the recognizers', () => {
	const options = { referenceDate: TODAY, dictionary: DICTIONARY, ourParts: new Set(['L760-128B']) };

	it('reads two facts out of one letter, each with the line it came from', () => {
		const text = [
			'Hi,',
			'',
			'From now on please ship freight collect on our stocking orders.',
			'Our terms stay Net 45 from the invoice date.',
			'',
			'Thanks'
		].join('\n');
		const hits = recognize(text, options);
		const byAttribute = new Map(hits.map((hit) => [hit.attribute, hit]));

		expect(byAttribute.get('payment_terms_days')?.value.number).toBe(45);
		expect(byAttribute.get('payment_terms_days')?.locator).toBe('line 4');
		expect(byAttribute.get('freight_terms')?.value.text).toBe('collect');
		expect(byAttribute.get('freight_terms')?.locator).toBe('line 3');
		// The snippet is the whole line, so a person reads a sentence.
		expect(byAttribute.get('freight_terms')?.snippet).toBe(
			'From now on please ship freight collect on our stocking orders.'
		);
	});

	it('does not read a question as an agreement', () => {
		const asking = recognize('Could we get Net 60 on this one?', options);
		expect(asking.some((hit) => hit.attribute === 'payment_terms_days')).toBe(false);

		const telling = recognize('Our terms are Net 60.', options);
		expect(telling.some((hit) => hit.attribute === 'payment_terms_days')).toBe(true);
	});

	it('pairs our part number with the customer’s own and scopes the claim to the part', () => {
		const hits = recognize('Also, your L760-128B shows up as XPT-4471 in our system.', options);
		const hit = hits.find((entry) => entry.attribute === 'customer_part_no');
		expect(hit).toBeDefined();
		expect(hit!.value.text).toBe('XPT-4471');
		// The scope is what makes this applicable rather than just true.
		expect(hit!.scope.itemNo).toBe('L760-128B');
	});

	it('says the same thing once, however many times a letter says it', () => {
		const text = 'Our terms are Net 45.\nAgain, terms Net 45, as agreed.';
		const hits = recognize(text, options).filter((hit) => hit.attribute === 'payment_terms_days');
		expect(hits).toHaveLength(1);
	});

	it('skips a pattern whose attribute is not in this database’s dictionary', () => {
		const thin = new Map([[FREIGHT_TERMS.key, FREIGHT_TERMS]]);
		const hits = recognize('Our terms stay Net 45 and freight collect.', {
			...options,
			dictionary: thin
		});
		expect(hits.map((hit) => hit.attribute)).toEqual(['freight_terms']);
	});

	it('reads only the attribute it was asked about, when it was asked about one', () => {
		const hits = recognize('Our terms stay Net 45 and freight collect.', {
			...options,
			only: ['payment_terms_days']
		});
		expect(hits.map((hit) => hit.attribute)).toEqual(['payment_terms_days']);
	});
});

// ---------------------------------------------------------------------------
// Stage two, and the guard that makes it safe
// ---------------------------------------------------------------------------

/** A stage-two model that answers whatever a test tells it to. */
function fakeModel(answers: { attribute: string; value: string; span: string; confidence: number }[]): ProseModel {
	return { name: 'prose_model', version: '1', extract: async () => answers };
}

const PROSE = [
	'Hello,',
	'',
	'Following our conversation last week, and to put it beyond doubt for the people in your office',
	'who will be looking at this later, we came away with the understanding that the pricing we',
	'discussed would be held through the end of December, and that nothing would move before then.',
	'',
	'Regards,',
	'Purchasing'
].join('\n');

const baseInput = {
	sourceDocumentId: 70001,
	text: PROSE,
	subject: { kind: 'customer' as const, id: '1214', raw: 'An account' },
	subjectConfidence: 0.98,
	assertedAt: '2026-08-01',
	dictionary: DICTIONARY,
	referenceDate: TODAY
};

describe('stage two, with the model faked', () => {
	it('accepts a claim whose quoted span is really in the text', async () => {
		const model = fakeModel([
			{
				attribute: 'price_hold_until',
				value: 'through the end of December',
				span: 'would be held through the end of December',
				confidence: 0.9
			}
		]);
		const result = await extractFrom(baseInput, model);
		expect(result.proseRan).toBe(true);
		expect(result.inventedSpans).toBe(0);
		expect(result.claims).toHaveLength(1);
		expect(result.claims[0].attribute).toBe('price_hold_until');
		expect(result.claims[0].value.date).toBe('2026-12-31');
		// The locator points at the line the span is actually on.
		expect(result.claims[0].locator).toBe('line 5');
		// A model's own confidence is capped, because choosing an attribute is
		// a weaker act than matching a labelled pattern.
		expect(result.claims[0].attributeConfidence).toBeLessThanOrEqual(0.85);
	});

	it('THROWS AWAY a claim whose quoted span is not in the text', async () => {
		const model = fakeModel([
			{
				attribute: 'price_hold_until',
				value: 'through the end of March',
				// Plausible, specific, and nowhere in the letter.
				span: 'we agreed to hold pricing through the end of March',
				confidence: 0.95
			}
		]);
		const result = await extractFrom(baseInput, model);
		expect(result.claims).toHaveLength(0);
		expect(result.inventedSpans).toBe(1);
		// Not kept as a query either: an invented citation is not a gap in the
		// dictionary, it is an extractor doing the one thing it must not.
		expect(result.unparsed).toHaveLength(0);
	});

	it('refuses an attribute that is not in the dictionary, and keeps the words', async () => {
		const model = fakeModel([
			{
				attribute: 'blanket_release_terms',
				value: 'annual',
				span: 'nothing would move before then',
				confidence: 0.8
			}
		]);
		const result = await extractFrom(baseInput, model);
		expect(result.claims).toHaveLength(0);
		expect(result.unparsed).toHaveLength(1);
		expect(result.unparsed[0].reason).toMatch(/blanket_release_terms/);
		expect(result.unparsed[0].snippet).toBe('nothing would move before then');
	});

	it('keeps a value it could not type as a query rather than dropping it', async () => {
		const model = fakeModel([
			{
				attribute: 'price_hold_until',
				value: 'for a while yet',
				span: 'nothing would move before then',
				confidence: 0.7
			}
		]);
		const result = await extractFrom(baseInput, model);
		expect(result.claims).toHaveLength(0);
		expect(result.unparsed).toHaveLength(1);
		expect(result.unparsed[0].proposedAttribute).toBe('price_hold_until');
		expect(result.unparsed[0].reason).toMatch(/date/i);
	});

	it('does not ask a model at all when stage one already read the document', async () => {
		let asked = 0;
		const model: ProseModel = {
			name: 'prose_model',
			version: '1',
			extract: async () => {
				asked += 1;
				return [];
			}
		};
		const result = await extractFrom(
			{ ...baseInput, text: 'Our terms stay Net 45 from the invoice date.' },
			model
		);
		expect(asked).toBe(0);
		expect(result.proseRan).toBe(false);
		expect(result.claims).toHaveLength(1);
	});

	it('does not ask a model about three lines of nothing', async () => {
		let asked = 0;
		const model: ProseModel = {
			name: 'prose_model',
			version: '1',
			extract: async () => {
				asked += 1;
				return [];
			}
		};
		await extractFrom({ ...baseInput, text: 'Thanks.\nSpeak soon.' }, model);
		expect(asked).toBe(0);
	});

	it('folds whitespace when it checks a span, because readers disagree about it', () => {
		expect(spanIsPresent('a  line   with   odd    spacing', 'line with odd spacing')).toBe(true);
		expect(spanIsPresent('a line with odd spacing', 'a line with even spacing')).toBe(false);
		// Too short to be a citation of anything.
		expect(spanIsPresent('anything at all', 'at')).toBe(false);
	});
});
