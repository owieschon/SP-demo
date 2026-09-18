// Reading the policy engine.
//
// Nothing here decides anything. The order of resolution, the explanation and
// the trace are all worked out in migration 0031, so a page, the assistant
// and an MCP client cannot disagree about what a policy says. This file asks
// and renames.
import type { Db, Tx } from '../db/types.ts';
import type {
	AllocationMove,
	Backtest,
	BacktestAccount,
	PolicyAnswer,
	PolicyRow,
	PolicyTraceRow,
	PolicyType
} from '$lib/policy/types';

/** The shape a policy context takes: what is being decided. */
export interface PolicyContext {
	customerNo?: string | null;
	itemNo?: string | null;
	vendorNo?: string | null;
	locationCode?: string | null;
	mailboxId?: number | null;
	documentNo?: string | null;
	lineNo?: number | null;
	customerSegment?: string | null;
	itemFamily?: string | null;
	onDate?: string | null;
}

/** The context as the database wants it: snake_case keys, nothing empty. */
export function contextToJson(context: PolicyContext): string {
	const pairs: [string, string][] = [
		['customer_no', context.customerNo ?? ''],
		['item_no', context.itemNo ?? ''],
		['vendor_no', context.vendorNo ?? ''],
		['location_code', context.locationCode ?? ''],
		['mailbox_id', context.mailboxId === null || context.mailboxId === undefined ? '' : String(context.mailboxId)],
		['document_no', context.documentNo ?? ''],
		['line_no', context.lineNo === null || context.lineNo === undefined ? '' : String(context.lineNo)],
		['customer_segment', context.customerSegment ?? ''],
		['item_family', context.itemFamily ?? ''],
		['on_date', context.onDate ?? '']
	];
	return JSON.stringify(Object.fromEntries(pairs.filter(([, value]) => value !== '')));
}

interface TypeDb {
	key: string;
	group_key: string;
	name: string;
	description: string;
	value_type: string;
	allowed: string[];
	min_value: number | null;
	max_value: number | null;
	value_schema: Record<string, string>;
	unit: string;
	scopes: string[];
	default_value: unknown;
	default_words: string;
	read_by: string;
	editable: boolean;
	edit_role: string;
}

function toType(r: TypeDb): PolicyType {
	return {
		key: r.key,
		groupKey: r.group_key as PolicyType['groupKey'],
		name: r.name,
		description: r.description,
		valueType: r.value_type as PolicyType['valueType'],
		allowed: r.allowed ?? [],
		minValue: r.min_value,
		maxValue: r.max_value,
		valueSchema: r.value_schema ?? {},
		unit: r.unit,
		scopes: (r.scopes ?? []) as PolicyType['scopes'],
		defaultValue: r.default_value,
		defaultWords: r.default_words,
		readBy: r.read_by,
		editable: r.editable,
		editRole: r.edit_role as PolicyType['editRole']
	};
}

/** Every policy that exists, in the order the page shows them. */
export async function listPolicyTypes(db: Db, userId: number): Promise<PolicyType[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<TypeDb>`
			select t.*, nl.policy_words(t.value_type, t.unit, t.default_value) as default_words
			from nl.policy_types t
			order by t.group_key, t.key`
	);
	return rows.map(toType);
}

function toAnswer(value: unknown): PolicyAnswer {
	const r = value as Record<string, unknown>;
	return {
		type: String(r.type),
		name: String(r.name),
		unit: String(r.unit ?? ''),
		value: r.value,
		valueWords: String(r.value_words ?? ''),
		onDate: String(r.on_date ?? ''),
		source: r.source === 'policy' ? 'policy' : 'default',
		policyId: r.policy_id === null || r.policy_id === undefined ? null : Number(r.policy_id),
		scopeKind: String(r.scope_kind ?? ''),
		scopeId: String(r.scope_id ?? ''),
		scopeWords: String(r.scope_words ?? ''),
		effectiveFrom: (r.effective_from as string | null) ?? null,
		effectiveTo: (r.effective_to as string | null) ?? null,
		priority: r.priority === null || r.priority === undefined ? null : Number(r.priority),
		note: String(r.note ?? ''),
		explanation: String(r.explanation ?? ''),
		beat: Array.isArray(r.beat)
			? r.beat.map((one) => {
					const b = one as Record<string, unknown>;
					return {
						policyId: b.policy_id === null || b.policy_id === undefined ? null : Number(b.policy_id),
						scopeKind: String(b.scope_kind ?? ''),
						scopeId: String(b.scope_id ?? ''),
						scopeWords: String(b.scope_words ?? ''),
						value: b.value,
						valueWords: String(b.value_words ?? ''),
						reason: String(b.reason ?? '')
					};
				})
			: []
	};
}

/**
 * Several policies for one context in one round trip, keyed by policy. This
 * is the call a quoting screen or an agent makes; resolving one at a time is
 * the same answer and more round trips.
 */
export async function resolvePolicies(
	db: Db,
	userId: number,
	types: string[],
	context: PolicyContext = {}
): Promise<Record<string, PolicyAnswer>> {
	if (types.length === 0) return {};
	const rows = await db.asUser(userId, (tx) => resolveOn(tx, types, context));
	return rows;
}

/** The same, inside a transaction somebody else opened. */
export async function resolveOn(
	tx: Tx,
	types: string[],
	context: PolicyContext = {}
): Promise<Record<string, PolicyAnswer>> {
	// The list of types travels as JSON and becomes an array in SQL, so no
	// array literal is ever built by hand out of values.
	const [row] = await tx.query<{ answers: Record<string, unknown> }>(
		`select nl.resolve_policies(array(select jsonb_array_elements_text($1::jsonb)), $2::jsonb) as answers`,
		[JSON.stringify(types), contextToJson(context)]
	);
	const answers = row?.answers ?? {};
	return Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, toAnswer(value)]));
}

/** One policy for one context. */
export async function resolvePolicy(
	db: Db,
	userId: number,
	type: string,
	context: PolicyContext = {}
): Promise<PolicyAnswer> {
	const answers = await resolvePolicies(db, userId, [type], context);
	return answers[type];
}

interface RowDb {
	id: number;
	policy_type: string;
	type_name: string;
	group_key: string;
	unit: string;
	value_type: string;
	scope_kind: string;
	scope_id: string;
	scope_label: string;
	value: unknown;
	value_words: string;
	effective_from: string;
	effective_to: string | null;
	priority: number;
	note: string;
	set_by_name: string | null;
	status: string;
	updated_at: Date | string;
}

function toRow(r: RowDb): PolicyRow {
	return {
		id: r.id,
		policyType: r.policy_type,
		typeName: r.type_name,
		groupKey: r.group_key as PolicyRow['groupKey'],
		unit: r.unit,
		valueType: r.value_type as PolicyRow['valueType'],
		scopeKind: r.scope_kind as PolicyRow['scopeKind'],
		scopeId: r.scope_id,
		scopeLabel: r.scope_label,
		value: r.value,
		valueWords: r.value_words,
		effectiveFrom: r.effective_from,
		effectiveTo: r.effective_to,
		priority: r.priority,
		note: r.note,
		setByName: r.set_by_name,
		status: r.status as PolicyRow['status'],
		// The row version the editor sends back, so a save from a page somebody
		// left open is refused rather than quietly winning.
		updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at)
	};
}

/** Every policy row anybody has set, newest window first. */
export async function listPolicies(db: Db, userId: number, policyType?: string): Promise<PolicyRow[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<RowDb>(
			`select * from nl.policy_list
			 where $1 = '' or policy_type = $1
			 order by group_key, policy_type,
			          case status when 'in_force' then 0 when 'upcoming' then 1 else 2 end,
			          effective_from desc, id desc`,
			[policyType ?? '']
		)
	);
	return rows.map(toRow);
}

/** Every candidate for one policy and one context, and why each one lost. */
export async function traceFor(
	db: Db,
	userId: number,
	type: string,
	context: PolicyContext
): Promise<PolicyTraceRow[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<{
			policy_id: number | null;
			scope_kind: string;
			scope_id: string;
			scope_words: string;
			value: unknown;
			value_words: string;
			effective_from: string | null;
			effective_to: string | null;
			priority: number | null;
			note: string;
			is_winner: boolean;
			verdict: string;
			reason: string;
		}>(`select * from nl.policy_trace($1, $2::jsonb)`, [type, contextToJson(context)])
	);
	return rows.map((r) => ({
		policyId: r.policy_id,
		scopeKind: r.scope_kind,
		scopeId: r.scope_id,
		scopeWords: r.scope_words,
		value: r.value,
		valueWords: r.value_words,
		effectiveFrom: r.effective_from,
		effectiveTo: r.effective_to,
		priority: r.priority,
		note: r.note,
		isWinner: r.is_winner,
		verdict: r.verdict === 'won' ? 'won' : 'lost',
		reason: r.reason
	}));
}

/**
 * The lines the allocation priority policy moves, against plain ship-date
 * order. Empty when nobody has a priority, which is the honest empty state:
 * the policy is doing nothing because nothing is set.
 */
export async function allocationMoves(db: Db, userId: number, limit = 40): Promise<AllocationMove[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			item_no: string;
			description: string;
			document_no: string;
			line_no: number;
			customer_no: string;
			customer_name: string;
			ship_date: string;
			quantity: number;
			on_hand: number;
			priority_rank: number;
			priority_reason: string;
			allocated_by_date: number;
			allocated_by_priority: number;
			change: number;
			bucket_by_date: string;
			bucket_by_priority: string;
		}>`
			select e.*, c.name as customer_name
			from nl.allocation_priority_effect e
			join nl.customers c on c.customer_no = e.customer_no
			order by e.change desc, e.item_no, e.ship_date, e.document_no, e.line_no
			limit ${limit}`
	);
	return rows.map((r) => ({
		itemNo: r.item_no,
		description: r.description,
		documentNo: r.document_no,
		lineNo: r.line_no,
		customerNo: r.customer_no,
		customerName: r.customer_name,
		shipDate: r.ship_date,
		quantity: r.quantity,
		onHand: r.on_hand,
		priorityRank: r.priority_rank,
		priorityReason: r.priority_reason,
		allocatedByDate: r.allocated_by_date,
		allocatedByPriority: r.allocated_by_priority,
		change: r.change,
		bucketByDate: r.bucket_by_date,
		bucketByPriority: r.bucket_by_priority
	}));
}

/** How many open lines there are, and how many sit behind a priority. */
export async function allocationSummary(
	db: Db,
	userId: number
): Promise<{ lines: number; prioritized: number; moved: number }> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ lines: number; prioritized: number; moved: number }>`
			select
			  (select count(*) from nl.allocation_plan)::int as lines,
			  (select count(*) from nl.allocation_plan where priority_rank > 0)::int as prioritized,
			  (select count(*) from nl.allocation_priority_effect)::int as moved`
	);
	return row ?? { lines: 0, prioritized: 0, moved: 0 };
}

interface BacktestRowDb {
	customer_no: string;
	customer_name: string;
	lines: number;
	units: number;
	revenue: number;
	cost_of_goods: number;
	margin: number;
	margin_pct: number | null;
	lines_below: number;
	revenue_below: number;
	margin_below: number;
	floor_revenue: number;
	margin_gained: number;
	worst_margin_pct: number | null;
}

/**
 * What a proposed margin floor would have done to a window of the ledger.
 *
 * Two bounds and no prediction: what holding to the floor would have added if
 * every customer had still bought, and what was on those lines at all if none
 * of them had. The arithmetic is nl.margin_floor_backtest() (migration 0031);
 * this orders it and adds up the totals.
 */
export async function backtestMarginFloor(
	db: Db,
	userId: number,
	input: { floor: number; from: string; to: string; limit?: number }
): Promise<Backtest> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<BacktestRowDb>(
			`select * from nl.margin_floor_backtest($1::numeric, $2::date, $3::date)
			 order by margin_gained desc, revenue_below desc, customer_no`,
			[input.floor, input.from, input.to]
		)
	);

	const accounts: BacktestAccount[] = rows.map((r) => ({
		customerNo: r.customer_no,
		customerName: r.customer_name,
		lines: r.lines,
		units: r.units,
		revenue: r.revenue,
		costOfGoods: r.cost_of_goods,
		margin: r.margin,
		marginPct: r.margin_pct,
		linesBelow: r.lines_below,
		revenueBelow: r.revenue_below,
		marginBelow: r.margin_below,
		floorRevenue: r.floor_revenue,
		marginGained: r.margin_gained,
		worstMarginPct: r.worst_margin_pct
	}));

	// Money added up in floating point stops being money, so every total is
	// rounded back to the cent.
	const add = (pick: (one: BacktestAccount) => number) =>
		Math.round(accounts.reduce((total, one) => total + pick(one), 0) * 100) / 100;

	const revenue = add((one) => one.revenue);
	const margin = add((one) => one.margin);
	const revenueBelow = add((one) => one.revenueBelow);
	const marginGained = add((one) => one.marginGained);
	const marginAfter = Math.round((margin + marginGained) * 100) / 100;
	const revenueAfter = Math.round((revenue + marginGained) * 100) / 100;

	return {
		floor: input.floor,
		from: input.from,
		to: input.to,
		accounts: accounts.slice(0, input.limit ?? 25),
		accountCount: accounts.length,
		accountsBelow: accounts.filter((one) => one.linesBelow > 0).length,
		lines: accounts.reduce((total, one) => total + one.lines, 0),
		linesBelow: accounts.reduce((total, one) => total + one.linesBelow, 0),
		revenue,
		margin,
		marginPct: revenue === 0 ? null : Math.round((margin / revenue) * 10000) / 10000,
		revenueBelow,
		marginBelow: add((one) => one.marginBelow),
		marginGained,
		// The optimistic end: every under-floor line repriced, nobody walks.
		marginAfter,
		marginPctAfter: revenueAfter === 0 ? null : Math.round((marginAfter / revenueAfter) * 10000) / 10000,
		shareOfRevenueBelow: revenue === 0 ? 0 : Math.round((revenueBelow / revenue) * 10000) / 10000
	};
}
