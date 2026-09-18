// What an outside agent can ask for, and nothing else.
//
// There is no second tool registry here. The list is built from the
// assistant's one (assistant/tools.ts), which is where a tool's risk class
// lives:
//
//   read     exposed as itself. It answers straight away and writes nothing.
//   gated    exposed as propose_<name>. Calling it creates a proposal a person
//            approves in the app. The gated tool itself is never exposed and
//            never runs from here, whatever the token's scopes are.
//   additive deliberately NOT exposed. add_note and add_next_step do write a
//            row, and the promise this endpoint makes is that an outside agent
//            changes nothing without a person. An agent that wants a note
//            written asks a person for it.
//   propose  not exposed either: propose_action is the assistant's own plumbing,
//            and the propose_* tools below are the door to it.
//
// One tool is new (list_pending_approvals), because an outside agent needs to
// be able to see what it has left for a person to decide.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { runTool } from '../assistant/gate.ts';
import { inputProblem, outputProblem, TOOLS, type Tool, type ToolContext } from '../assistant/tools.ts';
import { proposeFromMcp } from './propose.ts';
import type { McpScope } from './tokens.ts';
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
	/** Which scope a token needs to call it. */
	scope: McpScope;
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
		scope: 'read',
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

/*
  Strict, like every other tool input: an invented field is an error naming
  the field rather than a default applied behind the caller's back. Both of
  these fields have a default, so both come back in the answer.
*/
const pendingSchema = z.strictObject({
	status: z
		.enum(['draft', 'approved', 'rejected', 'executed'])
		.default('draft')
		.describe('draft is waiting for a person. executed means the write went through.'),
	limit: z.number().int().min(1).max(20).default(10)
});

const pendingJsonSchema = z.toJSONSchema(pendingSchema, { target: 'draft-2020-12', io: 'input' }) as Record<
	string,
	unknown
>;

const listPendingApprovals: McpTool = {
	name: 'list_pending_approvals',
	title: 'List pending approvals',
	description:
		'Proposals waiting for a person to decide, newest first: what was proposed, which tool it would run, and the page to approve it on. Use it to check whether something you proposed has been decided yet. Ask for status "executed" to see the ones that went through.',
	inputSchema: pendingJsonSchema,
	scope: 'read',
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
				/* Both defaulted filters, reported under the names the input takes. */
				status: z.enum(['draft', 'approved', 'rejected', 'executed']),
				limit: z.number().int().positive()
			}),
			mcpRefusal
		])
	),
	// The same wording every other tool's refusal uses, from the same function,
	// so an unknown field is named here too instead of blamed on "input".
	check: (input) => {
		const parsed = pendingSchema.safeParse(input ?? {});
		if (parsed.success) return { ok: true };
		return { ok: false, message: inputProblem(parsed.error, pendingJsonSchema) };
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
			payload: { rows, row_count: rows.length, status: asked.status, limit: asked.limit },
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
 *
 * `additionalProperties: false` is stated here and enforced by the gated
 * tool's strict schema when the input is checked, so the published rule and
 * the running one are the same rule.
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
	const inputSchema = schemaWithSummary(gated);
	/** Everything this tool takes: the gated tool's fields, plus summary. */
	const accepted = Object.keys((inputSchema.properties ?? {}) as Record<string, unknown>);
	return {
		name: `propose_${gated.name}`,
		title: titleFor(`propose_${gated.name}`),
		description:
			`Ask for this change instead of making it. It writes nothing: it creates a proposal that a person approves or rejects in the app, ` +
			`and you get back the proposal's id and the page to approve it on. What it would do once approved: ${gated.description}`,
		inputSchema,
		scope: 'propose',
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
			/*
			  The unknown-field check belongs here rather than in the gated
			  tool, which has never heard of `summary`: delegating it would
			  name the field correctly but then list the accepted fields
			  without the one the caller had just got right. Anything nested
			  inside a field is still caught by the gated tool's own strict
			  schema below.

			  It runs before the summary check for the same reason the zod
			  formatting prefers an unrecognized key: a misspelled `summary`
			  is both a missing field and an unknown one, and only the second
			  reading says what the caller typed.
			*/
			const unknownFields = Object.keys(shape).filter((key) => !accepted.includes(key));
			if (unknownFields.length > 0) {
				return {
					ok: false,
					message: `${unknownFields.join(', ')}: there is no input by that name. This tool takes ${accepted.join(', ')}.`
				};
			}
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
// The list
// ---------------------------------------------------------------------------

export const MCP_TOOLS: McpTool[] = [
	...TOOLS.filter((tool) => tool.risk === 'read').map(readTool),
	listPendingApprovals,
	...TOOLS.filter((tool) => tool.risk === 'gated').map(proposeTool)
];

const BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

export function findMcpTool(name: string): McpTool | undefined {
	return BY_NAME.get(name);
}

export function mcpToolNames(): string[] {
	return MCP_TOOLS.map((tool) => tool.name);
}

/** The tools a token with these scopes may call. */
export function toolsForScopes(scopes: readonly McpScope[]): McpTool[] {
	return MCP_TOOLS.filter((tool) => scopes.includes(tool.scope));
}
