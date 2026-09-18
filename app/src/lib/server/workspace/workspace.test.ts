// The agent workspace against a real database: one queue over every source,
// and a decision made there landing exactly where the feature's own page would
// have landed it.
//
// The small world, "today" pinned to 2026-09-17, plus the RFQ eval customers
// and parts. This file covers the two sources a person owns their own records
// in: quote requests (migration 0011) and assistant proposals (0017). The
// order desk's mail drafts are in queue-sources.test.ts, and the procurement
// desk's purchase requests (0022) are not in this database, which is what the
// degradation tests at the bottom check.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SessionUser } from '$lib/types';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { runTool } from '../assistant/gate.ts';
import { saveTurn, startConversation } from '../assistant/conversation.ts';
import type { ToolContext } from '../assistant/tools.ts';
import { approveDraft, createDraft, type DraftWriteResult } from '../rfq/drafts.ts';
import { loadEvalWorld } from '../rfq/evals.ts';
import { extractWithRules } from '../rfq/rules.ts';
import { decideQueueItem } from './decide.ts';
import { countQueue, listDecisions, listQueue, queueSources, subjectsOf } from './queue.ts';

const TODAY = '2026-09-17';
const ADMIN = 1;
const DANA = 2;
const MARCUS = 3;

let db: Db;
/** A commitment closed short, for the assistant to propose an outcome on. */
let closedShort: number;

const user = (id: number): SessionUser => ({
	id,
	fullName: `Test ${id}`,
	title: '',
	role: id === ADMIN ? 'admin' : 'account_manager',
	responsibility: ''
});

const CLEAN_EMAIL = `From: Micah Crowley <micah.crowley@driftlessmachinefab.example>
Subject: RFQ
Date: Wed, 16 Sep 2026 08:00:00 -0500

Please quote:
4 x S6-96BC
10 x CL6SZ

Needed by Oct 2.
`;

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });
	await loadEvalWorld(db);
	// A commitment whose window closed short, so record_outcome has something
	// real to be proposed about.
	const [row] = await db.asSystem(
		(tx) => tx.sql<{ id: number }>`
			insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on,
			                            confidence, created_by)
			values ('Clamp restock for the yard', '1228', ${DANA}, 5000, '2025-11-01', '2026-02-10', 60, ${DANA})
			returning id`
	);
	closedShort = row.id;
});

afterAll(async () => {
	await db?.close();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A quote request draft, read from the clean sample email. */
async function newDraft(userId = DANA): Promise<DraftWriteResult> {
	return createDraft(db, userId, {
		source: CLEAN_EMAIL,
		sourceName: 'test',
		extraction: { draft: extractWithRules(CLEAN_EMAIL, TODAY), extractor: 'rules', model: null, usage: null },
		requestId: randomUUID()
	});
}

/** A proposal on the screen, the way the assistant puts one there. */
async function newProposal(
	userId = DANA,
	commitmentId = closedShort
): Promise<{ proposalId: number; conversationId: number }> {
	const base = randomUUID();
	const ctx: ToolContext = {
		db,
		userId,
		today: TODAY,
		round: 1,
		requestId: (suffix) => `${base}-r1-${suffix}`
	};
	const run = await runTool(
		ctx,
		{
			id: 't1',
			name: 'propose_action',
			input: {
				summary: 'That window closed short. What happened?',
				options: [
					{ label: 'Still coming', tool: 'record_outcome', input: { commitment_id: commitmentId, outcome: 'pushed', note: 'Moved out.' } },
					{ label: 'They did not buy', tool: 'record_outcome', input: { commitment_id: commitmentId, outcome: 'broken', note: '' } }
				]
			}
		},
		{ proposalAllowed: true }
	);
	if (!run.proposal) throw new Error(`the proposal was refused: ${run.lookup.note}`);

	const { conversationId } = await startConversation(db, userId, {
		title: 'What should I do about this window?',
		mode: 'mock',
		requestId: `${base}-conv`
	});
	const saved = await saveTurn(db, userId, {
		conversationId,
		question: 'What should I do about this window?',
		answer: 'The options are above.',
		lookups: [run.lookup],
		proposal: run.proposal,
		usage: [],
		requestId: `${base}-turn`
	});
	return { proposalId: saved.proposalId!, conversationId };
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

async function queueFor(userId: number) {
	return listQueue(db, user(userId));
}

async function find(userId: number, source: string, sourceId: number) {
	const items = await queueFor(userId);
	return items.find((item) => item.source === source && item.sourceId === sourceId);
}

/**
 * What a quote request approval wrote, with the ids and timestamps that must
 * differ between two runs taken out, so two approvals can be compared.
 */
async function written(result: DraftWriteResult) {
	const [quote] = await db.asSystem(
		(tx) => tx.sql<Record<string, unknown>>`
			select customer_no, contact_id, quoted_on, valid_until, source, created_by
			from nl.quotes where id = ${result.quoteId!}`
	);
	const lines = await db.asSystem(
		(tx) => tx.sql<Record<string, unknown>>`
			select line_no, item_no, quantity, unit_price
			from nl.quote_lines where quote_id = ${result.quoteId!} order by line_no`
	);
	const [commitment] = await db.asSystem(
		(tx) => tx.sql<Record<string, unknown>>`
			select customer_no, buyer_contact_id, owner_id, committed_value, starts_on, ends_on,
			       confidence, created_by
			from nl.commitments where id = ${result.commitmentId!}`
	);
	const items = await db.asSystem(
		(tx) => tx.sql<Record<string, unknown>>`
			select item_no, quantity from nl.commitment_items
			where commitment_id = ${result.commitmentId!} order by item_no`
	);
	const audit = await db.asSystem(
		(tx) => tx.sql<Record<string, unknown>>`
			select action, via, actor_id from nl.audit_log
			where entity = 'rfq_draft' and entity_id = ${String(result.draftId)} order by id`
	);
	return { quote, lines, commitment, items, audit, total: result.total };
}

// ---------------------------------------------------------------------------

describe('the queue', () => {
	it('shows a quote request and an assistant proposal in one shape', async () => {
		const draft = await newDraft();
		const proposal = await newProposal();

		const items = await queueFor(DANA);
		const rfq = items.find((i) => i.source === 'rfq' && i.sourceId === draft.draftId);
		const assistant = items.find((i) => i.source === 'assistant' && i.sourceId === proposal.proposalId);

		expect(rfq).toBeDefined();
		expect(assistant).toBeDefined();

		// The same fields, whichever source the row came from.
		expect(rfq).toMatchObject({
			source: 'rfq',
			subjectKind: 'account',
			createdVia: 'person',
			createdById: DANA,
			reviewerId: DANA,
			needsYou: true,
			status: 'waiting'
		});
		expect(rfq!.summary).toContain(`R-${draft.draftId}`);
		expect(rfq!.value).toBeGreaterThan(0);
		expect(rfq!.detail.lines.length).toBe(2);
		expect(rfq!.rowVersion).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		expect(assistant).toMatchObject({
			source: 'assistant',
			createdVia: 'assistant',
			createdById: DANA,
			reviewerId: DANA,
			needsYou: true,
			status: 'waiting',
			// A proposal proposes an action, not an amount.
			value: null
		});
		expect(assistant!.detail.options.map((o) => o.tool)).toEqual(['record_outcome', 'record_outcome']);
		// The account comes from the commitment the first option names.
		expect(assistant!.subjectNo).toBe('1228');

		// Newest first.
		const positions = items.map((i) => Date.parse(i.createdAt));
		expect([...positions].sort((a, b) => b - a)).toEqual(positions);
	});

	it('counts what is waiting and lists the accounts it is about', async () => {
		const items = await queueFor(DANA);
		const counts = countQueue(items);
		expect(counts.total).toBe(items.length);
		expect(counts.needsYou + counts.needsSomeone).toBe(counts.total);
		expect(counts.bySource.rfq).toBeGreaterThan(0);
		expect(counts.bySource.assistant).toBeGreaterThan(0);
		// The seeded world has mail waiting to be worked but no drafts yet, and
		// purchase requests are not in this database at all.
		expect(counts.bySource.mail).toBe(0);
		expect(counts.bySource.purchase).toBe(0);

		const subjects = subjectsOf(items);
		expect(subjects.length).toBeGreaterThan(0);
		expect(subjects.every((s) => s.no && s.name)).toBe(true);
	});

	it('filters by source and by account', async () => {
		const draft = await newDraft();
		const onlyRfq = await listQueue(db, user(DANA), { source: 'rfq' });
		expect(onlyRfq.length).toBeGreaterThan(0);
		expect(onlyRfq.every((i) => i.source === 'rfq')).toBe(true);

		const mine = onlyRfq.find((i) => i.sourceId === draft.draftId)!;
		const byAccount = await listQueue(db, user(DANA), { subjectNo: mine.subjectNo });
		expect(byAccount.length).toBeGreaterThan(0);
		expect(byAccount.every((i) => i.subjectNo === mine.subjectNo)).toBe(true);
	});

	it('shows nobody else what is waiting on them', async () => {
		const draft = await newDraft(DANA);
		const proposal = await newProposal(DANA);

		// Row-level security on each source table decides this, not the queue:
		// an unapproved quote request is its creator's (or an admin's) and a
		// proposal is only ever its own person's.
		const marcus = await queueFor(MARCUS);
		expect(marcus.some((i) => i.source === 'rfq' && i.sourceId === draft.draftId)).toBe(false);
		expect(marcus.some((i) => i.source === 'assistant' && i.sourceId === proposal.proposalId)).toBe(false);

		const admin = await queueFor(ADMIN);
		expect(admin.some((i) => i.source === 'rfq' && i.sourceId === draft.draftId)).toBe(true);
		expect(admin.some((i) => i.source === 'assistant' && i.sourceId === proposal.proposalId)).toBe(false);
		// An admin looking at somebody else's draft is told whose it is.
		expect(admin.find((i) => i.sourceId === draft.draftId)!.needsYou).toBe(false);
	});
});

describe('approving through the queue', () => {
	it('writes exactly what approving on the quote request page writes', async () => {
		// Two drafts from the same email: one approved the way the page does
		// it, one approved through the queue.
		const onPage = await newDraft();
		const inQueue = await newDraft();

		const pageResult = await approveDraft(db, DANA, {
			draftId: onPage.draftId,
			expectedUpdatedAt: onPage.updatedAt,
			requestId: randomUUID()
		});

		const item = (await find(DANA, 'rfq', inQueue.draftId))!;
		const decided = await decideQueueItem(db, user(DANA), {
			source: 'rfq',
			sourceId: inQueue.draftId,
			decision: 'approve',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
		expect(decided.decision).toBe('approved');

		const queueResult: DraftWriteResult = {
			draftId: inQueue.draftId,
			updatedAt: '',
			replayed: false,
			quoteId: (decided.result as { quoteId: number }).quoteId,
			commitmentId: (decided.result as { commitmentId: number }).commitmentId,
			total: (decided.result as { total: number }).total
		};

		const fromPage = await written(pageResult);
		const fromQueue = await written(queueResult);

		// The same quote, the same lines, the same commitment, the same scope,
		// the same money, and the same audit action by the same person.
		expect(fromQueue.quote).toEqual(fromPage.quote);
		expect(fromQueue.lines).toEqual(fromPage.lines);
		expect(fromQueue.commitment).toEqual(fromPage.commitment);
		expect(fromQueue.items).toEqual(fromPage.items);
		expect(fromQueue.total).toEqual(fromPage.total);
		expect(fromQueue.audit).toEqual(fromPage.audit);
		expect(fromQueue.audit.map((a) => a.action)).toEqual(['save_rfq_draft', 'approve_rfq_draft']);
	});

	it("runs an assistant proposal through the assistant's own approval", async () => {
		const target = await db.asSystem(
			(tx) => tx.sql<{ id: number }>`
				insert into nl.commitments (title, customer_no, owner_id, committed_value, starts_on, ends_on,
				                            confidence, created_by)
				values ('Stack order that closed short', '1228', ${DANA}, 4000, '2025-10-01', '2026-01-10', 60, ${DANA})
				returning id`
		);
		const commitmentId = target[0].id;
		const proposal = await newProposal(DANA, commitmentId);

		const item = (await find(DANA, 'assistant', proposal.proposalId))!;
		const decided = await decideQueueItem(db, user(DANA), {
			source: 'assistant',
			sourceId: proposal.proposalId,
			decision: 'approve',
			optionIndex: 0,
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
		expect(decided.decision).toBe('approved');

		// The outcome was written by the assistant's own path: one answer, by
		// this person, with via = 'assistant' in the trail.
		const answers = await db.asSystem(
			(tx) => tx.sql<{ outcome: string; source: string; answered_by: number; note: string }>`
				select outcome, source, answered_by, note from nl.commitment_outcomes
				where commitment_id = ${commitmentId}`
		);
		expect(answers).toEqual([{ outcome: 'pushed', source: 'person', answered_by: DANA, note: 'Moved out.' }]);
		const audit = await db.asSystem(
			(tx) => tx.sql<{ via: string; actor_id: number }>`
				select via, actor_id from nl.audit_log
				where action = 'record_outcome' and entity_id = ${String(commitmentId)}`
		);
		expect(audit).toEqual([{ via: 'assistant', actor_id: DANA }]);

		// And it has left the queue.
		expect(await find(DANA, 'assistant', proposal.proposalId)).toBeUndefined();
	});

	it('corrects and approves, and says it was corrected', async () => {
		const draft = await newDraft();
		const item = (await find(DANA, 'rfq', draft.draftId))!;
		const firstLine = item.detail.lines[0];

		const decided = await decideQueueItem(db, user(DANA), {
			source: 'rfq',
			sourceId: draft.draftId,
			decision: 'approve',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID(),
			edit: JSON.stringify({ lines: [{ line: firstLine.line, quantity: 9 }] })
		});
		expect(decided.decision).toBe('edited_approved');

		// The correction went through the revise step, so the quote carries the
		// quantity the person typed, not the one the email asked for.
		const lines = await db.asSystem(
			(tx) => tx.sql<{ item_no: string; quantity: number }>`
				select item_no, quantity from nl.quote_lines
				where quote_id = ${(decided.result as { quoteId: number }).quoteId} order by line_no`
		);
		expect(lines[0]).toMatchObject({ item_no: firstLine.itemNo, quantity: 9 });

		// The trail shows the correction and then the approval.
		const audit = await db.asSystem(
			(tx) => tx.sql<{ action: string }>`
				select action from nl.audit_log
				where entity = 'rfq_draft' and entity_id = ${String(draft.draftId)} order by id`
		);
		expect(audit.map((a) => a.action)).toEqual(['save_rfq_draft', 'revise_rfq_draft', 'approve_rfq_draft']);

		const [history] = await listDecisions(db, DANA, 1);
		expect(history).toMatchObject({ source: 'rfq', sourceId: draft.draftId, decision: 'edited_approved' });
	});

	it('leaves the queue when it is rejected, and writes nothing', async () => {
		const draft = await newDraft();
		const before = await quoteCount();
		const item = (await find(DANA, 'rfq', draft.draftId))!;

		const decided = await decideQueueItem(db, user(DANA), {
			source: 'rfq',
			sourceId: draft.draftId,
			decision: 'reject',
			note: 'They went elsewhere.',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
		expect(decided.decision).toBe('rejected');
		expect(await quoteCount()).toBe(before);
		expect(await find(DANA, 'rfq', draft.draftId)).toBeUndefined();

		const [history] = await listDecisions(db, DANA, 1);
		expect(history).toMatchObject({ decision: 'rejected', note: 'They went elsewhere.' });
	});
});

describe('what the queue refuses', () => {
	it('is a 404 for an item that is not yours', async () => {
		// Row-level security gets there before any role check: somebody else's
		// quote request is not in your queue at all, so there is nothing to be
		// forbidden from. The 403 path is the reviewer rule, which needs a
		// source whose rows the whole team can see (see queue-sources.test.ts).
		const draft = await newDraft(DANA);
		const item = (await find(DANA, 'rfq', draft.draftId))!;
		const refusal = await errorOf(() =>
			decideQueueItem(db, user(MARCUS), {
				source: 'rfq',
				sourceId: draft.draftId,
				decision: 'approve',
				expectedUpdatedAt: item.rowVersion,
				requestId: randomUUID()
			})
		);
		expect(refusal.status).toBe(404);
		// And nothing was recorded about it.
		expect((await listDecisions(db, DANA, 50)).some((d) => d.sourceId === draft.draftId)).toBe(false);
	});

	it('is a 409 when the row version is stale', async () => {
		const draft = await newDraft();
		const refusal = await errorOf(() =>
			decideQueueItem(db, user(DANA), {
				source: 'rfq',
				sourceId: draft.draftId,
				decision: 'approve',
				expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
				requestId: randomUUID()
			})
		);
		expect(refusal.status).toBe(409);
		expect(refusal.message).toContain('Reload');
		// Still waiting, untouched.
		expect(await find(DANA, 'rfq', draft.draftId)).toBeDefined();
	});

	it('writes once when the same decision arrives twice', async () => {
		const draft = await newDraft();
		const item = (await find(DANA, 'rfq', draft.draftId))!;
		const requestId = randomUUID();
		const input = {
			source: 'rfq' as const,
			sourceId: draft.draftId,
			decision: 'approve' as const,
			expectedUpdatedAt: item.rowVersion,
			requestId
		};

		const first = await decideQueueItem(db, user(DANA), input);
		expect(first.replayed).toBe(false);
		const again = await decideQueueItem(db, user(DANA), input);
		expect(again.replayed).toBe(true);

		// One quote, one commitment, one decision row.
		const [counted] = await db.asSystem(
			(tx) => tx.sql<{ quotes: number; decisions: number }>`
				select (select count(*)::int from nl.quotes q
				        where q.id = ${(first.result as { quoteId: number }).quoteId}) as quotes,
				       (select count(*)::int from nl.queue_decisions d
				        where d.source = 'rfq' and d.source_id = ${draft.draftId}) as decisions`
		);
		expect(counted).toEqual({ quotes: 1, decisions: 1 });
	});

	it('refuses a decision on a source this database does not have', async () => {
		const refusal = await errorOf(() =>
			decideQueueItem(db, user(DANA), {
				source: 'purchase',
				sourceId: 1,
				decision: 'approve',
				expectedUpdatedAt: '2026-09-17T00:00:00.000Z',
				requestId: randomUUID()
			})
		);
		// There is no such row, because migration 0022 is not applied here, so
		// there is no such table.
		expect(refusal.status).toBe(404);
	});
});

describe('the record of decisions', () => {
	it('says who decided and when, and keeps the request id the write ran under', async () => {
		const draft = await newDraft();
		const item = (await find(DANA, 'rfq', draft.draftId))!;
		const requestId = randomUUID();
		const before = new Date();

		await decideQueueItem(db, user(DANA), {
			source: 'rfq',
			sourceId: draft.draftId,
			decision: 'reject',
			note: 'Duplicate of an earlier request.',
			expectedUpdatedAt: item.rowVersion,
			requestId
		});

		const [row] = await db.asSystem(
			(tx) => tx.sql<{
				source: string;
				source_id: number;
				decision: string;
				decided_by: number;
				decided_at: Date;
				note: string;
				request_id: string;
			}>`
				select source, source_id, decision, decided_by, decided_at, note, request_id
				from nl.queue_decisions where source = 'rfq' and source_id = ${draft.draftId}`
		);
		expect(row).toMatchObject({
			source: 'rfq',
			source_id: draft.draftId,
			decision: 'rejected',
			decided_by: DANA,
			note: 'Duplicate of an earlier request.',
			// The id the reject itself ran under, which is what ties this row to
			// the audit row the source wrote.
			request_id: requestId
		});
		expect(row.decided_at.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

		// The whole team can read the workspace's history, like the audit log.
		const seenByMarcus = await listDecisions(db, MARCUS, 50);
		expect(seenByMarcus.some((d) => d.sourceId === draft.draftId && d.source === 'rfq')).toBe(true);
		expect(seenByMarcus.find((d) => d.sourceId === draft.draftId)!.decidedBy).toBeTruthy();
	});

	it("writes an audit row of its own beside the source's", async () => {
		const draft = await newDraft();
		const item = (await find(DANA, 'rfq', draft.draftId))!;
		await decideQueueItem(db, user(DANA), {
			source: 'rfq',
			sourceId: draft.draftId,
			decision: 'reject',
			expectedUpdatedAt: item.rowVersion,
			requestId: randomUUID()
		});
		const rows = await db.asSystem(
			(tx) => tx.sql<{ via: string; actor_id: number; detail: Record<string, unknown> }>`
				select via, actor_id, detail from nl.audit_log
				where action = 'queue_decision' and (detail ->> 'source_id')::bigint = ${draft.draftId}`
		);
		expect(rows.length).toBe(1);
		expect(rows[0]).toMatchObject({ via: 'ui', actor_id: DANA });
		expect(rows[0].detail).toMatchObject({ source: 'rfq', decision: 'rejected' });
	});
});

describe('the sources this database has', () => {
	it('says which sources it has', async () => {
		// Every source is here now: 0011, 0017, 0021 and the procurement desk
		// in 0029, which 0030 rebuilt the view to include.
		expect(await queueSources(db, DANA)).toEqual({
			rfq: true,
			assistant: true,
			mail: true,
			purchase: true
		});
	});

	it('names every table it was built over', async () => {
		const [row] = await db.asSystem(
			(tx) => tx.sql<{ definition: string }>`
				select pg_catalog.pg_get_viewdef('nl.agent_queue'::regclass, true) as definition`
		);
		expect(row.definition).toContain('rfq_drafts');
		expect(row.definition).toContain('assistant_proposals');
		expect(row.definition).toContain('mail_drafts');
		expect(row.definition).toContain('purchase_request');
	});

	it('still reads the queue with nothing waiting at all', async () => {
		// A person with no records of their own sees an empty queue, not an
		// error. This is the "Nothing is waiting on you" case.
		const items = await queueFor(MARCUS);
		expect(items.every((i) => i.needsYou === false || i.createdById === MARCUS)).toBe(true);
		expect(Array.isArray(items)).toBe(true);
	});
});

async function quoteCount(): Promise<number> {
	const [row] = await db.asSystem((tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.quotes`);
	return row.n;
}
