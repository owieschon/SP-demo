// The shapes of workflow C (RFQ intake), defined once with zod.
//
//   RfqDraft     what an extractor proposes from an email (rules or Claude)
//   Overrides    what a person changed on top of the draft
//   Validation   what deterministic code decided about draft + overrides
//
// The TypeScript types are derived from the schemas (z.infer), so the shape
// the model must return, the shape we store and the shape the page reads can
// never drift apart.
//
// This file (like everything in rfq/) imports with relative paths and .ts
// extensions, so `node scripts/eval-rfq.ts` can load it without SvelteKit.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// The draft an extractor proposes
// ---------------------------------------------------------------------------

/** How sure the extractor is about one value: 0 (a guess) to 1 (certain). */
const confidence = z.number().min(0).max(1);

// Every extracted value travels with its own confidence. `value` is null when
// the email did not say.
const textField = z.object({ value: z.string().nullable(), confidence });
const numberField = z.object({ value: z.number().nullable(), confidence });

export const draftLineSchema = z.object({
	/** The line of the email this came from, as written. */
	raw_text: z.string(),
	/** The part number exactly as written (typos and all). */
	item_no: textField,
	/** The number as written, before any unit conversion ("2 pair" is 2). */
	quantity: numberField,
	/** The unit as written: "ea", "pcs", "pair", "dozen", "box of 10" ... or null. */
	unit: textField,
	unit_price: numberField,
	line_total: numberField
});

export const rfqDraftSchema = z.object({
	sender_email: textField,
	sender_name: textField,
	/** The customer's company name as written (signature, sign-off). */
	customer_name: textField,
	/** A branch or city the sender names for themselves, to tell a chain's branches apart. */
	branch_hint: textField,
	lines: z.array(draftLineSchema),
	/** A subtotal or total the email states, if any. */
	stated_subtotal: numberField,
	/** The needed-by date as written ("by next Friday") ... */
	needed_by_text: textField,
	/** ... and as a date, YYYY-MM-DD, worked out from the email's own date. */
	needed_by: textField,
	/** Shipping, freight or other instructions worth keeping. */
	notes: z.string(),
	/** False when the email is not asking for parts at all. */
	is_request: z.boolean()
});

export type DraftLine = z.infer<typeof draftLineSchema>;
export type RfqDraft = z.infer<typeof rfqDraftSchema>;
export type TextField = z.infer<typeof textField>;
export type NumberField = z.infer<typeof numberField>;

export const EXTRACTORS = ['rules', 'claude'] as const;
export type ExtractorName = (typeof EXTRACTORS)[number];

/** Token counts for one live model call. */
export interface Usage {
	input_tokens: number;
	output_tokens: number;
	cache_read_input_tokens: number;
	cache_creation_input_tokens: number;
}

export interface Extraction {
	draft: RfqDraft;
	extractor: ExtractorName;
	model: string | null;
	usage: Usage | null;
}

// ---------------------------------------------------------------------------
// What a person changed
// ---------------------------------------------------------------------------

const isoDate = z.iso.date();

export const lineOverrideSchema = z.object({
	item_no: z.string().trim().min(1).max(40).optional(),
	quantity: z.number().int().optional(),
	/** "Quote at our price" after a stated price did not match. */
	accept_price: z.boolean().optional(),
	/** "This line is not a request" (a signature, an old order). */
	removed: z.boolean().optional()
});

export const overridesSchema = z.object({
	customer_no: z.string().trim().min(1).max(20).optional(),
	/** A date, or null for "no date: use the 90-day window". */
	needed_by: isoDate.nullable().optional(),
	/** "The email's total is wrong; quote the lines." */
	accept_totals: z.boolean().optional(),
	/** Keyed by the line's position in the draft (as text, because JSON keys are text). */
	lines: z.record(z.string().regex(/^\d{1,3}$/), lineOverrideSchema).optional()
});

export type LineOverride = z.infer<typeof lineOverrideSchema>;
export type Overrides = z.infer<typeof overridesSchema>;

// ---------------------------------------------------------------------------
// What validation decided
// ---------------------------------------------------------------------------

/**
 * Every field ends in one of three states:
 *   ok            matches the book as written
 *   corrected     code (or a person) fixed it, and says how
 *   needs_review  a person must decide before anything can be approved
 */
export type CheckStatus = 'ok' | 'corrected' | 'needs_review';

export interface Check {
	status: CheckStatus;
	/** Plain English, shown on the page. */
	reason: string;
}

export interface Suggestion {
	item_no: string;
	description: string;
	list_price: number;
	/** Why it was suggested: "same size, chrome instead of stainless". */
	why: string;
}

export interface CustomerCandidate {
	customer_no: string;
	name: string;
	city: string;
	state: string;
	blocked: boolean;
	closed: boolean;
}

export interface CustomerResult {
	customer_no: string | null;
	name: string | null;
	city: string | null;
	state: string | null;
	price_group: string | null;
	price_group_label: string | null;
	discount: number | null;
	contact_id: number | null;
	contact_name: string | null;
	candidates: CustomerCandidate[];
	check: Check;
}

export interface ValidatedLine {
	/** Position in the draft; overrides are keyed by it. */
	index: number;
	raw_text: string;
	item_as_written: string | null;
	/** The catalog item this line resolved to, or null. */
	item_no: string | null;
	description: string | null;
	suggestions: Suggestion[];
	item_check: Check;
	quantity_as_written: number | null;
	unit_as_written: string | null;
	/** Whole pieces, after unit conversion. */
	quantity: number | null;
	quantity_check: Check;
	list_price: number | null;
	/** Our price for this customer: list less their price group's discount. */
	unit_price: number | null;
	stated_unit_price: number | null;
	stated_line_total: number | null;
	line_total: number | null;
	price_check: Check;
	/**
	 * What the supply side says about this line, in plain English: what can
	 * ship now, what is on order and when, or the earliest date if nothing is.
	 * Information for the person reading the draft, not a check.
	 */
	supply: string | null;
	removed: boolean;
}

export interface Validation {
	/** The date validation ran against (the database's today). */
	today: string;
	customer: CustomerResult;
	lines: ValidatedLine[];
	/** The request as a whole: are there any lines at all? */
	lines_check: Check;
	needed_by: { text: string | null; date: string | null; check: Check };
	totals: { subtotal: number | null; stated_subtotal: number | null; check: Check };
	/** Things a person should know that do not block approval. */
	warnings: string[];
	/** How many checks say needs_review. Zero means it can be approved. */
	needs_review: number;
}

/** The needs_review flags the evals compare, one per field that needs a person. */
export type ReviewFlag =
	| 'customer'
	| 'needed_by'
	| 'lines'
	| 'subtotal'
	| 'line_item'
	| 'line_quantity'
	| 'line_price';

export function reviewFlags(v: Validation): ReviewFlag[] {
	const flags: ReviewFlag[] = [];
	if (v.customer.check.status === 'needs_review') flags.push('customer');
	if (v.needed_by.check.status === 'needs_review') flags.push('needed_by');
	if (v.lines_check.status === 'needs_review') flags.push('lines');
	if (v.totals.check.status === 'needs_review') flags.push('subtotal');
	for (const line of v.lines) {
		if (line.removed) continue;
		if (line.item_check.status === 'needs_review') flags.push('line_item');
		if (line.quantity_check.status === 'needs_review') flags.push('line_quantity');
		if (line.price_check.status === 'needs_review') flags.push('line_price');
	}
	return flags;
}

/** An empty draft: what an extractor returns for an email with nothing in it. */
export function emptyDraft(): RfqDraft {
	const none = { value: null, confidence: 0 };
	return {
		sender_email: none,
		sender_name: none,
		customer_name: none,
		branch_hint: none,
		lines: [],
		stated_subtotal: none,
		needed_by_text: none,
		needed_by: none,
		notes: '',
		is_request: false
	};
}
