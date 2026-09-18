// The output contract: every tool that declares what it answers with must
// actually answer with that, against a real database.
//
// This is the test that makes an output schema worth publishing. Without it,
// a schema is a comment: a query could quietly stop returning a promised
// column and every caller that trusted the schema would break, while the
// type checker and every other test stayed green.
//
// It runs each tool twice where it can: once on input that exists, so the
// success branch is exercised, and once on input that does not, so the
// refusal branch is. Both have to match the declared shape, because a
// refusal is a normal answer here rather than an exception.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../mcp/tools.ts';
import { findTool, TOOLS, type ToolContext } from './tools.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db, Row } from '../db/types.ts';

const TODAY = '2026-09-17';
const DANA = 2; // an account manager, so the reads have a book to read

let db: Db;

/** Something real to ask about, read out of the world rather than assumed. */
let anAccount: string;
let aPart: string;
let aCommitment: number;

beforeAll(async () => {
	db = await createTestDb();

	const [account] = await db.asSystem(
		(tx) => tx.sql<Row>`
			select customer_no, name from nl.account_list
			where revenue_ytd > 0 order by revenue_ytd desc limit 1`
	);
	anAccount = String(account.customer_no);

	const [part] = await db.asSystem(
		(tx) => tx.sql<Row>`select item_no from nl.part_summary where units_12m > 0 order by revenue_12m desc limit 1`
	);
	aPart = String(part.item_no);

	const [commitment] = await db.asSystem(
		(tx) => tx.sql<Row>`select id from nl.commitment_progress order by committed_value desc limit 1`
	);
	aCommitment = Number(commitment.id);
}, 120_000);

afterAll(async () => {
	await db?.close();
});

function ctx(round = 1): ToolContext {
	const base = randomUUID();
	return { db, userId: DANA, today: TODAY, round, requestId: (suffix) => `${base}-${suffix}` };
}

/** Run a tool by name and hold its answer to its own declared shape. */
async function answersItsSchema(name: string, input: unknown) {
	const tool = findTool(name);
	expect(tool, name).toBeDefined();
	expect(tool!.checkOutput, `${name} declares no output schema`).toBeDefined();

	const parsed = tool!.parse(input);
	expect(parsed.ok, `${name} refused its own test input`).toBe(true);
	if (!parsed.ok) return null;

	const payload = await tool!.run!(ctx(), parsed.value);
	const checked = tool!.checkOutput!(payload);
	// The message names the field, so a failure here says what drifted.
	expect(checked.ok ? '' : checked.message, `${name} broke its output contract`).toBe('');
	return payload as Record<string, unknown>;
}

describe('every tool that runs declares what it answers with', () => {
	it('leaves no runnable tool without an output schema', () => {
		const missing = TOOLS.filter((t) => t.run && !t.outputSchema).map((t) => t.name);
		expect(missing).toEqual([]);
	});

	it('gives a gated tool no output schema, because it never runs from a model', () => {
		const wrong = TOOLS.filter((t) => t.risk === 'gated' && t.outputSchema).map((t) => t.name);
		expect(wrong).toEqual([]);
	});

	it('publishes a schema whose JSON Schema says an object with named fields', () => {
		for (const tool of TOOLS.filter((t) => t.outputSchema)) {
			const schema = tool.outputSchema as { anyOf?: unknown[] };
			// Every one is "the answer, or a refusal", so a union of two.
			expect(Array.isArray(schema.anyOf), tool.name).toBe(true);
			expect(schema.anyOf!.length, tool.name).toBe(2);
		}
	});
});

describe('the success branch of each read tool', () => {
	it('search_accounts', async () => {
		const payload = await answersItsSchema('search_accounts', { query: anAccount });
		const rows = payload!.rows as Record<string, unknown>[];
		expect(rows.length).toBeGreaterThan(0);
		// The url is part of the contract, so check it is the real address.
		expect(rows[0].url).toBe(`/accounts/${encodeURIComponent(String(rows[0].customer_no))}`);
	});

	it('get_account', async () => {
		const payload = await answersItsSchema('get_account', { customer_no: anAccount });
		expect(payload!.account).toBeTruthy();
	});

	it('get_commitment', async () => {
		const payload = await answersItsSchema('get_commitment', { commitment_id: aCommitment });
		expect((payload!.commitment as Record<string, unknown>).url).toBe(`/commitments/${aCommitment}`);
	});

	it('list_windows_closed_short', async () => {
		await answersItsSchema('list_windows_closed_short', { owner: 'everyone' });
	});

	it('get_part', async () => {
		const payload = await answersItsSchema('get_part', { item_no: aPart });
		expect((payload!.part as Record<string, unknown>).item_no).toBe(aPart);
	});

	it('run_sql', async () => {
		const payload = await answersItsSchema('run_sql', {
			sql: 'select count(*) as n from nl.customers',
			why: 'the contract test'
		});
		expect(payload!.row_count).toBe(1);
	});

	it('test_automation_rule', async () => {
		await answersItsSchema('test_automation_rule', {
			// The same shape the rule builder saves, so the catalog validates it.
			rule: {
				name: 'Contract test',
				description: '',
				enabled: false,
				trigger: 'window_closed_short',
				conditions: [{ field: 'owner_id', op: 'eq', value: 'me' }],
				action: { kind: 'next_step', title: 'Ask {customer} about {commitment}', dueInDays: 3, assignTo: 'record_owner' }
			}
		});
	});
});

describe('the additive tools', () => {
	it('add_note answers with what it wrote', async () => {
		const payload = await answersItsSchema('add_note', {
			customer_no: anAccount,
			body: 'The contract test wrote this.',
			commitment_id: null
		});
		expect(payload!.wrote).toBe('note');
	});

	it('add_next_step answers with what it wrote', async () => {
		const payload = await answersItsSchema('add_next_step', {
			customer_no: anAccount,
			title: 'The contract test added this',
			due_in_days: 5,
			commitment_id: null
		});
		expect(payload!.wrote).toBe('next_step');
	});
});

describe('the refusal branch', () => {
	/*
	  A tool that cannot answer returns { error } rather than raising, and that
	  is part of the declared shape. These would fail if the union were
	  narrowed to the success case alone.
	*/
	it('an account that does not exist', async () => {
		const payload = await answersItsSchema('get_account', { customer_no: 'NOPE-0000' });
		expect(payload!.error).toContain('NOPE-0000');
	});

	it('a part that does not exist', async () => {
		const payload = await answersItsSchema('get_part', { item_no: 'NOPE-0000' });
		expect(payload!.error).toBeTruthy();
	});

	it('a commitment that does not exist', async () => {
		const payload = await answersItsSchema('get_commitment', { commitment_id: 99_999_999 });
		expect(payload!.error).toBeTruthy();
	});

	it('a query the database will not run', async () => {
		const payload = await answersItsSchema('run_sql', { sql: 'select * from nl.users', why: '' });
		expect(payload!.error).toBeTruthy();
	});
});

describe('the MCP surface publishes the same contract', () => {
	it('gives every tool an output schema', () => {
		const missing = MCP_TOOLS.filter((t) => !t.outputSchema).map((t) => t.name);
		expect(missing).toEqual([]);
	});

	it('reuses the assistant tool schema for a read rather than keeping a second copy', () => {
		for (const mcp of MCP_TOOLS) {
			const shared = findTool(mcp.name);
			if (!shared?.outputSchema) continue;
			expect(mcp.outputSchema, mcp.name).toEqual(shared.outputSchema);
		}
	});

	it('accepts a conforming payload and rejects one missing a promised field', () => {
		const search = MCP_TOOLS.find((t) => t.name === 'search_accounts')!;
		expect(search.checkOutput({ rows: [], row_count: 0 }).ok).toBe(true);
		// row_count is promised, so leaving it out is a broken contract.
		expect(search.checkOutput({ rows: [] }).ok).toBe(false);
		// A row without its url is too: that is the whole point of the field.
		expect(search.checkOutput({ rows: [{ customer_no: '1', name: 'X' }], row_count: 1 }).ok).toBe(false);
		// An extra column is fine: a query may gain one without breaking anyone.
		expect(
			search.checkOutput({ rows: [{ customer_no: '1', name: 'X', url: '/accounts/1', extra: 1 }], row_count: 1 }).ok
		).toBe(true);
	});

	it('still accepts a refusal, which is a normal answer', () => {
		const part = MCP_TOOLS.find((t) => t.name === 'get_part')!;
		expect(part.checkOutput({ error: 'There is no part NOPE.' }).ok).toBe(true);
		expect(part.checkOutput({ error: 'Refused.', code: 'NL403' }).ok).toBe(true);
	});
});
