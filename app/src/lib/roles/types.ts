// The role model, as the server and the pages both see it.
//
// Three orthogonal things, never one:
//
//   scope       which slice of the world is mine (migration 0027, nl.user_scope)
//   authority   what I may decide and up to what amount (nl.authority_grants)
//   disclosure  what I may be shown at all (nl.disclosure_grants)
//
// The lists here are the same lists the database keeps in nl.scope_dimensions(),
// nl.authority_kinds() and nl.disclosure_allows(). A test compares each pair,
// so a value added on one side cannot quietly go missing on the other.

import type { Disclosure, FactKind } from '$lib/desk/types';

export type { Disclosure, FactKind };

/** A named starting set of the three. Only a label: nothing resolves from it. */
export type Preset =
	| 'inside_sales'
	| 'buyer'
	| 'planner'
	| 'warehouse'
	| 'ops_manager'
	| 'account_manager'
	| 'operations'
	| 'admin'
	| 'agent';

export const PRESETS: Preset[] = [
	'inside_sales',
	'buyer',
	'planner',
	'warehouse',
	'ops_manager',
	'account_manager',
	'operations',
	'admin',
	'agent'
];

export const PRESET_LABEL: Record<Preset, string> = {
	inside_sales: 'Inside sales',
	buyer: 'Buyer',
	planner: 'Planner',
	warehouse: 'Warehouse',
	ops_manager: 'Operations manager',
	account_manager: 'Account manager',
	operations: 'Operations',
	admin: 'Admin',
	agent: 'Agent'
};

export type ScopeDimension = 'account' | 'warehouse' | 'vendor' | 'part_family' | 'mailbox';

export const SCOPE_DIMENSIONS: ScopeDimension[] = [
	'account',
	'warehouse',
	'vendor',
	'part_family',
	'mailbox'
];

export const SCOPE_LABEL: Record<ScopeDimension, { one: string; many: string }> = {
	account: { one: 'account', many: 'Accounts' },
	warehouse: { one: 'warehouse', many: 'Warehouses' },
	vendor: { one: 'supplier', many: 'Suppliers' },
	part_family: { one: 'part family', many: 'Part families' },
	mailbox: { one: 'mailbox', many: 'Mailboxes' }
};

export type Authority =
	| 'approve_quote'
	| 'approve_reply'
	| 'approve_agent_proposal'
	| 'answer_commitment'
	| 'release_purchase_order'
	| 'accept_price_increase'
	| 'resolve_shortage'
	| 'confirm_pick'
	| 'receive_stock'
	| 'count_stock'
	| 'override_margin_floor'
	| 'review_exception'
	| 'change_policy'
	| 'run_import'
	| 'agent_autonomy';

export const AUTHORITIES: Authority[] = [
	'approve_quote',
	'approve_reply',
	'approve_agent_proposal',
	'answer_commitment',
	'release_purchase_order',
	'accept_price_increase',
	'resolve_shortage',
	'confirm_pick',
	'receive_stock',
	'count_stock',
	'override_margin_floor',
	'review_exception',
	'change_policy',
	'run_import',
	'agent_autonomy'
];

/** True when the grant carries a number. The others are a plain yes. */
export const AUTHORITY_IS_AMOUNT: Record<Authority, boolean> = {
	approve_quote: true,
	release_purchase_order: true,
	accept_price_increase: true,
	agent_autonomy: true,
	approve_reply: false,
	approve_agent_proposal: false,
	answer_commitment: false,
	resolve_shortage: false,
	confirm_pick: false,
	receive_stock: false,
	count_stock: false,
	override_margin_floor: false,
	review_exception: false,
	change_policy: false,
	run_import: false
};

export const AUTHORITY_LABEL: Record<Authority, string> = {
	approve_quote: 'Approve a quote',
	approve_reply: 'Send a drafted reply',
	approve_agent_proposal: 'Decide an assistant proposal',
	answer_commitment: 'Answer a window that closed short',
	release_purchase_order: 'Release a purchase order',
	accept_price_increase: 'Accept a new cost',
	resolve_shortage: 'Decide what a short line does',
	confirm_pick: 'Confirm a pick',
	receive_stock: 'Receive stock in',
	count_stock: 'Post a count',
	override_margin_floor: 'Price below the floor',
	review_exception: 'Handle what an agent stopped on',
	change_policy: 'Change who may decide what',
	run_import: 'Stage and apply a load',
	agent_autonomy: 'Autonomy level'
};

/** The autonomy levels an agent's amount grant means. */
export const AUTONOMY_LABEL: Record<number, string> = {
	0: 'Watches only',
	1: 'Drafts, a person sends',
	2: 'Sends routine replies',
	3: 'Sends everything its disclosure allows'
};

export const DISCLOSURE_LABEL: Record<Disclosure, string> = {
	customer: 'Commercial: prices and availability, no cost',
	vendor: 'Supply: parts and lead times, no customer prices',
	internal: 'Everything, including cost, margin and the floor'
};

/** The kinds of thing nl.work_waiting_for can return. */
export type WorkKind =
	| 'mail_draft'
	| 'mail_exception'
	| 'mail_unanswered'
	| 'quote_request'
	| 'quote_expiring'
	| 'agent_proposal'
	| 'commitment_answer'
	| 'coverage_purchase'
	| 'coverage_production'
	| 'price_increase'
	| 'pick'
	| 'receipt'
	| 'count'
	| 'import_decision';

export const WORK_LABEL: Record<WorkKind, string> = {
	mail_draft: 'Reply to send',
	mail_exception: 'Agent stopped',
	mail_unanswered: 'Message to answer',
	quote_request: 'Quote to approve',
	quote_expiring: 'Quote running out',
	agent_proposal: 'Proposal to decide',
	commitment_answer: 'Window to answer',
	coverage_purchase: 'Nothing on order',
	coverage_production: 'Nothing planned',
	price_increase: 'Cost gone up',
	pick: 'Shipment to pick',
	receipt: 'Transfer to receive',
	count: 'Count to post',
	import_decision: 'Load to apply'
};

/** One row of a home page. */
export interface WorkItem {
	kind: WorkKind;
	ref: string;
	subject: string;
	amount: number | null;
	waitingSince: string;
	ageDays: number;
	why: string;
	/** Built from kind and ref through $lib/routes, never in SQL. */
	href: string;
}

/** What a principal's scope looks like in one dimension. */
export interface ScopeSlice {
	dimension: ScopeDimension;
	/** True when they hold every value in the dimension, now and in future. */
	all: boolean;
	/** The named values, when they do not hold all of them. */
	values: string[];
}

export interface AuthorityHolding {
	authority: Authority;
	/** The ceiling in dollars, or the autonomy level. Null means no ceiling. */
	limit: number | null;
	startsOn: string;
	endsOn: string | null;
	note: string;
}

/** A grant that has not started yet, so a forward-dated raise is visible. */
export interface AuthorityAhead {
	authority: Authority;
	limit: number | null;
	startsOn: string;
}

/** Everything about one principal, for /people and for the rail. */
export interface PrincipalPolicy {
	id: number;
	email: string;
	fullName: string;
	title: string;
	preset: Preset;
	kind: 'person' | 'agent';
	responsibility: string;
	active: boolean;
	disclosure: Disclosure;
	scope: ScopeSlice[];
	authority: AuthorityHolding[];
	authorityAhead: AuthorityAhead[];
}

export function holds(policy: PrincipalPolicy, authority: Authority): boolean {
	return policy.authority.some((a) => a.authority === authority);
}

export function scopeOf(policy: PrincipalPolicy, dimension: ScopeDimension): ScopeSlice | null {
	return policy.scope.find((s) => s.dimension === dimension) ?? null;
}

/** True when this principal has any claim on a dimension at all. */
export function hasScope(policy: PrincipalPolicy, dimension: ScopeDimension): boolean {
	const slice = scopeOf(policy, dimension);
	return slice !== null && (slice.all || slice.values.length > 0);
}
