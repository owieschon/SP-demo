// Workflow A: commitments that measure themselves.
//
// Everything a page shows comes from nl.commitment_progress (status, delivered,
// expected value), which the database derives from the invoice ledger. The two
// writes go through SQL functions that check the user, the field rules and the
// row version, and write the audit trail.
import { z } from 'zod';
import type { Db } from './db/types.ts';
import { guarded } from './errors.ts';
import {
	SETTLED_CARD_LIMIT,
	type BoardCard,
	type BoardData,
	type CommitmentStatus,
	type Outcome,
	type SettledStatus
} from '$lib/types';

interface ProgressRow {
	id: number;
	title: string;
	customer_no: string;
	customer_name: string;
	owner_id: number;
	owner_name: string;
	buyer_name: string | null;
	committed_value: number;
	delivered: number;
	delivered_ratio: number;
	expected_value: number;
	confidence: number;
	starts_on: string;
	ends_on: string;
	status: CommitmentStatus;
	needs_outcome: boolean;
	days_since_close: number | null;
	window_elapsed_ratio: number;
	outcome_source: 'person' | 'nightly' | null;
	updated_at: Date;
}

function toCard(row: ProgressRow): BoardCard {
	return {
		id: row.id,
		title: row.title,
		customerNo: row.customer_no,
		customerName: row.customer_name,
		ownerId: row.owner_id,
		ownerName: row.owner_name,
		buyerName: row.buyer_name,
		committedValue: row.committed_value,
		delivered: row.delivered,
		deliveredRatio: row.delivered_ratio,
		expectedValue: row.expected_value,
		confidence: row.confidence,
		startsOn: row.starts_on,
		endsOn: row.ends_on,
		status: row.status,
		needsOutcome: row.needs_outcome,
		daysSinceClose: row.days_since_close,
		windowElapsedRatio: row.window_elapsed_ratio,
		outcomeSource: row.outcome_source,
		// ISO text keeps the millisecond the database stored; it goes back as the row version.
		updatedAt: row.updated_at.toISOString()
	};
}

/**
 * The board: open commitments, plus the ones settled in the last 90 days.
 * A settled column only sends its most recent cards (a big book settles
 * dozens a quarter); its full count and total come along separately.
 * ownerId null means everyone's.
 */
export async function listBoard(db: Db, userId: number, ownerId: number | null): Promise<BoardData> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<ProgressRow & { is_settled: boolean; column_count: number; column_committed: number }>`
			with board as (
				select p.*,
				       -- Newest settled first, so the cap keeps the recent ones.
				       row_number() over (
				         partition by p.status
				         order by coalesce(p.answered_at::date, p.ends_on) desc, p.id desc
				       ) as settled_rank,
				       count(*) over (partition by p.status) as column_count,
				       sum(p.committed_value) over (partition by p.status) as column_committed
				from nl.commitment_progress p
				where (${ownerId}::int is null or p.owner_id = ${ownerId}::int)
				  and (not p.is_settled
				       or coalesce(p.answered_at::date, p.ends_on) >= nl.today() - 90)
			)
			select b.id, b.title, b.customer_no, cu.name as customer_name,
			       b.owner_id, u.full_name as owner_name, ct.full_name as buyer_name,
			       b.committed_value, b.delivered, b.delivered_ratio, b.expected_value, b.confidence,
			       b.starts_on, b.ends_on, b.status, b.needs_outcome, b.days_since_close,
			       b.window_elapsed_ratio, b.outcome_source, b.updated_at,
			       b.is_settled, b.column_count::int as column_count, b.column_committed
			from board b
			join nl.customers cu on cu.customer_no = b.customer_no
			join nl.users u on u.id = b.owner_id
			left join nl.contacts ct on ct.id = b.buyer_contact_id
			where not b.is_settled or b.settled_rank <= ${SETTLED_CARD_LIMIT}
			order by b.needs_outcome desc, b.ends_on, b.id`
	);

	const settled: BoardData['settled'] = {
		kept: { count: 0, committed: 0 },
		pushed: { count: 0, committed: 0 },
		broken: { count: 0, committed: 0 }
	};
	for (const row of rows) {
		if (row.is_settled) {
			settled[row.status as SettledStatus] = { count: row.column_count, committed: row.column_committed };
		}
	}
	return { cards: rows.map(toCard), settled };
}

export interface CommitmentDetail extends BoardCard {
	notes: string;
	matchedLines: number;
	lastDeliveryOn: string | null;
	remaining: number;
	isSettled: boolean;
	keptByMeasure: boolean;
	buyerEmail: string | null;
	customerCity: string;
	customerState: string;
	customerCountry: string;
	canAnswer: boolean;
	canEdit: boolean;
	items: {
		itemNo: string;
		description: string;
		quantity: number | null;
		deliveredQty: number;
		delivered: number;
	}[];
	lines: {
		invoiceNo: string;
		lineNo: number;
		postedOn: string;
		customerNo: string;
		customerName: string;
		viaFamily: boolean;
		itemNo: string;
		quantity: number;
		unitPrice: number;
		amount: number;
		runningDelivered: number;
	}[];
	outcomes: {
		outcome: Outcome;
		source: 'person' | 'nightly';
		answeredBy: string | null;
		answeredAt: string;
		note: string;
	}[];
	quotes: {
		id: number;
		quotedOn: string;
		validUntil: string | null;
		total: number;
		lines: number;
		linked: boolean;
	}[];
	nextSteps: {
		id: number;
		title: string;
		dueOn: string | null;
		ownerName: string;
		done: boolean;
	}[];
}

export async function getCommitment(db: Db, userId: number, id: number): Promise<CommitmentDetail | null> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<
			ProgressRow & {
				notes: string;
				matched_lines: number;
				last_delivery_on: string | null;
				remaining: number;
				is_settled: boolean;
				kept_by_measure: boolean;
				buyer_email: string | null;
				city: string;
				state: string;
				country: string;
				is_admin: boolean;
			}
		>`
			select p.id, p.title, p.customer_no, cu.name as customer_name, cu.city, cu.state, cu.country,
			       p.owner_id, u.full_name as owner_name, ct.full_name as buyer_name, ct.email as buyer_email,
			       p.committed_value, p.delivered, p.delivered_ratio, p.expected_value, p.confidence,
			       p.starts_on, p.ends_on, p.status, p.needs_outcome, p.days_since_close,
			       p.window_elapsed_ratio, p.outcome_source, p.updated_at,
			       p.notes, p.matched_lines, p.last_delivery_on, p.remaining, p.is_settled, p.kept_by_measure,
			       nl.is_admin() as is_admin
			from nl.commitment_progress p
			join nl.customers cu on cu.customer_no = p.customer_no
			join nl.users u on u.id = p.owner_id
			left join nl.contacts ct on ct.id = p.buyer_contact_id
			where p.id = ${id}`;
		if (!head) return null;

		const items = await tx.sql<{
			item_no: string;
			description: string;
			quantity: number | null;
			delivered_qty: number;
			delivered: number;
		}>`
			select ci.item_no, i.description, ci.quantity,
			       coalesce(sum(l.quantity), 0)::int as delivered_qty,
			       coalesce(sum(l.amount), 0) as delivered
			from nl.commitment_items ci
			join nl.items i on i.item_no = ci.item_no
			left join nl.commitment_lines l on l.commitment_id = ci.commitment_id and l.item_no = ci.item_no
			where ci.commitment_id = ${id}
			group by ci.item_no, i.description, ci.quantity
			order by delivered desc, ci.item_no`;

		// A running total, so the page can show how delivery built up.
		const lines = await tx.sql<{
			invoice_no: string;
			line_no: number;
			posted_on: string;
			customer_no: string;
			customer_name: string;
			family_depth: number;
			item_no: string;
			quantity: number;
			unit_price: number;
			amount: number;
			running_delivered: number;
		}>`
			select l.invoice_no, l.line_no, l.posted_on, l.customer_no, cu.name as customer_name,
			       l.family_depth, l.item_no, l.quantity, l.unit_price, l.amount,
			       sum(l.amount) over (order by l.posted_on, l.invoice_no, l.line_no) as running_delivered
			from nl.commitment_lines l
			join nl.customers cu on cu.customer_no = l.customer_no
			where l.commitment_id = ${id}
			order by l.posted_on, l.invoice_no, l.line_no`;

		const outcomes = await tx.sql<{
			outcome: Outcome;
			source: 'person' | 'nightly';
			answered_by: string | null;
			answered_at: Date;
			note: string;
		}>`
			select o.outcome, o.source, u.full_name as answered_by, o.answered_at, o.note
			from nl.commitment_outcomes o
			left join nl.users u on u.id = o.answered_by
			where o.commitment_id = ${id}
			order by o.answered_at desc, o.id desc`;

		// Quotes written for this commitment, and any later quote to the same
		// customer family that asks for its parts (the nightly job's evidence).
		const quotes = await tx.sql<{
			id: number;
			quoted_on: string;
			valid_until: string | null;
			total: number;
			lines: number;
			linked: boolean;
		}>`
			select q.id, q.quoted_on, q.valid_until,
			       coalesce(sum(ql.quantity * ql.unit_price), 0) as total,
			       count(ql.line_no)::int as lines,
			       q.commitment_id is not distinct from ${id}::bigint as linked
			from nl.quotes q
			join nl.quote_lines ql on ql.quote_id = q.id
			where q.commitment_id = ${id}
			   or (q.customer_no in (select f.customer_no from nl.commitment_family f where f.commitment_id = ${id})
			       and exists (select 1 from nl.commitment_items ci
			                   where ci.commitment_id = ${id} and ci.item_no = ql.item_no))
			group by q.id
			order by q.quoted_on desc`;

		const steps = await tx.sql<{
			id: number;
			title: string;
			due_on: string | null;
			owner_name: string;
			done: boolean;
		}>`
			select s.id, s.title, s.due_on, u.full_name as owner_name, s.completed_at is not null as done
			from nl.next_steps s
			join nl.users u on u.id = s.owner_id
			where s.commitment_id = ${id}
			order by s.completed_at is not null, s.due_on nulls last`;

		const mayChange = head.owner_id === userId || head.is_admin;
		return {
			...toCard(head),
			notes: head.notes,
			matchedLines: head.matched_lines,
			lastDeliveryOn: head.last_delivery_on,
			remaining: head.remaining,
			isSettled: head.is_settled,
			keptByMeasure: head.kept_by_measure,
			buyerEmail: head.buyer_email,
			customerCity: head.city,
			customerState: head.state,
			customerCountry: head.country,
			canAnswer: mayChange && head.days_since_close !== null && !head.kept_by_measure,
			canEdit: mayChange && !head.is_settled,
			items: items.map((r) => ({
				itemNo: r.item_no,
				description: r.description,
				quantity: r.quantity,
				deliveredQty: r.delivered_qty,
				delivered: r.delivered
			})),
			lines: lines.map((r) => ({
				invoiceNo: r.invoice_no,
				lineNo: r.line_no,
				postedOn: r.posted_on,
				customerNo: r.customer_no,
				customerName: r.customer_name,
				viaFamily: r.family_depth > 0,
				itemNo: r.item_no,
				quantity: r.quantity,
				unitPrice: r.unit_price,
				amount: r.amount,
				runningDelivered: r.running_delivered
			})),
			outcomes: outcomes.map((r) => ({
				outcome: r.outcome,
				source: r.source,
				answeredBy: r.answered_by,
				answeredAt: r.answered_at.toISOString(),
				note: r.note
			})),
			quotes: quotes.map((r) => ({
				id: r.id,
				quotedOn: r.quoted_on,
				validUntil: r.valid_until,
				total: r.total,
				lines: r.lines,
				linked: r.linked
			})),
			nextSteps: steps.map((r) => ({
				id: r.id,
				title: r.title,
				dueOn: r.due_on,
				ownerName: r.owner_name,
				done: r.done
			}))
		};
	});
}

// ---------------------------------------------------------------------------
// Writes. Inputs are checked here (shape) and again in SQL (meaning).
// ---------------------------------------------------------------------------

const requestId = z.string().min(8).max(100);
const rowVersion = z.iso.datetime({ offset: true });

export const recordOutcomeInput = z.object({
	commitmentId: z.coerce.number().int().positive(),
	outcome: z.enum(['pushed', 'kept', 'broken']),
	note: z.string().trim().max(500).default(''),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type RecordOutcomeInput = z.infer<typeof recordOutcomeInput>;

export interface WriteResult {
	commitmentId: number;
	updatedAt: string;
	replayed: boolean;
}

interface WriteRow {
	result: { commitment_id: number; updated_at: string; replayed?: boolean };
}

export async function recordOutcome(
	db: Db,
	userId: number,
	input: RecordOutcomeInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<WriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.record_outcome(${input.commitmentId}, ${input.outcome}, ${input.expectedUpdatedAt}::timestamptz,
				                         ${input.requestId}, ${input.note}, ${via}) as result`
		)
	);
	return {
		commitmentId: row.result.commitment_id,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}

export const setConfidenceInput = z.object({
	commitmentId: z.coerce.number().int().positive(),
	confidence: z.coerce.number().int().min(0).max(100),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type SetConfidenceInput = z.infer<typeof setConfidenceInput>;

export async function setConfidence(
	db: Db,
	userId: number,
	input: SetConfidenceInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<WriteResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<WriteRow>`
				select nl.set_confidence(${input.commitmentId}, ${input.confidence}, ${input.expectedUpdatedAt}::timestamptz,
				                         ${input.requestId}, ${via}) as result`
		)
	);
	return {
		commitmentId: row.result.commitment_id,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}
