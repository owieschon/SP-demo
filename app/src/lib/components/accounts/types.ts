// Shapes the accounts pages and their components share. The server builds
// them (lib/server/accounts); the components only read them. They live here,
// outside lib/server, so components can import them.
import type { CommitmentStatus } from '$lib/types';
import type { Bucket } from '$lib/components/exports/types';

export type ActivityKind = 'note' | 'call' | 'email' | 'meeting';
export type CallOutcome = 'reached' | 'voicemail' | 'no_answer' | 'callback';

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
	note: 'Note',
	call: 'Call',
	email: 'Email',
	meeting: 'Meeting'
};

export const CALL_OUTCOMES: { value: CallOutcome; label: string }[] = [
	{ value: 'reached', label: 'Reached them' },
	{ value: 'voicemail', label: 'Left a voicemail' },
	{ value: 'no_answer', label: 'No answer' },
	{ value: 'callback', label: 'Asked for a call back' }
];

export const CALL_OUTCOME_LABEL: Record<CallOutcome, string> = {
	reached: 'Reached',
	voicemail: 'Voicemail',
	no_answer: 'No answer',
	callback: 'Call back'
};

// ---------------------------------------------------------------------------
// The accounts list
// ---------------------------------------------------------------------------

export type AccountSort = 'revenue' | 'quiet' | 'name';

export interface AccountFilters {
	q: string;
	who: 'mine' | 'all';
	state: string;
	group: string;
	quiet: boolean;
	open: boolean;
	sort: AccountSort;
	page: number;
}

export interface AccountRow {
	customerNo: string;
	name: string;
	parentName: string | null;
	branchCount: number;
	city: string;
	state: string;
	country: string;
	ownerName: string | null;
	agencyName: string | null;
	priceGroupLabel: string;
	blocked: boolean;
	closed: boolean;
	revenueYtd: number;
	revenuePriorYtd: number;
	lastOrderOn: string | null;
	typicalGapDays: number | null;
	daysQuiet: number | null;
	goneQuiet: boolean;
	openCommitments: number;
	openCommitted: number;
	openSteps: number;
	overdueSteps: number;
	primaryContact: string | null;
}

export interface AccountPage {
	rows: AccountRow[];
	total: number;
	page: number;
	pageSize: number;
}

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------

export interface PersonOption {
	id: number;
	fullName: string;
}

export interface AccountHeader {
	customerNo: string;
	name: string;
	billToNo: string | null;
	parentName: string | null;
	city: string;
	state: string;
	country: string;
	emailDomain: string | null;
	ownerId: number | null;
	ownerName: string | null;
	agencyName: string | null;
	agencyTerritory: string | null;
	priceGroup: string;
	priceGroupLabel: string;
	discount: number;
	blocked: boolean;
	closed: boolean;
	shipsOwnCarrier: boolean;
	customerSince: string;
	/** The company's date, so a due-date field cannot offer the past. */
	today: string;
	branches: { customerNo: string; name: string; place: string; blocked: boolean }[];
	branchCount: number;
	/** Active people a next step can go to. */
	people: PersonOption[];
}

export interface AccountNumbers {
	revenueYtd: number;
	revenuePriorYtd: number;
	revenueLastYear: number;
	/** This account plus every account billed to it, this year. Null when it has no branches. */
	familyRevenueYtd: number | null;
	lastOrderOn: string | null;
	typicalGapDays: number | null;
	daysQuiet: number | null;
	goneQuiet: boolean;
	openCommitments: number;
	openCommitted: number;
	openExpected: number;
	/** 24 calendar months, oldest first, ending with this month. */
	months: { month: string; revenue: number }[];
}

export interface Contact {
	id: number;
	fullName: string;
	title: string;
	email: string | null;
	phone: string | null;
	mobile: string | null;
	notes: string;
	isPrimary: boolean;
	leftOn: string | null;
	canEdit: boolean;
	updatedAt: string;
}

export interface TimelineEntry {
	id: number;
	kind: ActivityKind;
	callOutcome: CallOutcome | null;
	body: string;
	occurredAt: string;
	authorName: string;
	contactName: string | null;
	commitmentId: number | null;
	commitmentTitle: string | null;
	via: string;
}

export interface Timeline {
	entries: TimelineEntry[];
	total: number;
}

export interface NextStep {
	id: number;
	title: string;
	dueOn: string | null;
	ownerName: string;
	overdue: boolean;
	done: boolean;
	completedAt: string | null;
	completedBy: string | null;
	commitmentId: number | null;
	canComplete: boolean;
	updatedAt: string;
}

export interface AccountCommitment {
	id: number;
	title: string;
	customerNo: string;
	customerName: string;
	status: CommitmentStatus;
	committedValue: number;
	delivered: number;
	deliveredRatio: number;
	startsOn: string;
	endsOn: string;
	buyerName: string | null;
	ownerName: string;
	needsOutcome: boolean;
}

export interface AccountQuote {
	id: number;
	customerNo: string;
	quotedOn: string;
	validUntil: string | null;
	total: number;
	lines: number;
	contactName: string | null;
	commitmentId: number | null;
}

export interface RfqDraftRow {
	id: number;
	status: 'draft' | 'approved' | 'rejected';
	createdAt: string;
	needsReview: number;
}

export interface Deals {
	commitments: AccountCommitment[];
	quotes: AccountQuote[];
	rfqDrafts: RfqDraftRow[];
}

export interface OpenLine {
	documentNo: string;
	lineNo: number;
	customerNo: string;
	itemNo: string;
	description: string;
	shipDate: string;
	quantity: number;
	short: number;
	openValue: number;
	bucket: Bucket;
}

export interface InvoiceRow {
	invoiceNo: string;
	docType: 'invoice' | 'credit_memo';
	postedOn: string;
	customerPo: string | null;
	subtotal: number;
	freight: number;
	lines: number;
	topParts: string[];
}

export interface Orders {
	openLines: OpenLine[];
	invoices: InvoiceRow[];
}

/** Current people at the commitment's customer family, for picking a buyer. */
export interface BuyerChoice {
	id: number;
	fullName: string;
	title: string;
	customerNo: string;
	customerName: string;
}
