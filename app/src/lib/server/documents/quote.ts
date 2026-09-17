// The quote as a document: one set of numbers, read once, used by the web
// page, the PDF and the email body.
//
// There are two kinds. An approved quote has its own row (nl.quotes) and is
// read through nl.quote_document, the view that derives the subtotal from
// the lines. A draft has no quote yet, so the same shape is built from the
// draft's stored validation, which is exactly what the review page shows.
//
// Money is worked in whole cents here, the same way ../rfq/validate.ts and
// nl.approve_rfq_draft work it, so the page, this file and the quote that
// eventually gets written cannot differ by a rounding cent.
import type { Db, Tx } from '../db/types.ts';
import type { Validation } from '../rfq/schema.ts';
import { freightNote, QUOTE_VALID_DAYS, TERMS } from './letterhead.ts';

export interface QuoteDocLine {
	lineNo: number;
	itemNo: string;
	description: string;
	quantity: number;
	unitPrice: number;
	/** quantity x unitPrice, rounded to the cent. */
	extended: number;
}

export interface QuoteDoc {
	/** 'quote' once it is real; 'draft' while it is still being reviewed. */
	kind: 'quote' | 'draft';
	/** What the document calls itself: "448123", or "R-7001" for a draft. */
	reference: string;
	/** "Quote 448123" or "Draft quote for request R-7001". */
	title: string;
	quoteId: number | null;
	draftId: number | null;
	commitmentId: number | null;
	quotedOn: string;
	validUntil: string | null;
	customerNo: string;
	customerName: string;
	customerCity: string;
	customerState: string;
	customerCountry: string;
	priceGroupLabel: string;
	buyerName: string | null;
	buyerTitle: string | null;
	buyerEmail: string | null;
	preparedBy: string;
	lines: QuoteDocLine[];
	subtotal: number;
	freightNote: string;
	terms: string;
}

const cents = (value: number) => Math.round(value * 100);

/** quantity x unit price, to the cent. */
export function extend(quantity: number, unitPrice: number): number {
	return (cents(unitPrice) * quantity) / 100;
}

/** The sum of the lines, to the cent. */
export function subtotalOf(lines: QuoteDocLine[]): number {
	return lines.reduce((sum, line) => sum + cents(line.extended), 0) / 100;
}

/** A date that many days later, as YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
	const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86400000;
	return new Date(ms).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// An approved quote
// ---------------------------------------------------------------------------

interface QuoteHeadRow {
	id: number;
	customer_no: string;
	customer_name: string;
	customer_city: string;
	customer_state: string;
	customer_country: string;
	ships_own_carrier: boolean;
	price_group_label: string;
	contact_name: string | null;
	contact_title: string | null;
	contact_email: string | null;
	commitment_id: number | null;
	quoted_on: string;
	valid_until: string | null;
	created_by_name: string;
	subtotal: number;
}

async function readQuote(tx: Tx, quoteId: number): Promise<QuoteDoc | null> {
	const [head] = await tx.sql<QuoteHeadRow>`
		select id, customer_no, customer_name, customer_city, customer_state, customer_country,
		       ships_own_carrier, price_group_label, contact_name, contact_title, contact_email,
		       commitment_id, quoted_on, valid_until, created_by_name, subtotal
		from nl.quote_document
		where id = ${quoteId}`;
	if (!head) return null;

	const rows = await tx.sql<{
		line_no: number;
		item_no: string;
		description: string;
		quantity: number;
		unit_price: number;
	}>`
		select ql.line_no, ql.item_no, i.description, ql.quantity, ql.unit_price
		from nl.quote_lines ql
		join nl.items i on i.item_no = ql.item_no
		where ql.quote_id = ${quoteId}
		order by ql.line_no`;

	const lines: QuoteDocLine[] = rows.map((r) => ({
		lineNo: r.line_no,
		itemNo: r.item_no,
		description: r.description,
		quantity: r.quantity,
		unitPrice: r.unit_price,
		extended: extend(r.quantity, r.unit_price)
	}));

	return {
		kind: 'quote',
		reference: String(head.id),
		title: `Quote ${head.id}`,
		quoteId: head.id,
		draftId: null,
		commitmentId: head.commitment_id,
		quotedOn: head.quoted_on,
		validUntil: head.valid_until,
		customerNo: head.customer_no,
		customerName: head.customer_name,
		customerCity: head.customer_city,
		customerState: head.customer_state,
		customerCountry: head.customer_country,
		priceGroupLabel: head.price_group_label,
		buyerName: head.contact_name,
		buyerTitle: head.contact_title,
		buyerEmail: head.contact_email,
		preparedBy: head.created_by_name,
		lines,
		// The view derives the same figure in SQL; this asserts the two agree
		// rather than trusting one of them.
		subtotal: subtotalOf(lines),
		freightNote: freightNote(head.ships_own_carrier),
		terms: TERMS
	};
}

/** One quote as a document, or null when there is no such quote. */
export async function loadQuoteDoc(db: Db, userId: number, quoteId: number): Promise<QuoteDoc | null> {
	return db.asUser(userId, (tx) => readQuote(tx, quoteId));
}

/** The subtotal the database derives, for the test that proves they match. */
export async function storedSubtotal(db: Db, userId: number, quoteId: number): Promise<number | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ subtotal: number }>`select subtotal from nl.quote_document where id = ${quoteId}`
	);
	return row?.subtotal ?? null;
}

// ---------------------------------------------------------------------------
// A draft, before anyone has approved it
// ---------------------------------------------------------------------------

/**
 * The quote a draft would become. Built from the draft's stored validation,
 * so every figure is the one on the review page. A line that is removed, or
 * whose part or quantity is not settled, is left out: a draft quote shows
 * what can be quoted so far, and the page says how many fields still need a
 * person.
 */
export function quoteFromValidation(input: {
	draftId: number;
	validation: Validation;
	customer: {
		customerNo: string;
		name: string;
		city: string;
		state: string;
		country: string;
		shipsOwnCarrier: boolean;
		priceGroupLabel: string;
	};
	buyer: { name: string; title: string | null; email: string | null } | null;
	preparedBy: string;
}): QuoteDoc {
	const lines: QuoteDocLine[] = [];
	for (const line of input.validation.lines) {
		if (line.removed) continue;
		if (line.item_no === null || line.quantity === null || line.unit_price === null) continue;
		lines.push({
			lineNo: lines.length + 1,
			itemNo: line.item_no,
			description: line.description ?? '',
			quantity: line.quantity,
			unitPrice: line.unit_price,
			extended: extend(line.quantity, line.unit_price)
		});
	}

	const quotedOn = input.validation.today;
	return {
		kind: 'draft',
		reference: `R-${input.draftId}`,
		title: `Draft quote for request R-${input.draftId}`,
		quoteId: null,
		draftId: input.draftId,
		commitmentId: null,
		quotedOn,
		validUntil: addDays(quotedOn, QUOTE_VALID_DAYS),
		customerNo: input.customer.customerNo,
		customerName: input.customer.name,
		customerCity: input.customer.city,
		customerState: input.customer.state,
		customerCountry: input.customer.country,
		priceGroupLabel: input.customer.priceGroupLabel,
		buyerName: input.buyer?.name ?? input.validation.customer.contact_name ?? null,
		buyerTitle: input.buyer?.title ?? null,
		buyerEmail: input.buyer?.email ?? null,
		preparedBy: input.preparedBy,
		lines,
		subtotal: subtotalOf(lines),
		freightNote: freightNote(input.customer.shipsOwnCarrier),
		terms: TERMS
	};
}

/** What a draft quote needs that the validation does not carry. */
export async function loadDraftQuoteDoc(
	db: Db,
	userId: number,
	draft: { id: number; validation: Validation; createdByName: string }
): Promise<QuoteDoc | null> {
	const customerNo = draft.validation.customer.customer_no;
	if (!customerNo) return null;

	return db.asUser(userId, async (tx) => {
		const [customer] = await tx.sql<{
			customer_no: string;
			name: string;
			city: string;
			state: string;
			country: string;
			ships_own_carrier: boolean;
			price_group_label: string;
		}>`
			select c.customer_no, c.name, c.city, c.state, c.country, c.ships_own_carrier,
			       pg.label as price_group_label
			from nl.customers c
			join nl.price_groups pg on pg.code = c.price_group
			where c.customer_no = ${customerNo}`;
		if (!customer) return null;

		const contactId = draft.validation.customer.contact_id;
		const [contact] = contactId
			? await tx.sql<{ full_name: string; title: string; email: string | null }>`
					select full_name, title, email from nl.contacts
					where id = ${contactId} and customer_no = ${customerNo}`
			: [];

		return quoteFromValidation({
			draftId: draft.id,
			validation: draft.validation,
			customer: {
				customerNo: customer.customer_no,
				name: customer.name,
				city: customer.city,
				state: customer.state,
				country: customer.country,
				shipsOwnCarrier: customer.ships_own_carrier,
				priceGroupLabel: customer.price_group_label
			},
			buyer: contact ? { name: contact.full_name, title: contact.title || null, email: contact.email } : null,
			preparedBy: draft.createdByName
		});
	});
}
