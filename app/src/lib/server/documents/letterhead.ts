// Northline's own details, in one place, so the quote page, the quote PDF
// and the email body cannot disagree about them.
//
// Northline Exhaust Co. is invented and so is everything here: the street,
// the town, the phone number (555-01xx is the range reserved for made-up
// numbers) and the .example domain, which can never be registered.

export const LETTERHEAD = {
	company: 'Northline Exhaust Co.',
	tagline: 'Exhaust systems for heavy-duty trucks',
	street: '1800 Forge Parkway',
	town: 'Braddock Vale, OH 44062',
	phone: '(216) 555-0100',
	email: 'quotes@northline.example',
	web: 'northline.example'
} as const;

/** The line at the bottom of every document this app sends out. */
export const DEMO_FOOTER =
	'This is a portfolio demo. Northline Exhaust Co., its customers, its parts and every figure on this document are invented.';

/** How long a quote holds, in days, matching nl.approve_rfq_draft. */
export const QUOTE_VALID_DAYS = 30;

export const TERMS =
	'Net 30 on approved credit. Prices are in US dollars and hold until the valid-until date. Lead times are confirmed at order entry.';

/** What the freight line says, which depends on how the customer ships. */
export function freightNote(shipsOwnCarrier: boolean): string {
	return shipsOwnCarrier
		? 'Freight collect on your own carrier account. Nothing for freight is added below.'
		: 'Freight is prepaid and added at cost when the order ships. It is not included below.';
}
