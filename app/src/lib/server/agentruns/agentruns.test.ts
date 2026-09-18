// The run trail against a real database: what the agent did, recorded from
// the record the agent kept of itself, and replayed.
//
// The world is the small test world with the desks and their inbox seeded on
// top (db/seed.d/70_desk.sql), "today" is 2026-09-17 and the mail provider is
// always the scripted one, so no test can reach a real mailbox. No paid API
// is called anywhere here: the replay's classifier is a plain function.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fact } from '$lib/desk/types';
import { RULES } from '$lib/agentruns/types';
import { findDbDir } from '../db/files.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { fileResponse } from '../documents/http.ts';
import { readRequest } from '../documents/read.ts';
import { extractRequest } from '../documents/request.ts';
import { readAttachment } from '../documents/store.ts';
import { listMailboxes, pollAll, readMockWorld, type MailboxRow } from '../desk/poll.ts';
import { getDraft as getQuoteRequest } from '../rfq/drafts.ts';
import { createMockClient } from '../desk/mock.ts';
import { findDeskItem, readItemSource, recordDeskTrail, recordPollTrails } from './desk.ts';
import { enterQuoteRequest } from './handentry.ts';
import { getRun, getRunFor, getRunForQuoteRequest, getRunsOn, listAgents, listRuns, readRunInputs } from './read.ts';
import { replayRun } from './replay.ts';
import { appendSteps, finishRun, startRun } from './writes.ts';

const TODAY = '2026-09-17';
const ORDER_DESK_USER = 6; // Jordan Pike, who reviews the order desk
const DANA = 2; // an account manager, not either desk's reviewer

const FIXTURES = resolve(findDbDir(), '..', 'fixtures', 'rfq');
const upload = (name: string): File => {
	const bytes = new Uint8Array(readFileSync(join(FIXTURES, name)));
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return new File([buffer], name);
};

let db: Db;
let mailboxes: MailboxRow[];
let orders: MailboxRow;
let recorded: number;

beforeAll(async () => {
	db = await createTestDb({ today: TODAY });
	mailboxes = await listMailboxes(db);
	orders = mailboxes.find((m) => m.kind === 'orders')!;
	const client = createMockClient(await readMockWorld(db, mailboxes, ORDER_DESK_USER));
	const summaries = await pollAll(db, { client, mode: 'mock', maxRuns: 20 });
	recorded = await recordPollTrails(db, mailboxes, summaries, (address) => `Mail arrived at ${address}`);
}, 240_000);

afterAll(async () => {
	await db?.close();
});

async function orderDeskRuns() {
	return listRuns(db, ORDER_DESK_USER, { agent: 'order_desk', limit: 100 });
}

describe('a run records what woke it and what it did', () => {
	it('writes one trail per run the agent worked', async () => {
		expect(recorded).toBeGreaterThan(0);
		const runs = await orderDeskRuns();
		expect(runs.length).toBeGreaterThan(0);
		for (const run of runs) {
			expect(run.agent).toBe('order_desk');
			expect(run.wokeBy).toBe('mail');
			expect(run.wokeNote).toContain(orders.address);
			expect(run.finishedAt).not.toBeNull();
			expect(run.durationMs).not.toBeNull();
			expect(run.entity).toBe('mail_message');
		}
	});

	it('keeps the steps in the order they happened, starting with what it read', async () => {
		const [newest] = await orderDeskRuns();
		const run = await getRun(db, ORDER_DESK_USER, newest.id);
		expect(run).not.toBeNull();
		expect(run!.steps.length).toBeGreaterThan(2);
		expect(run!.steps.map((step) => step.seq)).toEqual(run!.steps.map((_, i) => i + 1));
		expect(run!.steps[0].kind).toBe('read');
		expect(run!.steps[1].label).toContain('desk it came to');
		expect(run!.stepCount).toBe(run!.steps.length);
	});

	it('records every lookup the agent made, with its arguments and its cost', async () => {
		const runs = await orderDeskRuns();
		const withLookups = [];
		for (const summary of runs) {
			const run = await getRun(db, ORDER_DESK_USER, summary.id);
			const tools = run!.steps.filter((step) => step.kind === 'tool');
			if (tools.length > 0) withLookups.push({ run: run!, tools });
		}
		expect(withLookups.length).toBeGreaterThan(0);
		for (const { tools } of withLookups) {
			for (const tool of tools) {
				expect(tool.tool).toBeTruthy();
				expect(tool.rows).not.toBeNull();
				expect(tool.ms).not.toBeNull();
				expect(tool.result).toMatch(/rows? back/);
			}
		}
	});

	it('transcribes the same run once, however many times it is asked', async () => {
		const before = (await orderDeskRuns()).length;
		const again = await recordPollTrails(
			db,
			mailboxes,
			[
				{
					mailbox: orders.address,
					runs: await db.asUser(ORDER_DESK_USER, (tx) =>
						tx.sql<{ runId: number; messageId: number }>`
							select id as "runId", message_id as "messageId" from nl.mail_runs`
					).then((rows) => rows.map((r) => ({ ...r, policyRefusals: [] })))
				}
			],
			() => 'asked twice'
		);
		expect(again).toBeGreaterThan(0);
		expect((await orderDeskRuns()).length).toBe(before);
	});

	it('lists the agents that have run', async () => {
		const agents = await listAgents(db, ORDER_DESK_USER);
		expect(agents.map((a) => a.agent)).toContain('order_desk');
	});
});

describe('a refusal is a first-class step', () => {
	it('appears in the trail with the rule it refused under', async () => {
		const runs = await orderDeskRuns();
		const refusals = [];
		for (const summary of runs) {
			const run = await getRun(db, ORDER_DESK_USER, summary.id);
			refusals.push(...run!.steps.filter((step) => step.kind === 'refusal'));
		}
		// The seeded inbox has senders the desk cannot match and questions it
		// asks rather than guessing at, so at least one run refuses something.
		expect(refusals.length).toBeGreaterThan(0);
		for (const refusal of refusals) {
			expect(refusal.rule).toBeTruthy();
			expect(refusal.ruleNote).not.toBe('');
		}
		expect(runs.some((run) => run.refusals > 0)).toBe(true);
	});

	it('will not store a refusal with no rule on it', async () => {
		const { runId } = await db.asUser(ORDER_DESK_USER, (tx) =>
			startRun(
				tx,
				{
					agent: 'order_desk',
					wokeBy: 'person',
					wokeNote: 'a test',
					entity: null,
					entityId: null,
					reader: 'internal',
					subjectNo: null,
					mode: 'mock',
					model: null,
					bundleVersion: null,
					inputs: {},
					replayOf: null,
					sourceKind: null,
					sourceId: null
				},
				randomUUID()
			)
		);
		await expect(
			db.asUser(ORDER_DESK_USER, (tx) =>
				appendSteps(tx, runId, [{ kind: 'refusal', label: 'Refused something' }], randomUUID())
			)
		).rejects.toThrow(/names the rule/);
	});
});

describe('the trail is subject to the same disclosure check as a draft', () => {
	it('withholds a step the reader may not see, and says it is withholding it', async () => {
		const cost: Fact = {
			kind: 'unit_cost',
			text: 'L760-128B costs us $21.40.',
			subject: null,
			ids: { item_no: 'L760-128B' },
			amounts: [21.4]
		};

		const runId = await db.asUser(ORDER_DESK_USER, async (tx) => {
			const { runId: id } = await startRun(
				tx,
				{
					agent: 'order_desk',
					wokeBy: 'person',
					wokeNote: 'a trail a customer would read',
					entity: null,
					entityId: null,
					// The level is what makes this step refusable: a trail read at
					// customer level may not carry what a reply may not say.
					reader: 'customer',
					subjectNo: '1214',
					mode: 'mock',
					model: null,
					bundleVersion: null,
					inputs: {},
					replayOf: null,
					sourceKind: null,
					sourceId: null
				},
				randomUUID()
			);
			const { checkStep } = await import('./trail.ts');
			await appendSteps(
				tx,
				id,
				[
					checkStep(
						{ kind: 'tool', label: 'unit_cost', args: { item_no: 'L760-128B' }, result: cost.text, facts: [cost] },
						{ reader: 'customer', subject: '1214' }
					)
				],
				randomUUID()
			);
			await finishRun(
				tx,
				{
					runId: id,
					outcome: 'drafted',
					decision: 'a test',
					durationMs: 1,
					inputTokens: 0,
					outputTokens: 0,
					producedKind: null,
					producedId: null,
					produced: {},
					diff: null,
					error: null
				},
				randomUUID()
			);
			return id;
		});

		const run = await getRun(db, ORDER_DESK_USER, runId);
		const [step] = run!.steps;
		expect(step.withheld).toBe(true);
		// Visible, not silent: the step is still there and says what it holds back.
		expect(step.label).toBe('unit_cost');
		expect(step.withheldReason).toContain('what the part costs us');
		expect(step.args).toBeNull();
		expect(step.result).toBe('');
		// And nothing of the detail reached the database.
		const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ found: number }>`
				select count(*)::int as found from nl.agent_run_steps
				where run_id = ${runId} and (result like '%21.40%' or args::text like '%21.40%')`
		);
		expect(row.found).toBe(0);
	});

	it('drops the detail itself when a caller says withheld', async () => {
		const runId = await db.asUser(ORDER_DESK_USER, async (tx) => {
			const { runId: id } = await startRun(
				tx,
				{
					agent: 'order_desk',
					wokeBy: 'person',
					wokeNote: 'a careless caller',
					entity: null,
					entityId: null,
					reader: 'internal',
					subjectNo: null,
					mode: 'mock',
					model: null,
					bundleVersion: null,
					inputs: {},
					replayOf: null,
					sourceKind: null,
					sourceId: null
				},
				randomUUID()
			);
			await appendSteps(
				tx,
				id,
				[
					{
						kind: 'note',
						label: 'Something it may not say',
						args: { secret: 'our cost' },
						result: 'our cost is $21.40',
						withheld: true,
						withheld_reason: 'a customer may not be told what the part costs us'
					}
				],
				randomUUID()
			);
			return id;
		});
		const run = await getRun(db, ORDER_DESK_USER, runId);
		expect(run!.steps[0].args).toBeNull();
		expect(run!.steps[0].result).toBe('');
	});
});

describe('a desk item shows the run that produced its draft', () => {
	it('finds the run by what it produced', async () => {
		const runs = await orderDeskRuns();
		const withDraft = runs.find((run) => run.producedKind === 'mail_draft' && run.producedId !== null);
		expect(withDraft).toBeDefined();

		const found = await getRunFor(db, ORDER_DESK_USER, {
			kind: 'mail_draft',
			id: withDraft!.producedId!
		});
		expect(found?.id).toBe(withDraft!.id);
		expect(found!.steps.some((step) => step.kind === 'output')).toBe(true);
		// Not looked at yet, because nobody has approved or rejected it.
		expect(found!.humanChange).toBe('not looked at yet');
	});

	it('finds every run on one desk item', async () => {
		const runs = await orderDeskRuns();
		const onItem = await getRunsOn(db, ORDER_DESK_USER, { kind: 'mail_message', id: runs[0].entityId! });
		expect(onItem.length).toBeGreaterThan(0);
		expect(onItem[0].steps.length).toBeGreaterThan(0);
	});
});

/** A run whose reply cited this account's own prices: the interesting case. */
async function runWithPrices() {
	for (const summary of await orderDeskRuns()) {
		const held = await readRunInputs(db, ORDER_DESK_USER, summary.id);
		const inputs = held?.inputs as {
			draft?: { facts?: Fact[] } | null;
			decision?: { intent?: string; confidence?: number; reason?: string };
			subjectNo?: string | null;
		};
		if (inputs?.draft?.facts?.some((fact) => fact.kind === 'own_price')) {
			return { summary, inputs };
		}
	}
	throw new Error('No run in the seeded world cited a price.');
}

describe('a run can be replayed', () => {
	it('reproduces the same decision from the same inputs, and reports no change', async () => {
		const { summary, inputs } = await runWithPrices();
		const result = await replayRun(db, ORDER_DESK_USER, summary.id, {
			// A fake classifier, so nothing paid is ever called. It answers what
			// the run recorded, which is what "nothing changed" means.
			classify: async () => ({
				intent: inputs.decision!.intent as 'rfq',
				confidence: inputs.decision!.confidence!,
				reason: inputs.decision!.reason!
			})
		});
		expect(result.diff).toBe('same');
		expect(result.changes).toEqual([]);
		expect(result.before.outcome).toBe(result.after.outcome);
	});

	it('calls the same decision in different words a change of wording', async () => {
		const { summary, inputs } = await runWithPrices();
		const result = await replayRun(db, ORDER_DESK_USER, summary.id, {
			classify: async () => ({
				intent: inputs.decision!.intent as 'rfq',
				confidence: inputs.decision!.confidence!,
				reason: 'It reads as a request for a price on some parts.'
			})
		});
		expect(result.diff).toBe('wording');
		expect(result.changes.join(' ')).toContain('Same decision, different words');
		expect(result.after.outcome).toBe(result.before.outcome);
	});

	it('names the difference when the policy changed between the run and the replay', async () => {
		const { summary } = await runWithPrices();
		// The same reply, judged as though this desk wrote to a supplier: a
		// supplier may not be told a customer's price, so the reply that went
		// out before would be refused now.
		const result = await replayRun(db, ORDER_DESK_USER, summary.id, { policy: { level: 'vendor' } });
		expect(result.diff).toBe('decision');
		expect(result.after.outcome).toBe('refused');
		expect(result.after.refusedFor.length).toBeGreaterThan(0);
		expect(result.changes.join(' ')).toContain('refuses');
		expect(result.before.outcome).not.toBe('refused');
	});

	it('records the replay as a run of its own, pointing at the one it replayed', async () => {
		const { summary } = await runWithPrices();
		const result = await replayRun(db, ORDER_DESK_USER, summary.id, { note: 'checking a policy change' });
		expect(result.replayRunId).not.toBeNull();

		const replay = await getRun(db, ORDER_DESK_USER, result.replayRunId!);
		expect(replay!.replayOf).toBe(summary.id);
		expect(replay!.wokeBy).toBe('replay');
		expect(replay!.outcome).toBe('replayed');
		expect(replay!.diff).toBe(result.diff);
		expect(replay!.steps[0].label).toContain('recorded inputs');

		// A replay is not a run of the agent; the run list leaves it out.
		const listed = await listRuns(db, ORDER_DESK_USER, { agent: 'order_desk', limit: 100 });
		expect(listed.some((run) => run.id === result.replayRunId)).toBe(false);
		expect(listed.find((run) => run.id === summary.id)!.replays).toBeGreaterThan(0);
	});

	it('refuses to replay a run that recorded no inputs', async () => {
		const { runId } = await db.asUser(ORDER_DESK_USER, (tx) =>
			startRun(
				tx,
				{
					agent: 'order_desk',
					wokeBy: 'person',
					wokeNote: 'nothing recorded',
					entity: null,
					entityId: null,
					reader: 'internal',
					subjectNo: null,
					mode: 'mock',
					model: null,
					bundleVersion: null,
					inputs: {},
					replayOf: null,
					sourceKind: null,
					sourceId: null
				},
				randomUUID()
			)
		);
		await expect(replayRun(db, ORDER_DESK_USER, runId)).rejects.toThrow(/inputs a replay needs/);
	});
});

describe('a request entered by hand', () => {
	it('makes a desk item whose source is a person, with the lines and where each one sat', async () => {
		const cover = [
			'Called in by the buyer at the counter.',
			'',
			'Please quote the attached list for the next release.'
		].join('\n');
		const read = await readRequest({ paste: cover, files: [upload('parts-list.csv')] });
		expect(read.problems).toEqual([]);
		const extraction = await extractRequest(read.documents, { mode: 'rules', today: TODAY });

		const entered = await enterQuoteRequest(db, DANA, {
			mailboxId: orders.id,
			mailboxAddress: orders.address,
			mailboxLabel: orders.label,
			mailboxKind: 'orders',
			disclosure: 'customer',
			from: '',
			fromName: 'A buyer on the telephone',
			subject: 'Phoned in: next release',
			documents: read.documents,
			stored: read.stored,
			sourceName: read.sourceName,
			extraction,
			requestId: randomUUID()
		});

		const item = await readItemSource(db, DANA, entered.messageId);
		expect(item?.source).toBe('person');
		expect(item?.enteredByName).toBeTruthy();

		// The quote request it produced, with the file kept beside it and every
		// line saying which row of which file it came from.
		const request = await getQuoteRequest(db, DANA, entered.draftId);
		expect(request).not.toBeNull();
		expect(request!.attachments.length).toBe(1);
		const sources = request!.draft.lines.map((line) => line.source ?? '');
		expect(sources.length).toBeGreaterThan(0);
		expect(sources.every((source) => /row \d+/.test(source))).toBe(true);

		// And the desk item points back at it.
		const found = await findDeskItem(db, DANA, entered.draftId);
		expect(found?.messageId).toBe(entered.messageId);
		expect(found?.source).toBe('person');
	});

	it('leaves a trail woken by a person, with what it would not assume on it', async () => {
		const read = await readRequest({
			paste: [
				'Phoned in by the buyer.',
				'',
				'  L760-128B  qty 4',
				'  NOT-A-PART-AT-ALL  qty 2',
				'',
				'Needed by October 2.'
			].join('\n'),
			files: []
		});
		const extraction = await extractRequest(read.documents, { mode: 'rules', today: TODAY });
		const entered = await enterQuoteRequest(db, DANA, {
			mailboxId: orders.id,
			mailboxAddress: orders.address,
			mailboxLabel: orders.label,
			mailboxKind: 'orders',
			disclosure: 'customer',
			from: '',
			fromName: 'A buyer on the telephone',
			subject: 'Phoned in: two parts',
			documents: read.documents,
			stored: read.stored,
			sourceName: read.sourceName,
			extraction,
			requestId: randomUUID()
		});

		const run = await getRun(db, DANA, entered.runId);
		expect(run!.wokeBy).toBe('person');
		expect(run!.wokeNote).toContain(orders.label);
		expect(run!.producedKind).toBe('quote_request');
		expect(run!.producedId).toBe(entered.draftId);
		expect(run!.steps.some((step) => step.kind === 'tool' && step.tool === 'validate_quote_request')).toBe(true);

		// It would not guess at a part the catalog does not have.
		const refusal = run!.steps.find((step) => step.kind === 'refusal');
		expect(refusal).toBeDefined();
		expect([RULES.unresolvedLine.id, RULES.unmatchedSender.id]).toContain(refusal!.rule);

		// The same run is found from the quote request's own page.
		const fromRequest = await getRunForQuoteRequest(db, DANA, entered.draftId);
		expect(fromRequest?.id).toBe(entered.runId);
	});
});

describe('the old quote-request screen', () => {
	it('redirects /rfq to the desk', async () => {
		const { GET } = await import('../../../routes/rfq/+server.ts');
		// SvelteKit's redirect() throws; that is how a load or a handler says so.
		const thrown = await Promise.resolve()
			.then(() => GET({} as never))
			.catch((error: unknown) => error);
		expect((thrown as { status: number }).status).toBe(308);
		expect((thrown as { location: string }).location).toBe('/desk');
	});

	it('redirects /rfq/<id> to the same request under the desk', async () => {
		const { GET } = await import('../../../routes/rfq/[id=id]/+server.ts');
		const thrown = await Promise.resolve()
			.then(() => GET({ params: { id: '7001' } } as never))
			.catch((error: unknown) => error);
		expect((thrown as { status: number }).status).toBe(308);
		expect((thrown as { location: string }).location).toBe('/desk/requests/7001');
	});

	it('still serves an attachment from the address it always had', async () => {
		// The endpoint file stayed where it was, so links people already have
		// keep working.
		const route = resolve(
			findDbDir(),
			'..',
			'app',
			'src',
			'routes',
			'rfq',
			'[id=id]',
			'attachments',
			'[attachment=id]',
			'+server.ts'
		);
		expect(existsSync(route)).toBe(true);
		expect(readFileSync(route, 'utf8')).toContain('readAttachment');

		// And what it serves is the file, with the type that was stored.
		const read = await readRequest({ paste: 'Please quote the list.', files: [upload('parts-list.csv')] });
		const extraction = await extractRequest(read.documents, { mode: 'rules', today: TODAY });
		const entered = await enterQuoteRequest(db, DANA, {
			mailboxId: orders.id,
			mailboxAddress: orders.address,
			mailboxLabel: orders.label,
			mailboxKind: 'orders',
			disclosure: 'customer',
			from: '',
			fromName: 'A buyer on the telephone',
			subject: 'Phoned in: the list again',
			documents: read.documents,
			stored: read.stored,
			sourceName: read.sourceName,
			extraction,
			requestId: randomUUID()
		});
		const request = await getQuoteRequest(db, DANA, entered.draftId);
		const file = await readAttachment(db, DANA, entered.draftId, request!.attachments[0].id);
		expect(file).not.toBeNull();
		const response = fileResponse(file!.bytes, file!.mediaType, file!.fileName);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(file!.mediaType);
		expect(Number(response.headers.get('content-length'))).toBe(file!.byteSize);
	});
});

describe('a trail that cannot be written is never a reason a run fails', () => {
	it('says there is no such run rather than throwing', async () => {
		expect(await recordDeskTrail(db, ORDER_DESK_USER, { mailRunId: 999_999 })).toBeNull();
	});
});
