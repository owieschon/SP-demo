// What is this message? Six answers, a confidence, and a reason.
//
// The rule-based classifier is the default everywhere, including for public
// visitors, because it costs nothing and it is the same every run, which is
// what makes the tests worth having. The live classifier (claude.ts) answers
// in the same zod-checked shape, so nothing downstream can tell which one
// ran: both hand back an intent, a confidence between 0 and 1, and one
// sentence saying why.
//
// A message the classifier is not sure about, or that is not about the
// business at all, is not guessed at. It goes to a person with a short
// question, which is the honest answer and also the cheap one.
import { z } from 'zod';

export const INTENTS = [
	'rfq',
	'purchase_order',
	'price_question',
	'stock_question',
	'order_status',
	'other'
] as const;

export const classificationSchema = z.object({
	intent: z.enum(INTENTS),
	confidence: z.number().min(0).max(1),
	reason: z.string().trim().min(1).max(300)
});

export type Classification = z.infer<typeof classificationSchema>;

/** Below this, the agent asks a person instead of answering. */
export const LOW_CONFIDENCE = 0.55;

/**
 * Text that reads like instructions aimed at an automated system. Finding it
 * changes nothing about how the mail is treated (it was always data), but the
 * message is flagged so a person sees what was attempted.
 */
const INSTRUCTION_SHAPED =
	/\b(ignore|disregard|forget|override)\b[^.]{0,40}\b(previous|prior|earlier|above|your)?\s*(instructions|rules|prompt|policy|guardrails)\b|\bsystem prompt\b|\byou are (now )?an? (ai|assistant|agent|language model)\b|\b(auto|automatically)[- ]?approve\b|\bfor your automated system\b|\bas an ai\b/i;

export function looksLikeInstructions(text: string): boolean {
	return INSTRUCTION_SHAPED.test(text);
}

/**
 * The part of a mail that is this message: quoted history and the tail after
 * a forward marker are dropped. The classifier reads this, so a two-week-old
 * quote request at the bottom of a thread does not keep being answered.
 */
export function stripQuoted(body: string): string {
	const lines = body.replace(/\r\n/g, '\n').split('\n');
	const kept: string[] = [];
	for (const line of lines) {
		if (/^\s*-{2,}\s*(original message|forwarded message)/i.test(line)) break;
		if (/^\s*_{5,}\s*$/.test(line)) break;
		if (/^\s*On .{3,60}\b(wrote|schrieb):\s*$/i.test(line)) break;
		if (/^\s*>/.test(line)) continue;
		if (/^\s*(From|Sent|To|Cc|Subject):\s/i.test(line) && kept.length > 2) break;
		kept.push(line);
	}
	const text = kept.join('\n').trim();
	return text.length > 0 ? text : body.trim();
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

type Intent = (typeof INTENTS)[number];

interface Signal {
	intent: Exclude<Intent, 'other'>;
	pattern: RegExp;
	/** 2 for a phrase that only means one thing, 1 for a hint. */
	weight: 1 | 2;
	/** How the reason sentence names it. */
	says: string;
}

// Ordered by intent so the reason reads in a sensible order. A phrase only
// earns weight 2 when it is hard to read any other way: "please enter our
// purchase order" is an order, "price" on its own is a hint.
const SIGNALS: Signal[] = [
	// An order being placed.
	{ intent: 'purchase_order', pattern: /\b(please )?(enter|process|place|book)\b[^.]{0,20}\b(our |this |the )?(purchase )?order\b/i, weight: 2, says: 'asks us to enter an order' },
	{ intent: 'purchase_order', pattern: /\bpurchase order\b/i, weight: 2, says: 'names a purchase order' },
	{ intent: 'purchase_order', pattern: /\bp\.?o\.?\s*(#|no\.?|number)?\s*[A-Z0-9][A-Z0-9-]{2,}/i, weight: 2, says: 'carries a purchase order number' },
	{ intent: 'purchase_order', pattern: /\bship (to|by|on)\b/i, weight: 1, says: 'gives shipping instructions' },
	{ intent: 'purchase_order', pattern: /\bsame (terms|payment terms)\b/i, weight: 1, says: 'refers to payment terms' },

	// A request for a quote.
	{ intent: 'rfq', pattern: /\b(quote|quotation)\b/i, weight: 2, says: 'asks for a quote' },
	{ intent: 'rfq', pattern: /\brfq\b/i, weight: 2, says: 'says RFQ' },
	{ intent: 'rfq', pattern: /\b(can|could|would) you (please )?(quote|price)\b/i, weight: 2, says: 'asks us to quote' },
	{ intent: 'rfq', pattern: /\bdelivered to\b/i, weight: 1, says: 'names a delivery point' },
	{ intent: 'rfq', pattern: /\binclude freight\b/i, weight: 1, says: 'asks about freight' },

	// A price question about parts they already know.
	{ intent: 'price_question', pattern: /\b(what|whats|what's) (is |are )?(our|your|the) (price|pricing|net price|cost to us)\b/i, weight: 2, says: 'asks what the price is' },
	{ intent: 'price_question', pattern: /\bprice (on|for)\b/i, weight: 2, says: 'asks for a price on a part' },
	{ intent: 'price_question', pattern: /\bhow much (is|are|would)\b/i, weight: 2, says: 'asks how much' },
	{ intent: 'price_question', pattern: /\b(better|best) (number|price)\b/i, weight: 1, says: 'asks for a better number' },
	{ intent: 'price_question', pattern: /\bprice (good|valid|hold)\b/i, weight: 1, says: 'asks how long the price holds' },
	{ intent: 'price_question', pattern: /\bat (that|this) quantity\b/i, weight: 1, says: 'asks about a quantity break' },

	// Stock and lead time.
	{ intent: 'stock_question', pattern: /\b(in stock|availability|available)\b/i, weight: 2, says: 'asks about availability' },
	{ intent: 'stock_question', pattern: /\bhow many (can|could) you ship\b/i, weight: 2, says: 'asks how many can ship' },
	{ intent: 'stock_question', pattern: /\blead ?time\b/i, weight: 2, says: 'asks about lead time' },
	{ intent: 'stock_question', pattern: /\bwhen (can|could|would) you ship\b/i, weight: 2, says: 'asks when it can ship' },
	{ intent: 'stock_question', pattern: /\bon (the )?shelf\b/i, weight: 1, says: 'asks what is on the shelf' },
	{ intent: 'stock_question', pattern: /\bback ?order/i, weight: 1, says: 'mentions a back order' },

	// Where is what we already ordered.
	{ intent: 'order_status', pattern: /\border status\b/i, weight: 2, says: 'asks for order status' },
	{ intent: 'order_status', pattern: /\bwhere (is|are)\b[^.]{0,30}\b(our|my|the) (order|parts|shipment)\b/i, weight: 2, says: 'asks where an order is' },
	{ intent: 'order_status', pattern: /\bstatus of (our|my|the)\b/i, weight: 2, says: 'asks about the status of an order' },
	{ intent: 'order_status', pattern: /\b(our|my) open order\b/i, weight: 2, says: 'refers to an open order' },
	{ intent: 'order_status', pattern: /\bhas (it|that|this) shipped\b/i, weight: 2, says: 'asks whether it shipped' },
	{ intent: 'order_status', pattern: /\b(tracking|eta)\b/i, weight: 1, says: 'asks for tracking or an ETA' },
	{ intent: 'order_status', pattern: /\bslipped\b/i, weight: 1, says: 'asks what has slipped' }
];

/** A hint that a message is not about the business at all. */
const OFF_TOPIC = [
	/\bbooth\b/i,
	/\b(trade show|expo|conference)\b/i,
	/\b(resume|résumé|job (opening|opportunity)|apply|position)\b/i,
	/\b(newsletter|unsubscribe|webinar|survey)\b/i,
	/\b(seo|backlinks|marketing services)\b/i
];

export interface RuleClassification extends Classification {
	/** Every signal that fired, for the run's own record. */
	signals: { intent: Intent; says: string; weight: number }[];
	offTopic: boolean;
	instructionShaped: boolean;
}

/**
 * Classify a message from its subject and body. The subject counts double in
 * practice because "PO 48768" or "Order status" is usually the whole answer,
 * so it is simply read as well as the body.
 */
export function classifyWithRules(input: { subject: string; body: string }): RuleClassification {
	const text = `${input.subject}\n${stripQuoted(input.body)}`;
	const scores = new Map<Intent, number>();
	const fired: { intent: Intent; says: string; weight: number }[] = [];

	for (const signal of SIGNALS) {
		if (!signal.pattern.test(text)) continue;
		scores.set(signal.intent, (scores.get(signal.intent) ?? 0) + signal.weight);
		fired.push({ intent: signal.intent, says: signal.says, weight: signal.weight });
	}

	const offTopic = OFF_TOPIC.some((pattern) => pattern.test(text));
	const instructionShaped = looksLikeInstructions(text);

	const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const top = ranked[0];
	const second = ranked[1];

	if (!top || (offTopic && top[1] <= 2)) {
		return {
			intent: 'other',
			// Confident that it is not business when the off-topic words are
			// there; unsure, and so also a person's problem, when nothing fired.
			confidence: offTopic ? 0.8 : 0.4,
			reason: offTopic
				? 'This is not about parts, prices, stock or an order.'
				: 'Nothing in this message asks about parts, prices, stock or an order.',
			signals: fired,
			offTopic,
			instructionShaped
		};
	}

	const margin = top[1] - (second?.[1] ?? 0);
	const confidence = Math.min(0.95, Math.max(0.3, 0.45 + 0.08 * top[1] + 0.12 * margin));
	const why = fired
		.filter((f) => f.intent === top[0])
		.slice(0, 3)
		.map((f) => f.says)
		.join(', ');

	return {
		intent: top[0],
		confidence: Math.round(confidence * 1000) / 1000,
		reason: `It ${why}.`,
		signals: fired,
		offTopic,
		instructionShaped
	};
}

// ---------------------------------------------------------------------------
// Part numbers written into a sentence
// ---------------------------------------------------------------------------

/**
 * Tokens shaped like one of Northline's part numbers, anywhere in the text.
 *
 * The RFQ extractor reads lines of a request: a part with a quantity beside
 * it. A price or stock question has neither ("what is our price on FL25-8GA
 * these days?"), so the desk falls back to scanning for the shape: letters,
 * then a digit, then letters, digits and dashes. CL4VZ, FL25-8GA, S6-96SC,
 * P35-18SX and M-1007 all fit.
 *
 * It over-matches on purpose. Every candidate is looked up in the catalog and
 * anything that is not a part is dropped without a word, so a false positive
 * costs nothing and a missed part number costs an answer.
 */
export function scanPartNumbers(text: string): string[] {
	const found: string[] = [];
	for (const match of text.matchAll(/\b[A-Za-z]{1,3}-?\d[A-Za-z0-9]*(?:-[A-Za-z0-9]+)*\b/g)) {
		const token = match[0];
		// A part number is at least three characters and carries a digit and a
		// letter. That drops "on6", years and plain measurements.
		if (token.length < 3 || token.length > 24) continue;
		if (/^(?:19|20)\d{2}$/.test(token)) continue;
		if (!found.includes(token)) found.push(token);
	}
	return found.slice(0, 6);
}

// ---------------------------------------------------------------------------
// Quantities in a price question
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12,
	fifteen: 15,
	twenty: 20,
	'twenty-five': 25,
	fifty: 50,
	dozen: 12
};

/**
 * The quantities a price question asks about: "for six, and also for twelve"
 * gives [6, 12]. Words as well as digits, because a buyer writes both.
 *
 * Only numbers that look like a quantity count. A part number carries digits,
 * a date carries digits, and a phone number carries digits, so a number is
 * only taken when a quantity word is next to it or it is small and standing
 * on its own after "for" or "qty".
 */
export function askedQuantities(text: string): number[] {
	const found: number[] = [];
	const add = (value: number) => {
		if (Number.isInteger(value) && value > 0 && value <= 10_000 && !found.includes(value)) found.push(value);
	};

	for (const match of text.matchAll(
		/\b(?:qty|quantity|for|of|need|want|take|order)\s*:?\s*(\d{1,4})\b(?!\s*(?:["'”]|inch|in\b|ft\b|-))/gi
	)) {
		add(Number(match[1]));
	}
	for (const match of text.matchAll(/\b(\d{1,4})\s*(?:ea\b|each\b|pcs?\b|pieces?\b|units?\b)/gi)) {
		add(Number(match[1]));
	}
	const words = Object.keys(NUMBER_WORDS).join('|');
	for (const match of text.matchAll(new RegExp(`\\b(?:for|of|need|want|take|order)\\s+(${words})\\b`, 'gi'))) {
		add(NUMBER_WORDS[match[1].toLowerCase()]);
	}
	return found.slice(0, 3);
}
