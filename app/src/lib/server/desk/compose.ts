// Writing the reply.
//
// The words are code. That is a decision, not a shortcut: the reply's job is
// to say back exactly what the lookups found, and a sentence assembled from
// verified facts cannot drift from them. Every figure in every sentence below
// is put there together with the fact it came from, which is what lets
// policy.ts prove afterwards that nothing in the reply is unaccounted for.
//
// The live model's job is to decide what the message is (claude.ts). It never
// writes the reply, so an email that tells it to hand over cost has nowhere
// to go: the composer only knows how to print facts it was handed, and the
// facts a customer may be handed are decided in policy.ts.
//
// Style: short, plain, no salesmanship, no promise the data does not support.
// The desk signs as the desk.
import { moneyExact } from '$lib/format';
import type { Fact, Intent } from '$lib/desk/types';
import type {
	AgreementRow,
	Availability,
	DeskPrice,
	OpenLine,
	OpenQuote,
	PastPriceRow,
	SenderMatch,
	VendorLine
} from './tools.ts';

/** How long a quote from the desk holds, matching the RFQ quote in 0011. */
export const QUOTE_VALID_DAYS = 30;

export interface ComposeInput {
	mailbox: { label: string; address: string; purpose: string; kind: 'orders' | 'procurement' };
	message: { subject: string; fromAddress: string; fromName: string };
	intent: Intent;
	today: string;
	match: SenderMatch;
	/** What the request asked for, after the catalog was consulted. */
	lines: { itemNo: string; quantity: number; asWritten: string }[];
	/** Part numbers in the mail that are not in the catalog. */
	unresolved: string[];
	prices: DeskPrice[];
	agreements: AgreementRow[];
	pastPrices: PastPriceRow[];
	availability: Availability[];
	openOrders: OpenLine[];
	quotes: OpenQuote[];
	vendorLines: VendorLine[];
	neededBy: string | null;
	/** The quantities a price question asked about. */
	quantities: number[];
	freight: { freight: number; freeOver: number } | null;
	attachments: { kind: string; name: string; quoteId?: number }[];
	poNumber: string | null;
	instructionShaped: boolean;
}

export interface Composed {
	subject: string;
	body: string;
	facts: Fact[];
	/** Set when the agent cannot answer and a person has to. */
	question: string | null;
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

function longDay(iso: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
	return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
		timeZone: 'UTC',
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	});
}

function addDays(iso: string, days: number): string {
	const date = new Date(`${iso}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

/** "Pat" from "Pat Moreno", or nothing when we do not know who wrote. */
function greeting(input: ComposeInput): string {
	const name = input.match.contactName ?? input.message.fromName;
	const first = name.trim().split(/\s+/)[0] ?? '';
	return first.length > 1 && /^[A-Za-z][A-Za-z'-]+$/.test(first) ? `Hello ${first},` : 'Hello,';
}

function replySubject(subject: string): string {
	const clean = subject.trim() || 'Your message';
	return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

function signOff(input: ComposeInput): string {
	return [input.mailbox.label, 'Northline Exhaust Co.', input.mailbox.address].join('\n');
}

function percent(ratio: number): string {
	return `${Math.round(ratio * 1000) / 10}%`;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

function accountFact(match: SenderMatch): Fact {
	return {
		kind: 'account_identity',
		text: `${match.customerName} (${match.customerNo}), ${match.priceGroupLabel} pricing.`,
		subject: match.customerNo,
		ids: { customer_no: match.customerNo! },
		href: `/accounts/${match.customerNo}`
	};
}

function partFact(price: DeskPrice): Fact {
	return {
		kind: 'part_description',
		text: `${price.itemNo}: ${price.description}.`,
		subject: null,
		ids: { item_no: price.itemNo },
		href: `/parts/${encodeURIComponent(price.itemNo)}`
	};
}

function priceFact(price: DeskPrice): Fact {
	return {
		kind: 'own_price',
		text:
			`${price.itemNo} at ${price.quantity}: ${moneyExact(price.unitPrice)} each, ` +
			`${moneyExact(price.extended)} the line. ${price.detail}` +
			(price.breakQuantity ? `, less ${percent(price.breakDiscount ?? 0)} at ${price.breakQuantity} or more.` : '.'),
		subject: price.customerNo,
		ids: { customer_no: price.customerNo, item_no: price.itemNo, quantity: price.quantity },
		amounts: [price.unitPrice, price.extended],
		href: `/parts/${encodeURIComponent(price.itemNo)}`
	};
}

function breakFact(price: DeskPrice): Fact | null {
	if (price.nextQuantity === null || price.nextPrice === null) return null;
	return {
		kind: 'quantity_break',
		text: `${price.itemNo}: ${price.nextQuantity} or more is ${moneyExact(price.nextPrice)} each.`,
		subject: null,
		ids: { item_no: price.itemNo, min_quantity: price.nextQuantity },
		amounts: [price.nextPrice]
	};
}

/** Free stock, never counted above what was asked for: "8 of 2" is not an answer. */
function readyNow(row: Availability): number {
	return Math.min(Math.max(row.freeNow, 0), row.quantity);
}

function availabilityFact(row: Availability): Fact {
	const when = row.earliestDate === 'today' ? 'today' : longDay(row.earliestDate);
	const because =
		row.covering && row.covering.documentNo
			? ` on our ${row.covering.source} order ${row.covering.documentNo}`
			: row.earliestBasis === 'lead_time'
				? ` on a ${row.leadDays}-day lead time`
				: '';
	const now = readyNow(row);
	return {
		kind: 'availability',
		text:
			`${row.itemNo}: ` +
			(now >= row.quantity
				? `all ${row.quantity} can ship now.`
				: `${now} of ${row.quantity} can ship now, all ${row.quantity} by ${when}${because}.`) +
			(row.estimated ? ' Estimated from stock and open orders, not the supply forecast.' : ''),
		subject: null,
		ids: {
			item_no: row.itemNo,
			...(row.covering?.documentNo ? { document_no: row.covering.documentNo } : {})
		},
		href: `/parts/${encodeURIComponent(row.itemNo)}`
	};
}

function leadTimeFact(row: Availability): Fact {
	return {
		kind: 'lead_time',
		text: `${row.itemNo}: ${row.leadDays} days when we have to make or buy it (${row.replenishment}).`,
		subject: null,
		ids: { item_no: row.itemNo, lead_days: row.leadDays }
	};
}

function openLineFact(line: OpenLine, customerNo: string): Fact {
	const projected =
		line.projectedDate && line.projectedDate !== line.shipDate
			? ` Our forecast says ${longDay(line.projectedDate)}.`
			: '';
	return {
		kind: 'own_open_order',
		text:
			`Order ${line.documentNo} line ${line.lineNo}: ${line.quantity} x ${line.itemNo}, ` +
			`promised ${longDay(line.shipDate)}.${projected}`,
		subject: customerNo,
		ids: { document_no: line.documentNo, line_no: line.lineNo, item_no: line.itemNo },
		href: `/parts/${encodeURIComponent(line.itemNo)}`
	};
}

function agreementFact(row: AgreementRow, customerNo: string): Fact {
	return {
		kind: 'own_agreement',
		text:
			`${row.itemNo}: agreed at ${moneyExact(row.netPrice)} since ${longDay(row.validFrom)}` +
			(row.validTo ? `, to ${longDay(row.validTo)}.` : ', open ended.'),
		subject: customerNo,
		ids: { customer_no: customerNo, item_no: row.itemNo },
		amounts: [row.netPrice]
	};
}

function pastPriceFact(row: PastPriceRow, customerNo: string): Fact {
	return {
		kind: 'own_past_price',
		text: `${row.itemNo}: last paid ${moneyExact(row.unitPrice)} on ${longDay(row.postedOn)} (invoice ${row.invoiceNo}).`,
		subject: customerNo,
		ids: { customer_no: customerNo, item_no: row.itemNo, invoice_no: row.invoiceNo },
		amounts: [row.unitPrice]
	};
}

function quoteFact(row: OpenQuote, customerNo: string): Fact {
	return {
		kind: 'own_quote',
		text:
			`Quote ${row.quoteId} of ${longDay(row.quotedOn)}: ${row.lines} lines, ${moneyExact(row.total)}` +
			(row.validUntil ? `, good until ${longDay(row.validUntil)}.` : '.'),
		subject: customerNo,
		ids: { quote_id: row.quoteId, customer_no: customerNo },
		amounts: [row.total]
	};
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/** A short reply that asks a person's question instead of guessing. */
function askAPerson(input: ComposeInput, question: string, facts: Fact[] = []): Composed {
	return {
		subject: replySubject(input.message.subject),
		body: [greeting(input), '', question, '', signOff(input)].join('\n'),
		facts,
		question
	};
}

export function compose(input: ComposeInput): Composed {
	// Mail that is not about the business, or that the classifier could not
	// read, gets the same short answer whether or not we know who sent it.
	// Asking a conference organizer for their account number would be absurd.
	if (input.intent === 'other') {
		return composeOther(input);
	}

	// Nobody to price for: the desk asks who they are rather than guessing,
	// because quoting the wrong branch is a real mistake with real prices on it.
	if (input.match.customerNo === null && input.match.vendorNo === null) {
		const candidates = input.match.candidates;
		const question =
			candidates.length > 0
				? `Before I can price this I need to know which of your locations it is for. ` +
					`Could you confirm the account number or the town? ` +
					`We have ${candidates.length} accounts on this email domain.`
				: `I could not match your address to an account here. ` +
					`Could you send your account number, or the name and town the account is under, and I will price this straight away?`;
		return askAPerson(input, question);
	}

	if (input.match.customerNo !== null && (input.match.blocked || input.match.closed)) {
		return askAPerson(
			input,
			`Thanks for the message. There is a hold on the account that I cannot clear from the order desk. ` +
				`I have passed this to the person who looks after it and someone will come back to you today.`,
			[accountFact(input.match)]
		);
	}

	switch (input.intent) {
		case 'rfq':
			return composeQuote(input);
		case 'purchase_order':
			return composeOrder(input);
		case 'price_question':
			return composePrices(input);
		case 'stock_question':
			return composeAvailability(input);
		case 'order_status':
			return input.match.vendorNo !== null ? composeVendor(input) : composeStatus(input);
		default:
			return composeOther(input);
	}
}

// ---------------------------------------------------------------------------
// rfq: a quote
// ---------------------------------------------------------------------------

function composeQuote(input: ComposeInput): Composed {
	if (input.prices.length === 0) {
		return askAPerson(
			input,
			input.unresolved.length > 0
				? `I could not find ${input.unresolved.slice(0, 4).join(', ')} in our catalog. ` +
					`Could you check the numbers, or tell me the size and finish, and I will quote it today?`
				: `I could not tell from the message which parts to quote. ` +
					`Could you send the part numbers and quantities and I will price them today?`
		);
	}

	const facts: Fact[] = [accountFact(input.match)];
	const out: string[] = [greeting(input), ''];
	out.push(`Thanks for the request. Here is our quote for ${input.match.customerName}:`, '');

	let subtotal = 0;
	for (const price of input.prices) {
		facts.push(partFact(price), priceFact(price));
		subtotal += price.extended;
		out.push(`  ${price.itemNo}  ${price.description}`);
		out.push(
			`    ${price.quantity} at ${moneyExact(price.unitPrice)} each, ${moneyExact(price.extended)}`
		);

		const next = breakFact(price);
		if (next) {
			facts.push(next);
			out.push(`    ${price.nextQuantity} or more is ${moneyExact(price.nextPrice!)} each`);
		}

		const stock = input.availability.find((a) => a.itemNo === price.itemNo);
		if (stock) {
			facts.push(availabilityFact(stock));
			out.push(`    ${availabilityLine(stock)}`);
		}
		out.push('');
	}

	subtotal = Math.round(subtotal * 100) / 100;
	// The subtotal is a figure of its own, so it gets a fact of its own: the
	// disclosure check has to be able to account for every amount in the text.
	facts.push({
		kind: 'own_price',
		text: `Subtotal for this quote: ${moneyExact(subtotal)}.`,
		subject: input.match.customerNo,
		ids: { customer_no: input.match.customerNo!, lines: input.prices.length },
		amounts: [subtotal]
	});
	out.push(`Subtotal ${moneyExact(subtotal)}, before freight and tax.`);

	if (input.freight) {
		facts.push({
			kind: 'freight',
			text:
				input.freight.freight > 0
					? `Freight on ${moneyExact(subtotal)} is ${moneyExact(input.freight.freight)}; free over ${moneyExact(input.freight.freeOver)}.`
					: `Freight is free over ${moneyExact(input.freight.freeOver)}, which this order clears.`,
			subject: null,
			ids: { subtotal },
			amounts: [input.freight.freight, input.freight.freeOver, subtotal]
		});
		out.push(
			input.freight.freight > 0
				? `Freight would be ${moneyExact(input.freight.freight)} at our published rate, and it ships free over ${moneyExact(input.freight.freeOver)}.`
				: `It ships free: we cover freight over ${moneyExact(input.freight.freeOver)}.`
		);
	}

	const validUntil = addDays(input.today, QUOTE_VALID_DAYS);
	out.push(`This quote holds until ${longDay(validUntil)}.`);

	if (input.neededBy) {
		const late = input.availability.filter((a) => !a.canMeet);
		out.push(
			late.length === 0
				? `We can have all of it to you by ${longDay(input.neededBy)}.`
				: `One thing to flag about your ${longDay(input.neededBy)} date: ${late
						.map(
							(a) =>
								`${a.itemNo} is not all there until ${a.earliestDate === 'today' ? 'today' : longDay(a.earliestDate)}`
						)
						.join('; ')}. I would rather say so now than let it slip.`
		);
	}

	if (input.unresolved.length > 0) {
		out.push(
			`I could not place ${input.unresolved.slice(0, 4).join(', ')} in our catalog, so it is not on this quote. ` +
				`Send me the size and finish and I will add it.`
		);
	}

	if (input.match.ownerName) {
		facts.push({
			kind: 'own_rep',
			text: `${input.match.ownerName} looks after ${input.match.customerName} (${input.match.customerNo}).`,
			subject: input.match.customerNo,
			ids: { customer_no: input.match.customerNo! }
		});
		out.push(`${input.match.ownerName} looks after your account if you would rather talk it through.`);
	}

	out.push('', signOff(input));
	return { subject: replySubject(input.message.subject), body: out.join('\n'), facts, question: null };
}

function availabilityLine(row: Availability): string {
	const now = readyNow(row);
	if (now >= row.quantity) return `All ${row.quantity} can ship from stock`;
	const when = row.earliestDate === 'today' ? 'today' : longDay(row.earliestDate);
	const because =
		row.covering && row.covering.documentNo
			? ` (on our ${row.covering.source} order ${row.covering.documentNo})`
			: row.earliestBasis === 'lead_time'
				? ` (${row.leadDays}-day lead time)`
				: '';
	if (now <= 0) return `Can ship by ${when}${because}`;
	return `${now} can ship now, the rest by ${when}${because}`;
}

// ---------------------------------------------------------------------------
// purchase_order: an acknowledgement with the dates we can actually keep
// ---------------------------------------------------------------------------

function composeOrder(input: ComposeInput): Composed {
	if (input.prices.length === 0) {
		return askAPerson(
			input,
			`Thanks for the order. I could not match ${
				input.unresolved.length > 0 ? input.unresolved.slice(0, 4).join(', ') : 'the part numbers'
			} to our catalog, so I have not entered it yet. Could you confirm the numbers and I will get it in today?`
		);
	}

	const facts: Fact[] = [accountFact(input.match)];
	const out: string[] = [greeting(input), ''];
	out.push(
		input.poNumber
			? `Thanks for purchase order ${input.poNumber}. Here is what we have and the dates we can hold to:`
			: `Thanks for the order. Here is what we have and the dates we can hold to:`,
		''
	);

	let subtotal = 0;
	const cannotMeet: Availability[] = [];
	const offAgreement: string[] = [];

	for (const price of input.prices) {
		facts.push(partFact(price), priceFact(price));
		subtotal += price.extended;
		out.push(`  ${price.itemNo}  ${price.description}`);
		out.push(`    ${price.quantity} at ${moneyExact(price.unitPrice)} each, ${moneyExact(price.extended)}`);

		const stock = input.availability.find((a) => a.itemNo === price.itemNo);
		if (stock) {
			facts.push(availabilityFact(stock));
			out.push(`    ${availabilityLine(stock)}`);
			if (!stock.canMeet) cannotMeet.push(stock);
		}

		// A line priced away from the account's agreement is worth saying out
		// loud rather than discovering on the invoice.
		const agreed = input.agreements.find((a) => a.itemNo === price.itemNo);
		if (agreed && Math.round(agreed.netPrice * 100) !== Math.round(price.unitPrice * 100)) {
			facts.push(agreementFact(agreed, input.match.customerNo!));
			offAgreement.push(
				`${price.itemNo} is priced at ${moneyExact(price.unitPrice)} and your agreement says ${moneyExact(agreed.netPrice)}`
			);
		}
		out.push('');
	}

	subtotal = Math.round(subtotal * 100) / 100;
	facts.push({
		kind: 'own_price',
		text: `Order subtotal: ${moneyExact(subtotal)}.`,
		subject: input.match.customerNo,
		ids: { customer_no: input.match.customerNo!, lines: input.prices.length },
		amounts: [subtotal]
	});
	out.push(`Subtotal ${moneyExact(subtotal)}, before freight and tax.`);

	if (offAgreement.length > 0) {
		out.push(`Please check these before we invoice: ${offAgreement.join('; ')}.`);
	}

	if (input.neededBy) {
		out.push(
			cannotMeet.length === 0
				? `We can make your ${longDay(input.neededBy)} date on every line.`
				: `We cannot make ${longDay(input.neededBy)} on ${cannotMeet
						.map((a) => `${a.itemNo} (${a.earliestDate === 'today' ? 'available now' : longDay(a.earliestDate)})`)
						.join(', ')}. ` +
					`I would rather tell you now than let it slip. Say the word and we will ship what is ready and follow with the rest.`
		);
	}

	if (input.unresolved.length > 0) {
		out.push(
			`${input.unresolved.slice(0, 4).join(', ')} is not a number I can find, so it is not on the order. Send me the size and finish and I will add it.`
		);
	}

	out.push('', 'Nothing is entered in our system until you see this confirmed.', '', signOff(input));
	return { subject: replySubject(input.message.subject), body: out.join('\n'), facts, question: null };
}

// ---------------------------------------------------------------------------
// price_question: their price, at the quantities they asked about
// ---------------------------------------------------------------------------

function composePrices(input: ComposeInput): Composed {
	if (input.prices.length === 0) {
		return askAPerson(
			input,
			input.unresolved.length > 0
				? `I could not find ${input.unresolved.slice(0, 4).join(', ')} in our catalog. Could you check the number and I will price it today?`
				: `Could you tell me which part number you need the price on and I will send it straight back?`
		);
	}

	const facts: Fact[] = [accountFact(input.match)];
	const out: string[] = [greeting(input), '', `Your prices for ${input.match.customerName}:`, ''];

	// One block per part, one line per quantity asked about.
	const byItem = new Map<string, DeskPrice[]>();
	for (const price of input.prices) {
		byItem.set(price.itemNo, [...(byItem.get(price.itemNo) ?? []), price]);
	}

	for (const [itemNo, rows] of byItem) {
		const sorted = [...rows].sort((a, b) => a.quantity - b.quantity);
		facts.push(partFact(sorted[0]));
		out.push(`  ${itemNo}  ${sorted[0].description}`);
		for (const price of sorted) {
			facts.push(priceFact(price));
			out.push(
				`    ${price.quantity} at ${moneyExact(price.unitPrice)} each, ${moneyExact(price.extended)}` +
					(price.breakQuantity ? ` (the ${price.breakQuantity} or more price)` : '')
			);
		}
		const top = sorted[sorted.length - 1];
		const next = breakFact(top);
		if (next) {
			facts.push(next);
			out.push(`    ${top.nextQuantity} or more is ${moneyExact(top.nextPrice!)} each`);
		}
		const agreed = input.agreements.find((a) => a.itemNo === itemNo);
		if (agreed) {
			facts.push(agreementFact(agreed, input.match.customerNo!));
			out.push(`    This is your agreed price, in force since ${longDay(agreed.validFrom)}`);
		} else {
			// No agreement: what they actually paid last time is the thing they
			// are really comparing against, so say it before they have to ask.
			const paid = input.pastPrices.find((p) => p.itemNo === itemNo);
			if (paid) {
				facts.push(pastPriceFact(paid, input.match.customerNo!));
				out.push(`    You last paid ${moneyExact(paid.unitPrice)} on ${longDay(paid.postedOn)}`);
			}
		}
		out.push('');
	}

	out.push(`Good until ${longDay(addDays(input.today, QUOTE_VALID_DAYS))}.`);
	out.push('', signOff(input));
	return { subject: replySubject(input.message.subject), body: out.join('\n'), facts, question: null };
}

// ---------------------------------------------------------------------------
// stock_question: availability, never the shelf
// ---------------------------------------------------------------------------

function composeAvailability(input: ComposeInput): Composed {
	if (input.availability.length === 0) {
		return askAPerson(
			input,
			input.unresolved.length > 0
				? `I could not find ${input.unresolved.slice(0, 4).join(', ')} in our catalog. Could you check the number and I will tell you what we can ship?`
				: `Could you tell me the part number and how many you need, and I will tell you what we can ship and when?`
		);
	}

	const facts: Fact[] = input.match.customerNo ? [accountFact(input.match)] : [];
	const out: string[] = [greeting(input), '', 'Here is what we can ship:', ''];

	for (const row of input.availability) {
		facts.push(availabilityFact(row), leadTimeFact(row));
		out.push(`  ${row.itemNo}  ${row.description}`);
		out.push(`    ${availabilityLine(row)}`);
		if (row.estimated) {
			out.push('    This is read off stock and the orders already on the books, not our supply forecast');
		}
		out.push('');
	}

	out.push('If you want it held, say the word and I will put it aside against your order.');
	out.push('', signOff(input));
	return { subject: replySubject(input.message.subject), body: out.join('\n'), facts, question: null };
}

// ---------------------------------------------------------------------------
// order_status: where their open lines stand
// ---------------------------------------------------------------------------

function composeStatus(input: ComposeInput): Composed {
	const customerNo = input.match.customerNo!;
	if (input.openOrders.length === 0) {
		const facts: Fact[] = [accountFact(input.match)];
		const out: string[] = [
			greeting(input),
			'',
			`There is nothing open on ${input.match.customerName} at the moment: everything you have ordered has shipped.`
		];
		if (input.quotes.length > 0) {
			for (const quote of input.quotes.slice(0, 3)) facts.push(quoteFact(quote, customerNo));
			out.push(
				'',
				`You do have ${input.quotes.length === 1 ? 'a quote' : `${input.quotes.length} quotes`} open with us:`,
				...input.quotes
					.slice(0, 3)
					.map(
						(q) =>
							`  Quote ${q.quoteId} of ${longDay(q.quotedOn)}, ${moneyExact(q.total)}` +
							(q.validUntil ? `, good until ${longDay(q.validUntil)}` : '')
					)
			);
		}
		out.push('', signOff(input));
		return { subject: replySubject(input.message.subject), body: out.join('\n'), facts, question: null };
	}

	const facts: Fact[] = [accountFact(input.match)];
	const out: string[] = [greeting(input), '', `Here is where ${input.match.customerName} stands:`, ''];

	const late: OpenLine[] = [];
	for (const line of input.openOrders.slice(0, 12)) {
		facts.push(openLineFact(line, customerNo));
		const projected = line.projectedDate && line.projectedDate !== line.shipDate ? line.projectedDate : null;
		out.push(
			`  ${line.documentNo} line ${line.lineNo}: ${line.quantity} x ${line.itemNo}, ${line.description}`
		);
		out.push(
			`    promised ${longDay(line.shipDate)}` + (projected ? `, our forecast says ${longDay(projected)}` : '')
		);
		if (projected && projected > line.shipDate) late.push(line);
	}
	out.push('');

	if (input.openOrders.length > 12) {
		out.push(`That is the first 12 of ${input.openOrders.length} open lines; tell me if you want the rest.`);
	}
	out.push(
		late.length === 0
			? 'Nothing on it is running late as things stand.'
			: `${late.length === 1 ? 'One line is' : `${late.length} lines are`} running behind the promised date: ` +
				`${late.map((l) => `${l.documentNo} line ${l.lineNo} (${l.itemNo})`).join(', ')}. ` +
				`I would rather you had the real date than the one on the order.`
	);
	out.push('', signOff(input));
	return { subject: replySubject(input.message.subject), body: out.join('\n'), facts, question: null };
}

// ---------------------------------------------------------------------------
// The procurement desk: a supplier's own orders
// ---------------------------------------------------------------------------

function composeVendor(input: ComposeInput): Composed {
	const vendorNo = input.match.vendorNo!;
	if (input.vendorLines.length === 0) {
		return askAPerson(
			input,
			`Thanks for letting us know. I do not have an open order with you on file that matches, so I have passed this to purchasing to check against our own records.`,
			[]
		);
	}

	const facts: Fact[] = [];
	const out: string[] = [
		greeting(input),
		'',
		'Thanks for the update. This is what we have open with you:',
		''
	];
	for (const line of input.vendorLines.slice(0, 10)) {
		facts.push({
			kind: 'vendor_supply',
			text: `${line.documentNo}: ${line.quantity} x ${line.itemNo}, due ${longDay(line.dueDate)}.`,
			subject: vendorNo,
			ids: { document_no: line.documentNo, item_no: line.itemNo, vendor_no: vendorNo }
		});
		out.push(`  ${line.documentNo}: ${line.quantity} x ${line.itemNo}, ${line.description}`);
		out.push(
			`    due ${longDay(line.dueDate)}` + (line.promisedDate ? `, you promised ${longDay(line.promisedDate)}` : '')
		);
	}
	out.push('');
	out.push(
		'We do have customer orders waiting on these, so a partial release would help. Purchasing will confirm which lines to split.'
	);
	out.push('', signOff(input));
	return { subject: replySubject(input.message.subject), body: out.join('\n'), facts, question: null };
}

// ---------------------------------------------------------------------------
// other: ask, do not guess
// ---------------------------------------------------------------------------

function composeOther(input: ComposeInput): Composed {
	const facts: Fact[] = input.match.customerNo ? [accountFact(input.match)] : [];
	return askAPerson(
		input,
		`Thanks for writing. I look after quotes, orders, prices, stock and order status at this desk, and I could not tell which of those this is. ` +
			`Could you tell me what you need, with the part numbers if there are any, and I will come straight back?`,
		facts
	);
}
