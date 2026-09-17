// The one shape the workspace speaks, shared by the server and the page.
//
// Four features put things in front of a person: quote requests read out of
// customer email (migration 0011), the assistant's proposals (0017), the order
// desk's mail drafts (0021) and the procurement desk's purchase requests
// (0022). The last two are built elsewhere and may not be in the database at
// all; the queue then simply has no rows from them.

export type QueueSource = 'rfq' | 'assistant' | 'mail' | 'purchase';

/** In the order the workspace lists them. */
export const QUEUE_SOURCES: QueueSource[] = ['rfq', 'assistant', 'mail', 'purchase'];

export const SOURCE_LABEL: Record<QueueSource, string> = {
	rfq: 'Quote request',
	assistant: 'Assistant proposal',
	mail: 'Mail draft',
	purchase: 'Purchase request'
};

/** Where a person goes to see the whole record, with all of its history. */
export const SOURCE_HREF: Record<QueueSource, (id: number) => string> = {
	rfq: (id) => `/rfq/${id}`,
	assistant: (id) => `/ask?proposal=${id}`,
	mail: (id) => `/desk/${id}`,
	purchase: (id) => `/procurement/${id}`
};

/**
 * "Correct, then approve": what a person may change here, per source, and
 * null where the source has nothing to change through. The UI says so rather
 * than showing an edit box that would go nowhere.
 */
export const SOURCE_EDIT: Record<QueueSource, string | null> = {
	rfq: 'Quantities and the needed-by date can be corrected here. The change goes through the same revise step the quote request page uses, and it is checked again before you approve.',
	assistant:
		'An assistant proposal cannot be edited. It is a fixed option with a fixed input, which is what makes approving it safe. Reject it and ask for a different one.',
	mail: 'The subject and the body can be corrected here before the mail is approved.',
	purchase: 'A purchase request cannot be edited here. Open it to change what it asks for.'
};

/** True where the queue can actually change the record before approving it. */
export const SOURCE_EDITABLE: Record<QueueSource, boolean> = {
	rfq: true,
	assistant: false,
	mail: true,
	purchase: false
};

/**
 * waiting       ready for a yes or a no
 * needs_review  something on it has to be corrected first
 * retry         it was approved, the write failed, and it can be tried again
 */
export type QueueStatus = 'waiting' | 'needs_review' | 'retry';

export const STATUS_LABEL: Record<QueueStatus, string> = {
	waiting: 'Waiting',
	needs_review: 'Needs a correction',
	retry: 'Write failed, try again'
};

/** One line of a quote request, as the queue shows it. */
export interface QueueLine {
	/** Its position in the draft, which is what a correction names. */
	line: number;
	itemNo: string | null;
	description: string | null;
	quantity: number | null;
	unitPrice: number | null;
	amount: number | null;
	/** A field on this line still needs a person. */
	needsReview: boolean;
}

/** One thing the assistant offers to do. */
export interface QueueOption {
	index: number;
	label: string;
	tool: string;
	/** The exact input that would be written, as pretty JSON, for reading. */
	input: string;
}

/** A plain fact behind the proposal: what it is, who it is for, when. */
export interface QueueFact {
	label: string;
	value: string;
}

export interface QueueDetail {
	facts: QueueFact[];
	lines: QueueLine[];
	options: QueueOption[];
	/** A needed-by date a correction can move, when the source has one. */
	neededBy: string | null;
	/** Text a correction can change (a mail draft's subject and body). */
	subject: string | null;
	body: string | null;
}

/** One row of the queue: the same fields whichever source it came from. */
export interface QueueItem {
	source: QueueSource;
	sourceId: number;
	summary: string;
	subjectKind: 'account' | 'vendor' | null;
	subjectNo: string | null;
	subjectName: string | null;
	value: number | null;
	createdById: number | null;
	createdBy: string;
	createdVia: 'person' | 'assistant' | 'agent';
	createdAt: string;
	/** The row version to send back with a decision. */
	rowVersion: string;
	reviewerId: number | null;
	status: QueueStatus;
	/** You are the reviewer, or the record is yours. */
	needsYou: boolean;
	detail: QueueDetail;
}

export interface QueueDecisionRow {
	id: number;
	source: QueueSource;
	sourceId: number;
	decision: 'approved' | 'edited_approved' | 'rejected';
	decidedBy: string;
	decidedById: number;
	decidedAt: string;
	note: string;
}

export const DECISION_LABEL: Record<QueueDecisionRow['decision'], string> = {
	approved: 'Approved',
	edited_approved: 'Corrected, then approved',
	rejected: 'Rejected'
};

/** Which sources this database actually has, from nl.agent_queue_sources(). */
export type QueueSourcePresence = Record<QueueSource, boolean>;
