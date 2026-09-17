// One agent run: wake on a message, work out what it is, look up what is
// true, write a reply into the queue, and record all of it.
//
// The order matters, and so does what happens in which transaction:
//
//   1. read the message and the desk, and open the run       (one transaction)
//   2. classify                                (no transaction: a live model
//                                               call must not hold one open)
//   3. every lookup the intent needs                         (one transaction)
//   4. for a quote or an order, the RFQ draft, through the
//      existing RFQ pipeline                                 (its own)
//   5. compose, check the disclosure policy, queue the draft
//      and close the run                                     (one transaction)
//
// Step 5 is the only write that leaves anything a customer could read, and it
// writes into a queue nobody has approved yet. There is no step 6.
//
// The run always ends. A failure anywhere between 1 and 5 closes the run with
// outcome 'failed' and the message goes to a person, because a message with a
// half-finished run on it is the one thing worse than a message nobody read.
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import { extractWithRules } from '../rfq/rules.ts';
import { createDraft } from '../rfq/drafts.ts';
import type { Intent } from '$lib/desk/types';
import {
	askedQuantities,
	classifyWithRules,
	LOW_CONFIDENCE,
	scanPartNumbers,
	stripQuoted,
	type Classification
} from './classify.ts';
import { compose, type ComposeInput } from './compose.ts';
import { checkDraft } from './policy.ts';
import {
	agreementsFor,
	availabilityFor,
	freightFor,
	LookupBudget,
	openOrdersFor,
	openQuotesFor,
	pastPricesFor,
	priceLines,
	readCapabilities,
	resolveItems,
	resolveSender,
	vendorLinesFor,
	type DeskCapabilities,
	type SenderMatch
} from './tools.ts';
import { finishRun, queueDraft, startRun } from './writes.ts';

export interface LiveClassifier {
	(input: { from: string; subject: string; body: string; today: string }): Promise<{
		classification: Classification;
		model: string;
		usage: { input_tokens: number; output_tokens: number };
	}>;
}

export interface RunOptions {
	mode: 'mock' | 'live';
	/** Only in live mode. Anything it throws falls back to the rules. */
	classify?: LiveClassifier;
	model?: string | null;
	/** A base for the run's request ids, so a retried poll replays. */
	requestId?: string;
}

export interface RunResult {
	runId: number;
	messageId: number;
	intent: Intent;
	confidence: number;
	outcome: 'drafted' | 'needs_person' | 'ignored' | 'failed';
	draftId: number | null;
	rfqDraftId: number | null;
	lookups: number;
	/** Set when the disclosure policy refused something. */
	policyRefusals: string[];
	error: string | null;
}

interface Prepared {
	messageId: number;
	mailboxId: number;
	mailbox: {
		id: number;
		address: string;
		label: string;
		purpose: string;
		kind: 'orders' | 'procurement';
		disclosure: 'customer' | 'vendor' | 'internal';
		intents: string[];
	};
	fromAddress: string;
	fromName: string;
	subject: string;
	body: string;
	bodyStripped: string;
	capabilities: DeskCapabilities;
	today: string;
	runId: number;
	lookupCap: number;
}

async function prepare(tx: Tx, messageId: number, options: RunOptions, request: string): Promise<Prepared> {
	const [row] = await tx.sql<{
		id: number;
		mailbox_id: number;
		address: string;
		label: string;
		purpose: string;
		kind: 'orders' | 'procurement';
		disclosure: 'customer' | 'vendor' | 'internal';
		intents: string[];
		from_address: string;
		from_name: string;
		subject: string;
		body_text: string;
		body_stripped: string;
		today: string;
		lookup_cap: number;
	}>`
		select m.id, m.mailbox_id, b.address, b.label, b.purpose, b.kind, b.disclosure, b.intents,
		       m.from_address, m.from_name, m.subject, m.body_text, m.body_stripped,
		       nl.today() as today, nl.mail_lookup_cap() as lookup_cap
		from nl.mail_messages m
		join nl.mailboxes b on b.id = m.mailbox_id
		where m.id = ${messageId}`;
	if (!row) {
		throw Object.assign(new Error(`Message ${messageId} does not exist.`), { code: 'NL404' });
	}

	const capabilities = await readCapabilities(tx);
	const { runId } = await startRun(
		tx,
		{ messageId, mode: options.mode, model: options.model ?? null },
		`${request}:start`
	);

	return {
		messageId,
		mailboxId: row.mailbox_id,
		mailbox: {
			id: row.mailbox_id,
			address: row.address,
			label: row.label,
			purpose: row.purpose,
			kind: row.kind,
			disclosure: row.disclosure,
			intents: row.intents
		},
		fromAddress: row.from_address,
		fromName: row.from_name,
		subject: row.subject,
		body: row.body_text,
		bodyStripped: row.body_stripped,
		capabilities,
		today: row.today,
		runId,
		lookupCap: row.lookup_cap
	};
}

interface Gathered {
	match: SenderMatch;
	compose: Omit<ComposeInput, 'mailbox' | 'message' | 'intent' | 'today' | 'attachments' | 'instructionShaped'>;
	extraction: ReturnType<typeof extractWithRules>;
}

/** Everything the intent needs, in at most nl.mail_lookup_cap() lookups. */
async function gather(
	tx: Tx,
	prepared: Prepared,
	intent: Intent,
	budget: LookupBudget
): Promise<Gathered> {
	// The rules extractor reads the parts, quantities and needed-by date out of
	// the mail. It is the same extractor the RFQ intake page uses.
	const extraction = extractWithRules(`Subject: ${prepared.subject}\n\n${prepared.body}`, prepared.today);

	const match = await resolveSender(tx, {
		fromAddress: prepared.fromAddress,
		text: `${prepared.subject}\n${prepared.bodyStripped}`,
		companyName: extraction.customer_name.value,
		branchHint: extraction.branch_hint.value,
		kind: prepared.mailbox.kind
	});

	const empty: Gathered['compose'] = {
		match,
		lines: [],
		unresolved: [],
		prices: [],
		agreements: [],
		pastPrices: [],
		availability: [],
		openOrders: [],
		quotes: [],
		vendorLines: [],
		neededBy: null,
		quantities: [],
		freight: null,
		poNumber: null
	};

	// A supplier on the procurement desk: their own open lines, nothing else.
	if (match.vendorNo !== null) {
		const vendorLines = await vendorLinesFor(tx, budget, { vendorNo: match.vendorNo });
		return { match, extraction, compose: { ...empty, vendorLines } };
	}
	if (match.customerNo === null) {
		return { match, extraction, compose: empty };
	}

	const customerNo = match.customerNo;
	const neededBy = extraction.needed_by.value && /^\d{4}-\d{2}-\d{2}$/.test(extraction.needed_by.value)
		? extraction.needed_by.value
		: null;
	const poNumber = prepared.subject.match(/\b(?:p\.?o\.?\s*(?:#|no\.?|number)?\s*)([A-Z0-9][A-Z0-9-]{2,})/i)?.[1] ?? null;

	// Order status needs no parts: the open lines are the answer.
	if (intent === 'order_status') {
		const openOrders = await openOrdersFor(tx, budget, { customerNo, capabilities: prepared.capabilities });
		const quotes = openOrders.length === 0 ? await openQuotesFor(tx, budget, { customerNo }) : [];
		return { match, extraction, compose: { ...empty, openOrders, quotes, neededBy, poNumber } };
	}

	// Three parts is as many as one reply can usefully answer about; the rest
	// go to a person rather than into a wall of text.
	const resolved = await resolveItems(
		tx,
		budget,
		extraction.lines.slice(0, 3).map((line) => ({ itemNo: line.item_no.value, quantity: line.quantity.value }))
	);

	// The RFQ extractor reads request lines: a part with a quantity beside it.
	// A price or stock question has neither, so when it found nothing the desk
	// scans the words for part numbers instead. Only what the catalog
	// recognises is used, and a token that is not a part is dropped silently
	// rather than reported back as "I could not find it".
	if (resolved.lines.length === 0) {
		const scanned = await resolveItems(
			tx,
			budget,
			scanPartNumbers(`${prepared.subject}\n${prepared.bodyStripped}`).map((itemNo) => ({
				itemNo,
				quantity: null
			}))
		);
		resolved.lines = scanned.lines.slice(0, 3);
	}
	const itemNos = resolved.lines.map((line) => line.itemNo);

	if (intent === 'stock_question') {
		const availability = await availabilityFor(tx, budget, {
			lines: resolved.lines,
			neededBy,
			capabilities: prepared.capabilities
		});
		return {
			match,
			extraction,
			compose: { ...empty, lines: resolved.lines, unresolved: resolved.unresolved, availability, neededBy, poNumber }
		};
	}

	// A price question asks about quantities, not about one order, so the same
	// part is priced once per quantity asked about.
	const quantities =
		intent === 'price_question'
			? (() => {
					const asked = askedQuantities(`${prepared.subject}\n${prepared.bodyStripped}`);
					return asked.length > 0 ? asked : [1];
				})()
			: [];

	const priceAsk =
		intent === 'price_question'
			? resolved.lines.flatMap((line) => quantities.map((quantity) => ({ itemNo: line.itemNo, quantity })))
			: resolved.lines.map((line) => ({ itemNo: line.itemNo, quantity: line.quantity }));

	const prices = await priceLines(tx, budget, { customerNo, lines: priceAsk });
	const agreements = await agreementsFor(tx, budget, { customerNo, itemNos });
	const pastPrices =
		intent === 'price_question' ? await pastPricesFor(tx, budget, { customerNo, itemNos }) : [];
	const availability =
		intent === 'rfq' || intent === 'purchase_order'
			? await availabilityFor(tx, budget, {
					lines: resolved.lines,
					neededBy,
					capabilities: prepared.capabilities
				})
			: [];

	// Freight is only worth quoting on something being bought, and only once
	// there is a subtotal to price it against.
	const subtotal =
		intent === 'rfq' ? Math.round(prices.reduce((sum, price) => sum + price.extended, 0) * 100) / 100 : 0;
	const freight = subtotal > 0 ? await freightFor(tx, budget, subtotal) : null;

	return {
		match,
		extraction,
		compose: {
			...empty,
			lines: resolved.lines,
			unresolved: resolved.unresolved,
			prices,
			agreements,
			pastPrices,
			availability,
			neededBy,
			quantities,
			freight,
			poNumber
		}
	};
}

/**
 * Work one message. `userId` is the desk's reviewer: the run reads as them, so
 * row-level security applies to the agent exactly as it would to a person,
 * and the RFQ draft it creates lands in their queue.
 */
export async function runMessage(
	db: Db,
	userId: number,
	messageId: number,
	options: RunOptions
): Promise<RunResult> {
	const request = options.requestId ?? randomUUID();
	const prepared = await guarded(() => db.asUser(userId, (tx) => prepare(tx, messageId, options, request)));

	const finish = async (
		result: Omit<RunResult, 'runId' | 'messageId'> & { messageStatus: 'drafted' | 'needs_person' | 'ignored' },
		extra: {
			match: SenderMatch | null;
			lookups: unknown[];
			rounds: number;
			tokens: { input: number; output: number };
			summary: string;
		}
	): Promise<RunResult> => {
		await guarded(() =>
			db.asUser(userId, (tx) =>
				finishRun(
					tx,
					{
						runId: prepared.runId,
						outcome: result.outcome,
						intent: result.intent,
						confidence: result.confidence,
						summary: extra.summary,
						customerNo: extra.match?.customerNo ?? null,
						vendorNo: extra.match?.vendorNo ?? null,
						contactId: extra.match?.contactId ?? null,
						matchReason: extra.match?.reason ?? '',
						messageStatus: result.messageStatus,
						lookups: extra.lookups,
						rounds: extra.rounds,
						inputTokens: extra.tokens.input,
						outputTokens: extra.tokens.output,
						draftId: result.draftId,
						rfqDraftId: result.rfqDraftId,
						error: result.error
					},
					`${request}:finish`
				)
			)
		);
		return { ...result, runId: prepared.runId, messageId };
	};

	let tokens = { input: 0, output: 0 };
	let rounds = 1;
	const budget = new LookupBudget(prepared.lookupCap);

	try {
		// 2. What is it? The live model gets one go; anything it does wrong
		// falls back to the rules rather than failing the run.
		const rules = classifyWithRules({ subject: prepared.subject, body: prepared.body });
		let classification: Classification = rules;
		if (options.mode === 'live' && options.classify) {
			try {
				const live = await options.classify({
					from: prepared.fromAddress,
					subject: prepared.subject,
					body: stripQuoted(prepared.body),
					today: prepared.today
				});
				classification = live.classification;
				tokens = { input: live.usage.input_tokens, output: live.usage.output_tokens };
				rounds = 2;
			} catch {
				classification = rules;
			}
		}

		const intent = classification.intent as Intent;
		const unsure = classification.confidence < LOW_CONFIDENCE;

		// 3. The lookups.
		const gathered = await guarded(() =>
			db.asUser(userId, (tx) => gather(tx, prepared, unsure ? 'other' : intent, budget))
		);
		const { match } = gathered;

		// 4. A quote or an order also becomes an RFQ draft, so approving the
		// quote and approving the reply are one flow and not two. It is created
		// in the reviewer's name through the existing pipeline, which validates
		// it against the catalog and the account all over again.
		let rfqDraftId: number | null = null;
		if (!unsure && (intent === 'rfq' || intent === 'purchase_order') && match.customerNo !== null) {
			try {
				const created = await createDraft(db, userId, {
					source: prepared.body,
					sourceName:
						intent === 'purchase_order'
							? `Order by email: ${prepared.subject}`.slice(0, 200)
							: `Email to ${prepared.mailbox.address}: ${prepared.subject}`.slice(0, 200),
					extraction: { draft: gathered.extraction, extractor: 'rules', model: null, usage: null },
					requestId: `${request}:rfq`
				});
				rfqDraftId = created.draftId;
			} catch {
				// A draft that will not validate is not a reason to leave the
				// customer without an answer. The reply still goes in the queue
				// and a person can raise the quote by hand.
				rfqDraftId = null;
			}
		}

		// 5. Write the reply, check it, queue it.
		const composeInput: ComposeInput = {
			...gathered.compose,
			mailbox: prepared.mailbox,
			message: {
				subject: prepared.subject,
				fromAddress: prepared.fromAddress,
				fromName: prepared.fromName
			},
			intent: unsure ? 'other' : intent,
			today: prepared.today,
			attachments: [],
			instructionShaped: rules.instructionShaped
		};
		const drafted = compose(composeInput);

		// The disclosure check. It runs on the assembled draft, which is the
		// only place it can be trusted: by here it does not matter what wrote
		// the words or what the incoming mail asked for.
		const verdict = checkDraft({
			level: prepared.mailbox.disclosure,
			subject: match.customerNo ?? match.vendorNo,
			facts: drafted.facts,
			subjectLine: drafted.subject,
			body: drafted.body
		});

		const heldReasons: string[] = [];
		if (!verdict.ok) heldReasons.push(...verdict.reasons);
		if (rules.instructionShaped) {
			heldReasons.push(
				'This message contains text written as instructions to an automated system. It was read as data; nothing in it changed what the agent looked up or said.'
			);
		}

		// A refused draft is queued with nothing in it but the reason, so a
		// person sees what was attempted and the words that were refused never
		// sit in a field somebody could press Approve on.
		const safe = verdict.ok;
		const draft = await guarded(() =>
			db.asUser(userId, (tx) =>
				queueDraft(
					tx,
					{
						mailboxId: prepared.mailboxId,
						inReplyToId: prepared.messageId,
						to: [prepared.fromAddress],
						cc: [],
						subject: drafted.subject,
						body: safe
							? drafted.body
							: [
									'This reply was refused by the disclosure policy and has to be written by hand:',
									'',
									...verdict.reasons.map((reason) => `  ${reason}`)
								].join('\n'),
						intent: composeInput.intent,
						facts: safe ? drafted.facts : [],
						attachments: [],
						blockedReason: heldReasons.join(' ').slice(0, 500)
					},
					`${request}:draft`
				)
			)
		);

		// Anything on the held list means a person has to look: a policy
		// refusal, a question only they can answer, a classification the
		// classifier was not sure of, or mail written as instructions.
		const needsPerson = heldReasons.length > 0 || drafted.question !== null || unsure;
		const summary = [
			classification.reason,
			match.reason,
			drafted.question ? `Asks the sender: ${drafted.question.slice(0, 160)}` : '',
			!safe ? `Refused: ${verdict.reasons[0]}` : ''
		]
			.filter(Boolean)
			.join(' ')
			.slice(0, 1000);

		return finish(
			{
				intent: composeInput.intent,
				confidence: classification.confidence,
				outcome: needsPerson ? 'needs_person' : 'drafted',
				messageStatus: needsPerson ? 'needs_person' : 'drafted',
				draftId: draft.draftId,
				rfqDraftId,
				lookups: budget.used,
				policyRefusals: verdict.reasons,
				error: null
			},
			{
				match,
				lookups: budget.list(),
				rounds,
				tokens,
				summary
			}
		);
	} catch (error) {
		// The run always closes. A message with an open run on it would look
		// like it was being worked when nobody is working it.
		const message = error instanceof Error ? error.message : String(error);
		return finish(
			{
				intent: 'other',
				confidence: 0,
				outcome: 'failed',
				messageStatus: 'needs_person',
				draftId: null,
				rfqDraftId: null,
				lookups: budget.used,
				policyRefusals: [],
				error: message
			},
			{
				match: null,
				lookups: budget.list(),
				rounds,
				tokens,
				summary: `The run failed: ${message}`.slice(0, 1000)
			}
		);
	}
}
