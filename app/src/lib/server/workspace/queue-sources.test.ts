// The queue over the order desk's real mail drafts (migration 0021), and over
// a source that is still not in the database (purchase requests, 0022).
//
// When the workspace was built, 0021 was on another branch, so its mail branch
// was assembled from whatever columns a table called nl.mail_drafts turned out
// to have. 0021 has landed, migration 0025 writes that branch out properly,
// and this file holds it to the real shape: the account comes from the message
// the draft replies to, and the reviewer comes from the mailbox.
//
// The fixtures are built through the desk's own queueDraft, which calls
// nl.queue_mail_draft. There is no INSERT grant on any of those tables for
// anybody, so a function is the only way in, which is the point of them.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '$lib/types';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import {
	approveDraft as approveOnDeskPage,
	finishRun,
	queueDraft,
	rejectDraft as rejectOnDeskPage,
	startRun
} from '../desk/writes.ts';
import { decideQueueItem } from './decide.ts';
import { listDecisions, listQueue, queueSources } from './queue.ts';

const TODAY = '2026-09-17';
const ADMIN = 1; // Elena Brooks
const DANA = 2; // an account manager, and not the order desk's reviewer

let db: Db;
/** The order desk mailbox from the seeded world, and who reviews it. */
let mailbox: { id: number; reviewer_id: number };
/** A message in that mailbox, matched to a customer by an agent run. */
let message: { id: number; customer_no: string; customer_name: string };
/** The draft that run left behind, which is the most faithful fixture here. */
let draftFromRun: number;

const user = (id: number, role: SessionUser['role'] = 'account_manager'): SessionUser => ({
	id,
	fullName: `Test ${id}`,
	title: '',
	role
});

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });

	const [box] = await db.asSystem(
		(tx) => tx.sql<{ id: number; reviewer_id: number }>`
			select id, reviewer_id from nl.mailboxes where kind = 'orders' and active`
	);
	mailbox = box;

	// A message the seeded world put in that mailbox, and an account to match
	// it to. The seed leaves messages unworked, which is the state the agent
	// finds them in.
	const [msg] = await db.asSystem(
		(tx) => tx.sql<{ id: number }>`
			select id from nl.mail_messages where mailbox_id = ${box.id} order by id limit 1`
	);
	const [customer] = await db.asSystem(
		(tx) => tx.sql<{ customer_no: string; name: string }>`
			select customer_no, name from nl.customers where not blocked and not closed
			order by customer_no limit 1`
	);
	message = { id: msg.id, customer_no: customer.customer_no, customer_name: customer.name };

	// One run, exactly as the agent makes one: start it, put a draft in the
	// queue, then close it with what it decided. Closing the run is what puts
	// the customer on the MESSAGE, which is where the queue reads the account
	// from, because a draft does not carry one.
	await db.asUser(mailbox.reviewer_id, async (tx) => {
		const base = randomUUID();
		const { runId } = await startRun(
			tx,
			{ messageId: message.id, mode: 'mock', model: null },
			`${base}-start`
		);
		const { draftId } = await queueDraft(tx, draftInput(), `${base}-draft`);
		await finishRun(
			tx,
			{
				runId,
				outcome: 'drafted',
				intent: 'price_question',
				confidence: 0.9,
				summary: 'They asked what two parts cost.',
				customerNo: message.customer_no,
				vendorNo: null,
				contactId: null,
				matchReason: 'the sending domain is on the account',
				messageStatus: 'drafted',
				lookups: [{ name: 'get_account', ms: 3 }],
				rounds: 1,
				inputTokens: 0,
				outputTokens: 0,
				draftId,
				rfqDraftId: null,
				error: null
			},
			`${base}-finish`
		);
		draftFromRun = draftId;
	});
});

afterAll(async () => {
	await db?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SUBJECT = 'Re: stack and clamp pricing';
const BODY = 'Both parts are in stock and the prices below hold for thirty days.';

/** What the agent would write, the same every time so two can be compared. */
function draftInput(options: { blockedReason?: string; inReplyTo?: number | null } = {}) {
	return {
		mailboxId: mailbox.id,
		inReplyToId: options.inReplyTo === undefined ? message.id : options.inReplyTo,
		to: ['buyer@driftlessmachinefab.example'],
		cc: [],
		subject: SUBJECT,
		body: BODY,
		intent: 'price_question',
		facts: [{ kind: 'own_price', subject: '10012', text: 'Their price for 10012 is 128.40 each.' }],
		attachments: [],
		blockedReason: options.blockedReason ?? ''
	};
}

/**
 * One more draft in the desk's queue, through the same function the agent's
 * run uses. The reviewer of the mailbox is whoever the world says it is, so
 * the test never assumes a person.
 */
async function newMailDraft(options: { blockedReason?: string; inReplyTo?: number | null } = {}) {
	const requestId = randomUUID();
	const { draftId } = await db.asUser(mailbox.reviewer_id, (tx) =>
		queueDraft(tx, draftInput(options), requestId)
	);
	return draftId;
}

async function mailRow(id: number) {
	const [row] = await db.asSystem(
		(tx) => tx.sql<Record<string, unknown>>`
			select status, subject, body, edited, reviewed_by, reject_reason, provider_message_id,
			       sent_at, send_attempts, error
			from nl.mail_drafts where id = ${id}`
	);
	return row;
}

async function auditFor(id: number) {
	return db.asSystem(
		(tx) => tx.sql<Record<string, unknown>>`
			select action, via, actor_id, detail from nl.audit_log
			where entity = 'mail_draft' and entity_id = ${String(id)} order by id`
	);
}

async function inQueue(userId: number, draftId: number, role: SessionUser['role'] = 'account_manager') {
	const items = await listQueue(db, user(userId, role), { source: 'mail' });
	return items.find((item) => item.sourceId === draftId);
}

async function errorOf(work: () => Promise<unknown>): Promise<AppError> {
	try {
		await work();
	} catch (error) {
		if (error instanceof AppError) return error;
		throw error;
	}
	throw new Error('expected the decision to be refused');
}

// ---------------------------------------------------------------------------

describe('the order desk in the queue', () => {
	it('says the mail source is there', async () => {
		expect(await queueSources(db, DANA)).toEqual({
			rfq: true,
			assistant: true,
			mail: true,
			purchase: false
		});
	});

	it('carries a mail draft with the account and reviewer the desk decides', async () => {
		// The draft the agent run in beforeAll left behind.
		const draftId = draftFromRun;
		const item = (await inQueue(mailbox.reviewer_id, draftId, 'operations'))!;

		expect(item).toMatchObject({
			source: 'mail',
			sourceId: draftId,
			// The draft's own subject is the one line of what is proposed.
			summary: SUBJECT,
			// Neither of these is a column on the draft: the account comes from
			// the message it answers, the reviewer from the mailbox.
			subjectKind: 'account',
			subjectNo: message.customer_no,
			subjectName: message.customer_name,
			reviewerId: mailbox.reviewer_id,
			createdVia: 'agent',
			createdBy: 'the order desk agent',
			createdById: null,
			status: 'waiting',
			// A reply proposes words, not an amount.
			value: null,
			needsYou: true
		});

		// The detail is what a reviewer needs: the words, and what they rest on.
		expect(item.detail.subject).toBe(SUBJECT);
		expect(item.detail.body).toBe(BODY);
		expect(item.detail.facts.map((f) => f.label)).toEqual(
			expect.arrayContaining(['Desk', 'To', 'About', 'In reply to', 'Rests on own_price'])
		);
		// And it links to the message the desk page lists it under.
		expect(item.detail.href).toBe(`/desk/${message.id}`);
	});

	it('is waiting on someone for anybody who is not the reviewer', async () => {
		const draftId = await newMailDraft();
		// The whole team reads the desk's mail, which is what makes a reviewer
		// worth having: Dana sees it but it is not hers to decide.
		const seen = (await inQueue(DANA, draftId))!;
		expect(seen.needsYou).toBe(false);
		expect(seen.reviewerId).toBe(mailbox.reviewer_id);
		expect(seen.reviewerId).not.toBe(DANA);
	});

	it('writes exactly what approving on the desk page writes', async () => {
		// Two identical drafts: one approved the way the desk page does it,
		// one approved through the queue.
		const onPage = await newMailDraft();
		const inQueueDraft = await newMailDraft();

		const pageRow = await mailRow(onPage);
		await approveOnDeskPage(db, mailbox.reviewer_id, {
			draftId: onPage,
			// The desk page's form is prefilled with what the agent wrote.
			subject: String(pageRow.subject),
			body: String(pageRow.body),
			expectedUpdatedAt: (await rowVersion(onPage))!,
			requestId: randomUUID()
		});

		const item = (await inQueue(mailbox.reviewer_id, inQueueDraft, 'operations'))!;
		const decided = await decideQueueItem(db, user(mailbox.reviewer_id, 'operations'), {
			source: 'mail',
			sourceId: inQueueDraft,
			decision: 'approve',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
		expect(decided.decision).toBe('approved');

		// The same row, and the same audit row by the same person.
		expect(await mailRow(inQueueDraft)).toEqual(await mailRow(onPage));
		expect(await mailRow(inQueueDraft)).toMatchObject({
			status: 'approved',
			subject: SUBJECT,
			body: BODY,
			edited: false,
			reviewed_by: mailbox.reviewer_id,
			// Approving sends nothing. Only nl.mark_mail_sent can say sent.
			sent_at: null,
			provider_message_id: null,
			send_attempts: 0
		});

		const fromPage = await auditFor(onPage);
		const fromQueue = await auditFor(inQueueDraft);
		expect(fromQueue.map((r) => r.action)).toEqual(['queue_mail_draft', 'approve_mail_draft']);
		expect(fromQueue.map((r) => [r.action, r.via, r.actor_id])).toEqual(
			fromPage.map((r) => [r.action, r.via, r.actor_id])
		);
		expect(fromQueue[1].detail).toEqual(fromPage[1].detail);
	});

	it('corrects and approves, and the desk records that it was rewritten', async () => {
		const draftId = await newMailDraft();
		const item = (await inQueue(mailbox.reviewer_id, draftId, 'operations'))!;

		const decided = await decideQueueItem(db, user(mailbox.reviewer_id, 'operations'), {
			source: 'mail',
			sourceId: draftId,
			decision: 'approve',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID(),
			edit: JSON.stringify({
				subject: 'Re: your pricing question',
				body: 'Both parts are in stock. The prices below hold until the end of the month.'
			})
		});
		expect(decided.decision).toBe('edited_approved');

		expect(await mailRow(draftId)).toMatchObject({
			status: 'approved',
			subject: 'Re: your pricing question',
			body: 'Both parts are in stock. The prices below hold until the end of the month.',
			// The desk's own function decides this by comparing what came in
			// with what the agent wrote.
			edited: true
		});
		expect((await auditFor(draftId))[1].detail).toMatchObject({ edited: true });
		expect((await listDecisions(db, DANA, 5))[0]).toMatchObject({
			source: 'mail',
			sourceId: draftId,
			decision: 'edited_approved'
		});
		expect(await inQueue(mailbox.reviewer_id, draftId, 'operations')).toBeUndefined();
	});

	it('is a 403 for somebody who is not the mailbox reviewer', async () => {
		const draftId = await newMailDraft();
		const item = (await inQueue(DANA, draftId))!;

		const refusal = await errorOf(() =>
			decideQueueItem(db, user(DANA), {
				source: 'mail',
				sourceId: draftId,
				decision: 'approve',
				expectedUpdatedAt: item.rowVersion,
				requestId: randomUUID()
			})
		);
		expect(refusal.status).toBe(403);
		expect(refusal.message).toContain('waiting on someone else');

		// The queue is not what makes that true: the desk's own function
		// refuses her just the same, which is the guarantee that holds.
		const direct = await errorOf(() =>
			approveOnDeskPage(db, DANA, {
				draftId,
				subject: '',
				body: '',
				expectedUpdatedAt: item.rowVersion,
				requestId: randomUUID()
			})
		);
		expect(direct.status).toBe(403);

		expect(await mailRow(draftId)).toMatchObject({ status: 'draft', reviewed_by: null });
		expect((await listDecisions(db, DANA, 50)).some((d) => d.source === 'mail' && d.sourceId === draftId)).toBe(
			false
		);
	});

	it('lets an admin decide what is waiting on the desk', async () => {
		const draftId = await newMailDraft();
		const item = (await inQueue(ADMIN, draftId, 'admin'))!;
		const decided = await decideQueueItem(db, user(ADMIN, 'admin'), {
			source: 'mail',
			sourceId: draftId,
			decision: 'reject',
			note: 'We rang them instead.',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
		expect(decided.decision).toBe('rejected');
		expect(await mailRow(draftId)).toMatchObject({
			status: 'rejected',
			reviewed_by: ADMIN,
			reject_reason: 'We rang them instead.'
		});
		expect(await inQueue(ADMIN, draftId, 'admin')).toBeUndefined();
	});

	it('shows a held draft as needing a correction, and will not approve it', async () => {
		const draftId = await newMailDraft({ blockedReason: 'The price could not be verified.' });
		const item = (await inQueue(mailbox.reviewer_id, draftId, 'operations'))!;
		expect(item.status).toBe('needs_review');
		expect(item.detail.facts).toEqual(
			expect.arrayContaining([
				{ label: 'The agent held this', value: 'The price could not be verified.' }
			])
		);

		// The desk refuses a held draft however it is approached, so the queue
		// says so on the row instead of offering a button that cannot work.
		const refusal = await errorOf(() =>
			decideQueueItem(db, user(mailbox.reviewer_id, 'operations'), {
				source: 'mail',
				sourceId: draftId,
				decision: 'approve',
				expectedUpdatedAt: item.rowVersion,
				requestId: randomUUID()
			})
		);
		expect(refusal.status).toBe(422);
		expect(await mailRow(draftId)).toMatchObject({ status: 'draft' });

		// Rejecting it is still possible, and that is the way out.
		const decided = await decideQueueItem(db, user(mailbox.reviewer_id, 'operations'), {
			source: 'mail',
			sourceId: draftId,
			decision: 'reject',
			note: 'Cannot stand behind that price.',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
		expect(decided.decision).toBe('rejected');
	});

	it('is a 409 when the row version is stale', async () => {
		const draftId = await newMailDraft();
		const refusal = await errorOf(() =>
			decideQueueItem(db, user(mailbox.reviewer_id, 'operations'), {
				source: 'mail',
				sourceId: draftId,
				decision: 'approve',
				expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
				requestId: randomUUID()
			})
		);
		expect(refusal.status).toBe(409);
		expect(await mailRow(draftId)).toMatchObject({ status: 'draft' });
	});

	it('writes once when the same decision arrives twice', async () => {
		const draftId = await newMailDraft();
		const item = (await inQueue(mailbox.reviewer_id, draftId, 'operations'))!;
		const input = {
			source: 'mail' as const,
			sourceId: draftId,
			decision: 'approve' as const,
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		};
		const first = await decideQueueItem(db, user(mailbox.reviewer_id, 'operations'), input);
		expect(first.replayed).toBe(false);
		const again = await decideQueueItem(db, user(mailbox.reviewer_id, 'operations'), input);
		expect(again.replayed).toBe(true);

		// One approval in the trail, one decision in the history.
		const audit = await auditFor(draftId);
		expect(audit.filter((r) => r.action === 'approve_mail_draft').length).toBe(1);
		const [counted] = await db.asSystem(
			(tx) => tx.sql<{ n: number }>`
				select count(*)::int as n from nl.queue_decisions
				where source = 'mail' and source_id = ${draftId}`
		);
		expect(counted.n).toBe(1);
	});

	it('takes a draft that answers nobody, and links to the desk itself', async () => {
		const draftId = await newMailDraft({ inReplyTo: null });
		const item = (await inQueue(mailbox.reviewer_id, draftId, 'operations'))!;
		// No message behind it means no account to name, and nothing to link to
		// but the desk.
		expect(item.subjectKind).toBeNull();
		expect(item.subjectNo).toBeNull();
		expect(item.detail.href).toBe('/desk');
		// It is still a decision waiting on the desk's reviewer.
		expect(item.reviewerId).toBe(mailbox.reviewer_id);
		await rejectOnDeskPage(db, mailbox.reviewer_id, {
			draftId,
			reason: 'tidying up the fixture',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
	});
});

describe('purchase requests, which are not in this database', () => {
	it('reports the source as absent and keeps it out of the view', async () => {
		expect((await queueSources(db, DANA)).purchase).toBe(false);
		expect(await listQueue(db, user(DANA), { source: 'purchase' })).toEqual([]);

		const [row] = await db.asSystem(
			(tx) => tx.sql<{ definition: string }>`
				select pg_catalog.pg_get_viewdef('nl.agent_queue'::regclass, true) as definition`
		);
		// The mail branch is in the view now; the purchase branch cannot be,
		// because a view's names are resolved when it is created.
		expect(row.definition).toContain('mail_drafts');
		expect(row.definition).not.toContain('purchase_request');
	});
});

/** The draft's current row version, as the queue hands it to a page. */
async function rowVersion(draftId: number): Promise<string | null> {
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ updated_at: Date }>`select updated_at from nl.mail_drafts where id = ${draftId}`
	);
	return row ? row.updated_at.toISOString() : null;
}
