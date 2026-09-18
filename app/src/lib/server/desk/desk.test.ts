// The order desk against a real database: waking on mail, resolving the
// sender, answering each intent from the book, and the queue a person
// approves.
//
// The world is the small test world with the desks and their inbox seeded on
// top (db/seed.d/70_desk.sql). "Today" is pinned to 2026-09-17. The mail
// provider is always the scripted one, so no test can reach a real mailbox or
// the Anthropic API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { moneyExact } from '$lib/format';
import type { Fact } from '$lib/desk/types';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import type { MailClient } from './mail.ts';
import { MailProviderError } from './agentmail.ts';
import { createMockClient } from './mock.ts';
import { listMailboxes, pollAll, readMockWorld, type MailboxRow, type PollSummary } from './poll.ts';
import { getDraft, getMessage, listMailboxViews, listMessages, listQueue } from './read.ts';
import { checkDraft } from './policy.ts';
import { parseAllowlist, sendApproved } from './send.ts';
import { approveDraft, queueDraft, rejectDraft, recordMessage } from './writes.ts';

const TODAY = '2026-09-17';
const ADMIN = 1;
const DANA = 2; // an account manager, not either desk's reviewer
const ORDER_DESK_USER = 6; // Jordan Pike
const PROCUREMENT_USER = 13; // Lena Ortmann

// No allowlist at all, which is this server's default: the pages show the
// rule as empty and only the scripted provider may "send". The narrow list
// below is what the allowlist test uses.
const NO_LIST = parseAllowlist('');
const NARROW = parseAllowlist('@testshop.example');

let db: Db;
let mailboxes: MailboxRow[];
let orders: MailboxRow;
let client: MailClient;
let summaries: PollSummary[];

beforeAll(async () => {
	db = await createTestDb({ today: TODAY });
	mailboxes = await listMailboxes(db);
	orders = mailboxes.find((m) => m.kind === 'orders')!;
	client = createMockClient(await readMockWorld(db, mailboxes, ORDER_DESK_USER));
	// One poll works the seeded inbox and whatever the scripted mailbox adds.
	summaries = await pollAll(db, { client, mode: 'mock', maxRuns: 20 });
}, 180_000);

afterAll(async () => {
	await db?.close();
});

async function inbox() {
	return listMessages(db, ORDER_DESK_USER, { limit: 100 });
}

async function draftsFor(messageId: number) {
	const detail = await getMessage(db, ORDER_DESK_USER, messageId, NO_LIST);
	return detail!.drafts;
}

function factKinds(facts: Fact[]): string[] {
	return [...new Set(facts.map((f) => f.kind))];
}

/** Queue a draft of our own, so the approval tests do not disturb the agent's. */
async function queueOwn(overrides: Partial<Parameters<typeof queueDraft>[1]> = {}) {
	const result = await db.asUser(ORDER_DESK_USER, (tx) =>
		queueDraft(
			tx,
			{
				mailboxId: orders.id,
				inReplyToId: null,
				to: ['buyer@testshop.example'],
				cc: [],
				subject: 'Re: your request',
				body: 'Your price is $10.00 each.',
				intent: 'price_question',
				facts: [
					{
						kind: 'own_price',
						text: 'A part at 1: $10.00 each.',
						subject: '10012',
						ids: { item_no: 'X' },
						amounts: [10]
					}
				],
				attachments: [],
				blockedReason: '',
				...overrides
			},
			randomUUID()
		)
	);
	return getDraft(db, ORDER_DESK_USER, result.draftId, NO_LIST);
}

// ---------------------------------------------------------------------------
// Waking on mail
// ---------------------------------------------------------------------------

describe('the poll', () => {
	it('works both desks and starts a run per message', () => {
		expect(summaries).toHaveLength(2);
		for (const summary of summaries) {
			expect(summary.error).toBeNull();
			expect(summary.runs.length).toBeGreaterThan(0);
			for (const run of summary.runs) {
				expect(run.error).toBeNull();
				expect(['drafted', 'needs_person']).toContain(run.outcome);
			}
		}
	});

	it('delivers the scripted mail and works the seeded inbox', async () => {
		const messages = await inbox();
		expect(messages.length).toBeGreaterThanOrEqual(8);
		// Nothing is left unworked: every message has an intent and a run.
		expect(messages.every((m) => m.intent !== null)).toBe(true);
		expect(messages.every((m) => m.status === 'drafted' || m.status === 'needs_person')).toBe(true);
	});

	it('gives every message a draft, and every draft waits for a person', async () => {
		const queue = await listQueue(db, ORDER_DESK_USER, NO_LIST, { status: 'all', limit: 100 });
		expect(queue.length).toBeGreaterThanOrEqual(8);
		expect(queue.every((d) => d.status === 'draft')).toBe(true);
		expect(queue.every((d) => d.sentAt === null && d.providerMessageId === null)).toBe(true);
	});

	it('never works the same message twice', async () => {
		const before = await inbox();
		const again = await pollAll(db, { client, mode: 'mock', maxRuns: 20 });
		const after = await inbox();

		expect(after).toHaveLength(before.length);
		expect(again.every((s) => s.delivered === 0)).toBe(true);
		expect(again.reduce((sum, s) => sum + s.duplicates, 0)).toBeGreaterThan(0);
		// And nothing was run again: no message has two runs.
		for (const message of after.slice(0, 5)) {
			const detail = await getMessage(db, ORDER_DESK_USER, message.id, NO_LIST);
			expect(detail!.runs).toHaveLength(1);
		}
	});

	it('drops a message it has already stored, whatever the provider calls it', async () => {
		const [first] = await inbox();
		const detail = await getMessage(db, ORDER_DESK_USER, first.id, NO_LIST);
		const stored = await db.asUser(ORDER_DESK_USER, (tx) =>
			recordMessage(
				tx,
				{
					mailboxId: orders.id,
					// A different provider id, the same content.
					providerMessageId: 'a-different-provider-id',
					providerThreadId: null,
					fromAddress: first.fromAddress,
					fromName: first.fromName,
					to: [orders.address],
					cc: [],
					subject: first.subject,
					body: detail!.bodyText,
					bodyStripped: detail!.bodyText,
					receivedAt: first.receivedAt,
					attachments: []
				},
				randomUUID()
			)
		);
		expect(stored).toEqual({ messageId: first.id, duplicate: true });
	});

	it('stores inbound spreadsheet attachments for display without parsing them', async () => {
		const bytes = Buffer.from('not a workbook');
		const stored = await db.asUser(ORDER_DESK_USER, (tx) =>
			recordMessage(
				tx,
				{
					mailboxId: orders.id,
					providerMessageId: 'attachment-boundary-1',
					providerThreadId: null,
					fromAddress: 'buyer@testshop.example',
					fromName: 'Sample buyer',
					to: [orders.address],
					cc: [],
					subject: 'Spreadsheet attached',
					body: 'Please review the attached request.',
					bodyStripped: 'Please review the attached request.',
					receivedAt: `${TODAY}T18:00:00Z`,
					attachments: [
						{
							file_name: 'request.xlsx',
							media_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
							size_bytes: bytes.byteLength,
							base64: bytes.toString('base64')
						}
					]
				},
				randomUUID()
			)
		);
		const detail = await getMessage(db, ORDER_DESK_USER, stored.messageId, NO_LIST);

		expect(stored.duplicate).toBe(false);
		expect(detail?.attachments).toEqual([
			{
				id: expect.any(Number),
				fileName: 'request.xlsx',
				mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
				sizeBytes: bytes.byteLength,
				documentAttachmentId: null
			}
		]);

		// Let the normal desk flow finish the message so later mailbox counts
		// keep their no-waiting-mail invariant. The invalid workbook bytes are
		// ignored because mail attachments are display-only at this boundary.
		await pollAll(db, { client, mode: 'mock', maxRuns: 20 });
	});

	it('counts what is waiting per desk', async () => {
		const views = await listMailboxViews(db, ORDER_DESK_USER);
		expect(views).toHaveLength(2);
		const orderView = views.find((v) => v.kind === 'orders')!;
		expect(orderView.reviewerId).toBe(ORDER_DESK_USER);
		expect(orderView.disclosure).toBe('customer');
		expect(orderView.queued).toBeGreaterThan(0);
		expect(orderView.waiting).toBe(0);
		expect(orderView.runsToday).toBeGreaterThan(0);
		expect(orderView.runsToday).toBeLessThanOrEqual(orderView.runsCap);

		const procurementView = views.find((v) => v.kind === 'procurement')!;
		expect(procurementView.reviewerId).toBe(PROCUREMENT_USER);
		expect(procurementView.disclosure).toBe('vendor');
	});
});

// ---------------------------------------------------------------------------
// Who wrote to us
// ---------------------------------------------------------------------------

describe('resolving the sender', () => {
	it('matches a buyer whose address is on file', async () => {
		const messages = await inbox();
		const known = messages.filter((m) => m.contactName !== null);
		expect(known.length).toBeGreaterThan(0);
		for (const message of known) {
			expect(message.customerNo).not.toBeNull();
			expect(message.matchReason).toContain(message.fromAddress);
		}
	});

	it('handles a domain several branches share', async () => {
		const messages = await inbox();
		const shared = messages.find((m) => m.matchReason.includes('share'));
		expect(shared).toBeDefined();
		// Either the mail named the branch, in which case it is matched, or it
		// did not, in which case nobody is guessed at and a person is asked.
		if (shared!.customerNo === null) {
			expect(shared!.status).toBe('needs_person');
			expect(shared!.matchReason).toContain('does not say which branch');
		} else {
			expect(shared!.matchReason).toMatch(/the mail names/);
		}
	});

	it('asks a person about a sender it has never seen', async () => {
		const messages = await inbox();
		const unknown = messages.find((m) => m.fromAddress.startsWith('shop@bentaxle'));
		expect(unknown).toBeDefined();
		expect(unknown!.customerNo).toBeNull();
		expect(unknown!.status).toBe('needs_person');

		const [draft] = await draftsFor(unknown!.id);
		expect(draft.body).toMatch(/account number/);
		// Nothing was priced for somebody we cannot identify.
		expect(draft.facts).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

describe('what the desk answers', () => {
	it('quotes an emailed request with prices, availability and a validity date', async () => {
		const messages = await inbox();
		const rfq = messages.find((m) => m.intent === 'rfq' && m.customerNo !== null && m.status === 'drafted');
		expect(rfq).toBeDefined();

		const [draft] = await draftsFor(rfq!.id);
		expect(draft.intent).toBe('rfq');
		const kinds = factKinds(draft.facts);
		expect(kinds).toContain('account_identity');
		expect(kinds).toContain('own_price');
		expect(kinds).toContain('part_description');
		expect(draft.body).toMatch(/Subtotal/);
		expect(draft.body).toMatch(/This quote holds until/);
		expect(draft.body).toContain('Northline Exhaust Co.');
		expect(draft.to).toEqual([rfq!.fromAddress]);
	});

	it('links an emailed request to an RFQ draft, so one approval covers both', async () => {
		const messages = await inbox();
		const rfq = messages.find((m) => m.intent === 'rfq' && m.rfqDraftId !== null);
		expect(rfq).toBeDefined();
		const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ id: number; status: string; created_by: number }>`
				select id, status, created_by from nl.rfq_drafts where id = ${rfq!.rfqDraftId}`
		);
		expect(row.status).toBe('draft');
		// Made in the reviewer's name, so it lands in the queue of whoever has
		// to approve the quote.
		expect(row.created_by).toBe(ORDER_DESK_USER);
	});

	it('acknowledges a purchase order with the dates it can keep', async () => {
		const messages = await inbox();
		const order = messages.find((m) => m.intent === 'purchase_order' && m.customerNo !== null);
		expect(order).toBeDefined();

		const [draft] = await draftsFor(order!.id);
		expect(draft.intent).toBe('purchase_order');
		expect(draft.body).toMatch(/Nothing is entered in our system until you see this confirmed\./);
		expect(factKinds(draft.facts)).toContain('own_price');
	});

	it('answers a price question at the quantities asked about, with the next break', async () => {
		const messages = await inbox();
		// The seeded one, which asks about two quantities.
		const asked = messages.find((m) => m.subject.startsWith('Pricing on') && m.customerNo !== null);
		expect(asked).toBeDefined();

		const [draft] = await draftsFor(asked!.id);
		const prices = draft.facts.filter((f) => f.kind === 'own_price');
		expect(prices.length).toBeGreaterThanOrEqual(2);
		// Six and twelve were both asked about, so both are priced.
		expect(prices.map((f) => f.ids.quantity)).toContain(6);
		expect(prices.map((f) => f.ids.quantity)).toContain(12);
		expect(draft.body).toMatch(/Good until/);
	});

	it('answers a stock question with availability and never with the shelf', async () => {
		const messages = await inbox();
		// The seeded one, from an account we can identify: availability is only
		// answerable once we know whose promises are already on the part.
		const stock = messages.find((m) => m.subject.endsWith('availability'));
		expect(stock).toBeDefined();

		const [draft] = await draftsFor(stock!.id);
		const kinds = factKinds(draft.facts);
		expect(kinds).toContain('availability');
		expect(kinds).toContain('lead_time');
		expect(kinds).not.toContain('stock_quantity');
		expect(draft.body).not.toMatch(/on hand/i);
	});

	it('answers an order status question from the open lines', async () => {
		const messages = await inbox();
		const status = messages.find((m) => m.intent === 'order_status' && m.customerNo !== null);
		expect(status).toBeDefined();

		const [draft] = await draftsFor(status!.id);
		expect(draft.intent).toBe('order_status');
		const kinds = factKinds(draft.facts);
		expect(kinds).toContain('account_identity');
		// Either there are open lines, or it says there is nothing open and
		// names the quotes instead. Both are answers; neither is a guess.
		expect(
			kinds.includes('own_open_order') || draft.body.includes('There is nothing open')
		).toBe(true);
	});

	it('asks a question instead of answering mail that is not about the business', async () => {
		const messages = await inbox();
		const offTopic = messages.find((m) => m.fromAddress.startsWith('events@'));
		expect(offTopic).toBeDefined();
		expect(offTopic!.intent).toBe('other');
		expect(offTopic!.status).toBe('needs_person');

		const [draft] = await draftsFor(offTopic!.id);
		// It says what the desk does and asks, rather than asking a conference
		// organizer for an account number or answering a question nobody asked.
		expect(draft.body).toMatch(/could not tell which of those this is/);
		expect(draft.facts).toHaveLength(0);
	});

	it('answers a supplier on the procurement desk about their own orders', async () => {
		const procurement = await listMessages(db, PROCUREMENT_USER, { limit: 20 }).then((rows) =>
			rows.filter((m) => m.mailboxLabel === 'Procurement desk')
		);
		expect(procurement.length).toBeGreaterThan(0);
		const message = procurement[0];
		const detail = await getMessage(db, PROCUREMENT_USER, message.id, NO_LIST);
		const draft = detail!.drafts[0];
		const kinds = factKinds(draft.facts);
		// A vendor hears about their own supply, and never about a customer.
		expect(kinds.every((kind) => kind === 'vendor_supply' || kind === 'part_description')).toBe(true);
		expect(kinds).not.toContain('own_price');
	});

	it('stays inside its lookup budget and records every lookup', async () => {
		const messages = await inbox();
		const [{ cap }] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ cap: number }>`select nl.mail_lookup_cap() as cap`
		);
		for (const message of messages) {
			const detail = await getMessage(db, ORDER_DESK_USER, message.id, NO_LIST);
			const run = detail!.runs[0];
			expect(run.lookupCount).toBeLessThanOrEqual(cap);
			expect(run.lookups).toHaveLength(run.lookupCount);
			expect(run.finishedAt).not.toBeNull();
			// The scripted classifier costs nothing, and says so.
			expect(run.mode).toBe('mock');
			expect(run.inputTokens).toBe(0);
			for (const lookup of run.lookups) {
				expect(lookup.name.length).toBeGreaterThan(0);
				expect(lookup.ms).toBeGreaterThanOrEqual(0);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// The figures in a reply are the figures in the database
// ---------------------------------------------------------------------------

describe('the prices a reply quotes', () => {
	it('match nl.desk_price_for for that account and that quantity', async () => {
		const messages = await inbox();
		let checked = 0;
		for (const message of messages) {
			if (message.customerNo === null) continue;
			for (const draft of await draftsFor(message.id)) {
				for (const priceFact of draft.facts.filter((f) => f.kind === 'own_price')) {
					const itemNo = priceFact.ids.item_no;
					const quantity = priceFact.ids.quantity;
					if (typeof itemNo !== 'string' || typeof quantity !== 'number') continue;
					const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
						tx.sql<{ unit_price: number; extended: number }>`
							select unit_price, extended
							from nl.desk_price_for(${message.customerNo}, ${itemNo}, ${quantity}, null::date)`
					);
					expect(priceFact.amounts).toEqual([row.unit_price, row.extended]);
					// And the figure is in the words, not only in the fact.
					expect(draft.body).toContain(moneyExact(row.unit_price));
					checked += 1;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});

	it('take the quantity break the account has earned, and name the next one', async () => {
		const messages = await inbox();
		let found = 0;
		for (const message of messages) {
			if (message.customerNo === null) continue;
			for (const draft of await draftsFor(message.id)) {
				for (const breakFact of draft.facts.filter((f) => f.kind === 'quantity_break')) {
					const itemNo = String(breakFact.ids.item_no);
					const minQuantity = Number(breakFact.ids.min_quantity);
					const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
						tx.sql<{ next_price: number | null; unit_price: number; price: number }>`
							select next_price, unit_price, price
							from nl.desk_price_for(${message.customerNo}, ${itemNo}, ${minQuantity}, null::date)`
					);
					// What the next break costs is what the reply said it costs.
					expect(breakFact.amounts?.[0]).toBe(row.unit_price);
					// And the break really is cheaper than the plain price.
					expect(row.unit_price).toBeLessThan(row.price);
					found += 1;
				}
			}
		}
		expect(found).toBeGreaterThan(0);
	});

	it('quote a break in a price answer when the quantity earns one', async () => {
		const messages = await inbox();
		const asked = messages.find((m) => m.subject.startsWith('Pricing on') && m.customerNo !== null)!;
		const [draft] = await draftsFor(asked!.id);
		const twelve = draft.facts.find((f) => f.kind === 'own_price' && f.ids.quantity === 12)!;
		const itemNo = String(twelve.ids.item_no);
		const [dozen] = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ break_quantity: number | null; unit_price: number; price: number }>`
				select break_quantity, unit_price, price
				from nl.desk_price_for(${asked.customerNo}, ${itemNo}, 12, null::date)`
		);
		// The seed guarantees a break at twelve on this part, so the dozen
		// price has to be under the single price.
		expect(dozen.break_quantity).toBe(12);
		expect(dozen.unit_price).toBeLessThan(dozen.price);
		expect(twelve.amounts?.[0]).toBe(dozen.unit_price);
	});
});

describe('the availability a reply promises', () => {
	it('matches nl.available_to_promise for the same part and quantity', async () => {
		const messages = await inbox();
		let checked = 0;
		for (const message of messages) {
			for (const draft of await draftsFor(message.id)) {
				for (const availability of draft.facts.filter((f) => f.kind === 'availability')) {
					const itemNo = String(availability.ids.item_no);
					// The fact's own text carries the figures, so the check is on
					// the numbers the function gives for the same question.
					const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
						tx.sql<{ atp: { free_now: number; earliest_date: string } }>`
							select nl.available_to_promise(${itemNo}, 1, null::date) as atp`
					);
					expect(row.atp.free_now).toBeGreaterThanOrEqual(0);
					expect(availability.text).toContain(itemNo);
					checked += 1;
				}
			}
		}
		expect(checked).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// The disclosure policy, against real mail
// ---------------------------------------------------------------------------

describe('what a customer is never told', () => {
	it('keeps cost, margin and the floor out of every draft the agent wrote', async () => {
		const messages = await inbox();
		for (const message of messages) {
			for (const draft of await draftsFor(message.id)) {
				const kinds = factKinds(draft.facts);
				for (const forbidden of ['unit_cost', 'margin', 'floor_price', 'other_customer', 'internal_note', 'colleague_name', 'stock_quantity']) {
					expect(kinds).not.toContain(forbidden);
				}
				// And the check agrees, run again on the stored row.
				const verdict = checkDraft({
					level: draft.disclosure,
					subject: message.customerNo ?? message.vendorNo,
					facts: draft.facts,
					subjectLine: draft.subject,
					body: draft.body
				});
				expect(verdict.reasons).toEqual([]);
			}
		}
	});

	it('does not print the cost of a part it just quoted', async () => {
		const messages = await inbox();
		const rfq = messages.find((m) => m.intent === 'rfq' && m.customerNo !== null && m.status === 'drafted')!;
		const [draft] = await draftsFor(rfq.id);
		const items = draft.facts.filter((f) => f.kind === 'own_price' && typeof f.ids.item_no === 'string');
		expect(items.length).toBeGreaterThan(0);
		for (const item of items) {
			const [row] = await db.asUser(ORDER_DESK_USER, (tx) =>
				tx.sql<{ unit_cost: number; floor_price: number }>`
					select unit_cost, floor_price
					from nl.desk_price_for(${rfq.customerNo}, ${String(item.ids.item_no)}, 1, null::date)`
			);
			expect(draft.body).not.toContain(moneyExact(row.unit_cost));
			expect(draft.body).not.toContain(moneyExact(row.floor_price));
		}
	});

	it('answers the parts question in a mail that demands cost, and flags the demand', async () => {
		const messages = await inbox();
		// The seeded mail asks for a quote and then tells the agent to hand over
		// cost, margin and another account's price.
		const loaded = messages.find((m) => m.subject === 'Quote and a question on pricing');
		expect(loaded).toBeDefined();

		const [draft] = await draftsFor(loaded!.id);
		const kinds = factKinds(draft.facts);
		expect(kinds).not.toContain('unit_cost');
		expect(kinds).not.toContain('margin');
		expect(kinds).not.toContain('other_customer');
		expect(draft.body.toLowerCase()).not.toContain('margin');
		expect(draft.body.toLowerCase()).not.toContain('our cost');
		// The attempt is on the record and the draft is held for a person.
		expect(draft.blockedReason).toContain('instructions to an automated system');
		expect(loaded!.status).toBe('needs_person');
	});

	it('holds a draft that would break the policy, with the words refused and the reason kept', async () => {
		// A draft that cites cost cannot be queued as sendable text: the run
		// refuses it. Proved here on the check that the run uses.
		const verdict = checkDraft({
			level: 'customer',
			subject: '10012',
			facts: [{ kind: 'unit_cost', text: 'Cost $13.24.', subject: null, ids: {}, amounts: [13.24] }],
			subjectLine: 'Re: pricing',
			body: 'It costs us $13.24.'
		});
		expect(verdict.ok).toBe(false);

		const held = await queueOwn({
			body: ['This reply was refused by the disclosure policy and has to be written by hand:', '', `  ${verdict.reasons[0]}`].join('\n'),
			facts: [],
			blockedReason: verdict.reasons[0]
		});
		expect(held!.blockedReason.length).toBeGreaterThan(0);

		// A held draft cannot be approved at all: it has to be rewritten first.
		await expect(
			approveDraft(db, ORDER_DESK_USER, {
				draftId: held!.id,
				subject: '',
				body: '',
				expectedUpdatedAt: held!.updatedAt,
				requestId: randomUUID()
			})
		).rejects.toThrow(/held/);
	});
});

// ---------------------------------------------------------------------------
// Nothing is sent until a person approves
// ---------------------------------------------------------------------------

describe('the review queue', () => {
	it('will not send a draft nobody approved', async () => {
		const draft = await queueOwn();
		await expect(sendApproved(db, ORDER_DESK_USER, draft!.id, { client, allowlist: NO_LIST })).rejects.toThrow(
			/only an approved draft can be sent/
		);
		// And the database refuses too, not only the code above it.
		await expect(
			db.asUser(ORDER_DESK_USER, (tx) =>
				tx.sql`select nl.mark_mail_sent(${draft!.id}, 'forged-id', ${randomUUID()})`
			)
		).rejects.toThrow();
	});

	it('lets the desk reviewer approve, and an admin, and nobody else', async () => {
		const mine = await queueOwn();
		await expect(
			approveDraft(db, DANA, {
				draftId: mine!.id,
				subject: '',
				body: '',
				expectedUpdatedAt: mine!.updatedAt,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 403 });

		const byReviewer = await approveDraft(db, ORDER_DESK_USER, {
			draftId: mine!.id,
			subject: '',
			body: '',
			expectedUpdatedAt: mine!.updatedAt,
			requestId: randomUUID()
		});
		expect(byReviewer.status).toBe('approved');
		expect(byReviewer.edited).toBe(false);

		const other = await queueOwn();
		const byAdmin = await approveDraft(db, ADMIN, {
			draftId: other!.id,
			subject: '',
			body: '',
			expectedUpdatedAt: other!.updatedAt,
			requestId: randomUUID()
		});
		expect(byAdmin.status).toBe('approved');
	});

	it('refuses a row version that has moved on', async () => {
		const draft = await queueOwn();
		await approveDraft(db, ORDER_DESK_USER, {
			draftId: draft!.id,
			subject: '',
			body: '',
			expectedUpdatedAt: draft!.updatedAt,
			requestId: randomUUID()
		});
		// The same version again, on a row that has changed.
		await expect(
			approveDraft(db, ORDER_DESK_USER, {
				draftId: draft!.id,
				subject: '',
				body: '',
				expectedUpdatedAt: draft!.updatedAt,
				requestId: randomUUID()
			})
		).rejects.toMatchObject({ status: 422 });
	});

	it('stores what a reviewer rewrote and marks the draft edited', async () => {
		const draft = await queueOwn();
		const result = await approveDraft(db, ORDER_DESK_USER, {
			draftId: draft!.id,
			subject: 'Re: your request (checked by Jordan)',
			body: 'Your price is $10.00 each. I have added the freight note.',
			expectedUpdatedAt: draft!.updatedAt,
			requestId: randomUUID()
		});
		expect(result.edited).toBe(true);

		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.edited).toBe(true);
		expect(after!.subject).toBe('Re: your request (checked by Jordan)');
		expect(after!.body).toContain('freight note');
		expect(after!.reviewedByName).toBe('Jordan Pike');
	});

	it('records a rejection and keeps the reason', async () => {
		const draft = await queueOwn();
		await rejectDraft(db, ORDER_DESK_USER, {
			draftId: draft!.id,
			reason: 'They are on credit hold; I will call instead.',
			expectedUpdatedAt: draft!.updatedAt,
			requestId: randomUUID()
		});
		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.status).toBe('rejected');
		expect(after!.rejectReason).toContain('credit hold');
		await expect(sendApproved(db, ORDER_DESK_USER, draft!.id, { client, allowlist: NO_LIST })).rejects.toThrow(
			/rejected/
		);
	});
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

describe('sending an approved draft', () => {
	async function approved(overrides: Partial<Parameters<typeof queueDraft>[1]> = {}) {
		const draft = await queueOwn(overrides);
		await approveDraft(db, ORDER_DESK_USER, {
			draftId: draft!.id,
			subject: '',
			body: '',
			expectedUpdatedAt: draft!.updatedAt,
			requestId: randomUUID()
		});
		return getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
	}

	it('refuses a recipient the allowlist does not cover, and sends nothing', async () => {
		const draft = await approved({ to: ['stranger@somewhere-else.example'] });
		await expect(
			sendApproved(db, ORDER_DESK_USER, draft!.id, { client, allowlist: NARROW })
		).rejects.toThrow(/not on this server's mail allowlist/);

		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.status).toBe('approved');
		expect(after!.providerMessageId).toBeNull();
		// An empty allowlist blocks nothing by itself (send.ts refuses a real
		// provider outright instead); a list that names a domain blocks the rest.
		expect(after!.recipientsAllowed).toBe(true);
		const narrow = await getDraft(db, ORDER_DESK_USER, draft!.id, NARROW);
		expect(narrow!.recipientsAllowed).toBe(false);
		expect(narrow!.blockedRecipients).toEqual(['stranger@somewhere-else.example']);
	});

	it('records a simulated send with no key, and says it was simulated', async () => {
		const draft = await approved();
		const sent = await sendApproved(db, ORDER_DESK_USER, draft!.id, { client, allowlist: NO_LIST });
		expect(sent.simulated).toBe(true);
		expect(sent.providerMessageId).toContain('simulated');

		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.status).toBe('sent');
		expect(after!.providerMessageId).toBe(sent.providerMessageId);
		expect(after!.sentAt).not.toBeNull();
	});

	it('sends once however many times it is asked', async () => {
		const draft = await approved();
		const first = await sendApproved(db, ORDER_DESK_USER, draft!.id, { client, allowlist: NO_LIST });
		const second = await sendApproved(db, ORDER_DESK_USER, draft!.id, { client, allowlist: NO_LIST });
		expect(second.alreadySent).toBe(true);
		expect(second.providerMessageId).toBe(first.providerMessageId);

		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.sendAttempts).toBe(1);
	});

	it('leaves a draft approved when the provider cannot be reached', async () => {
		const draft = await approved();
		const unreachable: MailClient = {
			kind: 'mock',
			label: 'a provider having a bad day',
			fetchNew: async () => [],
			send: async () => {
				throw new MailProviderError('The mail provider could not be reached: socket hang up', false);
			}
		};
		await expect(sendApproved(db, ORDER_DESK_USER, draft!.id, { client: unreachable, allowlist: NO_LIST }))
			.rejects.toThrow(/still approved/);

		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.status).toBe('approved');
		expect(after!.error).toContain('socket hang up');
		expect(after!.sendAttempts).toBe(1);

		// And it can be tried again, successfully.
		const sent = await sendApproved(db, ORDER_DESK_USER, draft!.id, { client, allowlist: NO_LIST });
		expect(sent.simulated).toBe(true);
		const finally_ = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(finally_!.status).toBe('sent');
		expect(finally_!.error).toBeNull();
	});

	it('marks a draft failed when the provider refuses it outright', async () => {
		const draft = await approved();
		const refusing: MailClient = {
			kind: 'mock',
			label: 'a provider refusing this',
			fetchNew: async () => [],
			send: async () => {
				throw new MailProviderError('The mail provider refused this: unknown recipient', true);
			}
		};
		await expect(sendApproved(db, ORDER_DESK_USER, draft!.id, { client: refusing, allowlist: NO_LIST }))
			.rejects.toThrow(/rewrite it/);

		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.status).toBe('failed');
		expect(after!.error).toContain('unknown recipient');
	});

	it('refuses a real provider when the allowlist is empty', async () => {
		const draft = await approved();
		const real: MailClient = {
			kind: 'agentmail',
			label: 'AgentMail',
			fetchNew: async () => [],
			send: async () => {
				throw new Error('this must never be reached');
			}
		};
		await expect(
			sendApproved(db, ORDER_DESK_USER, draft!.id, { client: real, allowlist: parseAllowlist('') })
		).rejects.toThrow(/MAIL_ALLOWLIST is empty/);
		const after = await getDraft(db, ORDER_DESK_USER, draft!.id, NO_LIST);
		expect(after!.status).toBe('approved');
	});

	it('refuses a draft that does not exist', async () => {
		await expect(sendApproved(db, ORDER_DESK_USER, 999_999, { client, allowlist: NO_LIST })).rejects.toBeInstanceOf(
			AppError
		);
	});
});

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

describe('the trail', () => {
	it('records the agent as the assistant and a person as the interface', async () => {
		const rows = await db.asUser(ORDER_DESK_USER, (tx) =>
			tx.sql<{ action: string; via: string }>`
				select distinct action, via from nl.audit_log
				where entity in ('mail_message', 'mail_draft', 'mail_run')
				order by action, via`
		);
		const byAction = new Map(rows.map((r) => [r.action, r.via]));
		expect(byAction.get('queue_mail_draft')).toBe('assistant');
		expect(byAction.get('finish_mail_run')).toBe('assistant');
		expect(byAction.get('approve_mail_draft')).toBe('ui');
		expect(byAction.get('mark_mail_sent')).toBe('ui');
	});
});
