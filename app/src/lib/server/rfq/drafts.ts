// RFQ drafts in the database: create, read, revise, approve, reject.
//
// Reads run as the signed-in user, so row-level security hides other
// people's drafts. Every write goes through a SQL function that claims the
// request id, checks the user and the row version, and writes the audit
// trail (migration 0011).
//
// Revising re-validates on the server every time: the page sends only what a
// person changed (one field), never a validation result. Approving sends only
// the draft id, its row version and a request id; what gets created comes
// from the stored draft.
import { z } from 'zod';
import type { Db, Tx } from '../db/types.ts';
import type { StoredFile } from '../documents/read.ts';
import { listAttachmentsIn, saveAttachments, type AttachmentSummary } from '../documents/store.ts';
import { guarded } from '../errors.ts';
import {
	overridesSchema,
	rfqDraftSchema,
	type Extraction,
	type Overrides,
	type RfqDraft,
	type Usage,
	type Validation
} from './schema.ts';
import { validateDraft } from './validate.ts';

export type DraftStatus = 'draft' | 'approved' | 'rejected';

export interface DraftSummary {
	id: number;
	status: DraftStatus;
	sourceName: string;
	customerName: string | null;
	lines: number;
	needsReview: number;
	extractor: 'rules' | 'claude';
	createdAt: string;
	commitmentId: number | null;
	/** How many files were read into it. */
	attachments: number;
}

export interface DraftView {
	id: number;
	status: DraftStatus;
	createdBy: number;
	createdByName: string;
	sourceText: string;
	sourceName: string;
	extractor: 'rules' | 'claude';
	model: string | null;
	usage: Usage | null;
	draft: RfqDraft;
	overrides: Overrides;
	validation: Validation;
	quoteId: number | null;
	commitmentId: number | null;
	decidedByName: string | null;
	decidedAt: string | null;
	rejectReason: string;
	createdAt: string;
	/** The files this request arrived as, in upload order (migration 0020). */
	attachments: AttachmentSummary[];
	/** The row version, sent back with every change. */
	updatedAt: string;
}

export interface DraftWriteResult {
	draftId: number;
	updatedAt: string;
	replayed: boolean;
	quoteId?: number;
	commitmentId?: number;
	total?: number;
}

interface WriteRow {
	result: {
		draft_id: number;
		updated_at: string;
		replayed?: boolean;
		quote_id?: number;
		commitment_id?: number;
		total?: number;
	};
}

function toResult(row: WriteRow): DraftWriteResult {
	return {
		draftId: row.result.draft_id,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true,
		quoteId: row.result.quote_id,
		commitmentId: row.result.commitment_id,
		total: row.result.total
	};
}

const requestId = z.string().min(8).max(100);
const rowVersion = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface CreateDraftInput {
	source: string;
	sourceName: string;
	extraction: Extraction;
	/** The files the request arrived as, stored with the draft (migration 0020). */
	attachments?: StoredFile[];
	requestId: string;
}

/**
 * Validate an extraction as the user and store it, with its files.
 *
 * The draft and its attachments are written in one transaction, so a draft
 * never exists without the files it was read from, and the files never
 * exist without the draft.
 */
export async function createDraft(db: Db, userId: number, input: CreateDraftInput): Promise<DraftWriteResult> {
	const { extraction } = input;
	const [row] = await guarded(() =>
		db.asUser(userId, async (tx) => {
			const validation = await validateDraft(tx, { draft: extraction.draft, overrides: {}, source: input.source });
			const saved = await tx.sql<WriteRow>`
				select nl.save_rfq_draft(
					${input.source}, ${input.sourceName}, ${extraction.extractor}, ${extraction.model},
					${JSON.stringify(extraction.draft)}::jsonb, ${JSON.stringify(validation)}::jsonb,
					${extraction.usage ? JSON.stringify(extraction.usage) : null}::jsonb,
					${input.requestId}) as result`;
			if (input.attachments && input.attachments.length > 0) {
				await saveAttachments(tx, saved[0].result.draft_id, input.attachments, input.requestId);
			}
			return saved;
		})
	);
	return toResult(row);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** The user's own recent drafts, newest first. */
export async function listDrafts(db: Db, userId: number, limit = 20): Promise<DraftSummary[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			id: number;
			status: DraftStatus;
			source_name: string;
			customer_name: string | null;
			lines: number;
			needs_review: number;
			extractor: 'rules' | 'claude';
			created_at: Date;
			commitment_id: number | null;
			attachments: number;
		}>`
			select d.id, d.status, d.source_name, c.name as customer_name,
			       jsonb_array_length(d.draft -> 'lines')::int as lines,
			       d.needs_review, d.extractor, d.created_at, d.commitment_id,
			       (select count(*) from nl.rfq_attachment_index a where a.draft_id = d.id)::int as attachments
			from nl.rfq_drafts d
			left join nl.customers c on c.customer_no = d.customer_no
			where d.created_by = ${userId}
			order by d.created_at desc, d.id desc
			limit ${limit}`
	);
	return rows.map((r) => ({
		id: r.id,
		status: r.status,
		sourceName: r.source_name,
		customerName: r.customer_name,
		lines: r.lines,
		needsReview: r.needs_review,
		extractor: r.extractor,
		createdAt: r.created_at.toISOString(),
		commitmentId: r.commitment_id,
		attachments: r.attachments
	}));
}

interface DraftRow {
	id: number;
	status: DraftStatus;
	created_by: number;
	created_by_name: string;
	source_text: string;
	source_name: string;
	extractor: 'rules' | 'claude';
	model: string | null;
	usage: Usage | null;
	draft: RfqDraft;
	overrides: Overrides;
	validation: Validation;
	quote_id: number | null;
	commitment_id: number | null;
	decided_by_name: string | null;
	decided_at: Date | null;
	reject_reason: string;
	created_at: Date;
	updated_at: Date;
}

async function readDraft(tx: Tx, id: number): Promise<DraftRow | null> {
	const [row] = await tx.sql<DraftRow>`
		select d.id, d.status, d.created_by, u.full_name as created_by_name, d.source_text, d.source_name,
		       d.extractor, d.model, d.usage, d.draft, d.overrides, d.validation, d.quote_id, d.commitment_id,
		       du.full_name as decided_by_name, d.decided_at, d.reject_reason, d.created_at, d.updated_at
		from nl.rfq_drafts d
		join nl.users u on u.id = d.created_by
		left join nl.users du on du.id = d.decided_by
		where d.id = ${id}`;
	return row ?? null;
}

/** One draft, or null when it does not exist or belongs to someone else. */
export async function getDraft(db: Db, userId: number, id: number): Promise<DraftView | null> {
	// The draft and its attachments come from one transaction, so the panel
	// cannot show files from a moment the draft was not in.
	const { row, attachments } = await db.asUser(userId, async (tx) => ({
		row: await readDraft(tx, id),
		attachments: await listAttachmentsIn(tx, id)
	}));
	if (!row) return null;
	return {
		attachments,
		id: row.id,
		status: row.status,
		createdBy: row.created_by,
		createdByName: row.created_by_name,
		sourceText: row.source_text,
		sourceName: row.source_name,
		extractor: row.extractor,
		model: row.model,
		usage: row.usage,
		draft: row.draft,
		overrides: row.overrides,
		validation: row.validation,
		quoteId: row.quote_id,
		commitmentId: row.commitment_id,
		decidedByName: row.decided_by_name,
		decidedAt: row.decided_at?.toISOString() ?? null,
		rejectReason: row.reject_reason,
		createdAt: row.created_at.toISOString(),
		// ISO text keeps the millisecond the database stored.
		updatedAt: row.updated_at.toISOString()
	};
}

// ---------------------------------------------------------------------------
// Revise: one change at a time, re-validated on the server
// ---------------------------------------------------------------------------

const common = { draftId: z.coerce.number().int().positive(), expectedUpdatedAt: rowVersion, requestId };
const lineIndex = z.coerce.number().int().min(0).max(999);

/** The changes a person can make, as the page's forms send them. */
export const reviseInput = z.discriminatedUnion('change', [
	z.object({ ...common, change: z.literal('item'), line: lineIndex, itemNo: z.string().trim().min(1).max(40) }),
	z.object({ ...common, change: z.literal('quantity'), line: lineIndex, quantity: z.coerce.number().int().min(1).max(10_000) }),
	z.object({ ...common, change: z.literal('accept_price'), line: lineIndex }),
	z.object({ ...common, change: z.literal('remove_line'), line: lineIndex }),
	z.object({ ...common, change: z.literal('restore_line'), line: lineIndex }),
	z.object({ ...common, change: z.literal('customer'), customerNo: z.string().trim().min(1).max(20) }),
	z.object({
		...common,
		change: z.literal('needed_by'),
		// An empty date means "no date: use the 90-day window".
		neededBy: z.union([z.iso.date(), z.literal('')])
	}),
	z.object({ ...common, change: z.literal('accept_totals') })
]);

export type ReviseInput = z.infer<typeof reviseInput>;

/** Apply one change to the overrides a draft already has. */
export function applyChange(current: Overrides, input: ReviseInput, lineCount: number): Overrides {
	const next: Overrides = structuredClone(current);
	if ('line' in input) {
		if (input.line >= lineCount) throw new RangeError(`Line ${input.line} does not exist.`);
		const key = String(input.line);
		const line = { ...(next.lines?.[key] ?? {}) };
		if (input.change === 'item') {
			line.item_no = input.itemNo;
			// A new part gets a fresh price check.
			delete line.accept_price;
		}
		if (input.change === 'quantity') line.quantity = input.quantity;
		if (input.change === 'accept_price') line.accept_price = true;
		if (input.change === 'remove_line') line.removed = true;
		if (input.change === 'restore_line') delete line.removed;
		next.lines = { ...(next.lines ?? {}), [key]: line };
	} else if (input.change === 'customer') {
		next.customer_no = input.customerNo;
	} else if (input.change === 'needed_by') {
		next.needed_by = input.neededBy === '' ? null : input.neededBy;
	} else if (input.change === 'accept_totals') {
		next.accept_totals = true;
	}
	return overridesSchema.parse(next);
}

export async function reviseDraft(db: Db, userId: number, input: ReviseInput): Promise<DraftWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, async (tx) => {
			const current = await readDraft(tx, input.draftId);
			// Missing, someone else's, or already decided: the SQL function
			// gives the exact refusal, so let it speak.
			let overrides: Overrides = current?.overrides ?? {};
			let validation: Validation | Record<string, never> = {};
			if (current && current.status === 'draft') {
				const draft = rfqDraftSchema.parse(current.draft);
				try {
					overrides = applyChange(current.overrides, input, draft.lines.length);
				} catch (error) {
					if (error instanceof RangeError) {
						throw Object.assign(new Error(error.message), { code: 'NL422' });
					}
					throw error;
				}
				validation = await validateDraft(tx, { draft, overrides, source: current.source_text });
			}
			return tx.sql<WriteRow>`
				select nl.revise_rfq_draft(${input.draftId}, ${JSON.stringify(overrides)}::jsonb,
				                           ${JSON.stringify(validation)}::jsonb,
				                           ${input.expectedUpdatedAt}::timestamptz, ${input.requestId}) as result`;
		})
	);
	return toResult(row);
}

// ---------------------------------------------------------------------------
// Decide
// ---------------------------------------------------------------------------

/** Approval takes exactly these three fields; anything else in a form is ignored. */
export const approveInput = z.object({ ...common });
export type ApproveInput = z.infer<typeof approveInput>;

export async function approveDraft(db: Db, userId: number, input: ApproveInput): Promise<DraftWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.approve_rfq_draft(${input.draftId}, ${input.expectedUpdatedAt}::timestamptz,
				                            ${input.requestId}) as result`
		)
	);
	return toResult(row);
}

export const rejectInput = z.object({ ...common, reason: z.string().trim().max(500).default('') });
export type RejectInput = z.infer<typeof rejectInput>;

export async function rejectDraft(db: Db, userId: number, input: RejectInput): Promise<DraftWriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.reject_rfq_draft(${input.draftId}, ${input.reason}, ${input.expectedUpdatedAt}::timestamptz,
				                           ${input.requestId}) as result`
		)
	);
	return toResult(row);
}
