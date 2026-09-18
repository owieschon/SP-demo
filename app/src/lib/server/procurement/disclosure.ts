// What a vendor is allowed to hear, and the check that stops anything else
// reaching one.
//
// A vendor MAY hear:
//   * the part numbers and descriptions we want
//   * the quantities
//   * the dates we want them by
//   * the price WE pay THEM (our purchase price, from the cost timeline)
//   * our payment and freight terms with them
//   * our own name, purchase order number and contact details
//
// A vendor may NEVER hear:
//   * the name of any customer of ours
//   * what we sell the part for, or any customer's price
//   * our margin on anything
//   * another vendor's prices, or another vendor's name
//
// The reasoning is commercial rather than legal. A vendor who knows which
// customer the parts are for can go round us. A vendor who knows our selling
// price knows our margin and will ask for a share of it. A vendor who sees a
// competitor's quote learns exactly what it has to beat, which is worth more
// to it than it is to us.
//
// This is enforced two ways, and both matter:
//
//   1. The email is BUILT from a typed structure (email.ts) that only has
//      fields a vendor may hear. There is no field on it for a margin, so no
//      amount of editing the template can leak one.
//   2. The finished text is then SCANNED against the things this particular
//      order must not mention, gathered from the database in outbox.ts. That
//      catches anything a person typed into a note, and anything a future
//      change to the template lets through.
//
// Nothing is queued until the scan passes, and the scan runs inside the same
// transaction as the approval, so a refusal rolls the approval back with it.
import { AppError } from '../errors.ts';

/** The kinds of thing a vendor email is scanned for. */
export type DisclosureKind =
	| 'customer'
	| 'selling_price'
	| 'margin'
	| 'other_vendor_price'
	| 'other_vendor';

export interface VendorDisclosureContext {
	/** The vendor this email is going to. Its own prices are fine. */
	vendorNo: string;
	vendorName: string;
	/** Customer names behind the demand for these parts. */
	customerNames: string[];
	/** What we sell these parts for. */
	sellingPrices: number[];
	/** Our margin on these parts, as a ratio (0.42) or a percentage (42). */
	marginPcts: number[];
	/** What other vendors charge us for these parts. */
	otherVendorPrices: number[];
	/** The names of other vendors who supply these parts. */
	otherVendorNames: string[];
}

export interface DisclosureProblem {
	kind: DisclosureKind;
	/** The exact text found in the email. */
	found: string;
	message: string;
}

/**
 * Words that give the game away on their own, whatever numbers are next to
 * them. "Our cost" is fine to write to a vendor (it is their price); "our
 * margin" and "selling price" are not.
 */
const FORBIDDEN_PHRASES: { phrase: string; kind: DisclosureKind; why: string }[] = [
	{ phrase: 'margin', kind: 'margin', why: 'our margin is never a vendor’s business' },
	{ phrase: 'markup', kind: 'margin', why: 'our markup is never a vendor’s business' },
	{ phrase: 'gross profit', kind: 'margin', why: 'our profit is never a vendor’s business' },
	{ phrase: 'selling price', kind: 'selling_price', why: 'what we charge is not the vendor’s business' },
	{ phrase: 'sell price', kind: 'selling_price', why: 'what we charge is not the vendor’s business' },
	{ phrase: 'sell it for', kind: 'selling_price', why: 'what we charge is not the vendor’s business' },
	{ phrase: 'resale', kind: 'selling_price', why: 'what we charge is not the vendor’s business' },
	{ phrase: 'list price', kind: 'selling_price', why: 'our list price is not the vendor’s business' },
	{
		phrase: 'customer price',
		kind: 'selling_price',
		why: 'what a customer pays is not the vendor’s business'
	},
	{
		phrase: 'quoted us',
		kind: 'other_vendor_price',
		why: 'what another vendor quoted is not this vendor’s business'
	}
];

/**
 * The characters a word processor swaps in for the plain ones people type:
 * the two curly single quotes and the modifier apostrophe, and the en dash,
 * the em dash and the minus sign. They are written as code points rather than
 * as themselves so this file stays plain ASCII and the house style survives
 * whatever editor opens it next.
 */
const CURLY_QUOTES = new RegExp(`[${String.fromCharCode(0x2018, 0x2019, 0x02bc)}]`, 'g');
const LONG_DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014, 0x2212)}]`, 'g');

/** Fold a string down to something two spellings of the same name both reach. */
function normalize(text: string): string {
	return (
		text
			.toLowerCase()
			// Curly quotes and long dashes become their plain equivalents, so a
			// name cannot slip through by being typed with a different
			// apostrophe.
			.replace(CURLY_QUOTES, "'")
			.replace(LONG_DASHES, '-')
			// Thousands separators go, so $1,500.00 and 1500.00 are one shape.
			.replace(/(\d),(\d\d\d)/g, '$1$2')
			// A full stop that is not a decimal point is punctuation. Without
			// this, "at 118.75." keeps the sentence's period stuck to the
			// number and the number stops matching itself.
			.replace(/\.(?!\d)/g, ' ')
			// Everything else that is not a letter, a digit, a dot, a dollar
			// sign or a per cent sign becomes a space. The two signs are kept
			// because they are what tells a price from a quantity.
			.replace(/[^a-z0-9.$%]+/g, ' ')
			.trim()
	);
}

/**
 * Does this number appear in the text as a number in its own right? A bare
 * substring match would find 128 inside the part number ELB-1284, so a match
 * has to start and end at something that is not a digit or a dot.
 */
function standsAlone(normalized: string, shape: string, prefix = '', suffix = ''): boolean {
	const needle = `${prefix}${shape}${suffix}`;
	const padded = ` ${normalized} `;
	const isEdge = (ch: string | undefined) => ch === undefined || !/[0-9.]/.test(ch);
	let from = 0;
	for (;;) {
		const at = padded.indexOf(needle, from);
		if (at === -1) return false;
		if (isEdge(padded[at - 1]) && isEdge(padded[at + needle.length])) return true;
		from = at + 1;
	}
}

/**
 * Does the text mention this dollar amount?
 *
 * The email is SUPPOSED to contain quantities and the prices we pay this
 * vendor, so a plain search for the number 40 would refuse an order for 40
 * clamps because something sells for $40. Two shapes are therefore treated
 * as money and nothing else is:
 *
 *   $40, $40.00   a dollar sign says it is a price
 *   40.00         two decimal places is how money is written and how a
 *                 quantity never is
 *
 * Cents are compared rather than dollars, so 128.4 and 128.40 count as the
 * same price.
 */
function mentionsMoney(normalized: string, value: number): string | null {
	const cents = Math.round(Math.abs(value) * 100);
	if (cents === 0) return null;
	const exact = (cents / 100).toFixed(2); // 128.40
	const short = String(cents / 100); // 128.4
	const whole = cents % 100 === 0 ? String(cents / 100) : null; // 128

	// Two decimal places, with or without a dollar sign.
	if (standsAlone(normalized, exact)) return `$${exact}`;
	// A dollar sign in front of any spelling of it.
	for (const shape of [exact, short, whole]) {
		if (shape && standsAlone(normalized, shape, '$')) return `$${shape}`;
	}
	return null;
}

/**
 * Does the text mention this margin? A margin reaches a page as a ratio
 * (0.42) or as a percentage (42), and only counts when it is written as one:
 * next to a per cent sign, or as a decimal that is not a whole number.
 */
function mentionsPercent(normalized: string, value: number): string | null {
	const ratio = Math.abs(value) <= 1 ? Math.abs(value) : Math.abs(value) / 100;
	const pct = Math.round(ratio * 1000) / 10;
	if (pct <= 0) return null;
	const shapes = [String(pct), String(Math.round(pct))];
	for (const shape of shapes) {
		if (standsAlone(normalized, shape, '', '%')) return `${shape}%`;
		if (standsAlone(normalized, shape, '', ' percent')) return `${shape} percent`;
	}
	// The ratio itself, which is never a quantity and never a dollar amount
	// written the way this app writes them.
	const asRatio = ratio.toFixed(2);
	if (standsAlone(normalized, asRatio)) return asRatio;
	return null;
}

/**
 * The company-name endings people drop when they write a name in a sentence.
 * "Ridge Diesel Service Inc." and "Ridge Diesel Service" have to count as the
 * same name, or leaving off the suffix would be enough to get past the scan.
 */
// Written without their full stops, because normalize() has already taken
// those off by the time a name is compared.
const NAME_SUFFIXES = ['inc', 'llc', 'ltd', 'co', 'corp', 'company', 'incorporated'];

/** Does the text mention this name? Matched on whole words after folding. */
function mentionsName(normalized: string, name: string): boolean {
	const full = normalize(name);
	// A one or two character "name" would match everywhere; ignore it rather
	// than refuse every email.
	if (full.length < 3) return false;

	const words = full.split(' ');
	// The same name with the company ending taken off, when there is still
	// something distinctive left to match on.
	const trimmed =
		words.length > 1 && NAME_SUFFIXES.includes(words[words.length - 1])
			? words.slice(0, -1).join(' ')
			: full;

	const padded = ` ${normalized} `;
	for (const needle of new Set([full, trimmed])) {
		if (needle.length >= 3 && padded.includes(` ${needle} `)) return true;
	}
	return false;
}

/**
 * Everything in this email that a vendor must not hear. Empty means the
 * email is safe to queue.
 *
 * Returned rather than thrown, so the page can show every problem at once
 * and a test can assert on each one.
 */
export function findDisclosureProblems(
	text: string,
	context: VendorDisclosureContext
): DisclosureProblem[] {
	const normalized = normalize(text);
	const problems: DisclosureProblem[] = [];
	const seen = new Set<string>();
	const add = (problem: DisclosureProblem) => {
		const key = `${problem.kind}:${problem.found}`;
		if (seen.has(key)) return;
		seen.add(key);
		problems.push(problem);
	};

	for (const { phrase, kind, why } of FORBIDDEN_PHRASES) {
		if (normalized.includes(normalize(phrase))) {
			add({ kind, found: phrase, message: `The email says "${phrase}", and ${why}.` });
		}
	}

	for (const name of context.customerNames) {
		if (mentionsName(normalized, name)) {
			add({
				kind: 'customer',
				found: name,
				message: `The email names ${name}. A vendor never hears which customer the parts are for.`
			});
		}
	}

	for (const name of context.otherVendorNames) {
		// The vendor being written to is allowed to see its own name.
		if (normalize(name) === normalize(context.vendorName)) continue;
		if (mentionsName(normalized, name)) {
			add({
				kind: 'other_vendor',
				found: name,
				message: `The email names ${name}, another vendor. Keep each vendor out of the others' mail.`
			});
		}
	}

	for (const price of context.sellingPrices) {
		const found = mentionsMoney(normalized, price);
		if (found) {
			add({
				kind: 'selling_price',
				found,
				message: `${found} is what we sell one of these parts for. A vendor hears what we pay, not what we charge.`
			});
		}
	}

	for (const price of context.otherVendorPrices) {
		const found = mentionsMoney(normalized, price);
		if (found) {
			add({
				kind: 'other_vendor_price',
				found,
				message: `${found} is another vendor's price for one of these parts. It is not this vendor's to know.`
			});
		}
	}

	for (const pct of context.marginPcts) {
		const found = mentionsPercent(normalized, pct);
		if (found) {
			add({
				kind: 'margin',
				found,
				message: `${found} is our margin on one of these parts. A vendor never hears our margin.`
			});
		}
	}

	return problems;
}

/**
 * The gate. Called in outbox.ts before anything is written, so a refusal
 * takes the approval down with it.
 */
export function assertVendorSafe(text: string, context: VendorDisclosureContext): void {
	const problems = findDisclosureProblems(text, context);
	if (problems.length === 0) return;
	throw new AppError(
		422,
		'NL422',
		`This email cannot go to a vendor. ${problems.map((p) => p.message).join(' ')}`
	);
}
