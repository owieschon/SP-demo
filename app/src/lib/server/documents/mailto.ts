// The quote as an email the person can send from their own mail app.
//
// A mailto: link opens the mail app with the address, the subject and the
// body filled in. It cannot carry a file: no browser lets a link attach
// anything, for good reasons. So the page offers both, and says so plainly:
// download the PDF, then attach it to the message this link opened. The app
// never pretends the file went along.
//
// Everything that goes into the link is percent-encoded. A customer's name
// with an ampersand in it ("Hobbs & Vance Truck Parts") would otherwise end
// the body and start a header of its own.
import { DEMO_FOOTER, LETTERHEAD } from './letterhead.ts';
import type { QuoteDoc } from './quote.ts';

const money = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-17' -> 'Oct 17'. */
function shortDay(iso: string): string {
	const [, m, d] = iso.split('-').map(Number);
	return `${MONTHS[m - 1]} ${d}`;
}

/** '2026-10-17' -> 'Oct 17, 2026'. */
function longDay(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export interface MailDraft {
	/** The buyer's address, or null when nobody is named on the quote. */
	to: string | null;
	subject: string;
	body: string;
	/** The whole mailto: URL, ready for an href. */
	href: string;
}

/**
 * The subject: what it is, how much of it, and how long it holds.
 * "Quote 448123 for 6 parts, valid to Oct 17"
 */
export function mailSubject(doc: QuoteDoc): string {
	const parts = `${doc.lines.length} ${doc.lines.length === 1 ? 'part' : 'parts'}`;
	const head = doc.kind === 'quote' ? `Quote ${doc.reference}` : `Draft quote for request ${doc.reference}`;
	return doc.validUntil ? `${head} for ${parts}, valid to ${shortDay(doc.validUntil)}` : `${head} for ${parts}`;
}

/** The first name of whoever is named on the quote, for the greeting. */
function greeting(doc: QuoteDoc): string {
	const first = doc.buyerName?.trim().split(/\s+/)[0];
	return first ? `Hello ${first},` : 'Hello,';
}

export function mailBody(doc: QuoteDoc): string {
	const lines = doc.lines.map(
		(line) =>
			`  ${line.lineNo}. ${line.itemNo} - ${line.description} - ${line.quantity} at ${money.format(line.unitPrice)} = ${money.format(line.extended)}`
	);

	const held = doc.validUntil ? ` It holds until ${longDay(doc.validUntil)}.` : '';
	const what =
		doc.kind === 'quote'
			? `Here is quote ${doc.reference} for ${doc.customerName}.${held}`
			: `Here is a draft quote for your request, reference ${doc.reference}.${held}`;

	return [
		greeting(doc),
		'',
		'Thank you for the request.',
		what,
		'',
		...lines,
		'',
		`Subtotal: ${money.format(doc.subtotal)}`,
		'',
		doc.freightNote,
		doc.terms,
		'',
		'The quote PDF is attached.',
		'',
		doc.preparedBy,
		LETTERHEAD.company,
		`${LETTERHEAD.phone} / ${LETTERHEAD.email}`,
		'',
		DEMO_FOOTER
	].join('\n');
}

/** Percent-encode an address but leave the @ readable, as mail apps expect. */
function encodeAddress(address: string): string {
	return encodeURIComponent(address).replace(/%40/g, '@');
}

export function quoteMail(doc: QuoteDoc): MailDraft {
	const subject = mailSubject(doc);
	const body = mailBody(doc);
	const to = doc.buyerEmail?.trim() || null;
	const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
	return { to, subject, body, href: `mailto:${to ? encodeAddress(to) : ''}?${query}` };
}
