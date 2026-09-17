// The MCP endpoint: one POST, speaking MCP over streamable HTTP.
//
// The protocol itself is the official SDK's. This file is the four things
// around it that are ours:
//
//   1. authentication. A bearer token, hashed and compared in constant time
//      (tokens.ts). No token or a token that does not work is 401, and the
//      token decides which person every query runs as.
//   2. scopes. A tools/call the token's scopes do not cover is 403, before the
//      tool is looked at. The same check runs again inside the handler, so a
//      batched request cannot slip past the first one.
//   3. the day's cap. One claim per tools/call, counted in the database, so a
//      restarted server does not forget. Over the cap is 429 with a sentence
//      a person can read.
//   4. the log. Every call gets a row in nl.mcp_calls: which token, which
//      tool, how long it took, how many rows, how it ended.
//
// A fresh Server and transport are built for each request, with session
// management switched off. Vercel functions do not hold sessions between
// requests, so pretending otherwise would break the moment a second instance
// started.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import {
	CallToolRequestSchema,
	ErrorCode,
	ListToolsRequestSchema,
	McpError
} from '@modelcontextprotocol/sdk/types.js';
import { readToday } from '../assistant/gate.ts';
import { fitResult } from '../assistant/wrap.ts';
import { AppError, toAppError } from '../errors.ts';
import { MAX_TOOL_RESULT_BYTES, type McpLimits } from './caps.ts';
import { findMcpTool, toolsForScopes, type McpToolContext } from './tools.ts';
import { authenticate, claimCall, logCall, type TokenIdentity } from './tokens.ts';
import type { Db } from '../db/types.ts';

export const SERVER_NAME = 'northline';
export const SERVER_VERSION = '1.0.0';

/** What an outside agent is told about the shape of this server. */
const INSTRUCTIONS = `Northline is the sales and operations system for Northline Exhaust Co. All of its data is invented.

Read tools answer straight away. Anything that would change a record is not here: instead there are propose_* tools, which create a proposal that a named person approves in the app. Nothing you can call approves a proposal, and no scope changes that.

Start with search_accounts when a question names a customer, get_part for a part number, and run_sql for a total or a ranking that no other tool gives. list_pending_approvals shows what you have left for a person to decide.`;

export interface McpDeps {
	db: Db;
	limits: McpLimits;
}

// ---------------------------------------------------------------------------
// Answers that never reach the protocol layer
// ---------------------------------------------------------------------------

/**
 * A JSON-RPC error as an HTTP response. The body is a valid JSON-RPC error
 * object whatever went wrong, so a client always has something to parse, and
 * the message is plain English rather than a stack trace.
 */
function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

/** What GET answers: this endpoint is POST only, and here is how to use it. */
export function mcpMetadata(endpoint: string): Record<string, unknown> {
	return {
		name: SERVER_NAME,
		version: SERVER_VERSION,
		protocol: 'MCP over streamable HTTP, JSON-RPC 2.0',
		endpoint,
		stateless: true,
		methods: ['initialize', 'tools/list', 'tools/call', 'ping'],
		authentication: 'Authorization: Bearer <token>, minted at /settings/mcp',
		connect: `claude mcp add --transport http ${SERVER_NAME} ${endpoint} --header "Authorization: Bearer <token>"`,
		message:
			'This endpoint speaks MCP over POST only. It holds no sessions, so there is no stream to open with GET. Mint a token at /settings/mcp and point Claude Code, Cursor or Codex at this URL.'
	};
}

export function mcpGetResponse(endpoint: string): Response {
	return new Response(JSON.stringify(mcpMetadata(endpoint), null, 2), {
		status: 405,
		headers: { 'content-type': 'application/json', allow: 'POST' }
	});
}

// ---------------------------------------------------------------------------
// Reading the request before the protocol layer sees it
// ---------------------------------------------------------------------------

interface RpcCall {
	method: string;
	/** The tool, when the method is tools/call and one was named. */
	tool: string | null;
	/** True for a tools/call whose params name no tool at all. */
	toolMissing: boolean;
}

/**
 * The calls in a body that expect an answer. A JSON-RPC message with no id is
 * a notification: there is nothing to answer, nothing to charge for and
 * nothing to log, so it is left to the protocol layer.
 */
function callsIn(body: unknown): RpcCall[] {
	const list = Array.isArray(body) ? body : [body];
	const calls: RpcCall[] = [];
	for (const item of list) {
		if (!item || typeof item !== 'object') continue;
		const message = item as { method?: unknown; params?: unknown; id?: unknown };
		if (typeof message.method !== 'string' || message.id === undefined) continue;
		const params = (message.params ?? {}) as { name?: unknown };
		const named = typeof params.name === 'string' && params.name.length > 0;
		calls.push({
			method: message.method,
			tool: message.method === 'tools/call' && named ? (params.name as string) : null,
			toolMissing: message.method === 'tools/call' && !named
		});
	}
	return calls;
}

/**
 * The SDK's transport insists on an Accept header naming both media types,
 * which is right for a client that might get a stream. This server always
 * answers with JSON, and being usable from curl is worth more than the check,
 * so the header is filled in when it is missing. The body has already been
 * parsed as JSON here, so saying so in the content type is a statement of
 * fact, not a shortcut.
 */
function withProtocolHeaders(request: Request): Request {
	const headers = new Headers(request.headers);
	headers.set('accept', 'application/json, text/event-stream');
	headers.set('content-type', 'application/json');
	return new Request(request.url, { method: 'POST', headers });
}

// ---------------------------------------------------------------------------
// The server for one request
// ---------------------------------------------------------------------------

function buildServer(deps: McpDeps, token: TokenIdentity, today: () => Promise<string>): Server {
	const server = new Server(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ capabilities: { tools: {} }, instructions: INSTRUCTIONS }
	);

	// tools/list shows what this token can actually call, so an agent does not
	// plan around a tool it would be refused for.
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: toolsForScopes(token.scopes).map((tool) => ({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema,
			annotations: {
				title: tool.title,
				readOnlyHint: tool.readOnly,
				// A propose_* tool writes a proposal and nothing else, so it can
				// never destroy anything and running it twice only asks twice.
				destructiveHint: false,
				idempotentHint: tool.readOnly
			}
		}))
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const started = Date.now();
		const since = () => Date.now() - started;
		const name = request.params.name;
		const asked = name.slice(0, 60);

		const tool = findMcpTool(name);
		if (!tool) {
			// A gated tool (record_outcome, set_confidence, decide_export,
			// save_automation_rule) lands here: it is not in the list at all, so
			// there is no input that could make it run.
			await logCall(deps.db, token, {
				method: 'tools/call',
				tool: asked,
				ms: since(),
				outcome: 'refused',
				note: 'No tool of that name.'
			});
			throw new McpError(
				ErrorCode.InvalidParams,
				`There is no tool called "${asked}". Call tools/list to see the ones this token has. A change to a record is asked for with a propose_ tool and approved by a person.`
			);
		}
		if (!token.scopes.includes(tool.scope)) {
			await logCall(deps.db, token, {
				method: 'tools/call',
				tool: tool.name,
				ms: since(),
				outcome: 'refused',
				note: `Needs the ${tool.scope} scope.`
			});
			throw new McpError(
				ErrorCode.InvalidParams,
				`${tool.name} needs the "${tool.scope}" scope, and this token has ${token.scopes.join(' and ')}.`
			);
		}

		const input = (request.params.arguments ?? {}) as Record<string, unknown>;
		const checked = tool.check(input);
		if (!checked.ok) {
			await logCall(deps.db, token, {
				method: 'tools/call',
				tool: tool.name,
				ms: since(),
				outcome: 'refused',
				note: checked.message
			});
			throw new McpError(ErrorCode.InvalidParams, `The input for ${tool.name} does not fit: ${checked.message}`);
		}

		const ctx: McpToolContext = {
			db: deps.db,
			userId: token.userId,
			today: await today(),
			tokenLabel: token.label
		};

		try {
			const answer = await tool.run(ctx, input);
			// The same 16 KB cap the assistant's own results get, from the same
			// function: a result with rows loses rows from the end and says so.
			const fitted = fitResult(answer.payload, MAX_TOOL_RESULT_BYTES);
			await logCall(deps.db, token, {
				method: 'tools/call',
				tool: tool.name,
				ms: since(),
				rows: fitted.rows ?? answer.rows,
				outcome: answer.isError ? 'refused' : 'ok',
				note: fitted.truncated ? 'Truncated to fit 16 KB.' : ''
			});
			return { content: [{ type: 'text' as const, text: fitted.json }], isError: answer.isError };
		} catch (error) {
			// A refusal the database raised (no such record, a rule the catalog
			// does not allow) is something the agent can act on.
			const refusal = toAppError(error);
			await logCall(deps.db, token, {
				method: 'tools/call',
				tool: tool.name,
				ms: since(),
				outcome: 'failed',
				note: refusal ? refusal.message : 'The tool raised.'
			});
			if (refusal) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: refusal.message }) }],
					isError: true
				};
			}
			// Anything else is a fault in this app, and the agent gets a sentence
			// rather than a stack trace.
			throw new McpError(ErrorCode.InternalError, `${tool.name} did not finish. Nothing was written.`);
		}
	});

	return server;
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

export async function handleMcpPost(request: Request, deps: McpDeps): Promise<Response> {
	// 1. Who is calling. Nothing else is read until this passes.
	const auth = await authenticate(deps.db, request.headers.get('authorization'));
	if (!auth.ok) {
		return rpcError(401, -32000, auth.message, { 'www-authenticate': 'Bearer realm="northline"' });
	}
	const token = auth.token;

	// 2. The body, ours to parse so the checks below can look at it.
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return rpcError(400, -32700, 'Parse error: the body of this request is not JSON.');
	}

	const calls = callsIn(body);

	// 3. A tools/call that names no tool. The SDK would report this as an
	//    internal error with a zod dump in it; -32602 with a sentence is what
	//    a client can actually act on.
	if (calls.some((call) => call.toolMissing)) {
		return rpcError(
			400,
			-32602,
			'A tools/call names the tool in params.name. Call tools/list to see the names.'
		);
	}

	// 4. Scopes, before any tool is touched.
	for (const call of calls) {
		if (call.tool === null) continue;
		const tool = findMcpTool(call.tool);
		if (!tool || token.scopes.includes(tool.scope)) continue;
		await logCall(deps.db, token, {
			method: call.method,
			tool: tool.name,
			ms: 0,
			outcome: 'refused',
			note: `Needs the ${tool.scope} scope.`
		});
		return rpcError(
			403,
			-32000,
			`This token has the ${token.scopes.join(' and ')} scope, and ${tool.name} needs "${tool.scope}". Mint a token with that scope at /settings/mcp.`
		);
	}

	// 5. The day's cap: one claim per tool call, before the tool runs.
	const toolCalls = calls.filter((call) => call.method === 'tools/call');
	for (const call of toolCalls) {
		try {
			await claimCall(deps.db, token, deps.limits.perTokenPerDay);
		} catch (error) {
			const refusal = toAppError(error);
			if (refusal instanceof AppError && refusal.status === 429) {
				await logCall(deps.db, token, {
					method: call.method,
					tool: call.tool ?? '',
					ms: 0,
					outcome: 'capped',
					note: refusal.message
				});
				return rpcError(429, -32000, refusal.message, { 'retry-after': '3600' });
			}
			throw error;
		}
	}

	// 6. The protocol. Today's date is read at most once, and only if a tool
	//    is going to want it.
	let todayValue: string | null = null;
	const today = async () => {
		todayValue ??= await readToday(deps.db, token.userId);
		return todayValue;
	};

	const server = buildServer(deps, token, today);
	const transport = new WebStandardStreamableHTTPServerTransport({
		// Stateless: no session id, nothing held between requests.
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);

	const started = Date.now();
	try {
		const response = await transport.handleRequest(withProtocolHeaders(request), { parsedBody: body });

		// tools/call logs itself, with its tool and its rows. Everything else
		// gets one row here, so the log has every call in it.
		for (const call of calls) {
			if (call.method === 'tools/call') continue;
			await logCall(deps.db, token, {
				method: call.method,
				ms: Date.now() - started,
				outcome: response.ok ? 'ok' : 'refused',
				note: response.ok ? '' : `HTTP ${response.status}`
			});
		}
		return response;
	} finally {
		await server.close();
	}
}
