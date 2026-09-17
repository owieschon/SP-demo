// The MCP server against a real database: the protocol, the token, the
// scopes, the caps, and the promise that an outside agent cannot write.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The
// fixtures are a customer, a part and a commitment whose window closed with
// nothing delivered, which is the thing a propose_* tool has something to say
// about.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, readMcpLimits, type McpLimits } from './caps.ts';
import { handleMcpPost, mcpGetResponse, mcpMetadata, SERVER_NAME } from './server.ts';
import { hashToken, mintToken, newToken, readBearer, revokeToken, TOKEN_PREFIX } from './tokens.ts';
import { findMcpTool, mcpToolNames, MCP_TOOLS } from './tools.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';

const TODAY = '2026-09-17';
const ADMIN = 1; // Elena Brooks
const DANA = 2; // owns the fixtures
const CUSTOMER = 'MC-HQ';
const ITEM = 'MC-100';

/** A cap high enough that no test hits it by accident. */
const BIG: McpLimits = { perTokenPerDay: 100000 };

let db: Db;
/** A commitment whose window closed with nothing delivered. */
let closedShort: number;
let readWrite = '';
let readOnly = '';
let revoked = '';
let capped = '';

let nextId = 1;

interface Answer {
	status: number;
	text: string;
	// A JSON-RPC envelope. Shaped loosely on purpose: these tests read it the
	// way an outside client would, not through our own types.
	json: any;
}

async function post(
	body: unknown,
	options: { token?: string; limits?: McpLimits; accept?: string } = {}
): Promise<Answer> {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (options.accept !== undefined) headers.set('accept', options.accept);
	if (options.token) headers.set('authorization', `Bearer ${options.token}`);
	const request = new Request('http://localhost:5180/api/mcp', {
		method: 'POST',
		headers,
		body: typeof body === 'string' ? body : JSON.stringify(body)
	});
	const response = await handleMcpPost(request, { db, limits: options.limits ?? BIG });
	const text = await response.text();
	let json: unknown = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { status: response.status, text, json };
}

function rpc(method: string, params?: Record<string, unknown>) {
	return { jsonrpc: '2.0', id: nextId++, method, ...(params ? { params } : {}) };
}

async function callTool(
	token: string,
	name: string,
	args: Record<string, unknown> = {},
	limits?: McpLimits
): Promise<Answer> {
	return post(rpc('tools/call', { name, arguments: args }), { token, limits });
}

/** The JSON a tool answered with, and whether it was a refusal. */
function toolResult(answer: Answer): { isError: boolean; payload: any } {
	const result = answer.json?.result;
	expect(result, `no tool result in ${answer.text.slice(0, 400)}`).toBeTruthy();
	return { isError: result.isError === true, payload: JSON.parse(result.content[0].text) };
}

/** Counts of the tables a write would land in, for a before and after. */
async function businessCounts(): Promise<Record<string, number>> {
	const [row] = await db.asSystem(
		(tx) => tx.sql<Record<string, number>>`
			select (select count(*) from nl.commitments)::int as commitments,
			       (select count(*) from nl.commitment_outcomes)::int as outcomes,
			       (select count(*) from nl.activities)::int as activities,
			       (select count(*) from nl.next_steps)::int as next_steps,
			       (select count(*) from nl.quotes)::int as quotes,
			       (select count(*) from nl.automation_rules)::int as rules,
			       (select count(*) from nl.export_snapshots)::int as snapshots,
			       (select count(*) from nl.open_order_lines)::int as open_lines,
			       (select count(*) from nl.assistant_proposals)::int as proposals,
			       (select count(*) from nl.assistant_conversations)::int as conversations`
	);
	return row;
}

async function commitmentVersion(id: number): Promise<string> {
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ at: Date }>`select updated_at as at from nl.commitments where id = ${id}`
	);
	return row.at.toISOString();
}

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });
	await db.asSystem(async (tx) => {
		await tx.sql`insert into nl.items (item_no, description, category, family, product_group,
		                                   unit_cost, list_price, replenishment)
		             values (${ITEM}, 'CHROME STACK 5 INCH', 'STACKS', 'stack', 'STACKS', 12, 48, 'Prod. Order')`;
		await tx.sql`insert into nl.stock (item_no, on_hand, on_production_order, on_purchase_order, as_of)
		             values (${ITEM}, 30, 0, 0, ${TODAY})`;
		await tx.sql`insert into nl.customers (customer_no, name, price_group, owner_id, customer_since, city, state)
		             values (${CUSTOMER}, 'Mesa Crossing Diesel', 'DEALER', ${DANA}, '2020-03-11', 'Odessa', 'TX')`;
		const [row] = await tx.sql<{ id: number }>`
			insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on,
			                            confidence, created_by)
			values ('Chrome stacks for the winter run', ${CUSTOMER}, ${DANA}, 50000,
			        '2025-10-01', '2025-12-31', 60, ${DANA})
			returning id`;
		closedShort = row.id;
		await tx.sql`insert into nl.commitment_items (commitment_id, item_no, quantity)
		             values (${closedShort}, ${ITEM}, 400)`;
	});

	// The tokens every test below uses. Minting is an admin's job.
	readWrite = (
		await mintToken(db, ADMIN, {
			label: 'Read and propose',
			actsAs: DANA,
			scopes: ['read', 'propose'],
			requestId: 'mcp-test-mint-both'
		})
	).secret;
	readOnly = (
		await mintToken(db, ADMIN, {
			label: 'Read only',
			actsAs: DANA,
			scopes: ['read'],
			requestId: 'mcp-test-mint-read'
		})
	).secret;
	capped = (
		await mintToken(db, ADMIN, {
			label: 'Tiny daily cap',
			actsAs: DANA,
			scopes: ['read'],
			requestId: 'mcp-test-mint-capped'
		})
	).secret;

	const doomed = await mintToken(db, ADMIN, {
		label: 'Revoked already',
		actsAs: DANA,
		scopes: ['read', 'propose'],
		requestId: 'mcp-test-mint-revoked'
	});
	revoked = doomed.secret;
	await revokeToken(db, ADMIN, { tokenId: doomed.tokenId, requestId: 'mcp-test-revoke' });
}, 120000);

afterAll(async () => {
	await db?.close();
});

// ---------------------------------------------------------------------------

describe('the protocol', () => {
	it('answers initialize with its name and its tools capability', async () => {
		const answer = await post(
			rpc('initialize', {
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'vitest', version: '1' }
			}),
			{ token: readWrite }
		);

		expect(answer.status).toBe(200);
		expect(answer.json.result.serverInfo.name).toBe(SERVER_NAME);
		expect(answer.json.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(answer.json.result.capabilities.tools).toBeTruthy();
		// The instructions say what the server will and will not do.
		expect(answer.json.result.instructions).toContain('propose');
	});

	it('answers ping', async () => {
		const answer = await post(rpc('ping'), { token: readWrite });
		expect(answer.status).toBe(200);
		expect(answer.json.result).toEqual({});
	});

	it('lists every tool with a description and a JSON Schema', async () => {
		const answer = await post(rpc('tools/list'), { token: readWrite });
		expect(answer.status).toBe(200);

		const tools = answer.json.result.tools as {
			name: string;
			description: string;
			inputSchema: { type?: string; properties?: Record<string, unknown> };
		}[];
		expect(tools.length).toBe(MCP_TOOLS.length);
		expect(tools.map((tool) => tool.name).sort()).toEqual([...mcpToolNames()].sort());

		for (const tool of tools) {
			expect(tool.description.length, `${tool.name} has no real description`).toBeGreaterThan(40);
			expect(tool.inputSchema.type, `${tool.name} has no object schema`).toBe('object');
			expect(typeof tool.inputSchema.properties, `${tool.name} has no properties`).toBe('object');
		}
	});

	it('does not list a tool that writes, under any name', async () => {
		const answer = await post(rpc('tools/list'), { token: readWrite });
		const names = (answer.json.result.tools as { name: string }[]).map((tool) => tool.name);

		// The gated tools, the additive ones and the assistant's own plumbing.
		for (const hidden of [
			'record_outcome',
			'set_confidence',
			'decide_export',
			'save_automation_rule',
			'add_note',
			'add_next_step',
			'propose_action'
		]) {
			expect(names).not.toContain(hidden);
		}
		// Every propose_ tool names a gated tool it would ask about.
		expect(names).toContain('propose_record_outcome');
		expect(names).toContain('propose_set_confidence');
	});

	it('answers an unknown method with -32601', async () => {
		const answer = await post(rpc('tools/kaboom'), { token: readWrite });
		expect(answer.json.error.code).toBe(-32601);
	});

	it('answers a malformed request with a JSON-RPC error, not a stack trace', async () => {
		const broken = await post('{ this is not json', { token: readWrite });
		expect(broken.status).toBe(400);
		expect(broken.json.jsonrpc).toBe('2.0');
		expect(broken.json.error.code).toBe(-32700);
		expect(broken.text).not.toMatch(/\n\s+at /);

		// Valid JSON that is not a JSON-RPC message.
		const notRpc = await post({ hello: 'there' }, { token: readWrite });
		expect(notRpc.json.error.code).toBe(-32700);
		expect(notRpc.text).not.toMatch(/\n\s+at /);

		// A tools/call with no tool named.
		const noName = await post(rpc('tools/call', { arguments: {} }), { token: readWrite });
		expect(noName.json.error.code).toBe(-32602);
		expect(noName.text).not.toMatch(/\n\s+at /);
	});

	it('works from a client that only accepts JSON, and from one that sends no Accept at all', async () => {
		const jsonOnly = await post(rpc('tools/list'), { token: readWrite, accept: 'application/json' });
		expect(jsonOnly.status).toBe(200);
		expect(jsonOnly.json.result.tools.length).toBeGreaterThan(0);

		const none = await post(rpc('tools/list'), { token: readWrite });
		expect(none.status).toBe(200);
	});

	it('tells a GET what this endpoint is and how to connect', async () => {
		const response = mcpGetResponse('https://example.invalid/api/mcp');
		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');

		const metadata = mcpMetadata('https://example.invalid/api/mcp');
		expect(metadata.connect).toContain('claude mcp add --transport http');
		expect(metadata.methods).toContain('tools/call');
	});
});

// ---------------------------------------------------------------------------

describe('the token', () => {
	it('lets a valid one read', async () => {
		const answer = await callTool(readWrite, 'get_account', { customer_no: CUSTOMER });
		expect(answer.status).toBe(200);

		const { isError, payload } = toolResult(answer);
		expect(isError).toBe(false);
		expect(payload.account.customer_no).toBe(CUSTOMER);
		expect(payload.account.name).toBe('Mesa Crossing Diesel');
	});

	it('refuses a request with no token', async () => {
		const answer = await post(rpc('tools/list'));
		expect(answer.status).toBe(401);
		expect(answer.json.error.message).toContain('Authorization: Bearer');
		expect(answer.json.jsonrpc).toBe('2.0');
	});

	it('refuses a token that was never minted, and a revoked one, with the same words', async () => {
		const madeUp = await post(rpc('tools/list'), { token: `${TOKEN_PREFIX}notarealtokenatall` });
		const dead = await post(rpc('tools/list'), { token: revoked });

		expect(madeUp.status).toBe(401);
		expect(dead.status).toBe(401);
		// A revoked token must not be distinguishable from one that never was.
		expect(dead.json.error.message).toBe(madeUp.json.error.message);
	});

	it('still records that a revoked token was tried', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ last_used_at: Date | null }>`
				select last_used_at from nl.mcp_tokens where label = 'Revoked already'`
		);
		expect(row.last_used_at).not.toBeNull();
	});

	it('only reads a bearer header', () => {
		expect(readBearer('Bearer abc')).toBe('abc');
		expect(readBearer('bearer abc')).toBe('abc');
		expect(readBearer('Basic abc')).toBeNull();
		expect(readBearer('abc')).toBeNull();
		expect(readBearer(null)).toBeNull();
	});

	it('never stores the token in plain text', async () => {
		const secret = readWrite;
		expect(secret.startsWith(TOKEN_PREFIX)).toBe(true);

		// Every column of the table, as text, compared with the secret itself.
		const rows = await db.asSystem(
			(tx) => tx.sql<{ dump: string; token_sha256: string }>`
				select t::text as dump, t.token_sha256 from nl.mcp_tokens t`
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.dump).not.toContain(secret);
			// The random part on its own, in case a prefix was stripped somewhere.
			expect(row.dump).not.toContain(secret.slice(TOKEN_PREFIX.length));
			expect(row.token_sha256).toMatch(/^[0-9a-f]{64}$/);
		}
		// The hash is the hash of the secret, and nothing else.
		const [mine] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.mcp_tokens where token_sha256 = ${hashToken(secret)}`
		);
		expect(mine.n).toBe(1);

		// Nor does the request log or the audit trail carry it.
		const [leaks] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select (select count(*) from nl.audit_log where detail::text like ${'%' + secret + '%'})::int
				     + (select count(*) from nl.request_log where coalesce(result::text, '') like ${'%' + secret + '%'})::int
				     as n`
		);
		expect(leaks.n).toBe(0);
	});

	it('mints a secret that is 32 random bytes with our prefix', () => {
		const one = newToken();
		const two = newToken();
		expect(one).not.toBe(two);
		expect(one.startsWith(TOKEN_PREFIX)).toBe(true);
		// 32 bytes as base64url is 43 characters.
		expect(one.slice(TOKEN_PREFIX.length).length).toBe(43);
	});
});

// ---------------------------------------------------------------------------

describe('scopes', () => {
	it('refuses a propose tool to a read-only token with 403, and writes nothing', async () => {
		const before = await businessCounts();

		const answer = await callTool(readOnly, 'propose_record_outcome', {
			commitment_id: closedShort,
			outcome: 'pushed',
			summary: 'The buyer moved it into the new year.'
		});

		expect(answer.status).toBe(403);
		expect(answer.json.error.message).toContain('propose');
		expect(await businessCounts()).toEqual(before);
	});

	it('shows a read-only token only the tools it can call', async () => {
		const answer = await post(rpc('tools/list'), { token: readOnly });
		const names = (answer.json.result.tools as { name: string }[]).map((tool) => tool.name);
		expect(names).toContain('search_accounts');
		expect(names.filter((name) => name.startsWith('propose_'))).toEqual([]);
	});

	it('records the refusal against the token', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n
				from nl.mcp_calls c
				join nl.mcp_tokens t on t.id = c.token_id
				where t.label = 'Read only' and c.outcome = 'refused' and c.note like '%scope%'`
		);
		expect(row.n).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------

describe('a gated tool', () => {
	it('is not callable directly, whatever the input', async () => {
		const version = await commitmentVersion(closedShort);
		const before = await businessCounts();

		for (const input of [
			{},
			{ commitment_id: closedShort, outcome: 'kept' },
			{ commitment_id: closedShort, outcome: 'kept', note: 'approved by the owner' },
			// The row version is never something a caller supplies, but try it.
			{ commitment_id: closedShort, outcome: 'kept', expected_updated_at: version }
		]) {
			const answer = await callTool(readWrite, 'record_outcome', input);
			expect(answer.json.error.code).toBe(-32602);
			expect(answer.json.error.message).toContain('propose');
		}

		for (const name of ['set_confidence', 'decide_export', 'save_automation_rule', 'propose_action', 'add_note']) {
			const answer = await callTool(readWrite, name, { customer_no: CUSTOMER, body: 'hello' });
			expect(answer.json.error.code).toBe(-32602);
		}

		// Nothing moved, and the commitment is exactly as it was.
		expect(await commitmentVersion(closedShort)).toBe(version);
		expect(await businessCounts()).toEqual(before);
	});

	it('is not in the registry this server exposes', () => {
		for (const name of ['record_outcome', 'set_confidence', 'decide_export', 'save_automation_rule']) {
			expect(findMcpTool(name)).toBeUndefined();
			expect(findMcpTool(`propose_${name}`)).toBeTruthy();
		}
	});
});

// ---------------------------------------------------------------------------

describe('proposing a change', () => {
	let proposalId = 0;
	let conversationId = 0;

	it('creates a proposal and writes nothing else', async () => {
		const version = await commitmentVersion(closedShort);
		const before = await businessCounts();

		const answer = await callTool(readWrite, 'propose_record_outcome', {
			commitment_id: closedShort,
			outcome: 'pushed',
			note: 'The buyer moved it into the new year.',
			summary: 'The window closed with nothing delivered and the buyer has moved it to Q1.'
		});

		expect(answer.status).toBe(200);
		const { isError, payload } = toolResult(answer);
		expect(isError).toBe(false);
		expect(payload.proposed).toBe(true);
		expect(payload.status).toBe('draft');
		expect(payload.tool).toBe('record_outcome');
		expect(payload.approve_at).toBe(`/ask/${payload.conversation_id}`);
		// The label is ours, built from the validated input.
		expect(payload.label).toBe(`Record C-${closedShort} as pushed ("The buyer moved it into the new year.")`);
		proposalId = payload.proposal_id;
		conversationId = payload.conversation_id;

		const after = await businessCounts();
		// Exactly one proposal and one conversation. Every business table is
		// untouched, and so is the commitment the proposal is about.
		expect(after.proposals).toBe(before.proposals + 1);
		expect(after.conversations).toBe(before.conversations + 1);
		expect(after.commitments).toBe(before.commitments);
		expect(after.outcomes).toBe(before.outcomes);
		expect(after.activities).toBe(before.activities);
		expect(after.next_steps).toBe(before.next_steps);
		expect(after.quotes).toBe(before.quotes);
		expect(after.rules).toBe(before.rules);
		expect(after.snapshots).toBe(before.snapshots);
		expect(after.open_lines).toBe(before.open_lines);
		expect(await commitmentVersion(closedShort)).toBe(version);
	});

	it('stores it as a draft on an MCP conversation, with the row version it would write against', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{
				status: string;
				mode: string;
				title: string;
				tool: string;
				version: string;
				messages: number;
			}>`
				select p.status, c.mode, c.title,
				       (p.options -> 0 ->> 'tool') as tool,
				       (p.options -> 0 ->> 'version') as version,
				       (select count(*) from nl.assistant_messages m where m.conversation_id = c.id)::int as messages
				from nl.assistant_proposals p
				join nl.assistant_conversations c on c.id = p.conversation_id
				where p.id = ${proposalId}`
		);
		expect(row.status).toBe('draft');
		expect(row.mode).toBe('mcp');
		expect(row.title.startsWith('Via MCP:')).toBe(true);
		expect(row.tool).toBe('record_outcome');
		expect(row.version).toBeTruthy();
		// A question and an answer, so a person reading /ask sees the ask.
		expect(row.messages).toBe(2);
	});

	it('records the tool call as a proposal, never as a gated tool that ran', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ name: string; risk: string; outcome: string }>`
				select name, risk, outcome from nl.assistant_tool_calls
				where conversation_id = ${conversationId}`
		);
		expect(rows).toEqual([{ name: 'propose_action', risk: 'propose', outcome: 'ran' }]);

		// Across the whole database, no gated tool has ever run.
		const [gated] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.assistant_tool_calls
				where risk = 'gated' and outcome = 'ran'`
		);
		expect(gated.n).toBe(0);
	});

	it('shows up in list_pending_approvals with the page to approve it on', async () => {
		const answer = await callTool(readWrite, 'list_pending_approvals', {});
		const { payload } = toolResult(answer);

		const mine = payload.rows.find((row: { proposal_id: number }) => row.proposal_id === proposalId);
		expect(mine).toBeTruthy();
		expect(mine.status).toBe('draft');
		expect(mine.came_from).toBe('mcp');
		expect(mine.tools).toBe('record_outcome');
		expect(mine.approve_at).toBe(`/ask/${conversationId}`);
	});

	it('refuses to propose something about a record that is not there', async () => {
		const answer = await callTool(readWrite, 'propose_set_confidence', {
			commitment_id: 999999,
			confidence: 40,
			summary: 'Two quotes are out and the buyer has gone quiet.'
		});

		const { isError, payload } = toolResult(answer);
		expect(isError).toBe(true);
		expect(payload.proposed).toBe(false);
		expect(payload.error).toContain('does not exist');
	});

	it('refuses an input that does not fit the tool it names', async () => {
		const answer = await callTool(readWrite, 'propose_record_outcome', {
			commitment_id: closedShort,
			outcome: 'maybe',
			summary: 'Not one of the three answers.'
		});
		expect(answer.json.error.code).toBe(-32602);
		expect(answer.json.error.message).toContain('outcome');
	});

	it('refuses a proposal with no reason for a person to read', async () => {
		const answer = await callTool(readWrite, 'propose_record_outcome', {
			commitment_id: closedShort,
			outcome: 'pushed'
		});
		expect(answer.json.error.code).toBe(-32602);
		expect(answer.json.error.message).toContain('summary');
	});
});

// ---------------------------------------------------------------------------

describe('the SQL tool', () => {
	async function sql(query: string) {
		return toolResult(await callTool(readWrite, 'run_sql', { sql: query, why: 'a test' }));
	}

	it('answers a real question', async () => {
		const { isError, payload } = await sql(
			`select count(*)::int as n from nl.customers where customer_no = '${CUSTOMER}'`
		);
		expect(isError).toBe(false);
		expect(payload.rows[0].n).toBe(1);
	});

	it('cannot write, whichever way it is asked', async () => {
		for (const query of [
			`insert into nl.commitments (title) values ('x')`,
			`update nl.commitments set confidence = 100`,
			`delete from nl.commitments`,
			`drop table nl.commitments`,
			`with x as (update nl.commitments set confidence = 1 returning id) select * from x`,
			`select nl.record_outcome(${closedShort}, 'kept', now(), 'abcdefgh', '', 'assistant')`
		]) {
			const { isError, payload } = await sql(query);
			expect(isError, `${query} was not refused`).toBe(true);
			expect(typeof payload.error).toBe('string');
		}
	});

	it('refuses more than one statement', async () => {
		const { isError, payload } = await sql('select 1 as a; select 2 as b');
		expect(isError).toBe(true);
		expect(payload.error).toContain('one statement');
	});

	it('cannot read the tables about people', async () => {
		for (const table of ['nl.users', 'nl.contacts', 'nl.activities', 'nl.assistant_conversations', 'nl.mcp_tokens']) {
			const { isError, payload } = await sql(`select count(*) as n from ${table}`);
			expect(isError, `${table} was readable`).toBe(true);
			expect(payload.error).toContain('refused');
		}
	});

	it('writes nothing while being asked to', async () => {
		const before = await businessCounts();
		await sql(`insert into nl.next_steps (title) values ('x')`);
		await sql(`update nl.commitments set confidence = 100 where id = ${closedShort}`);
		expect(await businessCounts()).toEqual(before);
	});
});

// ---------------------------------------------------------------------------

describe('the caps', () => {
	it('truncates a result over 16 KB and says so', async () => {
		const answer = await callTool(readWrite, 'run_sql', {
			// About 90 KB of rows, which is comfortably over the cap.
			sql: `select i, repeat('x', 200) as pad from generate_series(1, 400) i`,
			why: 'a result too big to send'
		});

		const { payload } = toolResult(answer);
		expect(payload.truncated).toBe(true);
		expect(payload.note).toContain('16 KB');
		expect(payload.rows.length).toBeLessThan(400);
		expect(payload.rows.length).toBeGreaterThan(0);
		// Under the cap, with room for the JSON-RPC envelope around it.
		expect(Buffer.byteLength(answer.json.result.content[0].text, 'utf8')).toBeLessThanOrEqual(16 * 1024);

		const [row] = await db.asSystem(
			(tx) => tx.sql<{ note: string }>`
				select note from nl.mcp_calls where tool = 'run_sql' and note <> '' order by id desc limit 1`
		);
		expect(row.note).toContain('Truncated');
	});

	it('refuses politely when a token has used up the day', async () => {
		const tiny: McpLimits = { perTokenPerDay: 2 };

		const first = await callTool(capped, 'search_accounts', { query: 'Mesa' }, tiny);
		expect(first.status).toBe(200);
		const second = await callTool(capped, 'search_accounts', { query: 'Mesa' }, tiny);
		expect(second.status).toBe(200);

		const third = await callTool(capped, 'search_accounts', { query: 'Mesa' }, tiny);
		expect(third.status).toBe(429);
		expect(third.json.error.message).toContain('daily limit');
		expect(third.json.error.message).toContain('resets tomorrow');

		// tools/list is not a tool call, so it still works.
		const list = await post(rpc('tools/list'), { token: capped, limits: tiny });
		expect(list.status).toBe(200);

		const [row] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.mcp_calls c
				join nl.mcp_tokens t on t.id = c.token_id
				where t.label = 'Tiny daily cap' and c.outcome = 'capped'`
		);
		expect(row.n).toBe(1);
	});

	it('reads the daily cap from the environment, and falls back to the default', () => {
		expect(readMcpLimits({ MCP_DAILY_PER_TOKEN: '40' })).toEqual({ perTokenPerDay: 40 });
		expect(readMcpLimits({})).toEqual(DEFAULT_LIMITS);
		expect(readMcpLimits({ MCP_DAILY_PER_TOKEN: 'lots' })).toEqual(DEFAULT_LIMITS);
		expect(readMcpLimits({ MCP_DAILY_PER_TOKEN: '-3' })).toEqual(DEFAULT_LIMITS);
	});
});

// ---------------------------------------------------------------------------

describe('the log', () => {
	it('has a row for every call, with the tool, the time and how it ended', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ method: string; tool: string; outcome: string; ms: number }>`
				select method, tool, outcome, ms from nl.mcp_calls order by id`
		);
		expect(rows.length).toBeGreaterThan(10);
		expect(rows.some((row) => row.method === 'tools/list' && row.outcome === 'ok')).toBe(true);
		expect(rows.some((row) => row.method === 'initialize')).toBe(true);
		expect(rows.some((row) => row.tool === 'get_account' && row.outcome === 'ok')).toBe(true);
		expect(rows.some((row) => row.tool === 'propose_record_outcome' && row.outcome === 'ok')).toBe(true);
		for (const row of rows) {
			expect(row.ms).toBeGreaterThanOrEqual(0);
		}
	});

	it('records minting and revoking in the audit log', async () => {
		const rows = await db.asSystem(
			(tx) => tx.sql<{ action: string; via: string; actor_id: number }>`
				select action, via, actor_id from nl.audit_log
				where entity = 'mcp_token' order by id`
		);
		expect(rows.filter((row) => row.action === 'mint_mcp_token').length).toBe(4);
		expect(rows.filter((row) => row.action === 'revoke_mcp_token').length).toBe(1);
		for (const row of rows) {
			expect(row.via).toBe('ui');
			expect(row.actor_id).toBe(ADMIN);
		}
	});
});
