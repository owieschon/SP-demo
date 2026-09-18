// Turning what somebody typed into the value a policy takes, and back again.
//
// The real check is in the database: the trigger on nl.policies calls
// nl.policy_shape_problem() and refuses anything that does not fit, whoever
// writes it. This file exists so the form can turn text into the right kind
// of JSON first, and so an obvious mistake gets a sentence back without a
// round trip. It never decides that something is allowed: it only decides
// what shape to send.
import type { PolicyType } from './types.ts';

export type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

/**
 * One form field, as text, turned into the value for this policy type. A
 * text_list arrives as a comma-separated line, because that is what a single
 * input can carry and this is not a place for a tag widget.
 */
export function parsePolicyValue(type: PolicyType, raw: string): Parsed {
	const text = raw.trim();

	switch (type.valueType) {
		case 'number':
		case 'integer': {
			if (text === '') return { ok: false, message: 'Type a number.' };
			// A ratio may be typed either way round: 20 means 20%, 0.2 means the
			// same thing. Anything above 1 with a ratio unit is a percentage,
			// because no ratio policy here goes above 1.
			const asNumber = Number(text.replace(/[$,%\s]/g, ''));
			if (!Number.isFinite(asNumber)) return { ok: false, message: `${text} is not a number.` };
			const scaled = type.unit === 'ratio' && asNumber > 1 ? asNumber / 100 : asNumber;
			if (type.valueType === 'integer' && !Number.isInteger(scaled)) {
				return { ok: false, message: 'This one is a whole number.' };
			}
			return { ok: true, value: scaled };
		}
		case 'boolean':
			// A checkbox sends 'on' when it is ticked and nothing at all when it
			// is not, so anything that is not plainly false counts as true.
			return { ok: true, value: text !== '' && text !== 'false' && text !== 'no' };
		case 'enum':
		case 'text':
			if (text === '') return { ok: false, message: 'Choose a value.' };
			return { ok: true, value: text };
		case 'text_list': {
			const parts = text
				.split(',')
				.map((part) => part.trim())
				.filter((part) => part !== '');
			return { ok: true, value: parts };
		}
		case 'object':
			// The one object policy is not editable in the app yet, so the form
			// never offers it. Saying so beats a JSON box nobody can be sure of.
			return {
				ok: false,
				message: 'This policy holds several named numbers and is not editable here yet.'
			};
	}
}

/** The value of a policy row, as text to put back in the form. */
export function policyValueToText(type: PolicyType, value: unknown): string {
	if (value === null || value === undefined) return '';
	if (Array.isArray(value)) return value.join(', ');
	if (typeof value === 'boolean') return value ? 'yes' : 'no';
	if (typeof value === 'object') return JSON.stringify(value);
	if (typeof value === 'number' && type.unit === 'ratio') return String(Math.round(value * 1000) / 10);
	return String(value);
}

/** What to put under the input, so the rules are visible before a refusal. */
export function policyValueHint(type: PolicyType): string {
	const bits: string[] = [];
	if (type.unit === 'ratio') bits.push('a percentage, so 20 or 0.20');
	else if (type.unit === 'USD') bits.push('dollars');
	else if (type.unit === 'days') bits.push('whole days');
	else if (type.unit === 'pieces') bits.push('a number of pieces');
	else if (type.unit === 'rank') bits.push('0 to 100, higher goes first');
	if (type.valueType === 'text_list') bits.push('several, separated by commas');
	if (type.minValue !== null || type.maxValue !== null) {
		const low = type.minValue === null ? null : type.unit === 'ratio' ? `${type.minValue * 100}%` : String(type.minValue);
		const high = type.maxValue === null ? null : type.unit === 'ratio' ? `${type.maxValue * 100}%` : String(type.maxValue);
		if (low !== null && high !== null) bits.push(`between ${low} and ${high}`);
		else if (low !== null) bits.push(`${low} or more`);
		else if (high !== null) bits.push(`${high} at most`);
	}
	return bits.join(', ');
}
