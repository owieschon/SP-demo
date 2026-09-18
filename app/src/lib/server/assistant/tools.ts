// Every tool the assistant has, and the risk class that decides what happens
// when it asks for one.
//
// The risk class is a property of the tool in this file, not something the
// prompt asks for politely:
//
//   read      runs straight away. Reads business facts, writes nothing.
//   additive  runs straight away, and can only add a row: a note, a next step.
//             Nothing existing changes, so there is nothing to undo.
//   gated     NEVER runs when the model asks for it. runTool returns a result
//             saying so and telling the model to use propose_action instead.
//             The only way a gated tool runs is proposals.ts, after a person
//             has approved a stored proposal.
//   propose   propose_action itself, which puts one to three options on the
//             screen and writes nothing.
//
// A tool's handler is plain code with a zod schema on its input, so a made-up
// field or a string where a number belongs is refused before any SQL runs.
//
// Every input object is a strictObject, which is the whole point rather than a
// detail: a loose input drops a field it does not know and carries on with the
// default, so "whose" instead of "owner" quietly asks a different question and
// answers it confidently. A misspelled or invented field is an error naming
// the field instead, and `additionalProperties: false` says so in the JSON
// Schema that tools/list publishes, so a client sees the same rule the server
// enforces.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ruleSchema } from '$lib/automation/catalog';
import type { RiskClass } from '$lib/assistant/types';
import { routes } from '$lib/routes';
import type { Db, Row } from '../db/types.ts';
import { testRule } from '../automation/rules.ts';
import { toAskError } from './errors.ts';
import { runReadOnlySql } from './sql.ts';

/** What a handler is given. One per turn, with the round filled in per call. */
export interface ToolContext {
	db: Db;
	userId: number;
	/** The company's date, read once at the start of the turn. */
	today: string;
	/** Which round of the turn this call is, from 1. */
	round: number;
	/**
	 * A request id for a write made in this round. Derived from the turn's own
	 * request id, so asking the same question twice (a double submit) replays
	 * the first write instead of making a second one.
	 */
	requestId: (suffix: string) => string;
}

/**
 * What a gated tool's capture step found: the row version to hold the write
 * to (null when the write creates a row), or a message saying the thing the
 * proposal is about is not there.
 */
export type Capture = { version: string | null } | { missing: string };

export interface ToolDef<I> {
	name: string;
	risk: RiskClass;
	/** Written for the model: what it does, and when to reach for it. */
	description: string;
	schema: z.ZodType<I>;
	/**
	 * What this tool promises to answer with. Only the tools that actually run
	 * have one: a gated tool never runs from a model, so an output schema on
	 * it would describe something a caller can never receive.
	 *
	 * The shapes use looseObject on purpose. The named fields are the
	 * contract, so dropping one from a query breaks the schema test in
	 * tools.test.ts; the rest of the columns are free to change, because a
	 * query gaining a column should not be a breaking change for a caller.
	 */
	output?: z.ZodType;
	/** read and additive tools only. */
	run?: (ctx: ToolContext, input: I) => Promise<unknown>;
	/** gated tools only: the row version now, stored with the proposal. */
	capture?: (ctx: ToolContext, input: I) => Promise<Capture>;
	/** gated tools only: the write, once a person has approved. */
	execute?: (
		ctx: ToolContext,
		input: I,
		version: string | null,
		requestId: string
	) => Promise<Record<string, unknown>>;
	/** gated tools only: the sentence a proposal option shows. */
	label?: (input: I) => string;
	/**
	 * Defaulted input fields that do NOT change the answer, so the answer does
	 * not report them back.
	 *
	 * Every other defaulted field is a filter, and a filter that was applied
	 * without being asked for has to be visible in the answer: that is how an
	 * agent notices it asked the wrong question. The registry test in
	 * contract.test.ts holds every tool to it, so a new tool with a hidden
	 * default fails the test rather than shipping. Listing a field here is a
	 * claim that its value cannot change which rows come back.
	 */
	nonFilterDefaults?: readonly string[];
}

/** The registry's view of a tool: the same shape whatever its input type is. */
export interface Tool {
	name: string;
	risk: RiskClass;
	description: string;
	jsonSchema: Record<string, unknown>;
	/** The JSON Schema of what it answers with, when it is a tool that runs. */
	outputSchema?: Record<string, unknown>;
	/**
	 * Does a payload match what this tool promised? Used by the test that
	 * holds the contract, and by the MCP server before it sends
	 * structuredContent, so a caller is never handed a payload that does not
	 * match the schema it was given.
	 */
	checkOutput?(payload: unknown): { ok: true } | { ok: false; message: string };
	/** See ToolDef.nonFilterDefaults. Empty for most tools. */
	nonFilterDefaults: readonly string[];
	parse(input: unknown): { ok: true; value: unknown } | { ok: false; message: string };
	run?(ctx: ToolContext, input: unknown): Promise<unknown>;
	capture?(ctx: ToolContext, input: unknown): Promise<Capture>;
	execute?(
		ctx: ToolContext,
		input: unknown,
		version: string | null,
		requestId: string
	): Promise<Record<string, unknown>>;
	label?(input: unknown): string;
}

/** Turn a typed definition into a registry entry. */
function tool<I>(def: ToolDef<I>): Tool {
	const jsonSchema = z.toJSONSchema(def.schema, { target: 'draft-2020-12', io: 'input' }) as Record<
		string,
		unknown
	>;
	return {
		name: def.name,
		risk: def.risk,
		description: def.description,
		jsonSchema,
		outputSchema: def.output
			? (z.toJSONSchema(def.output, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>)
			: undefined,
		checkOutput: def.output
			? (payload) => {
					const parsed = def.output!.safeParse(payload);
					if (parsed.success) return { ok: true };
					return { ok: false, message: outputProblem(parsed.error) };
				}
			: undefined,
		nonFilterDefaults: def.nonFilterDefaults ?? [],
		parse(input) {
			const parsed = def.schema.safeParse(input);
			if (parsed.success) return { ok: true, value: parsed.data };
			return { ok: false, message: inputProblem(parsed.error, jsonSchema) };
		},
		run: def.run ? (ctx, input) => def.run!(ctx, input as I) : undefined,
		capture: def.capture ? (ctx, input) => def.capture!(ctx, input as I) : undefined,
		execute: def.execute
			? (ctx, input, version, requestId) => def.execute!(ctx, input as I, version, requestId)
			: undefined,
		label: def.label ? (input) => def.label!(input as I) : undefined
	};
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

const customerNo = z
	.string()
	.trim()
	.min(1)
	.max(20)
	.describe('The account number, for example "1214". Find it with search_accounts first.');
const itemNo = z.string().trim().min(1).max(40).describe('The part number exactly as the catalog spells it.');
const commitmentId = z.number().int().positive().describe('The commitment id, without the "C-" prefix.');

// ---------------------------------------------------------------------------
// What the tools answer with
// ---------------------------------------------------------------------------

/*
  A read that could not be answered: the account does not exist, the query
  was refused. It is a normal answer, not a fault, so it is part of the
  declared output rather than an exception.
*/
const refusal = z.looseObject({
	error: z.string(),
	/** The database's own NL4xx SQLSTATE, when the refusal came from one. */
	code: z.string().optional()
});

/** Either the tool's own answer or a refusal. */
const answers = (shape: z.ZodType) => z.union([shape, refusal]);

/**
 * Why a payload did not match, in words that name the field.
 *
 * Every output schema is a union of "the answer" and "a refusal", and zod
 * reports a failed union at the top as a bare "Invalid input". The useful
 * reason is in the first branch's own issues, because a result that was
 * meant to be an answer almost never fails because it was not a refusal.
 */
export function outputProblem(error: z.ZodError): string {
	const first = error.issues[0];
	if (first.code === 'invalid_union') {
		const branches = (first as unknown as { errors?: z.core.$ZodIssue[][] }).errors ?? [];
		const inner = branches[0]?.[0];
		if (inner) {
			const path = [...first.path, ...inner.path].join('.');
			return `${path || 'result'}: ${inner.message}`;
		}
	}
	return `${first.path.join('.') || 'result'}: ${first.message}`;
}

/**
 * The field names a JSON Schema accepts at a path, so an error about an
 * unknown field can say what the tool would have taken instead. It walks
 * `properties` (and `items` for an array step) and gives up quietly if the
 * path leads somewhere without named fields.
 */
function acceptedAt(schema: Record<string, unknown>, path: readonly PropertyKey[]): string[] {
	let node: Record<string, unknown> | undefined = schema;
	for (const step of path) {
		if (!node) return [];
		if (typeof step === 'number') {
			node = node.items as Record<string, unknown> | undefined;
			continue;
		}
		const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
		node = properties?.[String(step)];
	}
	const properties = node?.properties as Record<string, unknown> | undefined;
	return properties ? Object.keys(properties) : [];
}

/**
 * Why an input was refused, in one line that names the field.
 *
 * An unknown field gets its own sentence, because that is the case this is
 * here for: zod reports an unrecognized key with the key inside the message
 * and no path at all, so the plain join would blame "input" and leave the
 * reader guessing which word was wrong. Saying the field and then what the
 * tool does accept turns a silently dropped filter into a fixable error.
 */
export function inputProblem(error: z.ZodError, schema: Record<string, unknown>): string {
	/*
	  An unknown field is reported ahead of any other problem, even though zod
	  lists the field problems first. It is usually the cause rather than a
	  second fault: an input of { account_no: "1214" } has two issues, a
	  missing customer_no and an unrecognized account_no, and only the second
	  one tells the caller what it actually did wrong. Fixing the name fixes
	  both, and anything still wrong is reported on the next attempt.
	*/
	const unknownKey = error.issues.find((issue) => issue.code === 'unrecognized_keys');
	const first = unknownKey ?? error.issues[0];
	if (first.code === 'unrecognized_keys') {
		const keys = (first as unknown as { keys: string[] }).keys;
		const at = first.path.join('.');
		const where = keys.map((key) => (at ? `${at}.${key}` : key)).join(', ');
		const accepted = acceptedAt(schema, first.path);
		const expected = accepted.length
			? `${at ? `"${at}" takes` : 'This tool takes'} ${accepted.join(', ')}.`
			: 'Check the input schema for the fields it takes.';
		return `${where}: there is no input by that name. ${expected}`;
	}
	const where = first.path.length ? first.path.join('.') : 'input';
	return `${where}: ${first.message}`;
}

/**
 * A row that names a record. Every read tool puts `url` on these, built from
 * `$lib/routes`, so a caller can follow an answer instead of reassembling
 * the address from the id.
 */
const linked = (fields: z.ZodRawShape) => z.looseObject({ ...fields, url: z.string() });

/** A whole number of rows. */
const rowCount = z.number().int().nonnegative();

/**
 * The `limit` that was actually used, reported back under the same name the
 * input takes.
 *
 * It matters because `limit` has a default: an agent that did not ask for one
 * still got one, and without seeing it a short list reads as "that is all
 * there is" rather than "that is the first ten". With the cap in the answer,
 * row_count equal to limit is a visible sign there may be more.
 */
const rowCap = z.number().int().positive();

/**
 * The row version of the thing a gated tool would change, as it is right now.
 * It is stored with the proposal, so approving writes against the state the
 * person was shown: if the row moved in between, the write raises a conflict
 * instead of quietly overwriting. Null means the row is not there.
 */
async function rowVersion(
	ctx: ToolContext,
	kind: 'commitment' | 'snapshot' | 'rule',
	id: number
): Promise<Capture> {
	const rows = await ctx.db.asUser(ctx.userId, (tx) => {
		if (kind === 'commitment') return tx.sql<{ at: Date }>`select updated_at as at from nl.commitments where id = ${id}`;
		if (kind === 'snapshot') return tx.sql<{ at: Date }>`select updated_at as at from nl.export_snapshots where id = ${id}`;
		return tx.sql<{ at: Date }>`select updated_at as at from nl.automation_rules where id = ${id}`;
	});
	if (!rows[0]) {
		const what = kind === 'commitment' ? `Commitment C-${id}` : kind === 'snapshot' ? `Snapshot ${id}` : `Rule ${id}`;
		return { missing: `${what} does not exist, so there is nothing to propose about it.` };
	}
	return { version: rows[0].at.toISOString() };
}

/** A write function's answer, as every one of them shapes it. */
interface WriteRow {
	result: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// read tools
// ---------------------------------------------------------------------------

const searchAccounts = tool({
	name: 'search_accounts',
	risk: 'read',
	description:
		'Find accounts by name, town or account number. Returns revenue this year and last, when they last ordered, how quiet they are against their own rhythm, and their open commitments. Use this first when the question names a customer.',
	schema: z.strictObject({
		query: z.string().trim().min(1).max(60).describe('Part of the name, the town, or the account number.'),
		limit: z.number().int().min(1).max(20).default(8)
	}),
	output: answers(
		z.looseObject({
			rows: z.array(linked({ customer_no: z.string(), name: z.string() })),
			row_count: rowCount,
			/** The cap that was applied, asked for or defaulted. See rowCap. */
			limit: rowCap
		})
	),
	run: async (ctx, input) => {
		const like = `%${input.query}%`;
		const rows = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<Row>`
				select a.customer_no, a.name, a.city, a.state, a.owner_name, a.price_group,
				       a.revenue_ytd, a.revenue_prior_ytd, a.revenue_last_year, a.last_order_on,
				       a.days_quiet, a.typical_gap_days, a.quiet_ratio, a.gone_quiet,
				       a.open_commitments, a.open_committed, a.blocked, a.closed
				from nl.account_list a
				where a.name ilike ${like} or a.city ilike ${like} or a.customer_no = ${input.query}
				order by a.revenue_ytd desc nulls last, a.name
				limit ${input.limit}`
		);
		// Each row carries its own address, built from the one route registry
		// the pages use, so an answer can be followed rather than read out.
		return {
			rows: rows.map((r) => ({ ...r, url: routes.account(String(r.customer_no)) })),
			row_count: rows.length,
			limit: input.limit
		};
	}
});

const getAccount = tool({
	name: 'get_account',
	risk: 'read',
	description:
		'One account in full: revenue, ordering rhythm, its open commitments and its open order lines from the morning ERP export. Business facts only, no contact details.',
	schema: z.strictObject({ customer_no: customerNo }),
	output: answers(
		z.looseObject({
			account: linked({ customer_no: z.string(), name: z.string() }),
			open_commitments: z.array(linked({ id: z.number(), title: z.string() })),
			open_order_lines: z.array(z.looseObject({ document_no: z.string(), item_no: z.string() }))
		})
	),
	run: async (ctx, input) => {
		return ctx.db.asUser(ctx.userId, async (tx) => {
			const [account] = await tx.sql<Row>`
				select a.customer_no, a.name, a.city, a.state, a.country, a.owner_name, a.agency_name,
				       a.price_group, a.price_group_label, a.customer_since, a.blocked, a.closed,
				       a.parent_name, a.branch_count,
				       a.revenue_ytd, a.revenue_prior_ytd, a.revenue_last_year, a.last_order_on,
				       a.days_quiet, a.typical_gap_days, a.quiet_ratio, a.gone_quiet,
				       a.open_commitments, a.open_committed, a.open_expected,
				       a.open_steps, a.overdue_steps
				from nl.account_list a
				where a.customer_no = ${input.customer_no}`;
			if (!account) {
				return { error: `There is no account ${input.customer_no}. Use search_accounts to find the number.` };
			}

			const commitments = await tx.sql<Row>`
				select p.id, p.title, p.status, p.committed_value, p.delivered, p.delivered_ratio,
				       p.confidence, p.starts_on, p.ends_on, p.needs_outcome, p.days_since_close
				from nl.commitment_progress p
				where p.customer_no = ${input.customer_no} and not p.is_settled
				order by p.ends_on`;

			const orders = await tx.sql<Row>`
				select o.document_no, o.line_no, o.item_no, o.description, o.ship_date,
				       o.quantity, o.open_value, o.allocated, o.short
				from nl.open_line_allocation o
				where o.customer_no = ${input.customer_no}
				order by o.ship_date, o.document_no, o.line_no
				limit 25`;

			return {
				account: { ...account, url: routes.account(input.customer_no) },
				open_commitments: commitments.map((c) => ({ ...c, url: routes.commitment(Number(c.id)) })),
				open_order_lines: orders
			};
		});
	}
});

const getCommitment = tool({
	name: 'get_commitment',
	risk: 'read',
	description:
		'One commitment: its derived status, what has been delivered against it from the invoice ledger, the parts in scope and the invoice lines that were matched to it.',
	schema: z.strictObject({ commitment_id: commitmentId }),
	output: answers(
		z.looseObject({
			commitment: linked({ id: z.number(), title: z.string(), status: z.string() }),
			items: z.array(linked({ item_no: z.string() })),
			matched_lines: z.array(z.looseObject({ invoice_no: z.string(), item_no: z.string() }))
		})
	),
	run: async (ctx, input) => {
		return ctx.db.asUser(ctx.userId, async (tx) => {
			const [head] = await tx.sql<Row>`
				select p.id, p.title, p.customer_no, cu.name as customer_name, p.owner_id, u.full_name as owner_name,
				       p.status, p.committed_value, p.delivered, p.delivered_ratio, p.remaining, p.expected_value,
				       p.confidence, p.starts_on, p.ends_on, p.needs_outcome, p.days_since_close,
				       p.window_elapsed_ratio, p.matched_lines, p.last_delivery_on, p.quote_count,
				       p.outcome, p.outcome_source, p.is_settled, p.kept_by_measure, p.notes
				from nl.commitment_progress p
				join nl.customers cu on cu.customer_no = p.customer_no
				join nl.users u on u.id = p.owner_id
				where p.id = ${input.commitment_id}`;
			if (!head) return { error: `There is no commitment C-${input.commitment_id}.` };

			const items = await tx.sql<Row>`
				select ci.item_no, i.description, ci.quantity as promised_quantity,
				       coalesce(sum(l.quantity), 0)::int as delivered_quantity,
				       coalesce(sum(l.amount), 0) as delivered_value
				from nl.commitment_items ci
				join nl.items i on i.item_no = ci.item_no
				left join nl.commitment_lines l
				  on l.commitment_id = ci.commitment_id and l.item_no = ci.item_no
				where ci.commitment_id = ${input.commitment_id}
				group by ci.item_no, i.description, ci.quantity
				order by delivered_value desc, ci.item_no`;

			const lines = await tx.sql<Row>`
				select l.invoice_no, l.posted_on, l.customer_no, l.item_no, l.quantity, l.amount,
				       l.family_depth > 0 as via_branch
				from nl.commitment_lines l
				where l.commitment_id = ${input.commitment_id}
				order by l.posted_on desc, l.invoice_no desc
				limit 20`;

			return {
				commitment: { ...head, url: routes.commitment(input.commitment_id) },
				items: items.map((i) => ({ ...i, url: routes.part(String(i.item_no)) })),
				matched_lines: lines
			};
		});
	}
});

const listWindowsClosedShort = tool({
	name: 'list_windows_closed_short',
	risk: 'read',
	description:
		'Commitments whose window has closed with less than 95% delivered and no answer yet. This is the list the "closed short" page shows. Answering one is gated: propose it.',
	schema: z.strictObject({
		owner: z.enum(['me', 'everyone']).default('me'),
		limit: z.number().int().min(1).max(20).default(10)
	}),
	output: answers(
		z.looseObject({
			rows: z.array(linked({ id: z.number(), title: z.string(), shortfall: z.number() })),
			row_count: rowCount,
			whose: z.enum(['me', 'everyone']),
			limit: rowCap
		})
	),
	run: async (ctx, input) => {
		const mine = input.owner === 'me' ? ctx.userId : null;
		const rows = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<Row>`
				select p.id, p.title, p.customer_no, cu.name as customer_name,
				       p.owner_id, u.full_name as owner_name,
				       p.committed_value, p.delivered, p.delivered_ratio, p.confidence,
				       p.starts_on, p.ends_on, p.days_since_close,
				       p.committed_value - p.delivered as shortfall
				from nl.commitment_progress p
				join nl.customers cu on cu.customer_no = p.customer_no
				join nl.users u on u.id = p.owner_id
				where p.needs_outcome
				  and (${mine}::int is null or p.owner_id = ${mine}::int)
				order by p.days_since_close desc, p.committed_value desc
				limit ${input.limit}`
		);
		return {
			rows: rows.map((r) => ({ ...r, url: routes.commitmentAnswer(Number(r.id)) })),
			row_count: rows.length,
			whose: input.owner,
			limit: input.limit
		};
	}
});

const getPart = tool({
	name: 'get_part',
	risk: 'read',
	description:
		'One part: stock on hand and on order, what open orders already claim, whether it is under its reorder point, how it has sold over the last twelve months, and its lead time.',
	schema: z.strictObject({ item_no: itemNo }),
	output: answers(z.looseObject({ part: linked({ item_no: z.string(), description: z.string() }) })),
	run: async (ctx, input) => {
		const rows = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<Row>`
				select s.item_no, s.description, s.category, s.family, s.replenishment, s.lead_time,
				       s.made_to_order, s.proprietary, s.blocked, s.list_price, s.unit_cost, s.list_margin,
				       s.on_hand, s.on_production_order, s.on_purchase_order, s.projected_available,
				       s.reorder_point, s.safety_stock, s.below_reorder_point,
				       s.open_lines, s.open_qty, s.open_value, s.short_lines, s.short_qty, s.next_ship_date,
				       s.units_12m, s.revenue_12m, s.margin_12m, s.buyers_12m,
				       s.units_prior_12m, s.revenue_prior_12m, s.last_sold_on, s.stock_as_of
				from nl.part_summary s
				where s.item_no = ${input.item_no}`
		);
		if (!rows[0]) {
			return { error: `There is no part ${input.item_no}. Part numbers look like L3515-630SC or CU-41545.` };
		}
		return { part: { ...rows[0], url: routes.part(input.item_no) } };
	}
});

/**
 * What the SQL tool can reach, named in its description. This list is exactly
 * what role nl_readonly is granted SELECT on; anything left out is refused by
 * the database, not by a list in the prompt.
 */
const SQL_TABLES = [
	'nl.customers (customer_no, name, bill_to_no, city, state, country, price_group, owner_id, agency_id, blocked, closed, customer_since)',
	'nl.items (item_no, description, category, family, product_group, unit_cost, list_price, replenishment, work_center, vendor_no, lead_time, made_to_order, blocked)',
	'nl.stock (item_no, on_hand, on_production_order, on_purchase_order, as_of)',
	'nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on, subtotal, freight)',
	'nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no, quantity, unit_price, amount, unit_cost)',
	'nl.commitments and nl.commitment_progress (id, title, customer_no, owner_id, committed_value, delivered, delivered_ratio, expected_value, confidence, starts_on, ends_on, status, is_settled, needs_outcome, days_since_close)',
	'nl.commitment_items, nl.commitment_lines, nl.commitment_delivery, nl.commitment_outcomes, nl.commitment_family',
	'nl.quotes, nl.quote_lines, nl.next_steps',
	'nl.open_order_lines and nl.open_line_allocation (this morning ERP export: ship_date, quantity, allocated, short)',
	'nl.account_cadence (customer_no, orders_2y, last_order_on, typical_gap_days, days_quiet, quiet_ratio)',
	'nl.part_summary, nl.part_position, nl.vendor_summary, nl.vendors, nl.agencies, nl.price_groups'
];

const runSql = tool({
	name: 'run_sql',
	risk: 'read',
	description: `Run one read-only SELECT against Postgres when no other tool answers the question: a total, a ranking, a group by. One statement, no semicolons, no comments, at most 1,000 rows. It runs as a read-only role with no access at all to the tables about people (nl.users, nl.contacts, nl.activities) or to assistant conversations, so a query touching one of those is refused by the database. Tables and views: ${SQL_TABLES.join('; ')}. Today's date is nl.today().`,
	schema: z.strictObject({
		sql: z.string().trim().min(1).max(4000).describe('One SELECT, or a WITH that ends in a SELECT.'),
		why: z.string().trim().max(200).default('').describe('One line on what you are measuring.')
	}),
	output: answers(
		z.looseObject({
			rows: z.array(z.unknown()),
			row_count: rowCount,
			/** The 1,000 row cap was reached, so there may be more. */
			capped: z.boolean()
		})
	),
	// `why` is a line for the log and for a person reading the trail. It is
	// never part of the query, so it cannot change which rows come back and
	// the answer does not repeat it. The 1,000 row cap is fixed rather than an
	// input, and `capped` already says when it was reached.
	nonFilterDefaults: ['why'],
	run: (ctx, input) => runReadOnlySql(ctx.db, input.sql)
});

const testAutomationRule = tool({
	name: 'test_automation_rule',
	risk: 'read',
	description:
		'Try an automation rule out without saving it: it is compiled to one parameterized query and run in a read-only transaction, and you get back how many subjects match now and what the action would write for each. Use this before proposing save_automation_rule.',
	schema: z.strictObject({ rule: ruleSchema }),
	output: answers(
		z.looseObject({
			matches_now: rowCount,
			already_fired: rowCount,
			fields: z.array(z.unknown()),
			sample: z.array(z.unknown())
		})
	),
	run: async (ctx, input) => {
		try {
			const result = await testRule(ctx.db, ctx.userId, input.rule, null);
			return {
				matches_now: result.total,
				already_fired: result.alreadyFired,
				fields: result.fields,
				// A handful is enough for the model to judge the rule.
				sample: result.matches.slice(0, 5)
			};
		} catch (error) {
			const refusal = toAskError(error);
			if (refusal) return { error: refusal.message, code: refusal.code };
			throw error;
		}
	}
});

// ---------------------------------------------------------------------------
// additive tools: they can only ever add a row
// ---------------------------------------------------------------------------

const addNote = tool({
	name: 'add_note',
	risk: 'additive',
	description:
		'Write a note on an account, in your name, marked as coming from the assistant. Nothing existing changes. Use it to record what you found out, not to promise anything.',
	schema: z.strictObject({
		customer_no: customerNo,
		body: z.string().trim().min(1).max(2000),
		commitment_id: z.number().int().positive().nullable().default(null)
	}),
	output: answers(
		z.looseObject({
			wrote: z.literal('note'),
			// From nl.log_activity's own result, which the write function builds.
			activity_id: z.number(),
			customer_no: z.string(),
			/**
			 * Which commitment the note was tied to, null for none. It defaults
			 * to null, so the answer says which it was: a note meant for a
			 * commitment that quietly landed on the account alone is the same
			 * mistake as a quietly defaulted filter.
			 */
			commitment_id: z.number().nullable()
		})
	),
	run: async (ctx, input) => {
		const [row] = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.log_activity(${input.customer_no}, 'note', null, ${input.body}, null,
				                       ${input.commitment_id}::bigint, null,
				                       ${ctx.requestId('note')}, 'assistant') as result`
		);
		return { wrote: 'note', ...row.result, commitment_id: input.commitment_id };
	}
});

const addNextStep = tool({
	name: 'add_next_step',
	risk: 'additive',
	description:
		'Add a next step on an account, owned by you, due in a number of days. Nothing existing changes.',
	schema: z.strictObject({
		customer_no: customerNo,
		title: z.string().trim().min(3).max(200),
		due_in_days: z.number().int().min(0).max(60).default(7),
		commitment_id: z.number().int().positive().nullable().default(null)
	}),
	output: answers(
		z.looseObject({
			wrote: z.literal('next_step'),
			// From nl.add_next_step's own result.
			next_step_id: z.number(),
			owner_id: z.number(),
			/**
			 * Both of these default, so both are reported. A step that was
			 * asked for with no due date lands seven days out, and an agent
			 * that cannot see the seven cannot tell that it never chose it.
			 */
			due_in_days: z.number().int().nonnegative(),
			commitment_id: z.number().nullable()
		})
	),
	run: async (ctx, input) => {
		const [row] = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.add_next_step(${input.customer_no}, ${input.title},
				                        (select nl.today()) + ${input.due_in_days}::int, null,
				                        ${input.commitment_id}::bigint,
				                        ${ctx.requestId('step')}, 'assistant') as result`
		);
		return {
			wrote: 'next_step',
			...row.result,
			due_in_days: input.due_in_days,
			commitment_id: input.commitment_id
		};
	}
});

// ---------------------------------------------------------------------------
// gated tools: the model can name one in a proposal and nothing else
// ---------------------------------------------------------------------------

const recordOutcome = tool({
	name: 'record_outcome',
	risk: 'gated',
	description:
		'Answer the window-closed question on a commitment: kept, pushed or broken. This settles the commitment and changes the pipeline, so it is gated: put it in propose_action and let the owner decide.',
	schema: z.strictObject({
		commitment_id: commitmentId,
		outcome: z.enum(['kept', 'pushed', 'broken']),
		note: z.string().trim().max(500).default('')
	}),
	label: (input) =>
		`Record C-${input.commitment_id} as ${input.outcome}${input.note ? ` ("${input.note}")` : ''}`,
	capture: (ctx, input) => rowVersion(ctx, 'commitment', input.commitment_id),
	execute: async (ctx, input, version, requestId) => {
		const [row] = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.record_outcome(${input.commitment_id}, ${input.outcome}, ${version}::timestamptz,
				                         ${requestId}, ${input.note}, 'assistant') as result`
		);
		return row.result;
	}
});

const setConfidence = tool({
	name: 'set_confidence',
	risk: 'gated',
	description:
		"Change the owner's confidence on a commitment, 0 to 100. It moves the expected value every report reads, so it is gated: propose it.",
	schema: z.strictObject({
		commitment_id: commitmentId,
		confidence: z.number().int().min(0).max(100)
	}),
	label: (input) => `Set confidence on C-${input.commitment_id} to ${input.confidence}%`,
	capture: (ctx, input) => rowVersion(ctx, 'commitment', input.commitment_id),
	execute: async (ctx, input, version, requestId) => {
		const [row] = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.set_confidence(${input.commitment_id}, ${input.confidence}, ${version}::timestamptz,
				                         ${requestId}, 'assistant') as result`
		);
		return row.result;
	}
});

const decideExport = tool({
	name: 'decide_export',
	risk: 'gated',
	description:
		'Apply, release or discard a staged ERP export snapshot. Applying replaces the live open order lines the whole operations view reads, and only operations or an admin may do it, so it is gated: propose it.',
	schema: z.strictObject({
		snapshot_id: z.number().int().positive(),
		decision: z.enum(['apply', 'release', 'discard']),
		note: z.string().trim().max(500).default('')
	}),
	label: (input) => `${input.decision === 'apply' ? 'Apply' : input.decision === 'release' ? 'Release' : 'Discard'} snapshot ${input.snapshot_id}`,
	capture: (ctx, input) => rowVersion(ctx, 'snapshot', input.snapshot_id),
	execute: async (ctx, input, version, requestId) => {
		const note = input.note || null;
		const [row] = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.decide_export(${input.snapshot_id}, ${input.decision}, ${version}::timestamptz,
				                        ${requestId}, ${note}, 'assistant') as result`
		);
		return row.result;
	}
});

const saveAutomationRule = tool({
	name: 'save_automation_rule',
	risk: 'gated',
	description:
		'Save an automation rule, new or changed. A saved rule writes on its own every night, so it is gated: try it with test_automation_rule, then propose saving it.',
	schema: z.strictObject({
		rule: ruleSchema,
		rule_id: z.number().int().positive().nullable().default(null)
	}),
	label: (input) =>
		`${input.rule_id === null ? 'Create' : 'Update'} the rule "${input.rule.name}"${input.rule.enabled ? ', switched on' : ', switched off'}`,
	// A new rule has no row yet, so there is no version to hold it to.
	capture: (ctx, input) =>
		input.rule_id === null ? Promise.resolve({ version: null }) : rowVersion(ctx, 'rule', input.rule_id),
	execute: async (ctx, input, version, requestId) => {
		const [row] = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.save_automation_rule(
				  ${input.rule_id}::bigint, ${input.rule.name}, ${input.rule.description}, ${input.rule.trigger},
				  ${JSON.stringify(input.rule.conditions)}::jsonb, ${JSON.stringify(input.rule.action)}::jsonb,
				  ${input.rule.enabled}, ${version}::timestamptz, ${requestId}) as result`
		);
		return row.result;
	}
});

// ---------------------------------------------------------------------------
// propose_action: the only door from a gated tool to a real write
// ---------------------------------------------------------------------------

export const proposalOptionSchema = z.strictObject({
	label: z.string().trim().min(3).max(200).describe('What this option does, in one line, for the person deciding.'),
	tool: z.string().trim().min(1).max(60).describe('The exact name of the gated tool.'),
	input: z.record(z.string(), z.unknown()).describe("That tool's input, complete and exact.")
});

export const proposeActionSchema = z.strictObject({
	summary: z
		.string()
		.trim()
		.min(3)
		.max(500)
		.describe('One or two sentences: what you found, and what you are asking to do about it.'),
	options: z.array(proposalOptionSchema).min(1).max(3)
});

export type ProposeActionInput = z.infer<typeof proposeActionSchema>;

const proposeAction = tool({
	name: 'propose_action',
	risk: 'propose',
	description:
		'Put one to three options in front of the person, each naming a gated tool and its exact input. This writes nothing: the options appear as a card and the person approves or rejects one. It is the only way a gated tool ever runs.',
	schema: proposeActionSchema
});

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export const TOOLS: Tool[] = [
	searchAccounts,
	getAccount,
	getCommitment,
	listWindowsClosedShort,
	getPart,
	runSql,
	testAutomationRule,
	addNote,
	addNextStep,
	recordOutcome,
	setConfidence,
	decideExport,
	saveAutomationRule,
	proposeAction
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): Tool | undefined {
	return BY_NAME.get(name);
}

export function toolNames(): string[] {
	return TOOLS.map((t) => t.name);
}

export function gatedToolNames(): string[] {
	return TOOLS.filter((t) => t.risk === 'gated').map((t) => t.name);
}

/** A request id for a write in one round of one turn, stable across retries. */
export function turnRequestId(base: string, round: number, suffix: string): string {
	const id = `${base}-r${round}-${suffix}`;
	// nl.claim_request wants 8 to 100 characters; a uuid base is already 36.
	return id.length >= 8 ? id.slice(0, 100) : `${id}-${randomUUID()}`.slice(0, 100);
}
