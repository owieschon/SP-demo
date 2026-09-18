// What an outside agent can ask for, and nothing else.
//
// There is no second tool registry here. The list is built from the
// assistant's one (assistant/tools.ts), which is where a tool's risk class
// lives. What has changed since migration 0044 is that the SHAPE a tool is
// offered in depends on the token's rung on the autonomy ladder, so
// tools/list tells an agent the truth about what it can do right now:
//
//   read     exposed as itself at every rung. It answers and writes nothing.
//   gated    at suggest, exposed as propose_<name>: calling it creates a
//            proposal a person approves in the app. At auto_review and auto,
//            exposed under its OWN name, and calling it makes the change, for
//            real, bounded by the person's authority, the policy engine's cap,
//            the pause switch and (at auto_review) an undo window.
//   additive add_note and add_next_step. Not exposed at suggest, exposed at
//            auto_review and auto. They used to be withheld at every rung, and
//            the reason given was that an outside agent must change nothing
//            without a person. That reason was really the absence of a dial:
//            with one, "a person said this agent may add a note for me" is an
//            authority grant like any other.
//   propose  not exposed at all: propose_action is the assistant's own
//            plumbing, and the propose_* tools below are the door to it.
//
// One tool is new (list_pending_approvals), because an outside agent needs to
// be able to see what it has left for a person to decide.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runTool } from '../assistant/gate.ts';
import { outputProblem, TOOLS, type Tool, type ToolContext } from '../assistant/tools.ts';
import { actFromMcp } from './act.ts';
import { proposeFromMcp } from './propose.ts';
import type { TokenAutonomy, TokenLevel } from './tokens.ts';
import type { Db, Row } from '../db/types.ts';

/** What a tool call is given. One per call. */
export interface McpToolContext {
	db: Db;
	/** The person the token acts as. Every query runs as them. */
	userId: number;
	/** The company's date. */
	today: string;
	/** Which token asked, for the line a person reads on a proposal. */
	tokenLabel: string;
	/**
	 * The rung this token stands on, read from the ladder when the request was
	 * authenticated. A tool that acts needs it for the record it writes; a
	 * read tool ignores it.
	 */
	autonomy: TokenAutonomy;
}

export interface McpToolAnswer {
	payload: unknown;
	/** True when the tool answered with a refusal rather than data. */
	isError: boolean;
	rows: number | null;
}

export type InputCheck = { ok: true } | { ok: false; message: string };

export interface McpTool {
	name: string;
	title: string;
	description: string;
	/** JSON Schema, converted from the zod schema, so tools/list is usable. */
	inputSchema: Record<string, unknown>;
	/**
	 * Does calling it change a record? 'read' answers a question; 'propose'
	 * writes only a proposal; 'change' writes for real.
	 *
	 * This is a DESCRIPTION, not a gate. Nothing decides whether a call is
	 * allowed by reading it: the rung decides which tools exist for this
	 * token, and the database decides whether the write is permitted. It is
	 * here for the annotations an MCP client shows and for the connect page.
	 */
	gate: 'read' | 'propose' | 'change';
	/** For the readOnlyHint an MCP client shows. */
	readOnly: boolean;
	/**
	 * JSON Schema of what this tool answers with, sent in tools/list, so a
	 * client can validate a result instead of reading prose out of it.
	 */
	outputSchema: Record<string, unknown>;
	/**
	 * Does a payload match that schema? The endpoint calls it before it sends
	 * structuredContent: a payload that does not match is still returned as
	 * text, because an answer is better than none, but it is not presented as
	 * conforming to a contract it breaks.
	 */
	checkOutput(payload: unknown): InputCheck;
	/**
	 * Check the input without running anything. The endpoint calls this first
	 * so a bad input answers with JSON-RPC -32602 (invalid params) instead of
	 * a tool result the agent has to read prose out of. The authoritative
	 * check is still the one inside the gate, which runs afterwards.
	 */
	check(input: unknown): InputCheck;
	run(ctx: McpToolContext, input: Record<string, unknown>): Promise<McpToolAnswer>;
}

/** A zod shape, as the JSON Schema to publish and the check to run. */
function outputOf(shape: z.ZodType): {
	outputSchema: Record<string, unknown>;
	checkOutput(payload: unknown): InputCheck;
} {
	return {
		outputSchema: z.toJSONSchema(shape, { target: 'draft-2020-12', io: 'output' }) as Record<string, unknown>,
		checkOutput(payload) {
			const parsed = shape.safeParse(payload);
			if (parsed.success) return { ok: true };
			return { ok: false, message: outputProblem(parsed.error) };
		}
	};
}

/*
  A refusal is a normal answer from any of these tools: the account is not
  there, the query was refused, the proposal could not be made. It is part of
  every declared output rather than a separate channel.
*/
const mcpRefusal = z.looseObject({ error: z.string(), code: z.string().optional() });

/** "search_accounts" -> "Search accounts", for the title an MCP client shows. */
function titleFor(name: string): string {
	const words = name.replaceAll('_', ' ');
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A tool context of the shape the assistant's tools expect. */
function toolContext(ctx: McpToolContext): ToolContext {
	const base = randomUUID();
	return {
		db: ctx.db,
		userId: ctx.userId,
		today: ctx.today,
		round: 1,
		requestId: (suffix) => `mcp-${base}-${suffix}`
	};
}

/**
 * A tool can run and still answer with a refusal: run_sql returns
 * `{ error: ... }` when Postgres will not have the query, and get_account
 * does the same for a customer number that is not there. That is a tool error
 * as far as an MCP client is concerned, so the flag has to look at the
 * payload as well as at whether the handler ran.
 */
function isRefusal(payload: unknown): boolean {
	if (!payload || typeof payload !== 'object') return false;
	return typeof (payload as { error?: unknown }).error === 'string';
}

function checkWith(tool: Tool): (input: unknown) => InputCheck {
	return (input) => {
		const parsed = tool.parse(input ?? {});
		return parsed.ok ? { ok: true } : { ok: false, message: parsed.message };
	};
}

// ---------------------------------------------------------------------------
// read tools: the assistant's own, unchanged
// ---------------------------------------------------------------------------

/**
 * Every call goes through the gate, even a read, so there is exactly one place
 * that decides what a tool name is allowed to do. A read that the gate refuses
 * (a customer number that is not there, a query Postgres would not run) comes
 * back as a tool error the agent can act on, not as a crash.
 */
function readTool(tool: Tool): McpTool {
	return {
		name: tool.name,
		title: titleFor(tool.name),
		description: tool.description,
		inputSchema: tool.jsonSchema,
		gate: 'read',
		readOnly: true,
		/*
		  The same schema the assistant declares, not a second copy of it. If
		  a read tool has none yet, say so honestly with an open object rather
		  than publish a shape nobody checks.
		*/
		outputSchema: tool.outputSchema ?? { type: 'object' },
		checkOutput: (payload) => tool.checkOutput?.(payload) ?? { ok: true },
		check: checkWith(tool),
		run: async (ctx, input) => {
			const run = await runTool(
				toolContext(ctx),
				{ id: `mcp-${randomUUID()}`, name: tool.name, input },
				{ proposalAllowed: false }
			);
			return {
				payload: run.payload,
				isError: run.lookup.outcome !== 'ran' || isRefusal(run.payload),
				rows: run.lookup.rows
			};
		}
	};
}

// ---------------------------------------------------------------------------
// list_pending_approvals: what is waiting for a person
// ---------------------------------------------------------------------------

const pendingSchema = z.object({
	status: z
		.enum(['draft', 'approved', 'rejected', 'executed'])
		.default('draft')
		.describe('draft is waiting for a person. executed means the write went through.'),
	limit: z.number().int().min(1).max(20).default(10)
});

const listPendingApprovals: McpTool = {
	name: 'list_pending_approvals',
	title: 'List pending approvals',
	description:
		'Proposals waiting for a person to decide, newest first: what was proposed, which tool it would run, and the page to approve it on. Use it to check whether something you proposed has been decided yet. Ask for status "executed" to see the ones that went through.',
	inputSchema: z.toJSONSchema(pendingSchema, { target: 'draft-2020-12', io: 'input' }) as Record<string, unknown>,
	gate: 'read',
	readOnly: true,
	...outputOf(
		z.union([
			z.looseObject({
				rows: z.array(
					z.looseObject({
						proposal_id: z.number(),
						conversation_id: z.number(),
						summary: z.string(),
						status: z.string(),
						/** The page a person decides it on. */
						approve_at: z.string()
					})
				),
				row_count: z.number().int().nonnegative(),
				status: z.enum(['draft', 'approved', 'rejected', 'executed'])
			}),
			mcpRefusal
		])
	),
	check: (input) => {
		const parsed = pendingSchema.safeParse(input ?? {});
		if (parsed.success) return { ok: true };
		const first = parsed.error.issues[0];
		return { ok: false, message: `${first.path.join('.') || 'input'}: ${first.message}` };
	},
	run: async (ctx, input) => {
		const asked = pendingSchema.parse(input ?? {});
		const rows = await ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<Row>`
				select p.id as proposal_id, p.conversation_id, p.summary, p.status, p.created_at,
				       c.mode as came_from,
				       (select string_agg(o.value ->> 'tool', ', ')
				        from jsonb_array_elements(p.options) o) as tools,
				       (select string_agg(o.value ->> 'label', ' | ')
				        from jsonb_array_elements(p.options) o) as options,
				       '/ask/' || p.conversation_id::text as approve_at
				from nl.assistant_proposals p
				join nl.assistant_conversations c on c.id = p.conversation_id
				where p.status = ${asked.status}
				order by p.id desc
				limit ${asked.limit}`
		);
		return {
			payload: { rows, row_count: rows.length, status: asked.status },
			isError: false,
			rows: rows.length
		};
	}
};

// ---------------------------------------------------------------------------
// propose_* tools: the only way an agent can ask for a change
// ---------------------------------------------------------------------------

const summarySchema = z
	.string()
	.trim()
	.min(3)
	.max(500)
	.describe('One or two sentences for the person deciding: what you found, and what you are asking to do about it.');

/**
 * The gated tool's own JSON Schema with a required `summary` added. The input
 * an agent sends is therefore exactly the gated tool's input plus the reason,
 * which keeps one shape per concept.
 */
function schemaWithSummary(tool: Tool): Record<string, unknown> {
	const base = tool.jsonSchema as {
		properties?: Record<string, unknown>;
		required?: string[];
	};
	return {
		type: 'object',
		properties: {
			...(base.properties ?? {}),
			summary: z.toJSONSchema(summarySchema, { target: 'draft-2020-12', io: 'input' })
		},
		required: [...(base.required ?? []), 'summary'],
		additionalProperties: false
	};
}

/** Everything except the summary, which is ours rather than the tool's. */
function withoutSummary(input: Record<string, unknown>): Record<string, unknown> {
	const { summary: _summary, ...rest } = input;
	return rest;
}

function proposeTool(gated: Tool): McpTool {
	const checkGatedInput = checkWith(gated);
	return {
		name: `propose_${gated.name}`,
		title: titleFor(`propose_${gated.name}`),
		description:
			`Ask for this change instead of making it. It writes nothing: it creates a proposal that a person approves or rejects in the app, ` +
			`and you get back the proposal's id and the page to approve it on. What it would do once approved: ${gated.description}`,
		inputSchema: schemaWithSummary(gated),
		gate: 'propose',
		readOnly: false,
		...outputOf(
			z.union([
				z.looseObject({
					proposed: z.literal(true),
					proposal_id: z.number(),
					conversation_id: z.number(),
					/** The page a person approves or rejects it on. */
					approve_at: z.string(),
					tool: z.string(),
					label: z.string(),
					status: z.literal('draft')
				}),
				z.looseObject({ proposed: z.literal(false), error: z.string() })
			])
		),
		check: (input) => {
			const shape = (input ?? {}) as Record<string, unknown>;
			const summary = summarySchema.safeParse(shape.summary);
			if (!summary.success) return { ok: false, message: `summary: ${summary.error.issues[0].message}` };
			return checkGatedInput(withoutSummary(shape));
		},
		run: async (ctx, input) => {
			const summary = summarySchema.parse(input.summary);
			const outcome = await proposeFromMcp(toolContext(ctx), {
				tool: gated.name,
				toolInput: withoutSummary(input),
				summary,
				tokenLabel: ctx.tokenLabel
			});
			return outcome.ok
				? { payload: outcome.payload, isError: false, rows: null }
				: { payload: { error: outcome.message, proposed: false }, isError: true, rows: null };
		}
	};
}

// ---------------------------------------------------------------------------
// act tools: the same tool, under its own name, when the rung allows it
// ---------------------------------------------------------------------------

/**
 * A gated or additive tool, offered under its own name.
 *
 * The `summary` is still required and still says why, for the same reason a
 * proposal needs one: the record a person reads afterwards is worth nothing if
 * it only says which function ran. At these rungs nobody is asked to approve,
 * which makes the sentence more important rather than less.
 *
 * Everything that decides whether the call is allowed is in act.ts and in the
 * database. This wrapper only shapes the input and the answer.
 */
function actTool(inner: Tool): McpTool {
	const checkInnerInput = checkWith(inner);
	const acting =
		inner.risk === 'additive'
			? 'It adds a row and changes nothing existing.'
			: 'It makes the change for real, as you, with no approval step.';
	return {
		name: inner.name,
		title: titleFor(inner.name),
		description:
			`${acting} It is bounded by what the person this token acts as may do: their authority and its ceiling, ` +
			`the policy engine's cap, and the pause switch. At the act-with-review level there is also a window ` +
			`in which a person can take it back. What it does: ${inner.description}`,
		inputSchema: schemaWithSummary(inner),
		gate: 'change',
		readOnly: false,
		...outputOf(
			z.union([
				z.looseObject({
					acted: z.literal(true),
					tool: z.string(),
					level: z.string(),
					/** Non-null only at act-with-review: when the window closes. */
					undo_until: z.string().nullable(),
					sampled: z.boolean(),
					action_id: z.number()
				}),
				mcpRefusal
			])
		),
		check: (input) => {
			const shape = (input ?? {}) as Record<string, unknown>;
			const summary = summarySchema.safeParse(shape.summary);
			if (!summary.success) return { ok: false, message: `summary: ${summary.error.issues[0].message}` };
			return checkInnerInput(withoutSummary(shape));
		},
		run: async (ctx, input) => {
			const summary = summarySchema.parse(input.summary);
			const outcome = await actFromMcp(ctx.db, ctx.userId, ctx.today, {
				tool: inner.name,
				toolInput: withoutSummary(input),
				summary,
				tokenLabel: ctx.tokenLabel,
				autonomy: ctx.autonomy
			});
			return outcome.ok
				? { payload: outcome.payload, isError: false, rows: null }
				: {
						payload: { error: outcome.message, acted: false, ...(outcome.code ? { code: outcome.code } : {}) },
						isError: true,
						rows: null
					};
		}
	};
}

// ---------------------------------------------------------------------------
// The list, which depends on the rung
// ---------------------------------------------------------------------------

const READ_TOOLS: McpTool[] = [
	...TOOLS.filter((tool) => tool.risk === 'read').map(readTool),
	listPendingApprovals
];

const GATED = TOOLS.filter((tool) => tool.risk === 'gated');
const ADDITIVE = TOOLS.filter((tool) => tool.risk === 'additive');

/*
  The propose_ and act shapes, each built once.

  Built here rather than inside the three lists below so that the SAME object
  is in every list it belongs to. Two lists holding two separately built
  wrappers of one tool would pass every test and still let their output
  schemas drift apart.
*/
const PROPOSE_TOOLS: McpTool[] = GATED.map(proposeTool);
const ACT_TOOLS: McpTool[] = [...GATED.map(actTool), ...ADDITIVE.map(actTool)];

/**
 * Built once per rung rather than per request. The three lists are pure
 * functions of the registry, so building them on every tools/list would be
 * the same answer computed again.
 */
const BY_LEVEL: Record<TokenLevel, McpTool[]> = {
	// Exactly what this endpoint offered before there was a dial: reads, and
	// gated tools as proposals. Nothing an existing token could call has moved.
	suggest: [...READ_TOOLS, ...PROPOSE_TOOLS],
	auto_review: [...READ_TOOLS, ...ACT_TOOLS],
	// The same list as auto_review: what differs between the two rungs is the
	// undo window and the sampling on the action, not which tools exist.
	auto: [...READ_TOOLS, ...ACT_TOOLS]
};

const INDEX: Record<TokenLevel, Map<string, McpTool>> = {
	suggest: new Map(BY_LEVEL.suggest.map((tool) => [tool.name, tool])),
	auto_review: new Map(BY_LEVEL.auto_review.map((tool) => [tool.name, tool])),
	auto: new Map(BY_LEVEL.auto.map((tool) => [tool.name, tool]))
};

/** The tools this rung offers. What tools/list answers with, and nothing else. */
export function toolsForLevel(level: TokenLevel): McpTool[] {
	return BY_LEVEL[level] ?? BY_LEVEL.suggest;
}

/**
 * The tool this rung knows by that name, or undefined.
 *
 * The rung is part of the lookup on purpose. A name that is not in this rung's
 * list does not exist for this token, so there is no input that could make it
 * run and no second check to forget: at suggest, `set_confidence` is simply
 * not a tool, and `propose_set_confidence` is.
 */
export function findMcpTool(level: TokenLevel, name: string): McpTool | undefined {
	return (INDEX[level] ?? INDEX.suggest).get(name);
}

/**
 * Every tool this endpoint can ever build, one per name, with the lowest rung
 * it is offered at.
 *
 * This is the whole surface, which is not what any single token sees: a token
 * sees `toolsForLevel(its rung)`. It is here for the two callers that have to
 * reason about the surface rather than about one token, namely the connect
 * page and the contract test that holds every published output schema against
 * a real answer.
 */
export const ALL_MCP_TOOLS: { tool: McpTool; fromLevel: TokenLevel }[] = [
	...READ_TOOLS.map((tool) => ({ tool, fromLevel: 'suggest' as TokenLevel })),
	...PROPOSE_TOOLS.map((tool) => ({ tool, fromLevel: 'suggest' as TokenLevel })),
	...ACT_TOOLS.map((tool) => ({ tool, fromLevel: 'auto_review' as TokenLevel }))
];

/** The same list flattened, for a caller that only wants the tools. */
export const MCP_TOOLS: McpTool[] = ALL_MCP_TOOLS.map((entry) => entry.tool);

/** What the connect page draws: names and shapes, without the schemas. */
export interface RosterEntry {
	name: string;
	title: string;
	gate: McpTool['gate'];
	readOnly: boolean;
	/** The rung from which it is offered. Reads are offered at all of them. */
	fromLevel: TokenLevel;
}

export const MCP_TOOL_ROSTER: RosterEntry[] = ALL_MCP_TOOLS.map(({ tool, fromLevel }) => ({
	name: tool.name,
	title: tool.title,
	gate: tool.gate,
	readOnly: tool.readOnly,
	fromLevel
}));

/** Every name this endpoint can answer to, at any rung. */
export function mcpToolNames(): string[] {
	return [...new Set(MCP_TOOL_ROSTER.map((tool) => tool.name))];
}
