// The vendor email, built from a structure that only has fields a vendor may
// hear (see disclosure.ts for the rule and the reasoning).
//
// There is no field here for a customer, a selling price or a margin, so the
// first line of defence against a leak is that there is nothing to leak
// FROM. The scan in disclosure.ts is the second line, for anything a person
// typed into the note.
//
// Plain text, not HTML: a purchase order email gets forwarded, printed and
// pasted into an ERP, and plain text survives all three.

/** One line of the order, as the vendor reads it. */
export interface VendorEmailLine {
	itemNo: string;
	description: string;
	quantity: number;
	/** What WE pay THEM. Never what we charge a customer. */
	unitCost: number;
	requestedOn: string;
}

export interface VendorEmailInput {
	vendorName: string;
	contactName: string;
	orderNo: string;
	/** Our own terms with this vendor, in their words. */
	terms: string;
	freightNote: string;
	lines: VendorEmailLine[];
	/** Who is sending it, for the sign-off. */
	fromName: string;
	fromTitle: string;
	fromEmail: string;
}

export interface VendorEmail {
	subject: string;
	body: string;
}

const money = new Intl.NumberFormat('en-US', {
	style: 'currency',
	currency: 'USD',
	minimumFractionDigits: 2,
	maximumFractionDigits: 2
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-08' -> 'Oct 8, 2026'. Dates are calendar dates, never shifted. */
function longDay(iso: string): string {
	const [y, m, d] = iso.split('-').map(Number);
	return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** Pad to a fixed width so the table lines up in a monospaced mail client. */
function pad(text: string, width: number): string {
	return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
	return text.length >= width ? text : ' '.repeat(width - text.length) + text;
}

/**
 * Build the email. Nothing is sent: the result is stored for a person to
 * read, edit and send themselves (nl.purchase_request_drafts, and 0021's
 * nl.mail_drafts once that is here).
 */
export function buildVendorEmail(input: VendorEmailInput): VendorEmail {
	const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);
	const dates = [...new Set(input.lines.map((line) => line.requestedOn))].sort();

	const subject = `Purchase order ${input.orderNo} from Northline Exhaust`;

	// The line table. Item, description, quantity, our purchase price, the
	// date we want it. Nothing else.
	const header = `${pad('Item', 16)}${pad('Description', 34)}${padLeft('Qty', 6)}  ${padLeft('Unit', 10)}  ${padLeft('Total', 11)}  Wanted by`;
	const rows = input.lines.map((line) => {
		const lineTotal = line.quantity * line.unitCost;
		return (
			pad(line.itemNo, 16) +
			pad(line.description.slice(0, 32), 34) +
			padLeft(String(line.quantity), 6) +
			'  ' +
			padLeft(money.format(line.unitCost), 10) +
			'  ' +
			padLeft(money.format(lineTotal), 11) +
			'  ' +
			longDay(line.requestedOn)
		);
	});

	const greeting = input.contactName ? `Hello ${input.contactName.split(' ')[0]},` : 'Hello,';
	const wanted =
		dates.length === 1
			? `We would like all of it by ${longDay(dates[0])}.`
			: `Dates are on each line; the earliest is ${longDay(dates[0])}.`;

	const body = [
		greeting,
		'',
		`Please treat this as purchase order ${input.orderNo}. ${wanted}`,
		'',
		header,
		'-'.repeat(header.length),
		...rows,
		'-'.repeat(header.length),
		`${padLeft('Order total', 56)}  ${padLeft(money.format(total), 11)}`,
		'',
		input.terms ? `Terms: ${input.terms}` : null,
		input.freightNote ? `Freight: ${input.freightNote}` : null,
		'',
		'Please confirm the quantities, the prices and a ship date by return.',
		'If any line cannot make its date, tell us which one and when you can,',
		'and we will work round it rather than have you guess.',
		'',
		'Thank you,',
		input.fromName,
		input.fromTitle ? `${input.fromTitle}, Northline Exhaust Co.` : 'Northline Exhaust Co.',
		input.fromEmail
	]
		.filter((part) => part !== null)
		.join('\n');

	return { subject, body };
}
