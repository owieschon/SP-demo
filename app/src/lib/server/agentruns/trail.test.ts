// The two rules of a trail, with no database in the way.
//
//   1. A step never holds anything the disclosure policy would forbid its
//      reader from seeing, and what it keeps back it says it is keeping back.
//   2. A refusal is a step with a rule on it.
import { describe, expect, it } from 'vitest';
import type { Fact } from '$lib/desk/types';
import { RULES } from '$lib/agentruns/types';
import { checkStep, Trail } from './trail.ts';

const OWN_PRICE: Fact = {
	kind: 'own_price',
	text: 'L760-128B at 12: $57.79 each, $693.48 the line.',
	subject: '1214',
	ids: { customer_no: '1214', item_no: 'L760-128B' },
	amounts: [57.79, 693.48]
};

const COST: Fact = {
	kind: 'unit_cost',
	text: 'L760-128B costs us $21.40.',
	subject: null,
	ids: { item_no: 'L760-128B' },
	amounts: [21.4]
};

describe('a step goes through the same check as a draft reply', () => {
	it('keeps a step the reader may see', () => {
		const step = checkStep(
			{ kind: 'tool', label: 'price_lines', args: { customer_no: '1214' }, result: OWN_PRICE.text, facts: [OWN_PRICE] },
			{ reader: 'customer', subject: '1214' }
		);
		expect(step.withheld).toBeFalsy();
		expect(step.result).toContain('$57.79');
		expect(step.args).toEqual({ customer_no: '1214' });
	});

	it('withholds a step citing what the reader may not be told, and says so', () => {
		const step = checkStep(
			{ kind: 'tool', label: 'unit_cost', args: { item_no: 'L760-128B' }, result: COST.text, facts: [COST] },
			{ reader: 'customer', subject: '1214' }
		);
		expect(step.withheld).toBe(true);
		expect(step.args).toBeNull();
		expect(step.result).toBe('');
		// The label survives: "there was a step here" is information.
		expect(step.label).toBe('unit_cost');
		expect(step.withheld_reason).toContain('what the part costs us');
		expect(step.withheld_reason).toContain(RULES.trailDisclosure.note);
	});

	it('shows the same step inside the company', () => {
		const step = checkStep(
			{ kind: 'tool', label: 'unit_cost', result: COST.text, facts: [COST] },
			{ reader: 'internal', subject: '1214' }
		);
		expect(step.withheld).toBeFalsy();
		expect(step.result).toBe(COST.text);
	});

	it('withholds another account’s figures even inside the company', () => {
		const other: Fact = { ...OWN_PRICE, subject: '9999' };
		const step = checkStep(
			{ kind: 'tool', label: 'price_lines', result: other.text, facts: [other] },
			{ reader: 'customer', subject: '1214' }
		);
		expect(step.withheld).toBe(true);
	});

	it('withholds a figure no fact stands behind', () => {
		const step = checkStep(
			{ kind: 'note', label: 'Worked out a subtotal', result: 'The subtotal came to $907.12.' },
			{ reader: 'internal', subject: '1214' }
		);
		expect(step.withheld).toBe(true);
		expect(step.withheld_reason).toContain('$907.12');
	});

	it('keeps the same figure when a fact stands behind it', () => {
		const subtotal: Fact = {
			kind: 'own_price',
			text: 'Subtotal for this quote: $907.12',
			subject: '1214',
			ids: { customer_no: '1214' },
			amounts: [907.12]
		};
		const step = checkStep(
			{ kind: 'note', label: 'Worked out a subtotal', result: 'The subtotal came to $907.12.', facts: [subtotal] },
			{ reader: 'internal', subject: '1214' }
		);
		expect(step.withheld).toBeFalsy();
	});
});

describe('a refusal is a step with a rule on it', () => {
	it('carries the rule id and what the rule says', () => {
		const step = checkStep(
			{ kind: 'refusal', label: 'Did not price anything', rule: 'unmatchedSender', result: 'No contact, no domain, no name.' },
			{ reader: 'internal', subject: null }
		);
		expect(step.kind).toBe('refusal');
		expect(step.rule).toBe(RULES.unmatchedSender.id);
		expect(step.rule_note).toBe(RULES.unmatchedSender.note);
	});
});

describe('a trail keeps its order', () => {
	it('hands back every step in the order it happened', () => {
		const trail = new Trail({ reader: 'internal', subject: '1214' });
		trail
			.read('The message, as it arrived')
			.decide('Read it as a request for quote')
			.tool('price_lines', { customer_no: '1214' }, '2 rows back.', { rows: 2, ms: 4 })
			.refuse('Did not guess at a part', 'unresolvedLine')
			.produce('A reply, into the queue nobody has approved yet');

		const rows = trail.rows();
		expect(rows.map((step) => step.kind)).toEqual(['read', 'decision', 'tool', 'refusal', 'output']);
		expect(trail.length).toBe(5);
		expect(trail.refusals).toBe(1);
		expect(rows[2].rows).toBe(2);
		expect(rows[2].ms).toBe(4);
		expect(rows[3].rule).toBe(RULES.unresolvedLine.id);
	});
});
