// The run trail against a real database: how a run reached its decision,
// written from the record the agent kept of itself and hung off the harness's
// own run key, and replayed.
//
// The world is the small test world with the desks and their inbox seeded on
// top (db/seed.d/70_desk.sql), "today" is 2026-09-17 and the mail provider is
// always the scripted one, so no test can reach a real mailbox. No paid API is
// called anywhere here: the replay's classifier is a plain function.
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Fact } from '$lib/desk/types';
import { RULES, type RunStep, type RunSummary } from '$lib/agentruns/types';
import { findDbDir } from '../db/files.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { fileResponse } from '../documents/http.ts';
import { readRequest } from '../documents/read.ts';
import { extractRequest, nameOf } from '../documents/request.ts';
import { readAttachment } from '../documents/store.ts';
import { createMockClient } from '../desk/mock.ts';
import { listMailboxes, pollAll, readMockWorld, type MailboxRow } from '../desk/poll.ts';
import { getDraft as getQuoteRequest } from '../rfq/drafts.ts';
import { findDeskItem, readItemSource, recordDeskTrail, recordPollTrails } from './desk.ts';
import { enterQuoteRequest } from './handentry.ts';
import { getTrail, getTrailForQuoteRequest, getTrailsOn, listRuns, readTrailInputs } from './read.ts';
import { replayRun } from './replay.ts';
import { checkStep } from './trail.ts';
import { recordTrail } from './writes.ts';

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

async function orderDeskRuns(): Promise<RunSummary[]> {
	return listRuns(db, ORDER_DESK_USER, { agent: 'order_desk', withTrailOnly: true, limit: 100 });
}

/** Every step of every order desk run, for the tests that ask about all of them. */
async function allSteps(): Promise<RunStep[]> {
	const steps: RunStep[] = [];
	for (const run of await orderDeskRuns()) {
		const trail = await getTrail(db, ORDER_DESK_USER, run.runKey);
		steps.push(...(trail?.steps ?? []));
	}
	return steps;
}

describe('a trail hangs off the harness run it describes', () => {
	it('writes one trail per run the agent worked, under the harness key', async () => {
		expect(recorded).toBeGreaterThan(0);
		const runs = await orderDeskRuns();
		expect(runs.length).toBeGreaterThan(0);
		for (const run of runs) {
			expect(run.agent).toBe('order_desk');
			expect(run.runKey).toMatch(/^order_desk:\d+$/);
			expect(run.hasTrail).toBe(true);
			expect(run.wokeBy).toBe('mail');
			expect(run.wokeNote).toContain(orders.address);
			expect(run.entity).toBe('mail_message');
			// The run's own facts still come from the harness's view.
			expect(run.finishedAt).not.toBeNull();
			expect(run.ms).toBeGreaterThanOrEqual(0);
			expect(run.produced).toBeTruthy();
		}
	});

	it('keeps the steps in the order they happened, starting with what it read', async () => {
		const [newest] = await orderDeskRuns();
		const trail = await getTrail(db, ORDER_DESK_USER, newest.runKey);
		expect(trail).not.toBeNull();
		expect(trail!.steps.length).toBeGreaterThan(2);
		expect(trail!.steps.map((step) => step.seq)).toEqual(trail!.steps.map((_, i) => i + 1));
		expect(trail!.steps[0].kind).toBe('read');
		expect(trail!.steps[1].label).toContain('desk it came to');
		expect(trail!.stepCount).toBe(trail!.steps.length);
	});

	it('records every lookup with the arguments it was called with', async () => {
		const tools = (await allSteps()).filter((step) => step.kind === 'tool');
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			expect(tool.tool).toBeTruthy();
			expect(tool.rows).not.toBeNull();
			expect(tool.ms).not.toBeNull();
			expect(tool.result).toMatch(/rows? back/);
		}
		// The arguments are the part the harness's own tool_calls does not
		// carry, and the part that makes a lookup checkable.
		expect(tools.some((tool) => tool.args !== null && Object.keys(tool.args).length > 0)).toBe(true);
	});

	it('transcribes the same run once, however many times it is asked', async () => {
		const before = (await orderDeskRuns()).length;
		const runs = await db
			.asUser(ORDER_DESK_USER, (tx) =>
				tx.sql<{ run_id: number; message_id: number }>`select id as run_id, message_id from nl.mail_runs`
			)
			.then((rows) => rows.map((r) => ({ runId: r.run_id, messageId: r.message_id, policyRefusals: [] })));
		await recordPollTrails(db, mailboxes, [{ mailbox: orders.address, runs }], () => 'asked twice');
		expect((await orderDeskRuns()).length).toBe(before);
	});
});

describe('a refusal is a first-class step', () => {
	it('appears in the trail with the rule it refused under', async () => {
		// The seeded inbox has senders the desk cannot match and questions it
		// asks rather than guessing at, so at least one run refuses something.
		const refusals = (await allSteps()).filter((step) => step.kind === 'refusal');
		expect(refusals.length).toBeGreaterThan(0);
		for (const refusal of refusals) {
			expect(refusal.rule).toBeTruthy();
			expect(refusal.ruleNote).not.toBe('');
		}
		expect((await orderDeskRuns()).some((run) => run.refusals > 0)).toBe(true);
	});

	it('will not store a refusal with no rule on it', async () => {
		await expect(
			db.asUser(ORDER_DESK_USER, (tx) =>
				recordTrail(
					tx,
					{
						runKey: 'order_desk:999001',
						agent: 'order_desk',
						wokeBy: 'person',
						wokeNote: 'a test',
						entity: null,
						entityId: null,
						reader: 'internal',
						subjectNo: null,
						bundleVersion: null,
						decision: '',
						inputs: {},
						steps: [{ kind: 'refusal', label: 'Refused something' }]
					},
					randomUUID()
				)
			)
		).rejects.toThrow(/names the rule/);
	});
});

describe('the trail is subject to the same disclosure check as a draft', () => {
	const cost: Fact = {
		kind: 'unit_cost',
		text: 'L760-128B costs us $21.40.',
		subject: null,
		ids: { item_no: 'L760-128B' },
		amounts: [21.4]
	};

	it('withholds a step the reader may not see, and says it is withholding it', async () => {
		const runKey = 'order_desk:999002';
		await db.asUser(ORDER_DESK_USER, (tx) =>
			recordTrail(
				tx,
				{
					runKey,
					agent: 'order_desk',
					wokeBy: 'person',
					wokeNote: 'a trail a customer would read',
					entity: null,
					entityId: null,
					// The level is what makes this step refusable: a trail read at
					// customer level may not carry what a reply may not say.
					reader: 'customer',
					subjectNo: '1214',
					bundleVersion: null,
					decision: 'a test',
					inputs: {},
					steps: [
						checkStep(
							{ kind: 'tool', label: 'unit_cost', args: { item_no: 'L760-128B' }, result: cost.text, facts: [cost] },
							{ reader: 'customer', subject: '1214' }
						)
					]
				},
				randomUUID()
			)
		);

		const [step] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{
				label: string;
				withheld: boolean;
				withheld_reason: string;
				args: unknown;
				result: string;
			}>`select label, withheld, withheld_reason, args, result from nl.agent_run_steps where run_key = ${runKey}`
		);
		expect(step.withheld).toBe(true);
		// Visible, not silent: the step is still there and says what it holds back.
		expect(step.label).toBe('unit_cost');
		expect(step.withheld_reason).toContain('what the part costs us');
		expect(step.args).toBeNull();
		expect(step.result).toBe('');

		// And nothing of the detail reached the database.
		const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ found: number }>`
				select count(*)::int as found from nl.agent_run_steps
				where run_key = ${runKey} and (result like '%21.40%' or args::text like '%21.40%')`
		);
		expect(row.found).toBe(0);
	});

	it('drops the detail itself when a caller says withheld', async () => {
		const runKey = 'order_desk:999003';
		await db.asUser(ORDER_DESK_USER, (tx) =>
			recordTrail(
				tx,
				{
					runKey,
					agent: 'order_desk',
					wokeBy: 'person',
					wokeNote: 'a careless caller',
					entity: null,
					entityId: null,
					reader: 'internal',
					subjectNo: null,
					bundleVersion: null,
					decision: '',
					inputs: {},
					steps: [
						{
							kind: 'note',
							label: 'Something it may not say',
							args: { secret: 'our cost' },
							result: 'our cost is $21.40',
							withheld: true,
							withheld_reason: 'a customer may not be told what the part costs us'
						}
					]
				},
				randomUUID()
			)
		);
		const [step] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ args: unknown; result: string }>`
				select args, result from nl.agent_run_steps where run_key = ${runKey}`
		);
		expect(step.args).toBeNull();
		expect(step.result).toBe('');
	});
});

describe('a desk item shows the run that produced its draft', () => {
	it('finds the trail on the item, with what it produced on it', async () => {
		const runs = await orderDeskRuns();
		const withDraft = runs.find((run) => run.produced.startsWith('Draft'));
		expect(withDraft).toBeDefined();

		const trails = await getTrailsOn(db, ORDER_DESK_USER, {
			kind: 'mail_message',
			id: withDraft!.entityId!
		});
		expect(trails.length).toBeGreaterThan(0);
		expect(trails[0].runKey).toBe(withDraft!.runKey);
		expect(trails[0].steps.some((step) => step.kind === 'output')).toBe(true);
		// Nobody has approved or rejected it, and the harness says so.
		expect(trails[0].reviewState).toBe('waiting');
	});
});

/** A run whose reply cited this account's own prices: the interesting case. */
async function runWithPrices() {
	for (const run of await orderDeskRuns()) {
		const held = await readTrailInputs(db, ORDER_DESK_USER, run.runKey);
		const inputs = held?.inputs as {
			draft?: { facts?: Fact[] } | null;
			decision?: { intent?: string; confidence?: number; reason?: string };
		};
		if (inputs?.draft?.facts?.some((fact) => fact.kind === 'own_price')) {
			return { run, inputs };
		}
	}
	throw new Error('No run in the seeded world cited a price.');
}

describe('a run can be replayed', () => {
	it('reproduces the same decision from the same inputs, and reports no change', async () => {
		const { run, inputs } = await runWithPrices();
		const result = await replayRun(db, ORDER_DESK_USER, run.runKey, {
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
		const { run, inputs } = await runWithPrices();
		const result = await replayRun(db, ORDER_DESK_USER, run.runKey, {
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
		const { run } = await runWithPrices();
		// The same reply, judged as though this desk wrote to a supplier: a
		// supplier may not be told a customer's price, so the reply that went
		// out before would be refused now.
		const result = await replayRun(db, ORDER_DESK_USER, run.runKey, { policy: { level: 'vendor' } });
		expect(result.diff).toBe('decision');
		expect(result.after.outcome).toBe('refused');
		expect(result.after.refusedFor.length).toBeGreaterThan(0);
		expect(result.changes.join(' ')).toContain('refuses');
		expect(result.before.outcome).not.toBe('refused');
	});

	it('refuses to replay a run with no trail', async () => {
		await expect(replayRun(db, ORDER_DESK_USER, 'order_desk:999999')).rejects.toThrow(/no trail/);
	});
});

describe('a request entered by hand', () => {
	async function enter(paste: string, files: File[], subject: string) {
		const read = await readRequest({ paste, files });
		expect(read.problems).toEqual([]);
		const extraction = await extractRequest(read.documents, { mode: 'rules', today: TODAY });
		return enterQuoteRequest(db, DANA, {
			mailboxId: orders.id,
			mailboxAddress: orders.address,
			mailboxLabel: orders.label,
			mailboxKind: 'orders',
			disclosure: 'customer',
			from: '',
			fromName: 'A buyer on the telephone',
			subject,
			documents: read.documents,
			stored: read.stored,
			sourceName: nameOf(read.documents),
			extraction,
			requestId: randomUUID()
		});
	}

	it('makes a desk item whose source is a person, with every line and where it sat', async () => {
		const entered = await enter(
			'Called in by the buyer at the counter.\n\nPlease quote the attached list.',
			[upload('parts-list.csv')],
			'Phoned in: next release'
		);

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
		const entered = await enter(
			[
				'Phoned in by the buyer.',
				'',
				'  L760-128B  qty 4',
				'  NOT-A-PART-AT-ALL  qty 2',
				'',
				'Needed by October 2.'
			].join('\n'),
			[],
			'Phoned in: two parts'
		);

		const trail = await getTrail(db, DANA, entered.runKey);
		expect(trail).not.toBeNull();
		expect(trail!.wokeBy).toBe('person');
		expect(trail!.wokeNote).toContain(orders.label);
		expect(trail!.produced).toContain('No draft');
		expect(trail!.steps.some((step) => step.tool === 'validate_quote_request')).toBe(true);

		// It would not guess at a part the catalog does not have.
		const refusal = trail!.steps.find((step) => step.kind === 'refusal');
		expect(refusal).toBeDefined();
		expect([RULES.unresolvedLine.id, RULES.unmatchedSender.id]).toContain(refusal!.rule);

		// The same trail is found from the quote request's own page.
		const fromRequest = await getTrailForQuoteRequest(db, DANA, entered.draftId);
		expect(fromRequest?.runKey).toBe(entered.runKey);

		// And the harness's run log has it as one of the desk's runs.
		const [row] = await db.asUser(DANA, (tx) =>
			tx.sql<{ agent: string; work_kind: string }>`
				select agent, work_kind from nl.agent_runs where run_key = ${entered.runKey}`
		);
		expect(row.agent).toBe('order_desk');
		expect(row.work_kind).toBe('rfq');
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
		const entered = await enter('Please quote the list.', [upload('parts-list.csv')], 'Phoned in: the list again');
		const request = await getQuoteRequest(db, DANA, entered.draftId);
		const file = await readAttachment(db, DANA, entered.draftId, request!.attachments[0].id);
		expect(file).not.toBeNull();
		const response = fileResponse(file!.bytes, file!.mediaType, file!.fileName);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toBe(file!.mediaType);
		expect(Number(response.headers.get('content-length'))).toBe(file!.byteSize);
	});
});

describe('the old quote-request screen', () => {
	it('redirects /rfq to the desk', async () => {
		const { GET } = await import('../../../routes/rfq/+server.ts');
		// SvelteKit's redirect() throws; that is how a handler says so.
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
});

describe('a trail that cannot be written is never a reason a run fails', () => {
	it('says there is no such run rather than throwing', async () => {
		expect(await recordDeskTrail(db, ORDER_DESK_USER, { mailRunId: 999_999 })).toBeNull();
	});
});
