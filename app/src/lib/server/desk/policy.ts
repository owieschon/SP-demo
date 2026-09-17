// The disclosure policy: what may leave the building, and to whom.
//
// This file is the whole rule. It is not a paragraph in a prompt, because a
// prompt is a request and this is a constraint: the check runs on the
// assembled draft, after the words are written, and a draft that cites
// anything it should not is refused and handed to a person. It does not
// matter whether the words came from code, from a model, or from a model that
// had just read an email telling it to ignore its instructions.
//
// Two things are checked:
//
//   1. Every fact the draft cites must be a kind this recipient may hear, and
//      a fact about somebody must be about THIS recipient. "Their own price"
//      is allowed; the same kind of fact about another account is not, which
//      is why a fact carries a subject and not only a kind.
//
//   2. Every dollar figure in the body must be traceable to one of those
//      facts. A figure nobody verified is the shape a leak takes: the facts
//      list stays clean and the number appears in the prose. So the body is
//      read back and each amount has to be accounted for.
//
// Cost, margin, the floor price, raw stock levels, another customer's
// anything, internal notes and colleagues' names are on nobody's customer
// list. They are perfectly readable by the agent (it needs cost to know a
// price is below the floor, which is why a draft can be held for a person);
// they simply cannot be cited in a draft that goes outside.
import type { Disclosure, Fact, FactKind, PolicyVerdict } from '$lib/desk/types';

/** What each recipient may hear. Anything not listed is refused. */
export const DISCLOSURE_ALLOWS: Record<Disclosure, FactKind[]> = {
	// A customer hears their own commercial position and nothing else.
	customer: [
		'account_identity',
		'part_description',
		'own_price',
		'quantity_break',
		'own_past_price',
		'own_agreement',
		'availability',
		'lead_time',
		'own_open_order',
		'own_quote',
		'own_commitment',
		'own_rep',
		'freight'
	],
	// A supplier hears about their own orders and what we need from them.
	vendor: ['part_description', 'vendor_supply', 'vendor_lead_time', 'lead_time'],
	// Inside the company, everything the agent found can be shown.
	internal: [
		'account_identity',
		'part_description',
		'own_price',
		'quantity_break',
		'own_past_price',
		'own_agreement',
		'availability',
		'lead_time',
		'own_open_order',
		'own_quote',
		'own_commitment',
		'own_rep',
		'freight',
		'vendor_supply',
		'vendor_lead_time',
		'stock_quantity',
		'unit_cost',
		'margin',
		'floor_price',
		'other_customer',
		'internal_note',
		'colleague_name'
	]
};

/** Said plainly, for the refusal a person reads. */
const KIND_LABEL: Record<FactKind, string> = {
	account_identity: 'which account this is',
	part_description: 'a part description',
	own_price: 'their own price',
	quantity_break: 'a quantity break',
	own_past_price: 'a price they paid before',
	own_agreement: 'their own price agreement',
	availability: 'an availability date',
	lead_time: 'a lead time',
	own_open_order: 'their own open order',
	own_quote: 'their own quote',
	own_commitment: 'their own commitment',
	own_rep: 'the name of their account manager',
	freight: 'a freight figure',
	vendor_supply: "a supplier's own order",
	vendor_lead_time: "a supplier's lead time",
	stock_quantity: 'how many are on the shelf',
	unit_cost: 'what the part costs us',
	margin: 'our margin',
	floor_price: 'our price floor',
	other_customer: "another account's data",
	internal_note: 'an internal note',
	colleague_name: "a colleague's name"
};

/** A fact of this kind is about a particular account or supplier. */
function isAboutSomebody(kind: FactKind): boolean {
	return (
		kind === 'own_price' ||
		kind === 'own_past_price' ||
		kind === 'own_agreement' ||
		kind === 'own_open_order' ||
		kind === 'own_quote' ||
		kind === 'own_commitment' ||
		kind === 'own_rep' ||
		kind === 'account_identity' ||
		kind === 'vendor_supply' ||
		kind === 'other_customer'
	);
}

export function allows(level: Disclosure, kind: FactKind): boolean {
	return DISCLOSURE_ALLOWS[level].includes(kind);
}

/**
 * Every dollar figure in a piece of text, in cents.
 *
 * Only figures written as money count ($1,234.50). A bare number is a
 * quantity, a part number, a date or a purchase order, and treating those as
 * money would make the check cry wolf on every reply.
 */
export function moneyFigures(text: string): number[] {
	const found: number[] = [];
	for (const match of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/g)) {
		const value = Number(match[1].replace(/,/g, ''));
		if (Number.isFinite(value)) found.push(Math.round(value * 100));
	}
	return found;
}

export interface DraftCheck {
	/** The mailbox's disclosure level. */
	level: Disclosure;
	/** Whose mail this is: the customer number or vendor number it goes to. */
	subject: string | null;
	facts: Fact[];
	subjectLine: string;
	body: string;
}

/**
 * Check an assembled draft. `ok` false means it must not be sent: the caller
 * queues it held, with these reasons on it, and a person decides.
 */
export function checkDraft(input: DraftCheck): PolicyVerdict {
	const reasons: string[] = [];
	const { level, subject, facts } = input;

	for (const fact of facts) {
		if (!allows(level, fact.kind)) {
			reasons.push(
				`The reply cites ${KIND_LABEL[fact.kind]}, which a ${level} may not be told (${fact.text}).`
			);
			continue;
		}
		if (isAboutSomebody(fact.kind)) {
			if (fact.subject === null) {
				reasons.push(`The reply cites ${KIND_LABEL[fact.kind]} without saying whose it is (${fact.text}).`);
			} else if (subject === null) {
				reasons.push(
					`The reply cites ${KIND_LABEL[fact.kind]} for ${fact.subject}, but this message was not matched to an account.`
				);
			} else if (fact.subject !== subject) {
				reasons.push(
					`The reply cites ${KIND_LABEL[fact.kind]} belonging to ${fact.subject}, and this reply goes to ${subject}.`
				);
			}
		}
	}

	// Amounts a person may see, from the facts that passed the first check.
	const allowed = new Set<number>();
	for (const fact of facts) {
		if (!allows(level, fact.kind)) continue;
		if (isAboutSomebody(fact.kind) && fact.subject !== null && fact.subject !== subject) continue;
		for (const amount of fact.amounts ?? []) allowed.add(Math.round(amount * 100));
	}

	for (const cents of [...moneyFigures(input.subjectLine), ...moneyFigures(input.body)]) {
		if (!allowed.has(cents)) {
			reasons.push(
				`The reply names $${(cents / 100).toFixed(2)}, which is not one of the figures it verified. Every amount has to come from a fact.`
			);
		}
	}

	return { ok: reasons.length === 0, reasons };
}
