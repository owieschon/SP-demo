// The tool contract, both halves.
//
// The output half: every tool that declares what it answers with must
// actually answer with that, against a real database. Without it, a schema is
// a comment: a query could quietly stop returning a promised column and every
// caller that trusted the schema would break, while the type checker and
// every other test stayed green.
//
// It runs each tool twice where it can: once on input that exists, so the
// success branch is exercised, and once on input that does not, so the
// refusal branch is. Both have to match the declared shape, because a
// refusal is a normal answer here rather than an exception.
//
// The input half walks the registry instead: an unknown field is refused and
// named, a misspelling never falls through to a default, and a default that
// decides which rows come back is reported in the answer under the name the
// input takes. Those are rules about the shape of the registry, not about any
// one tool, so they are written that way.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_TOOLS } from '../mcp/tools.ts';
import { findTool, TOOLS, type ToolContext } from './tools.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db, Row } from '../db/types.ts';

const TODAY = '2026-09-17';
const DANA = 2; // an account manager, so the reads have a book to read

/** A rule the catalog accepts, for the tools that take one. */
const A_RULE = {
	name: 'Contract test',
	description: '',
	enabled: false,
	trigger: 'window_closed_short',
	conditions: [{ field: 'owner_id', op: 'eq', value: 'me' }],
	action: {
		kind: 'next_step',
		title: 'Ask {customer} about {commitment}',
		dueInDays: 3,
		assignTo: 'record_owner'
	}
};

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

// ---------------------------------------------------------------------------
// The input contract
// ---------------------------------------------------------------------------
//
// These walk the registry rather than name tools one at a time, on purpose.
// The defect they are here for is not a bug in one tool: it is somebody
// adding a tool and naming its input one thing and its answer another. A
// per-tool assertion would have passed the day that happened, because nobody
// would have written one for the new tool. A walk over the whole registry
// fails on the next one.

/** The named fields of a tool's input schema. */
function inputFields(schema: Record<string, unknown>): Record<string, Record<string, unknown>> {
	return (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
}

/** The input fields that have a default, and the default each one applies. */
function defaultedFields(schema: Record<string, unknown>): [string, unknown][] {
	return Object.entries(inputFields(schema))
		.filter(([, field]) => 'default' in field)
		.map(([name, field]): [string, unknown] => [name, field.default]);
}

/**
 * The named fields of the answer. An output schema is "the answer, or a
 * refusal", so the answer is the first branch of the union.
 */
function answerFields(schema: Record<string, unknown>): string[] {
	const branches = (schema.anyOf ?? []) as Record<string, unknown>[];
	const answer = branches[0] ?? schema;
	return Object.keys((answer.properties ?? {}) as Record<string, unknown>);
}

describe('every tool input refuses a field it does not have', () => {
	it('names the field, rather than blaming the input as a whole', () => {
		for (const tool of TOOLS) {
			const parsed = tool.parse({ definitely_not_a_field: 'x' });
			expect(parsed.ok, `${tool.name} accepted a field it has never heard of`).toBe(false);
			if (parsed.ok) continue;
			// The whole value of a strict input is that the message says which
			// word was wrong, so an agent can fix it instead of guessing.
			expect(parsed.message, tool.name).toContain('definitely_not_a_field');
		}
	});

	it('does not fall back to the default when the field is misspelled', () => {
		for (const tool of TOOLS) {
			const fields = inputFields(tool.jsonSchema);
			for (const [name] of defaultedFields(tool.jsonSchema)) {
				// A plural is the shape most of these misspellings take.
				const typo = `${name}s`;
				if (typo in fields) continue;
				const parsed = tool.parse({ [typo]: null });
				expect(parsed.ok, `${tool.name} ignored "${typo}" and used the default for ${name}`).toBe(false);
				if (parsed.ok) continue;
				expect(parsed.message, `${tool.name}.${typo}`).toContain(typo);
			}
		}
	});

	it('says so in the JSON Schema it publishes, not only on the server', () => {
		// A client that reads the schema should see the same rule the server
		// runs, so it can refuse the call itself rather than learn by error.
		for (const tool of TOOLS) {
			expect(tool.jsonSchema.additionalProperties, `${tool.name} publishes a loose input`).toBe(false);
		}
		for (const tool of MCP_TOOLS) {
			expect(tool.inputSchema.additionalProperties, `${tool.name} publishes a loose input`).toBe(false);
		}
	});
});

describe('one concept, one word, in and out', () => {
	/*
	  The defect that started this: list_windows_closed_short took `owner` and
	  reported `whose`. A client read the answer, sent `whose` back, and it was
	  dropped, because `owner` has a default. It got one person's commitments
	  while believing it had asked for everyone's, with no error at all.

	  So: a defaulted input decides which rows come back, and the answer has to
	  report it under the same name the input takes. Same name both ways means
	  a client can read a filter out of an answer and send it straight back.
	  A tool that genuinely has a default which cannot change the answer says
	  so in nonFilterDefaults, which is a claim rather than a shrug.
	*/
	it('reports every defaulted filter in the answer, under the input name', () => {
		for (const tool of TOOLS) {
			// A gated tool never runs from a model, so it has no answer to put
			// anything in.
			if (!tool.outputSchema) continue;
			const reported = answerFields(tool.outputSchema);
			for (const [name] of defaultedFields(tool.jsonSchema)) {
				if (tool.nonFilterDefaults.includes(name)) continue;
				expect(reported, `${tool.name} applies a default for "${name}" without saying so in its answer`).toContain(
					name
				);
			}
		}
	});

	it('claims nothing in nonFilterDefaults that is not a defaulted input', () => {
		// A stale exemption is how this rule would rot: a field renamed, its
		// old name left behind, and the new one quietly unchecked.
		for (const tool of TOOLS) {
			const defaulted = defaultedFields(tool.jsonSchema).map(([name]) => name);
			for (const claimed of tool.nonFilterDefaults) {
				expect(defaulted, `${tool.name} exempts "${claimed}", which is not a defaulted input`).toContain(claimed);
			}
		}
	});

	it('takes back the value it reported, under the name it reported it', () => {
		// The round trip the real client tried and lost: read the filter out
		// of the answer, send it back, get the same question asked again.
		for (const tool of TOOLS) {
			if (!tool.outputSchema) continue;
			for (const [name, value] of defaultedFields(tool.jsonSchema)) {
				if (tool.nonFilterDefaults.includes(name)) continue;
				const parsed = tool.parse({ ...requiredInputFor(tool.name), [name]: value });
				expect(parsed.ok ? '' : parsed.message, `${tool.name} would not take its own "${name}" back`).toBe('');
			}
		}
	});
});

/**
 * The required part of a tool's input, so the round trip above can send one
 * field back without tripping over a missing one. Every tool is listed, and
 * the test below fails if a new tool is not, so this cannot silently skip
 * the tool that needs checking most.
 */
const REQUIRED_INPUT: Record<string, Record<string, unknown>> = {
	search_accounts: { query: 'x' },
	get_account: { customer_no: '1214' },
	get_commitment: { commitment_id: 1 },
	list_windows_closed_short: {},
	get_part: { item_no: 'X-1' },
	run_sql: { sql: 'select 1' },
	test_automation_rule: { rule: A_RULE },
	add_note: { customer_no: '1214', body: 'x' },
	add_next_step: { customer_no: '1214', title: 'a step' },
	record_outcome: { commitment_id: 1, outcome: 'kept' },
	set_confidence: { commitment_id: 1, confidence: 50 },
	decide_export: { snapshot_id: 1, decision: 'apply' },
	save_automation_rule: { rule: A_RULE },
	propose_action: { summary: 'a reason', options: [{ label: 'do it', tool: 'set_confidence', input: {} }] }
};

function requiredInputFor(name: string): Record<string, unknown> {
	return REQUIRED_INPUT[name] ?? {};
}

describe('the registry walk covers every tool', () => {
	it('has a required input written down for each one', () => {
		expect(Object.keys(REQUIRED_INPUT).sort()).toEqual(TOOLS.map((t) => t.name).sort());
	});
});

describe('the MCP surface follows the same rule', () => {
	/*
	  Mostly the same tools, but not entirely: list_pending_approvals exists
	  only here, so the walk above would never see it.

	  Only the read tools. A propose_* tool's answer is a receipt for a
	  proposal, not rows, and its defaulted fields (a note, a rule id) belong
	  to the write a person has not approved yet. They show up in the option
	  label a person reads, which is where they matter.
	*/
	it('reports every defaulted filter in the answer, under the input name', () => {
		for (const tool of MCP_TOOLS.filter((t) => t.readOnly)) {
			const shared = findTool(tool.name);
			const exempt = shared?.nonFilterDefaults ?? [];
			const reported = answerFields(tool.outputSchema);
			for (const [name] of defaultedFields(tool.inputSchema)) {
				if (exempt.includes(name)) continue;
				expect(reported, `${tool.name} applies a default for "${name}" without saying so in its answer`).toContain(
					name
				);
			}
		}
	});

	it('refuses a field it does not have, and names it', () => {
		for (const tool of MCP_TOOLS) {
			const checked = tool.check({ definitely_not_a_field: 'x' });
			expect(checked.ok, `${tool.name} accepted a field it has never heard of`).toBe(false);
			if (checked.ok) continue;
			expect(checked.message, tool.name).toContain('definitely_not_a_field');
		}
	});
});

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
		await answersItsSchema('list_windows_closed_short', { whose: 'everyone' });
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
		// The same shape the rule builder saves, so the catalog validates it.
		await answersItsSchema('test_automation_rule', { rule: A_RULE });
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
		expect(search.checkOutput({ rows: [], row_count: 0, limit: 8 }).ok).toBe(true);
		// row_count is promised, so leaving it out is a broken contract.
		expect(search.checkOutput({ rows: [], limit: 8 }).ok).toBe(false);
		// So is the limit that was applied: a caller cannot tell a short list
		// from a capped one without it.
		expect(search.checkOutput({ rows: [], row_count: 0 }).ok).toBe(false);
		// A row without its url is too: that is the whole point of the field.
		expect(search.checkOutput({ rows: [{ customer_no: '1', name: 'X' }], row_count: 1, limit: 8 }).ok).toBe(false);
		// An extra column is fine: a query may gain one without breaking anyone.
		expect(
			search.checkOutput({
				rows: [{ customer_no: '1', name: 'X', url: '/accounts/1', extra: 1 }],
				row_count: 1,
				limit: 8
			}).ok
		).toBe(true);
	});

	it('still accepts a refusal, which is a normal answer', () => {
		const part = MCP_TOOLS.find((t) => t.name === 'get_part')!;
		expect(part.checkOutput({ error: 'There is no part NOPE.' }).ok).toBe(true);
		expect(part.checkOutput({ error: 'Refused.', code: 'NL403' }).ok).toBe(true);
	});
});
