// Turn a rule into one SQL query.
//
// A rule is data a person typed into a form, so nothing from it is ever
// pasted into SQL as text:
//   * the query itself is one of the reviewed sources (sources.ts);
//   * a column name is taken from the catalog's field list, never from the
//     rule (the rule only picks which catalog field it means);
//   * a comparison comes from the fixed OPERATOR_SQL table below;
//   * every value travels as a numbered parameter ($1, $2 ...).
// The rule is checked against the catalog again here, whoever called.
import { ruleSchema, TRIGGERS, type Operator, type Rule } from '$lib/automation/catalog';
import type { Param } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { SOURCES } from './sources.ts';

/** The only comparisons a rule can make, and the SQL each one becomes. */
const OPERATOR_SQL: Record<Operator, string> = {
	gt: '>',
	gte: '>=',
	lt: '<',
	lte: '<=',
	eq: '=',
	// "Owner is not me" should include records nobody owns; a plain <> would
	// drop them, because null <> 5 is not true in SQL.
	neq: 'is distinct from'
};

// A second guard on column names, in case a catalog entry is ever mistyped.
const SAFE_COLUMN = /^[a-z][a-z0-9_]{0,39}$/;

export interface CompiledRule {
	rule: Rule;
	text: string;
	params: Param[];
}

/** Every row a compiled query returns: the source's columns plus three of ours. */
export interface MatchRow {
	subject_key: string;
	customer_no: string;
	customer_name: string;
	commitment_id: number | null;
	record_owner_id: number | null;
	headline: string;
	/** This rule already fired for this subject. */
	already_fired: boolean;
	/** Matches in total, before the limit. */
	total_matches: number;
	/** How many of those the rule already fired for. */
	fired_before: number;
	[field: string]: unknown;
}

export interface CompileOptions {
	/** Who "me" means: the rule's owner. */
	ownerId: number;
	/** The saved rule, to mark subjects it already fired for (null for an unsaved rule). */
	ruleId: number | null;
	limit: number;
	/** List subjects that have not fired yet first (a real run), instead of most urgent first. */
	unfiredFirst?: boolean;
}

/** Throw a 422 that says what is wrong with the rule. */
export function refuseRule(issues: { path: PropertyKey[]; message: string }[]): never {
	const text = issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join(' ');
	throw new AppError(422, 'NL422', `This rule does not fit the catalog. ${text}`);
}

export function compileRule(input: unknown, options: CompileOptions): CompiledRule {
	const parsed = ruleSchema.safeParse(input);
	if (!parsed.success) refuseRule(parsed.error.issues);
	const rule = parsed.data;

	if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000) {
		throw new Error(`A rule query needs a limit from 1 to 1000, not ${options.limit}.`);
	}

	const trigger = TRIGGERS[rule.trigger];
	const source = SOURCES[rule.trigger];
	const params: Param[] = [options.ruleId];

	// $n for the next value.
	const bind = (value: Param) => {
		params.push(value);
		return `$${params.length}`;
	};

	const where = rule.conditions.map((condition) => {
		// The schema already refused unknown fields; look the field up anyway
		// and use the catalog's own key as the column name.
		const field = trigger.fields.find((f) => f.key === condition.field);
		if (!field || !SAFE_COLUMN.test(field.key)) {
			throw new AppError(422, 'NL422', `"${condition.field}" is not a field of this trigger.`);
		}
		const op = OPERATOR_SQL[condition.op];
		if (!op) throw new AppError(422, 'NL422', `"${condition.op}" is not a comparison a rule can make.`);

		if (field.type === 'user') {
			const userId = condition.value === 'me' ? options.ownerId : condition.value;
			if (!Number.isInteger(userId)) {
				throw new AppError(422, 'NL422', `"${field.label}" needs a person.`);
			}
			return `s.${field.key} ${op} ${bind(userId)}::int`;
		}
		if (condition.value === 'me') {
			throw new AppError(422, 'NL422', `"${field.label}" needs a number.`);
		}
		return `s.${field.key} ${op} ${bind(condition.value)}::numeric`;
	});

	const unfiredFirst = options.unfiredFirst ? 'm.already_fired, ' : '';
	const text = `
		select m.*,
		       (count(*) over ())::int as total_matches,
		       (count(*) filter (where m.already_fired) over ())::int as fired_before
		from (
			select s.*,
			       exists (
			         select 1 from nl.automation_firings f
			         where f.rule_id = $1::bigint and f.subject_key = s.subject_key
			       ) as already_fired
			from (${source.sql}
			) s
			where ${where.length ? where.join('\n\t\t\t  and ') : 'true'}
		) m
		order by ${unfiredFirst}${source.orderBy}
		limit ${bind(options.limit)}::int`;

	return { rule, text, params };
}
