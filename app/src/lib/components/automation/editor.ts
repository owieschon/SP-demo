// The rule editor's working state, and how it turns into a Rule.
//
// While someone types, a condition's value is text ("10000", "", "me"), not
// yet a number. toCondition turns it into what the catalog expects; a blank
// or half-typed number becomes NaN, which ruleSchema reports as "needs a
// number" next to that box.
import {
	OPERATORS_BY_TYPE,
	TRIGGERS,
	type Condition,
	type FieldDef,
	type Operator,
	type TriggerKey
} from '$lib/automation/catalog';

export interface EditorRow {
	/** Only for Svelte's keyed list; never sent. */
	key: number;
	field: string;
	op: Operator;
	value: string;
}

let nextKey = 1;

export function fieldOf(trigger: TriggerKey, key: string): FieldDef | undefined {
	return TRIGGERS[trigger].fields.find((f) => f.key === key);
}

export function fromCondition(condition: Condition): EditorRow {
	return { key: nextKey++, field: condition.field, op: condition.op, value: String(condition.value) };
}

/** A new row on the trigger's first field that is not a person. */
export function blankRow(trigger: TriggerKey): EditorRow {
	const field = TRIGGERS[trigger].fields.find((f) => f.type !== 'user') ?? TRIGGERS[trigger].fields[0];
	return { key: nextKey++, field: field.key, op: OPERATORS_BY_TYPE[field.type][0], value: '' };
}

export function toCondition(trigger: TriggerKey, row: EditorRow): Condition {
	const field = fieldOf(trigger, row.field);
	if (row.value === 'me' && field?.type === 'user') {
		return { field: row.field, op: row.op, value: 'me' };
	}
	const text = row.value.trim();
	return { field: row.field, op: row.op, value: text === '' ? Number.NaN : Number(text) };
}

/** After the field changes: keep the comparison if it still fits, and a value only of the same kind. */
export function fitRowToField(trigger: TriggerKey, row: EditorRow, previousType: FieldDef['type'] | undefined) {
	const field = fieldOf(trigger, row.field);
	if (!field) return;
	const allowed = OPERATORS_BY_TYPE[field.type];
	if (!allowed.includes(row.op)) row.op = allowed[0];
	if (field.type !== previousType) row.value = field.type === 'user' ? 'me' : '';
}

/**
 * The rows that still make sense after switching trigger: the same field
 * exists with the same type. The rest are dropped.
 */
export function rowsForTrigger(from: TriggerKey, to: TriggerKey, rows: EditorRow[]): EditorRow[] {
	return rows.filter((row) => {
		const before = fieldOf(from, row.field);
		const after = fieldOf(to, row.field);
		return before !== undefined && after !== undefined && before.type === after.type;
	});
}

/** Problem text for one condition row, from the issues keyed by path. */
export function rowIssue(issues: Record<string, string>, index: number): string | null {
	const prefix = `conditions.${index}`;
	return (
		issues[`${prefix}.field`] ?? issues[`${prefix}.op`] ?? issues[`${prefix}.value`] ?? issues[prefix] ?? null
	);
}

