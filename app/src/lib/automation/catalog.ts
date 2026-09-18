// What an automation rule can say, shared by the editor (browser) and the
// server. A rule is data: WHEN one of these triggers matches, IF every
// condition holds, THEN one of these actions happens.
//
// The SQL behind each trigger lives only on the server
// (lib/server/automation/sources.ts). This file names the fields a person
// can filter on, their types, and the comparisons each type allows, and it
// checks a rule's shape with zod. The server checks every rule against this
// catalog again before it runs.
import { z } from 'zod';

export type FieldType = 'number' | 'money' | 'percent' | 'days' | 'user';

export interface FieldDef {
	key: string;
	label: string;
	type: FieldType;
}

export interface TriggerDef {
	key: TriggerKey;
	label: string;
	/** One sentence a non-engineer can read. */
	description: string;
	/** What one match is ("commitment", "account"). A rule fires once per subject. */
	subject: string;
	fields: FieldDef[];
}

export const TRIGGER_KEYS = [
	'window_closed_short',
	'commitment_behind_pace',
	'account_gone_quiet',
	'order_line_at_risk',
	'order_line_projected_late'
] as const;
export type TriggerKey = (typeof TRIGGER_KEYS)[number];

const OWNER: FieldDef = { key: 'owner_id', label: 'Owner', type: 'user' };

export const TRIGGERS: Record<TriggerKey, TriggerDef> = {
	window_closed_short: {
		key: 'window_closed_short',
		label: 'A commitment window closed short',
		description: 'The window ended, less than 95% arrived, and nobody has said what happened.',
		subject: 'commitment',
		fields: [
			{ key: 'days_since_close', label: 'Days since the window closed', type: 'days' },
			{ key: 'committed_value', label: 'Committed value', type: 'money' },
			{ key: 'shortfall', label: 'Value still missing', type: 'money' },
			{ key: 'delivered_pct', label: 'Delivered', type: 'percent' },
			{ key: 'confidence', label: "Owner's confidence", type: 'percent' },
			OWNER
		]
	},
	commitment_behind_pace: {
		key: 'commitment_behind_pace',
		label: 'A commitment is behind pace',
		description: 'An open window is further along in time than in delivered value.',
		subject: 'commitment',
		fields: [
			{ key: 'gap_pts', label: 'Points behind (time elapsed minus delivered)', type: 'percent' },
			{ key: 'elapsed_pct', label: 'Window elapsed', type: 'percent' },
			{ key: 'delivered_pct', label: 'Delivered', type: 'percent' },
			{ key: 'days_left', label: 'Days left in the window', type: 'days' },
			{ key: 'committed_value', label: 'Committed value', type: 'money' },
			{ key: 'confidence', label: "Owner's confidence", type: 'percent' },
			OWNER
		]
	},
	account_gone_quiet: {
		key: 'account_gone_quiet',
		label: 'An account has gone quiet',
		description: "An account that orders regularly has not ordered for longer than usual, measured against its own rhythm.",
		subject: 'account (once per quiet spell)',
		fields: [
			{ key: 'days_quiet', label: 'Days since the last order', type: 'days' },
			{ key: 'typical_gap_days', label: 'Usual days between orders', type: 'days' },
			{ key: 'quiet_ratio', label: 'Quiet, as a multiple of the usual gap', type: 'number' },
			{ key: 'longest_gap_days', label: 'Longest gap in two years', type: 'days' },
			{ key: 'revenue_12m', label: 'Revenue, last 12 months', type: 'money' },
			{ key: 'orders_2y', label: 'Orders, last two years', type: 'number' },
			OWNER
		]
	},
	// Migration 0016's projection: not "is there stock today" but "when will
	// this line ship". A rule fires again when the projected date moves, so a
	// new slip is a new reminder.
	order_line_projected_late: {
		key: 'order_line_projected_late',
		label: 'A line is projected to ship late',
		description:
			'The late-order forecast says this line will miss its promised date, because of what is on hand, the supply order that covers it, or nothing being on order at all.',
		subject: 'order line (once per projected date)',
		fields: [
			{ key: 'days_late', label: 'Days late (projected date minus promised date)', type: 'days' },
			{ key: 'line_value', label: 'Line value', type: 'money' },
			{ key: 'no_supply', label: 'Nothing on hand or on order (1 yes, 0 no)', type: 'number' },
			{ key: 'supply_overdue', label: 'The supply order is itself past due (1 yes, 0 no)', type: 'number' },
			OWNER
		]
	},
	order_line_at_risk: {
		key: 'order_line_at_risk',
		label: 'An open order line is at risk',
		description: 'A line from the morning ERP export ships soon and stock does not cover it, or it is past due.',
		subject: 'order line',
		fields: [
			{ key: 'days_to_ship', label: 'Days until the ship date (negative when past due)', type: 'days' },
			{ key: 'short_qty', label: 'Quantity short', type: 'number' },
			{ key: 'line_value', label: 'Line value', type: 'money' },
			OWNER
		]
	}
};

export const OPERATORS = {
	gt: 'is more than',
	gte: 'is at least',
	lt: 'is less than',
	lte: 'is at most',
	eq: 'is',
	neq: 'is not'
} as const;
export type Operator = keyof typeof OPERATORS;

/** Which comparisons make sense for each type. */
export const OPERATORS_BY_TYPE: Record<FieldType, Operator[]> = {
	number: ['gte', 'gt', 'lte', 'lt', 'eq'],
	money: ['gte', 'gt', 'lte', 'lt'],
	percent: ['gte', 'gt', 'lte', 'lt'],
	days: ['gte', 'gt', 'lte', 'lt', 'eq'],
	user: ['eq', 'neq']
};

/** The words a text template may use, besides the trigger's own fields. */
export const COMMON_PLACEHOLDERS = ['customer', 'commitment', 'headline'] as const;

export const MAX_CONDITIONS = 6;

/*
  These three are strict, because a rule is an input to two tools
  (test_automation_rule and save_automation_rule) and a nested object is
  where a drafting agent actually types field names. A loose object would
  drop an invented key and save a rule that quietly does less than was asked
  for.

  Making them strict cannot break a rule that is already stored: a loose zod
  object strips the keys it does not know, so what save_automation_rule wrote
  to jsonb never had an extra key in it. The rule editor builds exactly this
  shape too.
*/
export const conditionSchema = z.strictObject({
	field: z.string().min(1).max(40),
	op: z.enum(Object.keys(OPERATORS) as [Operator, ...Operator[]]),
	// Numbers only: money in dollars, percents as 0 to 100, users by id.
	// "me" means whoever owns the rule.
	value: z.union([z.number().finite().min(-1_000_000_000).max(1_000_000_000), z.literal('me')])
});
export type Condition = z.infer<typeof conditionSchema>;

const template = (max: number) => z.string().trim().min(3).max(max);

export const actionSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('next_step'),
		title: template(200),
		dueInDays: z.number().int().min(0).max(60),
		assignTo: z.enum(['record_owner', 'rule_owner'])
	}),
	z.strictObject({
		kind: z.literal('note'),
		body: template(500)
	})
]);
export type Action = z.infer<typeof actionSchema>;

export const ACTION_LABELS: Record<Action['kind'], string> = {
	next_step: 'Add a next step',
	note: 'Add a note to the account'
};

export const ruleSchema = z
	.strictObject({
		name: z.string().trim().min(3).max(80),
		description: z.string().trim().max(300).default(''),
		trigger: z.enum(TRIGGER_KEYS),
		conditions: z.array(conditionSchema).max(MAX_CONDITIONS),
		action: actionSchema,
		enabled: z.boolean()
	})
	.superRefine((rule, ctx) => {
		const trigger = TRIGGERS[rule.trigger];
		rule.conditions.forEach((condition, index) => {
			const field = trigger.fields.find((f) => f.key === condition.field);
			if (!field) {
				ctx.addIssue({
					code: 'custom',
					path: ['conditions', index, 'field'],
					message: `"${condition.field}" is not something "${trigger.label}" knows about.`
				});
				return;
			}
			if (!OPERATORS_BY_TYPE[field.type].includes(condition.op)) {
				ctx.addIssue({
					code: 'custom',
					path: ['conditions', index, 'op'],
					message: `"${field.label}" cannot use "${OPERATORS[condition.op]}".`
				});
			}
			if (condition.value === 'me' && field.type !== 'user') {
				ctx.addIssue({
					code: 'custom',
					path: ['conditions', index, 'value'],
					message: `"${field.label}" needs a number.`
				});
			}
		});
		const text = rule.action.kind === 'next_step' ? rule.action.title : rule.action.body;
		for (const name of placeholdersIn(text)) {
			if (!allowedPlaceholders(rule.trigger).includes(name)) {
				ctx.addIssue({
					code: 'custom',
					path: ['action'],
					message: `{${name}} is not a value this trigger can fill in.`
				});
			}
		}
	});
export type Rule = z.infer<typeof ruleSchema>;

/** {customer}, {days_quiet} ... in a template. */
export function placeholdersIn(text: string): string[] {
	return [...text.matchAll(/\{([a-z_0-9]+)\}/g)].map((m) => m[1]);
}

export function allowedPlaceholders(trigger: TriggerKey): string[] {
	return [
		...COMMON_PLACEHOLDERS,
		...TRIGGERS[trigger].fields.filter((f) => f.type !== 'user').map((f) => f.key)
	];
}
