// Shapes the commitment-depth screens and their components share. The server
// builds them (lib/server/commitments/depth.ts); the components only read
// them. They live here, outside lib/server, so components can import them.

export type QuoteOutcome = 'open' | 'won' | 'lost' | 'expired' | 'superseded' | 'withdrawn';

export const QUOTE_OUTCOME_LABEL: Record<QuoteOutcome, string> = {
	open: 'Waiting on them',
	won: 'Won',
	lost: 'Lost',
	expired: 'Ran out',
	superseded: 'Replaced',
	withdrawn: 'Withdrawn'
};

export type RequirementKind =
	| 'first_article_inspection'
	| 'certificate_of_conformance'
	| 'packaging_and_marking'
	| 'delivery_terms'
	| 'freight_paid_by'
	| 'minimum_order'
	| 'price_hold';

export const REQUIREMENT_LABEL: Record<RequirementKind, string> = {
	first_article_inspection: 'First article inspection',
	certificate_of_conformance: 'Certificate of conformance',
	packaging_and_marking: 'Packaging and marking',
	delivery_terms: 'Delivery terms',
	freight_paid_by: 'Freight paid by',
	minimum_order: 'Minimum order',
	price_hold: 'Price held'
};

export type NextStepKind =
	| 'call'
	| 'send_quote'
	| 'chase_po'
	| 'confirm_requirement'
	| 'check_stock'
	| 'other';

export const NEXT_STEP_LABEL: Record<NextStepKind, string> = {
	call: 'Call',
	send_quote: 'Send a quote',
	chase_po: 'Chase the order',
	confirm_requirement: 'Confirm a condition',
	check_stock: 'Check stock',
	other: 'Other'
};

/** One line of one version of a quote. */
export interface RevisionLine {
	lineNo: number;
	itemNo: string;
	description: string;
	quantity: number;
	unitPrice: number;
	extended: number;
	/** Which rule in the pricing precedence set this price. */
	priceRule: string | null;
	leadDays: number | null;
}

/**
 * One difference between this version and the one before it, in a person's
 * words. Worked out on the server by comparing the two line lists, so the
 * page never has to.
 */
export interface RevisionChange {
	itemNo: string | null;
	text: string;
}

export interface QuoteRevision {
	id: number;
	version: number;
	revisedOn: string;
	sentByName: string;
	validFrom: string | null;
	validUntil: string | null;
	changeReason: string;
	changeNote: string;
	outcome: QuoteOutcome;
	outcomeReason: string | null;
	outcomeNote: string;
	decidedOn: string | null;
	total: number;
	lineCount: number;
	isLatest: boolean;
	stillValid: boolean;
	lines: RevisionLine[];
	/** Empty on version 1, and on a version that changed nothing measurable. */
	changes: RevisionChange[];
}

export interface QuoteHistory {
	id: number;
	quotedOn: string;
	contactName: string | null;
	outcome: QuoteOutcome;
	lostReason: string | null;
	versions: number;
	/** The latest version's total: the one that counts. */
	total: number;
	/** Written for this commitment, rather than found on the same account. */
	linked: boolean;
	revisions: QuoteRevision[];
}

export interface RequirementRow {
	id: number;
	kind: RequirementKind;
	party: 'us' | 'customer' | 'carrier' | null;
	/** The structured attribute, already written out: "40 pieces", "FOB origin". */
	attribute: string | null;
	detail: string;
	requiredBy: string | null;
	satisfied: boolean;
	satisfiedOn: string | null;
	satisfiedByName: string | null;
	satisfiedNote: string;
	overdue: boolean;
	lapsed: boolean;
	/** On the commitment itself rather than on one of its quotes. */
	onCommitment: boolean;
	quoteId: number | null;
}

export interface OutcomeEntry {
	id: number;
	outcome: 'kept' | 'pushed' | 'broken';
	source: 'person' | 'nightly';
	answeredByName: string | null;
	answeredAt: string;
	note: string;
	reason: string | null;
	windowStartsOn: string | null;
	windowEndsOn: string | null;
	committedValue: number | null;
	deliveredValue: number | null;
	pushedToStartsOn: string | null;
	pushedToEndsOn: string | null;
	nextCommitmentId: number | null;
}

export interface DepthStep {
	id: number;
	title: string;
	kind: NextStepKind;
	source: 'person' | 'agent';
	agent: string | null;
	note: string;
	dueOn: string | null;
	ownerName: string;
	createdByName: string;
	done: boolean;
	completedAt: string | null;
	overdue: boolean;
	dueToday: boolean;
	/** True when it was finished after its due date. */
	doneLate: boolean;
	requirementId: number | null;
}

/** Everything behind one commitment, streamed in behind the page. */
export interface CommitmentDepth {
	quotes: QuoteHistory[];
	requirements: RequirementRow[];
	outcomes: OutcomeEntry[];
	steps: DepthStep[];
	/** The company's date, so "overdue" on screen means overdue to the business. */
	today: string;
}

/** What an account's record looks like: the thing to read before promising. */
export interface AccountRecord {
	settledCount: number;
	kept: number;
	pushed: number;
	broken: number;
	/** Null until something has settled: nought out of nought is not a bad record. */
	keptRate: number | null;
	/** The last eight settled outcomes, oldest first. */
	pattern: ('kept' | 'pushed' | 'broken')[];
	lastSettledOn: string | null;
	quotes: number;
	quotesWon: number;
	quotesLost: number;
	quotesOpen: number;
	topLossReason: string | null;
	/** Every loss reason with its count, biggest first. */
	lossReasons: { reason: string; count: number }[];
	/** Conditions still owed across the account's quotes and commitments. */
	requirementsOpen: number;
	requirementsOverdue: number;
}
