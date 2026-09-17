// Words for rules: the plain-English sentence a rule reads as, the text an
// action writes once its {placeholders} are filled in, and problem messages
// a person can act on. Shared by the server (list page, runs, form actions)
// and the editor (the live sentence), so a rule reads the same everywhere.
import { money } from '$lib/format';
import {
	ACTION_LABELS,
	COMMON_PLACEHOLDERS,
	OPERATORS,
	TRIGGERS,
	type Action,
	type Condition,
	type FieldDef,
	type FieldType,
	type TriggerKey
} from './catalog';

/** "Committed value" -> "committed value", for the middle of a sentence. */
function lowerFirst(text: string): string {
	return text.charAt(0).toLowerCase() + text.slice(1);
}

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** A field's value as a person would say it: $1,234, 40%, 12 days, 1.5. */
export function formatValue(type: FieldType, value: number | null | undefined): string {
	if (value === null || value === undefined || Number.isNaN(value)) return 'unknown';
	switch (type) {
		case 'money':
			return money(value);
		case 'percent':
			return `${number.format(value)}%`;
		case 'days':
			return Math.abs(value) === 1 ? `${value} day` : `${number.format(value)} days`;
		default:
			return number.format(value);
	}
}

/** The label a placeholder chip shows. */
export function placeholderLabel(trigger: TriggerKey, name: string): string {
	const common: Record<(typeof COMMON_PLACEHOLDERS)[number], string> = {
		customer: 'Customer name',
		commitment: 'Commitment number',
		headline: 'What matched'
	};
	if (name in common) return common[name as keyof typeof common];
	return TRIGGERS[trigger].fields.find((f) => f.key === name)?.label ?? name;
}

/** One matched row, as the text renderer needs it. */
export interface TemplateRow {
	customer_name: string;
	commitment_id: number | null;
	headline: string;
	[field: string]: unknown;
}

/**
 * Fill in a template from one matched row:
 *   {customer}   the customer's name
 *   {commitment} C-123 (empty when the match is not a commitment)
 *   {headline}   the match's short label
 *   {field}      the field's value, formatted for its type
 * Unknown names are left as they are (the catalog check refuses them first).
 */
export function renderTemplate(trigger: TriggerKey, template: string, row: TemplateRow): string {
	const fields = new Map<string, FieldDef>(TRIGGERS[trigger].fields.map((f) => [f.key, f]));
	const filled = template.replace(/\{([a-z_0-9]+)\}/g, (whole, name: string) => {
		if (name === 'customer') return row.customer_name;
		if (name === 'commitment') return row.commitment_id === null ? '' : `C-${row.commitment_id}`;
		if (name === 'headline') return row.headline;
		const field = fields.get(name);
		if (!field || field.type === 'user') return whole;
		const value = row[name];
		return formatValue(field.type, typeof value === 'number' ? value : null);
	});
	// An empty {commitment} can leave double spaces behind.
	return filled.replace(/\s{2,}/g, ' ').trim();
}

/** Who a user condition names: "me" is whoever owns the rule. */
export type NameOf = (userId: number) => string;

function describeCondition(
	trigger: TriggerKey,
	condition: Condition,
	nameOf: NameOf,
	ownerName: string | null
): string {
	const field = TRIGGERS[trigger].fields.find((f) => f.key === condition.field);
	if (!field) return `${condition.field} (not known to this trigger)`;
	const op = OPERATORS[condition.op] ?? condition.op;
	let value: string;
	// The editor sends a box still being filled in as NaN.
	const blank = typeof condition.value === 'number' && !Number.isFinite(condition.value);
	if (blank) {
		value = '...';
	} else if (condition.value === 'me') {
		value = ownerName ?? 'me';
	} else if (field.type === 'user') {
		value = nameOf(condition.value);
	} else {
		value = formatValue(field.type, condition.value);
	}
	return `${lowerFirst(field.label)} ${op} ${value}`;
}

function describeAction(action: Action): string {
	if (action.kind === 'next_step') {
		const who = action.assignTo === 'record_owner' ? 'the record owner' : 'the rule owner';
		const days = action.dueInDays;
		let due = `due in ${days} days`;
		if (!Number.isFinite(days)) due = 'due in ... days';
		else if (days === 0) due = 'due the same day';
		else if (days === 1) due = 'due in 1 day';
		return `add a next step for ${who}, ${due}: "${action.title}"`;
	}
	return `${lowerFirst(ACTION_LABELS.note)}: "${action.body}"`;
}

/** Just enough of a rule to describe it; the editor's half-built rule fits too. */
export interface DescribableRule {
	trigger: TriggerKey;
	conditions: Condition[];
	action: Action;
}

/**
 * "When a commitment window closed short, if committed value is at least
 * $10,000 and days since the window closed is at least 3 days, add a next
 * step for the record owner, due in 2 days: "..."".
 */
export function describeRule(rule: DescribableRule, nameOf: NameOf, ownerName: string | null = null): string {
	const when = `When ${lowerFirst(TRIGGERS[rule.trigger].label)}`;
	const parts = rule.conditions.map((c) => describeCondition(rule.trigger, c, nameOf, ownerName));
	let conditions = '';
	if (parts.length === 1) conditions = `, if ${parts[0]}`;
	if (parts.length > 1) conditions = `, if ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
	return `${when}${conditions}, ${describeAction(rule.action)}.`;
}

/**
 * The catalog writes its own messages in plain English; zod's built-in ones
 * ("Too small: expected string to have >=3 characters") are for developers.
 * This swaps the built-in ones for words a person can act on.
 */
export function friendlyIssues(issues: { path: PropertyKey[]; message: string; code: string }[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const issue of issues) {
		const path = issue.path.join('.');
		if (out[path]) continue;
		const last = String(issue.path[issue.path.length - 1] ?? '');
		let message = issue.message;
		if (issue.code !== 'custom') {
			if (last === 'value') message = 'Enter a number.';
			else if (last === 'name') message = 'Give the rule a name of 3 to 80 characters.';
			else if (last === 'title' || last === 'body') message = 'Write at least 3 characters.';
			else if (last === 'dueInDays') message = 'Due in 0 to 60 days.';
			else if (last === 'conditions') message = 'A rule can have up to 6 conditions.';
		}
		out[path] = message;
	}
	return out;
}
