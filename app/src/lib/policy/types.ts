// What the policy engine hands back, shared by the server and the pages.
//
// Every one of these is worked out in the database (migration 0031) and only
// renamed on the way through, so a page, the assistant and an MCP client all
// see the same answer and the same explanation.

export type PolicyValueType =
	| 'number'
	| 'integer'
	| 'boolean'
	| 'text'
	| 'enum'
	| 'text_list'
	| 'object';

export type PolicyScopeKind =
	| 'global'
	| 'customer_segment'
	| 'customer'
	| 'vendor'
	| 'item'
	| 'item_family'
	| 'location'
	| 'mailbox'
	| 'order'
	| 'order_line';

export type PolicyGroup =
	| 'freight'
	| 'commercial'
	| 'fulfilment'
	| 'quality'
	| 'operations'
	| 'agents';

export type EditRole = 'admin' | 'operations' | 'account_manager';

/** The order the groups are shown in, and what each one is called. */
export const POLICY_GROUPS: { key: PolicyGroup; label: string; blurb: string }[] = [
	{ key: 'freight', label: 'Freight', blurb: 'Who pays, what ships free, and how it travels.' },
	{ key: 'commercial', label: 'Commercial', blurb: 'Terms, quote validity and the margin floor.' },
	{ key: 'fulfilment', label: 'Fulfilment', blurb: 'Who gets stock first, and what happens to what is short.' },
	{ key: 'quality', label: 'Quality', blurb: 'Paperwork and inspection.' },
	{ key: 'operations', label: 'Operations', blurb: 'The horizons and ratios the reports measure against.' },
	{ key: 'agents', label: 'Agents', blurb: 'How far a desk may go on its own.' }
];

/** What each scope kind is called on screen, and what its id is. */
export const SCOPE_LABEL: Record<PolicyScopeKind, string> = {
	global: 'Everyone',
	customer_segment: 'Price group',
	customer: 'Account',
	vendor: 'Supplier',
	item: 'Part',
	item_family: 'Part family',
	location: 'Location',
	mailbox: 'Mailbox',
	order: 'Order',
	order_line: 'Order line'
};

/** What to type in the scope box, per scope kind. */
export const SCOPE_HINT: Record<PolicyScopeKind, string> = {
	global: '',
	customer_segment: 'A price group code, for example ELITE',
	customer: 'An account number, for example 1218',
	vendor: 'A supplier number',
	item: 'A part number',
	item_family: 'A family, for example pipe',
	location: 'A location code, for example WEST',
	mailbox: 'A mailbox id',
	order: 'An order number',
	order_line: 'An order number and line, for example SO-20418:2'
};

/** One policy that exists: its shape, its default, and who may change it. */
export interface PolicyType {
	key: string;
	groupKey: PolicyGroup;
	name: string;
	description: string;
	valueType: PolicyValueType;
	/** The fixed list a value has to come from, empty when there is none. */
	allowed: string[];
	minValue: number | null;
	maxValue: number | null;
	/** For an object policy: the keys it carries and the kind of each. */
	valueSchema: Record<string, string>;
	/** 'ratio', 'USD', 'days', 'pieces', 'rank', or empty. */
	unit: string;
	scopes: PolicyScopeKind[];
	defaultValue: unknown;
	defaultWords: string;
	/** What reads this policy today, or empty when nothing does yet. */
	readBy: string;
	editable: boolean;
	editRole: EditRole;
}

/** A policy that lost, and why. */
export interface PolicyBeat {
	policyId: number | null;
	scopeKind: string;
	scopeId: string;
	scopeWords: string;
	value: unknown;
	valueWords: string;
	reason: string;
}

/** The answer: the value, and why it is the value. */
export interface PolicyAnswer {
	type: string;
	name: string;
	unit: string;
	value: unknown;
	valueWords: string;
	onDate: string;
	/** 'policy' when a row won, 'default' when nothing matched the context. */
	source: 'policy' | 'default';
	policyId: number | null;
	scopeKind: string;
	scopeId: string;
	scopeWords: string;
	effectiveFrom: string | null;
	effectiveTo: string | null;
	priority: number | null;
	note: string;
	/** One sentence: "collect, because this account has said so since 1 March 2026". */
	explanation: string;
	beat: PolicyBeat[];
}

/** A policy row as the editor lists it. */
export interface PolicyRow {
	id: number;
	policyType: string;
	typeName: string;
	groupKey: PolicyGroup;
	unit: string;
	valueType: PolicyValueType;
	scopeKind: PolicyScopeKind;
	scopeId: string;
	/** The account name, price group label, part description, and so on. */
	scopeLabel: string;
	value: unknown;
	valueWords: string;
	effectiveFrom: string;
	effectiveTo: string | null;
	priority: number;
	note: string;
	setByName: string | null;
	status: 'in_force' | 'expired' | 'upcoming';
	updatedAt: string;
}

/** One row of the trace: a candidate, and what happened to it. */
export interface PolicyTraceRow {
	policyId: number | null;
	scopeKind: string;
	scopeId: string;
	scopeWords: string;
	value: unknown;
	valueWords: string;
	effectiveFrom: string | null;
	effectiveTo: string | null;
	priority: number | null;
	note: string;
	isWinner: boolean;
	verdict: 'won' | 'lost';
	reason: string;
}

/** One field of the data dictionary. */
export interface DictionaryField {
	entity: string;
	field: string;
	label: string;
	meaning: string;
	unit: string;
	source: 'erp export' | 'app' | 'derived' | 'policy engine';
	derivation: string;
	example: string;
	/** Whether an agent may put this field in something that goes outside. */
	shareable: boolean;
}

/** The dictionary, grouped the way the page shows it. */
export interface DictionaryEntity {
	entity: string;
	fields: DictionaryField[];
	shareableCount: number;
}

/** One account in a margin floor backtest. */
export interface BacktestAccount {
	customerNo: string;
	customerName: string;
	lines: number;
	units: number;
	revenue: number;
	costOfGoods: number;
	margin: number;
	marginPct: number | null;
	/** Lines that were priced under the floor being tried. */
	linesBelow: number;
	revenueBelow: number;
	marginBelow: number;
	/** What those lines would have billed at the floor instead. */
	floorRevenue: number;
	/** The difference: what holding to the floor would have added. */
	marginGained: number;
	worstMarginPct: number | null;
}

/**
 * What a proposed margin floor would have done to a window of the ledger.
 *
 * Two bounds, not a prediction: `marginGained` is what it adds if every
 * customer still buys at the higher price, and `revenueBelow` is what is on
 * the line if none of them do.
 */
export interface Backtest {
	floor: number;
	from: string;
	to: string;
	/** The accounts with the most to gain, longest first. */
	accounts: BacktestAccount[];
	accountCount: number;
	accountsBelow: number;
	lines: number;
	linesBelow: number;
	revenue: number;
	margin: number;
	marginPct: number | null;
	revenueBelow: number;
	marginBelow: number;
	marginGained: number;
	marginAfter: number;
	marginPctAfter: number | null;
	shareOfRevenueBelow: number;
}

/** A line the allocation priority policy moves, against plain ship-date order. */
export interface AllocationMove {
	itemNo: string;
	description: string;
	documentNo: string;
	lineNo: number;
	customerNo: string;
	customerName: string;
	shipDate: string;
	quantity: number;
	onHand: number;
	priorityRank: number;
	priorityReason: string;
	allocatedByDate: number;
	allocatedByPriority: number;
	change: number;
	bucketByDate: string;
	bucketByPriority: string;
}
