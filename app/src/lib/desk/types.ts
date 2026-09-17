// What the order desk hands to its pages. Shared by the server and the
// components, so neither can drift from the other.

/** The six things a message to the order desk can be. */
export type Intent = 'rfq' | 'purchase_order' | 'price_question' | 'stock_question' | 'order_status' | 'other';

export const INTENT_LABEL: Record<Intent, string> = {
	rfq: 'Request for quote',
	purchase_order: 'Purchase order',
	price_question: 'Price question',
	stock_question: 'Stock or lead time',
	order_status: 'Order status',
	other: 'Something else'
};

export type MessageStatus = 'new' | 'working' | 'drafted' | 'needs_person' | 'ignored';

export const MESSAGE_STATUS_LABEL: Record<MessageStatus, string> = {
	new: 'Not worked yet',
	working: 'Working',
	drafted: 'Draft waiting',
	needs_person: 'Needs a person',
	ignored: 'Ignored'
};

export type DraftStatus = 'draft' | 'approved' | 'sent' | 'failed' | 'rejected';

export const DRAFT_STATUS_LABEL: Record<DraftStatus, string> = {
	draft: 'Waiting for you',
	approved: 'Approved',
	sent: 'Sent',
	failed: 'Send failed',
	rejected: 'Rejected'
};

/** How far a mailbox's drafts may go. The policy is keyed on this. */
export type Disclosure = 'customer' | 'vendor' | 'internal';

/**
 * The kinds of fact a draft can rest on. The kind is what the disclosure
 * policy decides about, so it is deliberately narrow: "the price this account
 * pays" and "what it costs us" are different kinds even though both are a
 * number of dollars on a part.
 */
export type FactKind =
	// Things a customer may hear.
	| 'account_identity'
	| 'part_description'
	| 'own_price'
	| 'quantity_break'
	| 'own_past_price'
	| 'own_agreement'
	| 'availability'
	| 'lead_time'
	| 'own_open_order'
	| 'own_quote'
	| 'own_commitment'
	| 'own_rep'
	| 'freight'
	// Things a vendor may hear.
	| 'vendor_supply'
	| 'vendor_lead_time'
	// Things that stay inside the building.
	| 'stock_quantity'
	| 'unit_cost'
	| 'margin'
	| 'floor_price'
	| 'other_customer'
	| 'internal_note'
	| 'colleague_name';

/**
 * One thing the agent found, with where it found it.
 *
 * `subject` is whose fact it is: a customer number, a vendor number, or null
 * for a fact about nobody in particular (a part description, a lead time).
 * The policy uses it to catch the case where the kind is allowed but the row
 * belongs to somebody else.
 *
 * `amounts` lists every dollar figure in the fact, so the check can prove
 * that a figure in the reply came from a fact a person may see.
 */
export interface Fact {
	kind: FactKind;
	/** One line a person can read, as the message page shows it. */
	text: string;
	subject: string | null;
	/** The rows it came from: {customer_no, item_no, quote_id, document_no, ...} */
	ids: Record<string, string | number>;
	amounts?: number[];
	/** Where the page can send someone to see it for themselves. */
	href?: string | null;
}

/** Why a draft was refused or held, in the words the queue shows. */
export interface PolicyVerdict {
	ok: boolean;
	reasons: string[];
}

export interface MailboxView {
	id: number;
	address: string;
	kind: 'orders' | 'procurement';
	label: string;
	purpose: string;
	reviewerId: number;
	reviewerName: string;
	disclosure: Disclosure;
	active: boolean;
	waiting: number;
	needsPerson: number;
	messages: number;
	queued: number;
	approved: number;
	sent: number;
	runsToday: number;
	runsCap: number;
}

export interface MessageSummary {
	id: number;
	mailboxId: number;
	mailboxLabel: string;
	fromAddress: string;
	fromName: string;
	subject: string;
	receivedAt: string;
	status: MessageStatus;
	intent: Intent | null;
	intentConfidence: number | null;
	summary: string;
	customerNo: string | null;
	customerName: string | null;
	vendorNo: string | null;
	vendorName: string | null;
	contactName: string | null;
	matchReason: string;
	attachments: number;
	draftId: number | null;
	draftStatus: DraftStatus | null;
	rfqDraftId: number | null;
}

export interface AttachmentView {
	id: number;
	fileName: string;
	mediaType: string;
	sizeBytes: number;
	/** Set once the documents work has parsed it. */
	documentAttachmentId: number | null;
}

export interface RunView {
	id: number;
	mode: 'mock' | 'live';
	model: string | null;
	startedAt: string;
	finishedAt: string | null;
	lookups: { name: string; input: Record<string, unknown>; rows: number; ms: number }[];
	lookupCount: number;
	rounds: number;
	inputTokens: number;
	outputTokens: number;
	outcome: 'running' | 'drafted' | 'needs_person' | 'ignored' | 'failed';
	draftId: number | null;
	error: string | null;
}

export interface DraftView {
	id: number;
	mailboxId: number;
	mailboxLabel: string;
	mailboxAddress: string;
	disclosure: Disclosure;
	reviewerId: number;
	reviewerName: string;
	inReplyToId: number | null;
	replySubject: string | null;
	replyFrom: string | null;
	to: string[];
	cc: string[];
	subject: string;
	body: string;
	intent: Intent;
	facts: Fact[];
	attachments: { kind: string; name: string; quoteId?: number }[];
	blockedReason: string;
	status: DraftStatus;
	edited: boolean;
	reviewedByName: string | null;
	reviewedAt: string | null;
	rejectReason: string;
	providerMessageId: string | null;
	sentAt: string | null;
	sendAttempts: number;
	error: string | null;
	createdAt: string;
	/** The row version, sent back with every decision. */
	updatedAt: string;
	/** True when every recipient is on the server's allowlist. */
	recipientsAllowed: boolean;
	blockedRecipients: string[];
}

export interface MessageDetail {
	message: MessageSummary;
	bodyText: string;
	toAddresses: string[];
	ccAddresses: string[];
	attachments: AttachmentView[];
	runs: RunView[];
	drafts: DraftView[];
}
