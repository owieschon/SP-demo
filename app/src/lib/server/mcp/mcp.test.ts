// The MCP server against a real database: the protocol, the token, the one
// dial, the caps, and what each rung of that dial does and does not allow.
//
// One small world for the whole file, "today" pinned to 2026-09-17. The
// fixtures are a customer, a part and a commitment whose window closed with
// nothing delivered, which is the thing a propose_* tool has something to say
// about.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, readMcpLimits, type McpLimits } from './caps.ts';
import { handleMcpPost, mcpGetResponse, mcpMetadata, SERVER_NAME } from './server.ts';
import {
	hashToken,
	mintToken,
	newToken,
	readBearer,
	revokeToken,
	setTokenLevel,
	TOKEN_PREFIX
} from './tokens.ts';
import { findMcpTool, mcpToolNames, MCP_TOOL_ROSTER, toolsForLevel } from './tools.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';

const TODAY = '2026-09-17';
const ADMIN = 1; // Elena Brooks
const DANA = 2; // owns the fixtures
const SAM = 3; // a second person, given a low ceiling on purpose
const CUSTOMER = 'MC-HQ';
const ITEM = 'MC-100';

/** A cap high enough that no test hits it by accident. */
const BIG: McpLimits = { perTokenPerDay: 100000 };

let db: Db;
/** A commitment whose window closed with nothing delivered. */
let closedShort: number;
/** At suggest, which is where every token starts and stays unless raised. */
let suggesting = '';
/** A second suggest-level token, for the tests that need two. */
let alsoSuggesting = '';
/** Raised to auto_review: it acts, and there is a window to undo it. */
let acting = '';
/** Raised to auto: it acts outright. */
let acted = '';
/** Raised to auto, but acting as somebody with a ceiling below the fixtures. */
let capped_by_ceiling = '';
let revoked = '';
let capped = '';

/** The token ids, for the tests that raise and lower a level. */
let actingId = 0;
let suggestingId = 0;

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

	/*
	  Dana may let an agent act for her. This is the ONE thing that has to be
	  true before any token of hers can change anything, whatever its level:
	  the authority is the roles model's own, granted with the same call that
	  raises a person's approval ceiling, and it is left with no ceiling here
	  so the ceiling test below can set one deliberately.
	*/
	await db.asUser(ADMIN, (tx) => tx.sql`
		select nl.grant_authority(${DANA}, 'approve_agent_proposal', null, null, null,
		                          'May let an agent act for her.', 'mcp-test-grant-dana', 'ui')`);

	// The tokens every test below uses. Minting is an admin's job, and every
	// one of them is minted at suggest, because that is the only level
	// nl.mint_mcp_token can produce.
	const first = await mintToken(db, ADMIN, {
		label: 'Suggesting',
		actsAs: DANA,
		requestId: 'mcp-test-mint-suggest'
	});
	suggesting = first.secret;
	suggestingId = first.tokenId;

	alsoSuggesting = (
		await mintToken(db, ADMIN, {
			label: 'Also suggesting',
			actsAs: DANA,
			requestId: 'mcp-test-mint-suggest-2'
		})
	).secret;

	const second = await mintToken(db, ADMIN, {
		label: 'Acting with a window',
		actsAs: DANA,
		requestId: 'mcp-test-mint-acting'
	});
	acting = second.secret;
	actingId = second.tokenId;
	await setTokenLevel(db, ADMIN, {
		tokenId: second.tokenId,
		level: 'auto_review',
		note: 'For the tests that need a token that acts.',
		requestId: 'mcp-test-raise-acting'
	});

	const third = await mintToken(db, ADMIN, {
		label: 'Acting outright',
		actsAs: DANA,
		requestId: 'mcp-test-mint-acted'
	});
	acted = third.secret;
	await setTokenLevel(db, ADMIN, {
		tokenId: third.tokenId,
		level: 'auto',
		note: 'For the tests that need a token with no queue step.',
		requestId: 'mcp-test-raise-acted'
	});

	/*
	  A token at the top rung, acting as somebody whose ceiling is below the
	  fixture commitment's 50,000. It exists to prove that the rung is not what
	  bounds a change: the person's ceiling is.
	*/
	const fourth = await mintToken(db, ADMIN, {
		label: 'Acting over a ceiling',
		actsAs: SAM,
		requestId: 'mcp-test-mint-ceiling'
	});
	capped_by_ceiling = fourth.secret;
	await setTokenLevel(db, ADMIN, {
		tokenId: fourth.tokenId,
		level: 'auto',
		note: 'Top rung, low ceiling.',
		requestId: 'mcp-test-raise-ceiling'
	});
	await db.asUser(ADMIN, (tx) => tx.sql`
		select nl.grant_authority(${SAM}, 'approve_agent_proposal', 1000, null, null,
		                          'May let an agent act for him, up to 1000.',
		                          'mcp-test-grant-sam', 'ui')`);

	capped = (
		await mintToken(db, ADMIN, {
			label: 'Tiny daily cap',
			actsAs: DANA,
			requestId: 'mcp-test-mint-capped'
		})
	).secret;

	const doomed = await mintToken(db, ADMIN, {
		label: 'Revoked already',
		actsAs: DANA,
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
			{ token: suggesting }
		);

		expect(answer.status).toBe(200);
		expect(answer.json.result.serverInfo.name).toBe(SERVER_NAME);
		expect(answer.json.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(answer.json.result.capabilities.tools).toBeTruthy();
		// The instructions say what the server will and will not do.
		expect(answer.json.result.instructions).toContain('propose');
	});

	it('answers ping', async () => {
		const answer = await post(rpc('ping'), { token: suggesting });
		expect(answer.status).toBe(200);
		expect(answer.json.result).toEqual({});
	});

	it('lists every tool with a description and a JSON Schema', async () => {
		const answer = await post(rpc('tools/list'), { token: suggesting });
		expect(answer.status).toBe(200);

		const tools = answer.json.result.tools as {
			name: string;
			description: string;
			inputSchema: { type?: string; properties?: Record<string, unknown> };
		}[];
		// The list is this token's rung, not the whole roster: a suggest-level
		// token sees the reads and the propose_ tools and nothing else.
		expect(tools.length).toBe(toolsForLevel('suggest').length);
		expect(tools.map((tool) => tool.name).sort()).toEqual(
			toolsForLevel('suggest')
				.map((tool) => tool.name)
				.sort()
		);
		// Every name on the list is one this server can answer to.
		for (const tool of tools) expect(mcpToolNames()).toContain(tool.name);

		for (const tool of tools) {
			expect(tool.description.length, `${tool.name} has no real description`).toBeGreaterThan(40);
			expect(tool.inputSchema.type, `${tool.name} has no object schema`).toBe('object');
			expect(typeof tool.inputSchema.properties, `${tool.name} has no properties`).toBe('object');
		}
	});

	it('does not list a tool that writes to a token at suggest, under any name', async () => {
		const answer = await post(rpc('tools/list'), { token: suggesting });
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
		const answer = await post(rpc('tools/kaboom'), { token: suggesting });
		expect(answer.json.error.code).toBe(-32601);
	});

	it('answers a malformed request with a JSON-RPC error, not a stack trace', async () => {
		const broken = await post('{ this is not json', { token: suggesting });
		expect(broken.status).toBe(400);
		expect(broken.json.jsonrpc).toBe('2.0');
		expect(broken.json.error.code).toBe(-32700);
		expect(broken.text).not.toMatch(/\n\s+at /);

		// Valid JSON that is not a JSON-RPC message.
		const notRpc = await post({ hello: 'there' }, { token: suggesting });
		expect(notRpc.json.error.code).toBe(-32700);
		expect(notRpc.text).not.toMatch(/\n\s+at /);

		// A tools/call with no tool named.
		const noName = await post(rpc('tools/call', { arguments: {} }), { token: suggesting });
		expect(noName.json.error.code).toBe(-32602);
		expect(noName.text).not.toMatch(/\n\s+at /);
	});

	it('works from a client that only accepts JSON, and from one that sends no Accept at all', async () => {
		const jsonOnly = await post(rpc('tools/list'), { token: suggesting, accept: 'application/json' });
		expect(jsonOnly.status).toBe(200);
		expect(jsonOnly.json.result.tools.length).toBeGreaterThan(0);

		const none = await post(rpc('tools/list'), { token: suggesting });
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
		const answer = await callTool(suggesting, 'get_account', { customer_no: CUSTOMER });
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
		const secret = suggesting;
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

describe('the one dial', () => {
	/*
	  The claim this whole migration rests on: a token at suggest proposes and
	  writes nothing, and the SAME token raised to act writes. Not two tokens,
	  not two code paths. One dial.
	*/
	it('proposes and writes nothing at suggest, and writes once raised to act', async () => {
		const before = await businessCounts();

		// At suggest, the tool does not exist under its own name.
		const refused = await callTool(alsoSuggesting, 'set_confidence', {
			commitment_id: closedShort,
			confidence: 40,
			summary: 'Delivery slipped, so the confidence should come down.'
		});
		expect(refused.json.error.code).toBe(-32602);
		expect(refused.json.error.message).toContain('propose_set_confidence');

		// The propose_ form does exist, and writes a proposal and nothing else.
		const proposed = await callTool(alsoSuggesting, 'propose_set_confidence', {
			commitment_id: closedShort,
			confidence: 40,
			summary: 'Delivery slipped, so the confidence should come down.'
		});
		expect(toolResult(proposed).payload.proposed).toBe(true);
		const afterPropose = await businessCounts();
		// A proposal and its conversation, and nothing in the business tables.
		expect(afterPropose.commitments).toBe(before.commitments);
		expect(afterPropose.outcomes).toBe(before.outcomes);
		expect(afterPropose.activities).toBe(before.activities);
		expect(afterPropose.proposals).toBe(before.proposals + 1);

		// Raise that same token, through the same write that raises a person's
		// approval ceiling, and the tool appears under its own name and acts.
		await setTokenLevel(db, ADMIN, {
			tokenId: suggestingId,
			level: 'auto',
			note: 'Trusted with confidence changes.',
			requestId: 'mcp-test-raise-the-same-token'
		});

		const acted_now = await callTool(suggesting, 'set_confidence', {
			commitment_id: closedShort,
			confidence: 35,
			summary: 'Delivery slipped again.'
		});
		const { isError, payload } = toolResult(acted_now);
		expect(isError, acted_now.text.slice(0, 400)).toBe(false);
		expect(payload.acted).toBe(true);
		expect(payload.level).toBe('auto');

		const [after] = await db.asSystem(
			(tx) => tx.sql<{ confidence: number }>`
				select confidence from nl.commitments where id = ${closedShort}`
		);
		expect(after.confidence).toBe(35);

		// Put it back, so the rest of the file sees a suggest-level token.
		await setTokenLevel(db, ADMIN, {
			tokenId: suggestingId,
			level: 'suggest',
			note: 'Back to proposing.',
			requestId: 'mcp-test-lower-the-same-token'
		});
		const listed = await post(rpc('tools/list'), { token: suggesting });
		const names = (listed.json.result.tools as { name: string }[]).map((t) => t.name);
		expect(names).not.toContain('set_confidence');
		expect(names).toContain('propose_set_confidence');
	});

	it('audits the write it made under the person the token acts as', async () => {
		/*
		  Every row the change wrote belongs to Dana, because the token acts as
		  her. What says a human did not choose it is nl.agent_actions: the
		  rung it acted at, her id as the actor, and the token's label in the
		  detail.
		*/
		const [action] = await db.asSystem(
			(tx) => tx.sql<{
				agent: string;
				work_kind: string;
				at_level: string;
				acted_by: number;
				action: string;
				undo_until: Date | null;
				detail: Record<string, unknown>;
			}>`
				select agent, work_kind, at_level, acted_by, action, undo_until, detail
				from nl.agent_actions
				where agent = 'mcp' and action = 'set_confidence'
				order by id desc limit 1`
		);
		expect(action).toBeTruthy();
		expect(action.agent).toBe('mcp');
		expect(action.work_kind).toBe('act');
		expect(action.at_level).toBe('auto');
		// Her id, not the admin's and not the token principal's.
		expect(action.acted_by).toBe(DANA);
		// At 'auto' there is no window: it went out at once.
		expect(action.undo_until).toBeNull();
		expect(action.detail.token_label).toBe('Suggesting');

		// And the audit log names her as the actor for the same change.
		const [audit] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.audit_log
				where action = 'agent_acted' and actor_id = ${DANA}`
		);
		expect(audit.n).toBeGreaterThan(0);
	});

	it('tells an agent the truth about what it can do right now', async () => {
		// The same server, the same tool, two rungs, two answers.
		const atSuggest = (
			(await post(rpc('tools/list'), { token: alsoSuggesting })).json.result.tools as { name: string }[]
		).map((t) => t.name);
		const atAct = (
			(await post(rpc('tools/list'), { token: acted })).json.result.tools as { name: string }[]
		).map((t) => t.name);

		expect(atSuggest).toContain('propose_record_outcome');
		expect(atSuggest).not.toContain('record_outcome');

		expect(atAct).toContain('record_outcome');
		expect(atAct).not.toContain('propose_record_outcome');

		// The additive pair was withheld at every level before there was a
		// dial. It is offered at the acting rungs and not at suggest.
		expect(atSuggest).not.toContain('add_note');
		expect(atSuggest).not.toContain('add_next_step');
		expect(atAct).toContain('add_note');
		expect(atAct).toContain('add_next_step');

		// The reads are the same at both.
		for (const read of ['search_accounts', 'get_account', 'run_sql', 'list_pending_approvals']) {
			expect(atSuggest).toContain(read);
			expect(atAct).toContain(read);
		}
	});

	it("refuses a request above the person's ceiling, and names the ceiling", async () => {
		const before = await businessCounts();
		const [was] = await db.asSystem(
			(tx) => tx.sql<{ confidence: number }>`
				select confidence from nl.commitments where id = ${closedShort}`
		);

		/*
		  This token is at the TOP rung. What refuses it is not its level: it is
		  that the person it acts as may let an agent act for them only up to
		  1,000, and the commitment is worth 50,000.
		*/
		const answer = await callTool(capped_by_ceiling, 'set_confidence', {
			commitment_id: closedShort,
			confidence: 90,
			summary: 'Trying to move a commitment worth more than the ceiling.'
		});

		const { isError, payload } = toolResult(answer);
		expect(isError).toBe(true);
		// The number is in the message, because "refused" on its own is not
		// something anybody can act on.
		expect(payload.error).toContain('1,000');
		expect(payload.error).toContain('50,000');
		// And it was NOT quietly downgraded to a proposal.
		expect(payload.error).not.toContain('proposal at /ask');
		expect(await businessCounts()).toEqual(before);

		const [now] = await db.asSystem(
			(tx) => tx.sql<{ confidence: number }>`
				select confidence from nl.commitments where id = ${closedShort}`
		);
		expect(now.confidence).toBe(was.confidence);
	});

	it('refuses a paused agent at every level', async () => {
		await db.asUser(ADMIN, (tx) => tx.sql`
			select nl.set_agent_pause('mcp', true, 'Testing the brake.', 'mcp-test-pause-on')`);
		const before = await businessCounts();

		try {
			// At suggest: the proposal is refused too. A queue nobody is working
			// is not a safe place to pile work up while the brake is on.
			const atSuggest = await callTool(alsoSuggesting, 'propose_record_outcome', {
				commitment_id: closedShort,
				outcome: 'pushed',
				summary: 'While the brake is on.'
			});
			expect(toolResult(atSuggest).isError).toBe(true);

			// At act with review.
			const atReview = await callTool(acting, 'set_confidence', {
				commitment_id: closedShort,
				confidence: 10,
				summary: 'While the brake is on.'
			});
			const review = toolResult(atReview);
			expect(review.isError).toBe(true);
			expect(review.payload.error).toContain('stopped');

			// At act.
			const atAct = await callTool(acted, 'add_note', {
				customer_no: CUSTOMER,
				body: 'While the brake is on.',
				summary: 'While the brake is on.'
			});
			const act = toolResult(atAct);
			expect(act.isError).toBe(true);
			expect(act.payload.error).toContain('stopped');

			// Reads still answer. A pause stops it acting, not seeing.
			const read = await callTool(acted, 'get_account', { customer_no: CUSTOMER });
			expect(toolResult(read).isError).toBe(false);

			expect(await businessCounts()).toEqual(before);
		} finally {
			// Letting it go is an admin's, which is why this runs as ADMIN.
			await db.asUser(ADMIN, (tx) => tx.sql`
				select nl.set_agent_pause('mcp', false, '', 'mcp-test-pause-off')`);
		}
	});

	it("raises a token's level through the same write as a person's limit", async () => {
		/*
		  Not "a similar write". The same one. nl.set_mcp_token_autonomy calls
		  nl.grant_authority, which is what /people calls to raise somebody's
		  approval ceiling, so the row, the audit entry and the effective
		  dating are all the roles model's.
		*/
		await setTokenLevel(db, ADMIN, {
			tokenId: actingId,
			level: 'auto',
			note: 'Earned it.',
			requestId: 'mcp-test-raise-for-the-audit'
		});

		// The grant is an ordinary row in nl.authority_grants, on the token's
		// own principal, with authority 'agent_autonomy' and level 3.
		const [grant] = await db.asSystem(
			(tx) => tx.sql<{ authority: string; limit_amount: string; kind: string; note: string }>`
				select g.authority, g.limit_amount, u.kind, g.note
				from nl.mcp_tokens t
				join nl.authority_grants g on g.user_id = t.principal_id
				join nl.users u on u.id = t.principal_id
				where t.id = ${actingId}
				  and g.authority = 'agent_autonomy'
				  and g.starts_on <= nl.today()
				  and (g.ends_on is null or g.ends_on >= nl.today())`
		);
		expect(grant.authority).toBe('agent_autonomy');
		expect(Number(grant.limit_amount)).toBe(3);
		// A principal, not a person.
		expect(grant.kind).toBe('agent');
		expect(grant.note).toBe('Earned it.');

		// And the audit row is grant_authority's own, on entity 'user',
		// exactly as it is when a person's ceiling is raised.
		const [audit] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.audit_log
				where action = 'grant_authority'
				  and request_id = 'mcp-test-raise-for-the-audit'
				  and entity = 'user'`
		);
		expect(audit.n).toBe(1);

		// Put it back where the rest of the file expects it.
		await setTokenLevel(db, ADMIN, {
			tokenId: actingId,
			level: 'auto_review',
			note: 'Back to a window.',
			requestId: 'mcp-test-lower-for-the-audit'
		});
	});

	it('has no scopes left to decide anything', async () => {
		// The column is gone, so there is nothing to fall back to.
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from information_schema.columns
				where table_schema = 'nl' and table_name = 'mcp_tokens' and column_name = 'scopes'`
		);
		expect(row.n).toBe(0);
	});

	it("reads the company's cap from the policy engine, and not before one is set", async () => {
		/*
		  agents.approval_threshold is the policy type 0034 wrote for "the value
		  up to which an agent may act without a person". Its built-in default
		  is 0, and a 0 that came from the built-in means unwired rather than
		  zero dollars, so nothing is capped until somebody sets a policy.
		*/
		const [unset] = await db.asUser(DANA, (tx) => tx.sql<{ cap: string | null }>`
			select nl.mcp_policy_cap('set_confidence',
			                         jsonb_build_object('commitment_id', ${closedShort})) as cap`);
		expect(unset.cap).toBeNull();

		// Set one, company wide, below the fixture commitment's 50,000.
		await db.asUser(ADMIN, (tx) => tx.sql`
			select nl.set_policy(null, 'agents.approval_threshold', 'global', '',
			                     '2500'::jsonb, nl.today(), null, 0,
			                     'An agent may act on up to 2,500 without a person.',
			                     null, 'mcp-test-policy-cap')`);

		try {
			const [set] = await db.asUser(DANA, (tx) => tx.sql<{ cap: string }>`
				select nl.mcp_policy_cap('set_confidence',
				                         jsonb_build_object('commitment_id', ${closedShort})) as cap`);
			expect(Number(set.cap)).toBe(2500);

			// Dana has no ceiling of her own, and her token is at the top rung,
			// so the only thing that can refuse this is the policy.
			const answer = await callTool(acted, 'set_confidence', {
				commitment_id: closedShort,
				confidence: 80,
				summary: 'Trying to move a commitment worth more than the company cap.'
			});
			const { isError, payload } = toolResult(answer);
			expect(isError).toBe(true);
			expect(payload.error).toContain('2,500');
			expect(payload.error).toContain('agents.approval_threshold');
		} finally {
			// Back to unset, so the rest of the file is not capped.
			await db.asSystem((tx) => tx.sql`
				delete from nl.policies where policy_type = 'agents.approval_threshold'`);
		}
	});
});

// ---------------------------------------------------------------------------

describe('acting with a window', () => {
	let actionId = 0;

	it('makes the change and leaves it reversible inside the window', async () => {
		const answer = await callTool(acting, 'add_next_step', {
			customer_no: CUSTOMER,
			title: 'Call the buyer about the winter run',
			due_in_days: 3,
			summary: 'The window closed short and nobody has called.'
		});
		const { isError, payload } = toolResult(answer);
		expect(isError, answer.text.slice(0, 400)).toBe(false);
		expect(payload.acted).toBe(true);
		expect(payload.level).toBe('auto_review');
		// A window, which is the whole difference between this rung and 'auto'.
		expect(payload.undo_until).toBeTruthy();
		expect(payload.sampled).toBe(false);
		actionId = payload.action_id;

		// The window came from the ladder, not from this code: it is the
		// undo_window_minutes on nl.agent_autonomy for ('mcp','act_with_review').
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ minutes: number; at_level: string; entity: string }>`
				select a.undo_window_minutes as minutes, x.at_level, x.entity
				from nl.agent_actions x
				join nl.agent_autonomy a on a.agent = x.agent and a.work_kind = x.work_kind
				where x.id = ${actionId}`
		);
		expect(row.at_level).toBe('auto_review');
		expect(row.minutes).toBe(60);
		expect(row.entity).toBe('mcp_change');
	});

	it('lets a person claim the undo while the window is open', async () => {
		const [claim] = await db.asUser(DANA, (tx) => tx.sql<{ result: { action_id: number } }>`
			select nl.claim_agent_undo(${actionId}, 'Not needed after all.',
			                           'mcp-test-undo-claim') as result`);
		expect(Number(claim.result.action_id)).toBe(actionId);
		await db.asUser(DANA, (tx) => tx.sql`
			select nl.finish_agent_undo(${actionId}, true, 'Taken back in the test.', false,
			                            'mcp-test-undo-finish')`);
	});

	it('refuses the undo once the window has closed', async () => {
		const answer = await callTool(acting, 'add_note', {
			customer_no: CUSTOMER,
			body: 'A note whose window will be pushed into the past.',
			summary: 'For the closed-window test.'
		});
		const id = toolResult(answer).payload.action_id as number;

		// Close the window by moving it behind us. The clock is the only thing
		// being faked here; every check the undo makes is the real one.
		await db.asSystem((tx) => tx.sql`
			update nl.agent_actions set undo_until = now() - interval '1 minute' where id = ${id}`);

		await expect(
			db.asUser(DANA, (tx) => tx.sql`
				select nl.claim_agent_undo(${id}, 'Too late.', 'mcp-test-undo-too-late') as result`)
		).rejects.toThrow();
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
			const answer = await callTool(suggesting, 'record_outcome', input);
			expect(answer.json.error.code).toBe(-32602);
			expect(answer.json.error.message).toContain('propose');
		}

		for (const name of ['set_confidence', 'decide_export', 'save_automation_rule', 'propose_action', 'add_note']) {
			const answer = await callTool(suggesting, name, { customer_no: CUSTOMER, body: 'hello' });
			expect(answer.json.error.code).toBe(-32602);
		}

		// Nothing moved, and the commitment is exactly as it was.
		expect(await commitmentVersion(closedShort)).toBe(version);
		expect(await businessCounts()).toEqual(before);
	});

	it('is not in the registry a suggest-level token sees', () => {
		for (const name of ['record_outcome', 'set_confidence', 'decide_export', 'save_automation_rule']) {
			// Not a tool at all at suggest, and a tool at the acting rungs. The
			// lookup takes the level, so there is no second check to forget.
			expect(findMcpTool('suggest', name)).toBeUndefined();
			expect(findMcpTool('suggest', `propose_${name}`)).toBeTruthy();
			expect(findMcpTool('auto_review', name)).toBeTruthy();
			expect(findMcpTool('auto', name)).toBeTruthy();
			// And nothing is offered in both shapes at once.
			expect(findMcpTool('auto', `propose_${name}`)).toBeUndefined();
		}
		// The roster the connect page draws names every shape exactly once.
		const names = MCP_TOOL_ROSTER.map((tool) => `${tool.name}@${tool.fromLevel}`);
		expect(new Set(names).size).toBe(names.length);
	});
});

// ---------------------------------------------------------------------------

describe('proposing a change', () => {
	let proposalId = 0;
	let conversationId = 0;

	it('creates a proposal and writes nothing else', async () => {
		const version = await commitmentVersion(closedShort);
		const before = await businessCounts();

		const answer = await callTool(suggesting, 'propose_record_outcome', {
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
		const answer = await callTool(suggesting, 'list_pending_approvals', {});
		const { payload } = toolResult(answer);

		const mine = payload.rows.find((row: { proposal_id: number }) => row.proposal_id === proposalId);
		expect(mine).toBeTruthy();
		expect(mine.status).toBe('draft');
		expect(mine.came_from).toBe('mcp');
		expect(mine.tools).toBe('record_outcome');
		expect(mine.approve_at).toBe(`/ask/${conversationId}`);
	});

	it('refuses to propose something about a record that is not there', async () => {
		const answer = await callTool(suggesting, 'propose_set_confidence', {
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
		const answer = await callTool(suggesting, 'propose_record_outcome', {
			commitment_id: closedShort,
			outcome: 'maybe',
			summary: 'Not one of the three answers.'
		});
		expect(answer.json.error.code).toBe(-32602);
		expect(answer.json.error.message).toContain('outcome');
	});

	it('refuses a proposal with no reason for a person to read', async () => {
		const answer = await callTool(suggesting, 'propose_record_outcome', {
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
		return toolResult(await callTool(suggesting, 'run_sql', { sql: query, why: 'a test' }));
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
		const answer = await callTool(suggesting, 'run_sql', {
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
		expect(rows.filter((row) => row.action === 'mint_mcp_token').length).toBe(7);
		expect(rows.filter((row) => row.action === 'revoke_mcp_token').length).toBe(1);
		for (const row of rows) {
			expect(row.via).toBe('ui');
			expect(row.actor_id).toBe(ADMIN);
		}
	});
});
