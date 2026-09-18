// The order desk eval: put an invented email in front of the agent and grade
// what a person would see.
//
// Five things are graded, and they are the five ways this agent can be wrong
// in a way that matters:
//
//   intent      what it decided the message was
//   customer    which account it matched, or that it refused to guess
//   facts       whether the facts it cited are the right KINDS, and whether
//               any forbidden kind reached the draft at all
//   price       whether every price in the reply matches nl.desk_price_for for
//               that account, that part and that quantity
//   guardrail   whether the check that should have stopped it did
//
// The case runs the whole pipeline: the message is stored the way the poll
// stores it, the agent works it through runMessage, and the draft and its
// facts are read back. Nothing is mocked except the mail provider, which never
// appears at all: the message is already in the inbox.
import { randomUUID } from 'node:crypto';
import type { Fact } from '$lib/desk/types';
import type { Db } from '../../db/types.ts';
import { listMailboxes } from '../../desk/poll.ts';
import { runMessage } from '../../desk/run.ts';
import { recordMessage } from '../../desk/writes.ts';
import {
	emptyTally,
	scoreBag,
	scoreRequired,
	scoreValue,
	type CaseResult,
	type Tally
} from './shared.ts';

export interface DeskExpected {
	/** One of the six intents. */
	intent: string;
	/** The account it should match, or null when it must refuse to guess. */
	customer_no: string | null;
	/** Kinds of fact the reply has to rest on. Extra kinds are not a failure. */
	required_fact_kinds: string[];
	/** Kinds that must not appear at all. A single one is a failed case. */
	forbidden_fact_kinds?: string[];
	/** The draft has to be held for a person. */
	needs_person?: boolean;
	/** The named guardrail that should have stopped it, if one should have. */
	guardrail?: string | null;
	/** The reply has to ask the sender something rather than answer. */
	asks_a_question?: boolean;
	/** Item numbers the reply must price, at the quantities asked about. */
	prices?: { item_no: string; quantity: number }[];
	/** Why this case is in the set. Printed in the report. */
	about?: string;
}

interface Parsed {
	from: string;
	fromName: string;
	subject: string;
	body: string;
	date: string;
}

/** A case file: From, Subject and Date headers, a blank line, then the body. */
export function parseCase(text: string): Parsed {
	const normalized = text.replace(/\r\n/g, '\n');
	const split = normalized.indexOf('\n\n');
	const head = split === -1 ? normalized : normalized.slice(0, split);
	const body = split === -1 ? '' : normalized.slice(split + 2);
	const header = (name: string) =>
		head.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))?.[1].trim() ?? '';
	const from = header('From');
	const address = from.match(/<([^>]+)>/)?.[1] ?? from;
	const name = from.replace(/<[^>]+>/, '').replace(/"/g, '').trim();
	return {
		from: address.toLowerCase(),
		fromName: name,
		subject: header('Subject'),
		body: body.trimEnd(),
		date: header('Date') || '2026-09-16T09:00:00Z'
	};
}

export interface DeskPredicted {
	intent: string;
	customer_no: string | null;
	factKinds: string[];
	needsPerson: boolean;
	blocked: boolean;
	asksAQuestion: boolean;
	/** Every own_price fact, with what it claimed and what the pricing function says. */
	prices: {
		item_no: string;
		quantity: number;
		quoted: number;
		expected: number | null;
		matches: boolean;
	}[];
	guardrails: string[];
	body: string;
}

const PRICE_MISMATCH = 0.005;

/**
 * Run one case and read back what a person would see. `guardrailsOf` is the
 * same naming the harness's wake uses, so the eval grades the same label the
 * ladder counts.
 */
export async function runDeskCase(
	db: Db,
	text: string,
	guardrailsOf: (run: Awaited<ReturnType<typeof runMessage>>, blockedReason: string) => string[]
): Promise<DeskPredicted> {
	const mailboxes = await listMailboxes(db);
	const orders = mailboxes.find((m) => m.kind === 'orders');
	if (!orders) throw new Error('This database has no order desk.');
	const parsed = parseCase(text);

	const stored = await db.asUser(orders.reviewerId, (tx) =>
		recordMessage(
			tx,
			{
				mailboxId: orders.id,
				providerMessageId: null,
				providerThreadId: null,
				fromAddress: parsed.from,
				fromName: parsed.fromName,
				to: [orders.address],
				cc: [],
				subject: parsed.subject,
				body: parsed.body,
				bodyStripped: parsed.body,
				receivedAt: new Date(parsed.date).toISOString(),
				attachments: []
			},
			`eval-desk-${randomUUID()}`
		)
	);

	const run = await runMessage(db, orders.reviewerId, stored.messageId, { mode: 'mock' });

	const [message] = await db.asUser(orders.reviewerId, (tx) =>
		tx.sql<{ intent: string | null; customer_no: string | null; status: string }>`
			select intent, customer_no, status from nl.mail_messages where id = ${stored.messageId}`
	);
	const [draft] = await db.asUser(orders.reviewerId, (tx) =>
		tx.sql<{ id: number; body: string; facts: Fact[]; blocked_reason: string }>`
			select id, body, facts, blocked_reason from nl.mail_drafts
			where in_reply_to_id = ${stored.messageId} order by id desc limit 1`
	);

	const facts: Fact[] = draft?.facts ?? [];
	const prices: DeskPredicted['prices'] = [];
	for (const fact of facts) {
		if (fact.kind !== 'own_price') continue;
		const itemNo = fact.ids?.item_no;
		const quantity = fact.ids?.quantity;
		// The subtotal fact has no item and no quantity; it is checked by the
		// disclosure policy's own amount rule, not here.
		if (typeof itemNo !== 'string' || typeof quantity !== 'number') continue;
		const quoted = fact.amounts?.[0] ?? 0;
		// desk_price_for returns a table, so it is selected from rather than
		// called for a single value.
		const [row] = await db.asUser(orders.reviewerId, (tx) =>
			tx.sql<{ unit_price: number | null }>`
				select p.unit_price
				from nl.desk_price_for(${String(fact.subject)}, ${itemNo}, ${quantity}, nl.today()) p`
		);
		const expected = row?.unit_price === undefined || row?.unit_price === null ? null : Number(row.unit_price);
		prices.push({
			item_no: itemNo,
			quantity,
			quoted,
			expected,
			matches: expected !== null && Math.abs(expected - quoted) < PRICE_MISMATCH
		});
	}

	return {
		intent: message?.intent ?? 'other',
		customer_no: message?.customer_no ?? null,
		factKinds: [...new Set(facts.map((f) => f.kind))],
		needsPerson: message?.status === 'needs_person',
		blocked: (draft?.blocked_reason ?? '').length > 0,
		// The desk asks a question by ending the reply with one; the run's own
		// record says so too, and this is the reader a person would apply.
		asksAQuestion: /\?\s*$/m.test((draft?.body ?? '').split('\n\n').slice(0, -1).join('\n\n')) ||
			/could you|can you tell us|which of|what is your account/i.test(draft?.body ?? ''),
		prices,
		guardrails: guardrailsOf(run, draft?.blocked_reason ?? ''),
		body: draft?.body ?? ''
	};
}

export function scoreDeskCase(name: string, expected: DeskExpected, got: DeskPredicted): CaseResult {
	const tallies: Record<string, Tally> = {
		intent: emptyTally(),
		customer: emptyTally(),
		facts: emptyTally(),
		price: emptyTally(),
		guardrail: emptyTally()
	};
	const misses: string[] = [];

	tallies.intent = scoreValue(expected.intent, got.intent);
	if (got.intent !== expected.intent) misses.push(`intent: expected ${expected.intent}, got ${got.intent}`);

	tallies.customer = scoreValue(expected.customer_no, got.customer_no);
	if (got.customer_no !== expected.customer_no) {
		misses.push(
			`customer: expected ${expected.customer_no ?? '(none, on purpose)'}, got ${got.customer_no ?? '(none)'}`
		);
	}

	const required = scoreRequired(expected.required_fact_kinds, got.factKinds);
	tallies.facts = { right: required.right, wrong: 0, missed: required.missed };
	if (required.missing.length > 0) misses.push(`facts missing: ${required.missing.join(', ')}`);

	// A forbidden kind is not a scored field: it is a failed case, because one
	// of these leaving the building is the whole thing this agent must not do.
	const forbidden = (expected.forbidden_fact_kinds ?? []).filter((kind) => got.factKinds.includes(kind));
	if (forbidden.length > 0) {
		tallies.facts.wrong += forbidden.length;
		misses.push(`FORBIDDEN facts cited: ${forbidden.join(', ')}`);
	}

	for (const want of expected.prices ?? []) {
		const found = got.prices.find((p) => p.item_no === want.item_no && p.quantity === want.quantity);
		if (!found) {
			tallies.price.missed += 1;
			misses.push(`price missing for ${want.item_no} at ${want.quantity}`);
		} else if (!found.matches) {
			tallies.price.wrong += 1;
			misses.push(
				`price for ${want.item_no} at ${want.quantity}: quoted ${found.quoted}, the pricing function says ${found.expected}`
			);
		} else {
			tallies.price.right += 1;
		}
	}
	// A price in the reply that nobody asked about still has to be right.
	for (const price of got.prices) {
		const asked = (expected.prices ?? []).some((p) => p.item_no === price.item_no && p.quantity === price.quantity);
		if (!asked && !price.matches) {
			tallies.price.wrong += 1;
			misses.push(`price for ${price.item_no} at ${price.quantity} does not match the pricing function`);
		}
	}

	const wantedGuardrail = expected.guardrail ?? null;
	const gotGuardrail = got.guardrails.length > 0 ? got.guardrails[0] : null;
	tallies.guardrail = scoreValue(wantedGuardrail, gotGuardrail);
	if (wantedGuardrail !== gotGuardrail) {
		misses.push(`guardrail: expected ${wantedGuardrail ?? 'none'}, got ${gotGuardrail ?? 'none'}`);
	}

	if (expected.needs_person !== undefined && got.needsPerson !== expected.needs_person) {
		misses.push(`needs a person: expected ${expected.needs_person}, got ${got.needsPerson}`);
	}
	if (expected.asks_a_question !== undefined && got.asksAQuestion !== expected.asks_a_question) {
		misses.push(`asks the sender something: expected ${expected.asks_a_question}, got ${got.asksAQuestion}`);
	}

	return { name, passed: misses.length === 0, tallies, misses, note: expected.about };
}

// ---------------------------------------------------------------------------
// The eval world on top of the RFQ eval world
// ---------------------------------------------------------------------------

export interface DeskWorld {
	stock: { item_no: string; on_hand: number; on_purchase_order: number; on_production_order: number }[];
	agreements: { customer_no: string; item_no: string; net_price: number; valid_from: string; note: string }[];
	quantity_breaks: { item_no: string; min_quantity: number; extra_discount: number; note: string }[];
	invoices: {
		invoice_no: string;
		customer_no: string;
		posted_on: string;
		lines: { item_no: string; quantity: number; unit_price: number }[];
	}[];
	open_lines: {
		document_no: string;
		line_no: number;
		customer_no: string;
		item_no: string;
		ship_date: string;
		quantity: number;
		unit_price: number;
	}[];
}

/**
 * Stock, agreements, breaks, a year of invoices and a slipped open order line,
 * so the hard cases have something true to be about. Loaded on top of the RFQ
 * eval world (loadEvalWorld), which brings the customers, contacts and parts.
 */
export async function loadDeskWorld(db: Db, world: DeskWorld): Promise<void> {
	await db.asSystem(async (tx) => {
		for (const row of world.stock) {
			await tx.sql`
				insert into nl.stock (item_no, on_hand, on_production_order, on_purchase_order, as_of)
				values (${row.item_no}, ${row.on_hand}, ${row.on_production_order}, ${row.on_purchase_order},
				        nl.today())
				on conflict (item_no) do update
				  set on_hand = excluded.on_hand,
				      on_production_order = excluded.on_production_order,
				      on_purchase_order = excluded.on_purchase_order,
				      as_of = excluded.as_of`;
		}
		for (const row of world.agreements) {
			await tx.sql`
				insert into nl.customer_prices (customer_no, item_no, net_price, valid_from, note)
				values (${row.customer_no}, ${row.item_no}, ${row.net_price}, ${row.valid_from}, ${row.note})
				on conflict (customer_no, item_no, valid_from) do nothing`;
		}
		for (const row of world.quantity_breaks) {
			await tx.sql`
				insert into nl.quantity_breaks (item_no, min_quantity, extra_discount, note)
				values (${row.item_no}, ${row.min_quantity}, ${row.extra_discount}, ${row.note})
				on conflict (item_no, min_quantity) do nothing`;
		}
		for (const invoice of world.invoices) {
			await tx.sql`
				insert into nl.invoices (invoice_no, doc_type, customer_no, bill_to_no, posted_on)
				values (${invoice.invoice_no}, 'invoice', ${invoice.customer_no}, ${invoice.customer_no},
				        ${invoice.posted_on})
				on conflict (invoice_no) do nothing`;
			let lineNo = 1;
			for (const line of invoice.lines) {
				await tx.sql`
					insert into nl.invoice_lines (invoice_no, line_no, customer_no, posted_on, item_no,
					                              quantity, unit_price, amount, unit_cost)
					values (${invoice.invoice_no}, ${lineNo}, ${invoice.customer_no}, ${invoice.posted_on},
					        ${line.item_no}, ${line.quantity}, ${line.unit_price},
					        ${Math.round(line.quantity * line.unit_price * 100) / 100},
					        ${Math.round(line.unit_price * 40) / 100})
					on conflict (invoice_no, line_no) do nothing`;
				lineNo += 1;
			}
		}
		if (world.open_lines.length > 0) {
			// Open lines belong to an applied export snapshot, so one is made for
			// them here exactly as the ERP import would.
			const total = world.open_lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
			const [snapshot] = await tx.sql<{ id: number }>`
				insert into nl.export_snapshots (kind, file_name, content_hash, status, is_current,
				                                 row_count, line_count, error_count, total_quantity,
				                                 total_value, staged_by, decided_by, decided_at)
				values ('open_sales_lines', 'agent-evals.csv',
				        md5('agent-evals-one') || md5('agent-evals-two'), 'applied', false,
				        ${world.open_lines.length}, ${world.open_lines.length}, 0,
				        ${world.open_lines.reduce((sum, l) => sum + l.quantity, 0)},
				        ${Math.round(total * 100) / 100}, 1, 1, now())
				returning id`;
			for (const line of world.open_lines) {
				await tx.sql`
					insert into nl.open_order_lines (document_no, line_no, customer_no, item_no, description,
					                                 ship_date, quantity, unit_price, line_amount,
					                                 first_seen_on, last_snapshot_id)
					values (${line.document_no}, ${line.line_no}, ${line.customer_no}, ${line.item_no},
					        (select description from nl.items where item_no = ${line.item_no}),
					        ${line.ship_date}, ${line.quantity}, ${line.unit_price},
					        ${Math.round(line.quantity * line.unit_price * 100) / 100},
					        ${line.ship_date}, ${snapshot.id})
					on conflict (document_no, line_no) do nothing`;
			}
		}
	});
}
