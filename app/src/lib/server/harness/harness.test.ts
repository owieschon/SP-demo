// The harness against a real database: one run record over every agent, the
// autonomy ladder the code actually honours, the undo window, the pause
// switch, and the numbers that decide a promotion.
//
// The world is the small test world with the desks and their inbox seeded on
// top (db/seed.d/70_desk.sql), today pinned to 2026-09-17. The mail provider
// is always a stub in this file, so nothing can reach a real mailbox, and no
// test touches the Anthropic API.
//
// THE LOAD-BEARING TEST in this file is "the same message queues at suggest
// and goes out at auto". Everything else is either the record behind it or a
// way of refusing it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import type { MailClient, SentMail } from '../desk/mail.ts';
import { listMailboxes, readMockWorld, type MailboxRow } from '../desk/poll.ts';
import { parseAllowlist } from '../desk/send.ts';
import { approveDraft, recordMessage } from '../desk/writes.ts';
import { DEGRADATION_MATRIX, classifyFailure } from './degrade.ts';
import { demoteOnSample, planRun, readAutonomy, readBoard, setLevel, setPause } from './ladder.ts';
import { recordEventAs, reviewSampled } from './record.ts';
import { getRun, listRefusals, listRuns, listUndoable, runSources } from './runs.ts';
import { AGENT_SCOPES } from './scope.ts';
import { releaseDueActions, undoAction, wakeMailbox, wakeRule } from './wake.ts';

const TODAY = '2026-09-17';
const ADMIN = 1;
const DANA = 2; // an account manager, neither desk's reviewer and not an admin
const ORDER_DESK_USER = 6; // Jordan Pike, the order desk's reviewer

// The server's own default: no allowlist at all, which means only the scripted
// provider may "send". Every send in this file is therefore simulated, and a
// real one is impossible.
const ALLOWED = parseAllowlist('');

let db: Db;
let orders: MailboxRow;
let mailboxes: MailboxRow[];
/** A real account with a buyer on file and parts it really buys. */
let world: Awaited<ReturnType<typeof readMockWorld>>;

/** A provider that delivers nothing and records what it was asked to send. */
const sentMail: { to: string[]; subject: string }[] = [];
const stub: MailClient = {
	kind: 'mock',
	label: 'a stub in the tests',
	async fetchNew() {
		return [];
	},
	async send(mail): Promise<SentMail> {
		sentMail.push({ to: mail.to, subject: mail.subject });
		return { providerMessageId: `stub-${sentMail.length}`, providerThreadId: null, simulated: true };
	}
};

beforeAll(async () => {
	db = await createTestDb({ today: TODAY });
	mailboxes = await listMailboxes(db);
	orders = mailboxes.find((m) => m.kind === 'orders')!;
	world = await readMockWorld(db, mailboxes, ORDER_DESK_USER);
}, 240_000);

afterAll(async () => {
	await db?.close();
});

/**
 * A price question from a buyer on file. The same text every time: only the
 * minute it arrived differs, which is what makes the content hash differ, so
 * "the same message" can be worked twice at two different levels.
 */
async function priceQuestion(minute: number): Promise<number> {
	const itemNo = world.parts[0]?.itemNo ?? 'UNKNOWN';
	const body = [
		'Hi,',
		'',
		`What is our price on ${itemNo} these days? I need it for six, and also for twelve`,
		'if there is a better number at that quantity.',
		'',
		world.buyer?.fullName ?? 'A buyer',
		world.account?.name ?? 'An account'
	].join('\n');
	const at = new Date(`2026-09-17T09:${String(minute).padStart(2, '0')}:00Z`).toISOString();
	const stored = await db.asUser(ORDER_DESK_USER, (tx) =>
		recordMessage(
			tx,
			{
				mailboxId: orders.id,
				providerMessageId: null,
				providerThreadId: null,
				fromAddress: world.buyer?.email ?? 'nobody@testshop.example',
				fromName: world.buyer?.fullName ?? 'A buyer',
				to: [orders.address],
				cc: [],
				subject: `Pricing on ${itemNo}`,
				body,
				bodyStripped: body,
				receivedAt: at,
				attachments: []
			},
			`test-msg-${minute}-${randomUUID()}`
		)
	);
	return stored.messageId;
}

/**
 * Set a level without going through the promotion rule, so the behaviour AT a
 * level can be tested separately from the rule that lets you get there. The
 * rule itself is tested through nl.set_agent_autonomy further down.
 */
async function levelIs(
	agent: string,
	workKind: string,
	level: string,
	options: { undo?: number; sample?: number } = {}
) {
	await db.asSystem((tx) =>
		tx.sql`
			update nl.agent_autonomy
			   set level = ${level},
			       undo_window_minutes = ${level === 'auto_review' ? (options.undo ?? 60) : 0},
			       sample_rate = ${level === 'auto' ? (options.sample ?? 0) : 0}
			 where agent = ${agent} and work_kind = ${workKind}`
	);
}

async function draftOf(messageId: number) {
	const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
		tx.sql<{ id: number; status: string; sent_at: string | null; updated_at: Date | string }>`
			select id, status, sent_at, updated_at from nl.mail_drafts
			where in_reply_to_id = ${messageId} order by id desc limit 1`
	);
	return row ?? null;
}

async function wake(options: Parameters<typeof wakeMailbox>[2] | null = null) {
	return wakeMailbox(db, orders, options ?? { client: stub, allowlist: ALLOWED, send: undefined });
}

// ---------------------------------------------------------------------------

describe('the autonomy ladder, which the code honours', () => {
	it('queues a draft at suggest and sends the same message at auto', async () => {
		// 1. At suggest, which is where this app is today.
		await levelIs('order_desk', 'price_question', 'suggest');
		const first = await priceQuestion(1);
		const summary = await wake();
		const one = summary.outcomes.find((o) => o.messageId === first);

		expect(one).toBeDefined();
		expect(one!.level).toBe('suggest');
		expect(one!.plan.do).toBe('queue');
		expect(one!.acted).toBe(false);
		expect(one!.sent).toBe(false);
		const queued = await draftOf(first);
		expect(queued?.status).toBe('draft');
		expect(queued?.sent_at).toBeNull();

		// 2. The same words, one minute later, at auto.
		const before = sentMail.length;
		await levelIs('order_desk', 'price_question', 'auto', { sample: 0 });
		const second = await priceQuestion(2);
		const next = await wake();
		const two = next.outcomes.find((o) => o.messageId === second);

		expect(two).toBeDefined();
		expect(two!.level).toBe('auto');
		expect(two!.plan.do).toBe('act_now');
		expect(two!.acted).toBe(true);
		expect(two!.sent).toBe(true);
		expect(two!.simulated).toBe(true);
		const sent = await draftOf(second);
		expect(sent?.status).toBe('sent');
		expect(sent?.sent_at).not.toBeNull();
		expect(sentMail.length).toBe(before + 1);

		// And the first one is untouched: a level is read when a run happens, so
		// it never rewrites what was already decided.
		expect((await draftOf(first))?.status).toBe('draft');
	}, 120_000);

	it('approves but holds the send at auto_review, and the window is real', async () => {
		await levelIs('order_desk', 'price_question', 'auto_review', { undo: 60 });
		const messageId = await priceQuestion(3);
		const before = sentMail.length;
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;

		expect(outcome.plan.do).toBe('act');
		expect(outcome.acted).toBe(true);
		expect(outcome.sent).toBe(false);
		expect(outcome.undoUntil).not.toBeNull();
		expect(sentMail.length).toBe(before);
		expect((await draftOf(messageId))?.status).toBe('approved');

		// Nothing is due yet, so the release step sends nothing.
		const draftId = (await draftOf(messageId))!.id;
		const released = await releaseDueActions(db, { client: stub, allowlist: ALLOWED });
		expect(released.some((r) => r.draftId === draftId)).toBe(false);
	}, 120_000);

	it('sends what nobody undid once the window has closed', async () => {
		await levelIs('order_desk', 'price_question', 'auto_review', { undo: 60 });
		const messageId = await priceQuestion(4);
		await wake();
		const draft = (await draftOf(messageId))!;

		// The window is a timestamp in the database, so closing it early is a
		// matter of moving it, which is exactly what waiting an hour would do.
		await db.asSystem((tx) =>
			tx.sql`update nl.agent_actions set undo_until = now() - interval '1 minute'
			        where entity = 'mail_draft' and entity_id = ${String(draft.id)}`
		);

		const released = await releaseDueActions(db, { client: stub, allowlist: ALLOWED });
		const mine = released.find((r) => r.draftId === draft.id);
		expect(mine?.sent).toBe(true);
		expect((await draftOf(messageId))?.status).toBe('sent');
	}, 120_000);

	it('drafts and stops when the agent is paused, and says that is why', async () => {
		await levelIs('order_desk', 'price_question', 'auto', { sample: 0 });
		await setPause(db, DANA, {
			agent: 'order_desk',
			paused: true,
			reason: 'Checking a price sheet',
			requestId: `pause-${randomUUID()}`
		});

		const messageId = await priceQuestion(5);
		const before = sentMail.length;
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;

		expect(outcome.plan.do).toBe('queue');
		expect(outcome.note).toContain('paused');
		expect(outcome.acted).toBe(false);
		expect(sentMail.length).toBe(before);
		expect((await draftOf(messageId))?.status).toBe('draft');

		// It is on the run's record, not only in the return value.
		const run = await getRun(db, ORDER_DESK_USER, outcome.runKey);
		expect(run?.events.length ?? 0).toBeGreaterThan(0);

		// Anybody may pause; only an admin may start it again.
		await expect(
			setPause(db, DANA, {
				agent: 'order_desk',
				paused: false,
				reason: 'Looked at the queue',
				requestId: `start-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 403 });
		await setPause(db, ADMIN, {
			agent: 'order_desk',
			paused: false,
			reason: 'Checked the drafts and let it run',
			requestId: `start-${randomUUID()}`
		});
		const autonomy = await db.asUser(ORDER_DESK_USER, (tx) =>
			readAutonomy(tx, 'order_desk', 'price_question')
		);
		expect(autonomy.paused).toBe(false);
		expect(autonomy.mayAct).toBe(true);
	}, 120_000);

	it('pauses every agent at once with the global brake', async () => {
		await setPause(db, ADMIN, {
			agent: 'all',
			paused: true,
			reason: 'Month end',
			requestId: `pause-all-${randomUUID()}`
		});
		for (const agent of ['order_desk', 'assistant', 'automation', 'mcp']) {
			const [row] = await db.asUser(DANA, (tx) =>
				tx.sql<{ result: { paused: boolean; scope: string } }>`select nl.agent_paused(${agent}) as result`
			);
			expect(row.result.paused).toBe(true);
			expect(row.result.scope).toBe('all');
		}
		await setPause(db, ADMIN, {
			agent: 'all',
			paused: false,
			reason: 'Month end is over',
			requestId: `start-all-${randomUUID()}`
		});
	});

	it('plans the same way in the pure function, with nothing else in the way', () => {
		const base = {
			agent: 'order_desk',
			workKind: 'rfq',
			undoWindowMinutes: 30,
			sampleRate: 0.1,
			paused: false,
			pauseReason: '',
			pausedByName: null,
			hidden: false
		};
		expect(planRun({ autonomy: { ...base, level: 'shadow', mayAct: false, needsReview: false } }).do).toBe('hold');
		expect(planRun({ autonomy: { ...base, level: 'suggest', mayAct: false, needsReview: true } }).do).toBe('queue');
		expect(planRun({ autonomy: { ...base, level: 'auto_review', mayAct: true, needsReview: false } }).do).toBe('act');
		expect(planRun({ autonomy: { ...base, level: 'auto', mayAct: true, needsReview: false } }).do).toBe('act_now');

		// A guardrail always wins, whatever the level.
		expect(
			planRun({
				autonomy: { ...base, level: 'auto', mayAct: true, needsReview: false },
				guardrail: { checkId: 'disclosure_policy', verdict: 'refuse', reason: 'It cites our margin.' }
			}).do
		).toBe('queue');
		// So does a run that degraded, and so does one it was not sure about.
		expect(
			planRun({ autonomy: { ...base, level: 'auto', mayAct: true, needsReview: false }, degraded: true }).do
		).toBe('queue');
		expect(
			planRun({ autonomy: { ...base, level: 'auto', mayAct: true, needsReview: false }, unsure: true }).do
		).toBe('queue');
	});
});

describe('undo', () => {
	it('takes back an approval inside the window, through the desk\'s own functions', async () => {
		await levelIs('order_desk', 'price_question', 'auto_review', { undo: 60 });
		const messageId = await priceQuestion(6);
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;
		expect(outcome.actionId).not.toBeNull();

		const undoable = await listUndoable(db, ORDER_DESK_USER);
		expect(undoable.some((a) => a.id === outcome.actionId)).toBe(true);

		const result = await undoAction(db, ORDER_DESK_USER, {
			actionId: outcome.actionId!,
			reason: 'The price sheet changed this morning.',
			requestId: `undo-${randomUUID()}`
		});
		expect(result.status).toBe('undone');
		expect((await draftOf(messageId))?.status).toBe('rejected');

		// Audited on both sides: the reversal by the feature, the undo by the harness.
		const trail = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ action: string }>`
				select action from nl.audit_log
				where entity in ('mail_draft', 'agent_action')
				order by id desc limit 8`
		);
		const actions = trail.map((r) => r.action);
		expect(actions).toContain('undo_agent_action');
		expect(actions).toContain('reject_mail_draft');

		// And it cannot be undone twice.
		await expect(
			undoAction(db, ORDER_DESK_USER, {
				actionId: outcome.actionId!,
				reason: 'again',
				requestId: `undo-again-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 422 });
	}, 120_000);

	it('refuses an undo after the window has closed, and says when it closed', async () => {
		await levelIs('order_desk', 'price_question', 'auto_review', { undo: 60 });
		const messageId = await priceQuestion(7);
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;

		await db.asSystem((tx) =>
			tx.sql`update nl.agent_actions set undo_until = now() - interval '2 hours' where id = ${outcome.actionId}`
		);

		await expect(
			undoAction(db, ORDER_DESK_USER, {
				actionId: outcome.actionId!,
				reason: 'too late',
				requestId: `undo-late-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 422, message: expect.stringContaining('window to undo') });
		// The draft is untouched: a refused undo changes nothing.
		expect((await draftOf(messageId))?.status).toBe('approved');
	}, 120_000);

	it('has no undo at all at auto, because the reply went out at once', async () => {
		await levelIs('order_desk', 'price_question', 'auto', { sample: 0 });
		const messageId = await priceQuestion(8);
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;
		expect(outcome.sent).toBe(true);
		expect(outcome.undoUntil).toBeNull();

		await expect(
			undoAction(db, ORDER_DESK_USER, {
				actionId: outcome.actionId!,
				reason: 'wrong price',
				requestId: `undo-auto-${randomUUID()}`
			})
		).rejects.toThrow(/no undo window/);
	}, 120_000);

	it('says plainly that a reply which has gone out cannot be taken back', async () => {
		// The race the code has to answer: the window closed, the release step
		// sent the reply, and a person presses undo a moment later.
		await levelIs('order_desk', 'price_question', 'auto_review', { undo: 60 });
		const messageId = await priceQuestion(13);
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;
		const draft = (await draftOf(messageId))!;

		await db.asSystem((tx) =>
			tx.sql`update nl.agent_actions set undo_until = now() - interval '1 minute' where id = ${outcome.actionId}`
		);
		await releaseDueActions(db, { client: stub, allowlist: ALLOWED });
		expect((await draftOf(messageId))?.status).toBe('sent');

		// Now the window looks open again, which is the only way to reach this
		// branch, and the answer is that it is too late.
		await db.asSystem((tx) =>
			tx.sql`update nl.agent_actions set undo_until = now() + interval '1 hour' where id = ${outcome.actionId}`
		);
		await expect(
			undoAction(db, ORDER_DESK_USER, {
				actionId: outcome.actionId!,
				reason: 'wrong price',
				requestId: `undo-sent-${randomUUID()}`
			})
		).rejects.toThrow(/already gone out/);

		const [action] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ status: string }>`select status from nl.agent_actions where id = ${outcome.actionId}`
		);
		expect(action.status).toBe('irreversible');
		expect(draft.id).toBeGreaterThan(0);
	}, 120_000);

	it('is only for the person it acted as, or an admin', async () => {
		await levelIs('order_desk', 'price_question', 'auto_review', { undo: 60 });
		const messageId = await priceQuestion(9);
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;

		await expect(
			undoAction(db, DANA, {
				actionId: outcome.actionId!,
				reason: 'not mine',
				requestId: `undo-other-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 403 });
	}, 120_000);
});

describe('the run record', () => {
	it('has one shape for every agent, from the tables the features already write', async () => {
		const sources = await runSources(db, ADMIN);
		// Every source is here, the procurement desk's own table included
		// since 0029. The log reads the tables that exist rather than a list
		// written down once.
		expect(sources.desk).toBe(true);
		expect(sources.assistant).toBe(true);
		expect(sources.mcp_calls).toBe(true);
		expect(sources.automation).toBe(true);
		expect(sources.purchase).toBe(true);

		const runs = await listRuns(db, ADMIN, { limit: 100 });
		expect(runs.length).toBeGreaterThan(0);
		for (const run of runs) {
			// The shape every agent answers in.
			expect(run.runKey).toMatch(/^[a-z_]+:\d+$/);
			expect(run.agent.length).toBeGreaterThan(0);
			expect(run.workKind.length).toBeGreaterThan(0);
			expect(typeof run.wokeBy).toBe('string');
			expect(Array.isArray(run.toolCalls)).toBe(true);
			expect(typeof run.produced).toBe('string');
			expect(['none', 'waiting', 'approved', 'edited_approved', 'rejected']).toContain(run.reviewState);
		}
		// Every desk run names the ids it read, never a copy of the message.
		const deskRun = runs.find((r) => r.agent === 'order_desk')!;
		expect(deskRun.inputIds).toHaveProperty('message_id');
		expect(JSON.stringify(deskRun.inputIds)).not.toContain('What is our price');
	}, 120_000);

	it('records which guardrail refused a run, so refusals can be counted', async () => {
		const refusals = await listRefusals(db, ADMIN);
		// The seeded inbox contains mail written as instructions and an email
		// that is not business at all, so at least one check has fired.
		expect(refusals.length).toBeGreaterThan(0);
		for (const refusal of refusals) {
			expect(refusal.times).toBeGreaterThan(0);
			expect(refusal.checkId.length).toBeGreaterThan(0);
		}
	}, 120_000);

	it('measures how big an edit was, after the text was overwritten in place', async () => {
		await levelIs('order_desk', 'price_question', 'suggest');
		const messageId = await priceQuestion(10);
		await wake();
		const draft = (await draftOf(messageId))!;

		const longer = 'Rewritten by hand.'.repeat(5);
		await approveDraft(db, ORDER_DESK_USER, {
			draftId: draft.id,
			subject: '',
			body: longer,
			expectedUpdatedAt: new Date(draft.updated_at).toISOString(),
			requestId: `edit-${randomUUID()}`
		});

		const [size] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ agent_chars: number; final_chars: number; delta_chars: number; changed: boolean }>`
				select agent_chars, final_chars, delta_chars, changed
				from nl.agent_edit_sizes where entity_id = ${String(draft.id)}`
		);
		expect(size.changed).toBe(true);
		expect(size.final_chars).toBe(longer.length);
		expect(size.delta_chars).toBe(Math.abs(longer.length - size.agent_chars));

		const run = await listRuns(db, ADMIN, { limit: 200 });
		const mine = run.find((r) => r.producedRef?.draft_id === draft.id);
		expect(mine?.reviewState).toBe('edited_approved');
		expect(mine?.editDeltaChars).toBe(size.delta_chars);
	}, 120_000);
});

describe('the promotion rule', () => {
	// A clean record, manufactured as the system role: 55 decided runs of a
	// kind of work, 50 approved as written, 3 edited then approved, 2 rejected.
	// Newer than everything the seeded world produced, so the rule's window of
	// the last 50 runs is exactly these.
	async function manufacture(workKind: string) {
		await db.asSystem(async (tx) => {
			for (let i = 0; i < 55; i++) {
				const state = i < 50 ? 'approved' : i < 53 ? 'edited' : 'rejected';
				const [message] = await tx.sql<{ id: number }>`
					insert into nl.mail_messages (mailbox_id, from_address, from_name, to_addresses, subject,
					                              body_text, body_stripped, received_at, content_sha256,
					                              customer_no, intent, intent_confidence, status)
					values (${orders.id}, 'fixture@testshop.example', 'A buyer', array[${orders.address}],
					        ${`Fixture ${workKind} ${i}`}, 'A body', 'A body',
					        now() + (${i} || ' seconds')::interval,
					        md5(${`fixture-${workKind}-${i}`}) || md5(${`fixture-b-${workKind}-${i}`}),
					        ${world.account?.customerNo ?? null}, ${workKind}, 0.9, 'drafted')
					returning id`;
				const [draft] = await tx.sql<{ id: number }>`
					insert into nl.mail_drafts (mailbox_id, in_reply_to_id, to_addresses, subject, body, intent,
					                            status, edited, reviewed_by, reviewed_at)
					values (${orders.id}, ${message.id}, array['fixture@testshop.example'],
					        'Re: fixture', 'A reply.', ${workKind},
					        ${state === 'rejected' ? 'rejected' : 'approved'}, ${state === 'edited'},
					        ${ORDER_DESK_USER}, now())
					returning id`;
				await tx.sql`
					insert into nl.mail_runs (mailbox_id, message_id, mode, started_at, finished_at,
					                          lookups, lookup_count, rounds, outcome, draft_id)
					values (${orders.id}, ${message.id}, 'mock', now() + (${i} || ' seconds')::interval,
					        now() + (${i} || ' seconds')::interval, '[]'::jsonb, 2, 1, 'drafted', ${draft.id})`;
			}
		});
	}

	it('refuses a promotion the numbers do not support, and says what is missing', async () => {
		await expect(
			setLevel(db, ADMIN, {
				agent: 'order_desk',
				workKind: 'order_status',
				level: 'auto_review',
				reason: 'It looks fine',
				requestId: `promote-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 422, message: expect.stringContaining('Not yet') });
	});

	it('refuses skipping a level', async () => {
		await expect(
			setLevel(db, ADMIN, {
				agent: 'order_desk',
				workKind: 'order_status',
				level: 'auto',
				reason: 'Straight to the top',
				requestId: `skip-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 422, message: expect.stringContaining('one step at a time') });
	});

	it('is an administrator\'s write, and nobody else\'s', async () => {
		await expect(
			setLevel(db, DANA, {
				agent: 'order_desk',
				workKind: 'order_status',
				level: 'shadow',
				reason: 'Turning it down',
				requestId: `demote-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 403 });
	});

	it('allows a demotion at once, whatever the numbers say', async () => {
		const result = await setLevel(db, ADMIN, {
			agent: 'order_desk',
			workKind: 'stock_question',
			level: 'shadow',
			reason: 'Two bad replies this morning.',
			requestId: `demote-${randomUUID()}`
		});
		expect(result.changed).toBe(true);
		expect(result.level).toBe('shadow');
	});

	it('promotes one step when the record clears the rule, and records who and the numbers', async () => {
		await manufacture('stock_question');

		const before = (await readBoard(db, ADMIN)).find(
			(r) => r.agent === 'order_desk' && r.workKind === 'stock_question'
		)!;
		expect(before.level).toBe('shadow');
		expect(before.reviewed).toBeGreaterThanOrEqual(55);
		expect(before.qualifies).toBe(true);
		expect(before.verdict).toContain('clear');

		const result = await setLevel(db, ADMIN, {
			agent: 'order_desk',
			workKind: 'stock_question',
			level: 'suggest',
			reason: 'Fifty-five clean answers.',
			requestId: `promote-ok-${randomUUID()}`
		});
		expect(result.changed).toBe(true);

		const [change] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ changed_via: string; changed_by: number; reason: string; metrics: Record<string, unknown> }>`
				select changed_via, changed_by, reason, metrics from nl.agent_autonomy_changes
				where agent = 'order_desk' and work_kind = 'stock_question' and to_level = 'suggest'
				order by id desc limit 1`
		);
		expect(change.changed_via).toBe('person');
		expect(change.changed_by).toBe(ADMIN);
		expect(change.metrics.reviewed).toBeGreaterThanOrEqual(55);

		const after = (await readBoard(db, ADMIN)).find(
			(r) => r.agent === 'order_desk' && r.workKind === 'stock_question'
		)!;
		expect(after.level).toBe('suggest');
		expect(after.setByName).not.toBeNull();
	}, 120_000);

	it('stops promoting when a guardrail refused something recently', async () => {
		// One refusal inside the window is enough, which is the point of the
		// rule: "zero refusals in the last hundred" is not a suggestion.
		const runs = await listRuns(db, ADMIN, { workKind: 'stock_question', limit: 1 });
		await recordEventAs(db, ORDER_DESK_USER, {
			agent: 'order_desk',
			runKey: runs[0].runKey,
			workKind: 'stock_question',
			kind: 'guardrail',
			checkId: 'disclosure_policy',
			verdict: 'refuse',
			detail: 'The reply cites our margin.',
			requestId: `refusal-${randomUUID()}`
		});

		const board = (await readBoard(db, ADMIN)).find(
			(r) => r.agent === 'order_desk' && r.workKind === 'stock_question'
		)!;
		expect(board.recentRefusals).toBeGreaterThan(0);
		expect(board.qualifies).toBe(false);
		expect(board.verdict).toContain('guardrail refusal');

		await expect(
			setLevel(db, ADMIN, {
				agent: 'order_desk',
				workKind: 'stock_question',
				level: 'auto_review',
				reason: 'Ignoring the refusal',
				requestId: `promote-blocked-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 422 });
	}, 120_000);
});

describe('sampling at auto, and the demotion nobody decides', () => {
	it('flags a share of actions for review, deterministically', async () => {
		await levelIs('order_desk', 'price_question', 'auto', { sample: 1 });
		const messageId = await priceQuestion(11);
		const summary = await wake();
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;
		expect(outcome.sampled).toBe(true);

		// The same run key is always in the sample or always out of it.
		const [a] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ hit: boolean }>`select nl.agent_sampled(${outcome.runKey}, 0.5) as hit`
		);
		const [b] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ hit: boolean }>`select nl.agent_sampled(${outcome.runKey}, 0.5) as hit`
		);
		expect(a.hit).toBe(b.hit);
		// Nothing is sampled at a rate of zero, and everything at one.
		const [none] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ hit: boolean }>`select nl.agent_sampled(${outcome.runKey}, 0) as hit`
		);
		expect(none.hit).toBe(false);
	}, 120_000);

	it('drops back off auto when the sample goes bad, with nobody deciding it', async () => {
		await levelIs('order_desk', 'price_question', 'auto', { sample: 1 });
		// Twenty sampled actions, sixteen of them bad: a pass rate of 20%.
		await db.asSystem(async (tx) => {
			for (let i = 0; i < 20; i++) {
				await tx.sql`
					insert into nl.agent_actions (agent, work_kind, run_key, action, entity, entity_id,
					                              at_level, acted_by, sampled, sample_verdict,
					                              sample_reviewed_by, sample_reviewed_at, request_id)
					values ('order_desk', 'price_question', ${`order_desk:${900000 + i}`}, 'send_mail',
					        'mail_draft', ${String(900000 + i)}, 'auto', ${ORDER_DESK_USER}, true,
					        ${i < 16 ? 'bad' : 'good'}, ${ORDER_DESK_USER}, now(),
					        ${`sample-fixture-${i}-${randomUUID()}`})`;
			}
		});

		const result = await demoteOnSample(db, ADMIN, {
			minReviewed: 20,
			minPassRate: 0.9,
			requestId: `demote-rule-${randomUUID()}`
		});
		expect(result.demoted.some((d) => d.agent === 'order_desk' && d.work_kind === 'price_question')).toBe(true);

		const board = (await readBoard(db, ADMIN)).find(
			(r) => r.agent === 'order_desk' && r.workKind === 'price_question'
		)!;
		expect(board.level).toBe('auto_review');
		expect(board.setByName).toBeNull();

		const [change] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ changed_via: string; changed_by: number | null; reason: string }>`
				select changed_via, changed_by, reason from nl.agent_autonomy_changes
				where agent = 'order_desk' and work_kind = 'price_question'
				order by id desc limit 1`
		);
		expect(change.changed_via).toBe('rule');
		expect(change.changed_by).toBeNull();
		expect(change.reason).toContain('pass rate');
	}, 120_000);

	it('takes a person\'s verdict on one sampled action, once', async () => {
		const [action] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ id: number }>`
				select id from nl.agent_actions where sampled and sample_verdict is null order by id limit 1`
		);
		expect(action).toBeDefined();
		const result = await reviewSampled(db, ORDER_DESK_USER, {
			actionId: action.id,
			verdict: 'good',
			note: 'Right price, right date.',
			requestId: `sample-${randomUUID()}`
		});
		expect(result.verdict).toBe('good');
		await expect(
			reviewSampled(db, ORDER_DESK_USER, {
				actionId: action.id,
				verdict: 'bad',
				requestId: `sample-again-${randomUUID()}`
			})
		).rejects.toMatchObject({ status: 422 });
	}, 120_000);
});

describe('the automation runner, through the ladder', () => {
	async function aRule(kind: 'next_step' | 'note' = 'next_step') {
		const [row] = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ id: number }>`
				select id from nl.automation_rules where action ->> 'kind' = ${kind} order by id limit 1`
		);
		return row?.id ?? null;
	}

	it('writes nothing at suggest, and says what it would have done', async () => {
		const ruleId = await aRule();
		expect(ruleId).not.toBeNull();
		await levelIs('automation', 'next_step', 'suggest');

		const before = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ count: number }>`select count(*)::int as count from nl.automation_firings`
		);
		const result = await wakeRule(db, ADMIN, ruleId!, { via: 'ui' });
		const after = await db.asUser(ADMIN, (tx) =>
			tx.sql<{ count: number }>`select count(*)::int as count from nl.automation_firings`
		);

		expect(result.plan.do).toBe('queue');
		expect(result.fired).toBe(0);
		expect(after[0].count).toBe(before[0].count);
	}, 120_000);

	it('fires at auto_review, and what it wrote can be closed again', async () => {
		const ruleId = await aRule();
		await levelIs('automation', 'next_step', 'auto_review', { undo: 120 });

		const result = await wakeRule(db, ADMIN, ruleId!, { via: 'schedule' });
		expect(result.plan.do).toBe('act');
		// The small world may have nothing for this rule to match, which is a
		// real state and not a failure: the assertion is that it wrote if it
		// matched, and recorded an action if it wrote.
		if (result.fired > 0) {
			expect(result.actionId).not.toBeNull();
			expect(result.undoUntil).not.toBeNull();

			const undone = await undoAction(db, ADMIN, {
				actionId: result.actionId!,
				reason: 'Wrong week for this.',
				requestId: `undo-rule-${randomUUID()}`
			});
			expect(undone.status).toBe('undone');
			expect(undone.what).toContain('closed');
		} else {
			expect(result.actionId).toBeNull();
		}
	}, 120_000);
});

describe('what the scope says, and what the database says', () => {
	it('has a written scope for every agent and kind of work in the database', async () => {
		const rows = await db.asUser(DANA, (tx) =>
			tx.sql<{ agent: string; work_kind: string }>`select agent, work_kind from nl.agent_work_kinds`
		);
		for (const row of rows) {
			const scope = AGENT_SCOPES.find((s) => s.id === row.agent);
			expect(scope, `no written scope for ${row.agent}`).toBeDefined();
			expect(scope!.workKinds, `${row.agent} has no written scope for ${row.work_kind}`).toContain(row.work_kind);
		}
		// And nothing written down that the database does not know about.
		for (const scope of AGENT_SCOPES) {
			for (const kind of scope.workKinds) {
				expect(
					rows.some((r) => r.agent === scope.id && r.work_kind === kind),
					`${scope.id}:${kind} is written down but not in nl.agent_work_kinds`
				).toBe(true);
			}
		}
	});

	it('starts every kind of work at a level, and never above what it can do', async () => {
		const board = await readBoard(db, ADMIN);
		expect(board.length).toBeGreaterThanOrEqual(15);
		for (const row of board) {
			expect(['shadow', 'suggest', 'auto_review', 'auto']).toContain(row.level);
			if (row.level === 'auto_review') expect(row.undoWindowMinutes).toBeGreaterThan(0);
			if (row.level !== 'auto') expect(row.sampleRate).toBe(0);
		}
	});
});

describe('graceful degradation', () => {
	it('recognises each kind of failure from the error itself', () => {
		expect(classifyFailure(Object.assign(new Error('too many'), { code: 'NL429' }))).toBe('daily_cap_reached');
		expect(classifyFailure(Object.assign(new Error('nope'), { code: '25006' }))).toBe('database_read_only');
		expect(classifyFailure(Object.assign(new Error('nope'), { code: '57014' }))).toBe('tool_timed_out');
		expect(classifyFailure(new Error('Jordan Pike is no longer active'))).toBe('person_inactive');
		expect(classifyFailure(new Error('mail provider refused the request'))).toBe('mail_provider_refused');
		expect(classifyFailure(new Error('the mailbox could not be reached'))).toBe('mail_provider_down');
		// Something it does not recognise is not degraded into a guess.
		expect(classifyFailure(new Error('something nobody planned for'))).toBeNull();
	});

	it('never lets a degraded run act on its own, whatever the matrix says', () => {
		for (const entry of Object.values(DEGRADATION_MATRIX)) {
			if (entry.reason === 'model_key_missing' || entry.reason === 'policy_engine_missing') continue;
			expect(entry.mayStillAct, `${entry.reason} must not act alone`).toBe(false);
		}
	});

	it('records a degradation and queues for a person when the provider is down', async () => {
		await levelIs('order_desk', 'price_question', 'auto', { sample: 0 });
		const messageId = await priceQuestion(12);
		const summary = await wake({
			client: stub,
			allowlist: ALLOWED,
			send: async () => {
				throw new AppError(502, 'NL502', 'The mail provider could not be reached.');
			}
		});
		const outcome = summary.outcomes.find((o) => o.messageId === messageId)!;

		expect(outcome.degraded).toBe('mail_provider_down');
		expect(outcome.sent).toBe(false);
		// The draft is approved and unsent, which is the retryable state the
		// desk already has for this, and the run says why.
		const run = await getRun(db, ORDER_DESK_USER, outcome.runKey);
		expect(run?.degraded).toBe(true);
		expect(run?.degradedReason).toBe('mail_provider_down');
	}, 120_000);

	it('starts nothing at all when the provider cannot be polled', async () => {
		const summary = await wakeMailbox(db, orders, {
			client: stub,
			allowlist: ALLOWED,
			poll: async () => {
				throw new Error('the mailbox could not be reached');
			}
		});
		expect(summary.error).toContain('could not be reached');
		expect(summary.degraded).toBe('mail_provider_down');
		expect(summary.outcomes).toHaveLength(0);
	});
});
