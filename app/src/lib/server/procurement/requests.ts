// The four things a person can do on the procurement desk.
//
//   sweepSignals            look for anything new and record it
//   draftPurchaseRequests   turn what needs buying into one draft per vendor
//   setRequestLine          change a quantity or a date on a draft
//   approvePurchaseRequest  approve it: raise the order and queue the email
//
// Every rule lives in the SQL functions in migration 0022, not here: who may
// press the button, whether the draft has moved since the page loaded,
// whether the same form was sent twice. This file checks the SHAPE of what
// the form sent (zod) and turns a database refusal into an HTTP status.
//
// The one thing that is enforced here and not in SQL is the vendor disclosure
// policy, because it is a judgement about English text (disclosure.ts). It
// runs inside the approval's own transaction, so a refusal takes the approval
// with it.
import { z } from 'zod';
import { guarded } from '../errors.ts';
import { queueVendorDraft } from './outbox.ts';
import type { VendorEmailLine } from './email.ts';
import type { Db, Row, Tx } from '../db/types.ts';

/** A form's request id: generated when the page loaded, so a resend writes once. */
const requestId = z.string().min(8).max(100);

/** A calendar date as the browser's date input sends it. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Pick a date.');

/** A row version as the page sends it back. */
const rowVersion = z.string().min(20).max(40);

export const sweepInput = z.object({ requestId });

export const draftInput = z.object({
	// Empty means every vendor with parts that need buying.
	vendorNo: z
		.string()
		.max(20)
		.optional()
		.transform((value) => (value && value.length > 0 ? value : null)),
	requestId
});

export const setLineInput = z.object({
	lineId: z.coerce.number().int().positive(),
	quantity: z.coerce
		.number()
		.int('A quantity is a whole number of pieces.')
		.min(1, 'A quantity is at least one.')
		.max(1_000_000),
	requestedOn: isoDate,
	expectedUpdatedAt: rowVersion,
	requestId
});

export const approveInput = z.object({
	purchaseRequestId: z.coerce.number().int().positive(),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type SweepInput = z.infer<typeof sweepInput>;
export type DraftInput = z.infer<typeof draftInput>;
export type SetLineInput = z.infer<typeof setLineInput>;
export type ApproveInput = z.infer<typeof approveInput>;

export interface SweepResult {
	total: number;
	raised: Record<string, number>;
	cleared: number;
	replayed: boolean;
}

/** Look for anything the desk should know about and record what is new. */
export async function sweepSignals(db: Db, userId: number, input: SweepInput): Promise<SweepResult> {
	return guarded(async () => {
		const [row] = await db.asUser(userId, (tx) =>
			tx.sql<{ r: SweepResult }>`select nl.sweep_procurement_signals(${input.requestId}, 'ui') as r`
		);
		return { ...row.r, replayed: row.r.replayed === true };
	});
}

export interface DraftResult {
	requestIds: number[];
	drafted: number;
	/** Parts that need buying but have no vendor or no cost, so were left out. */
	skipped: number;
	replayed: boolean;
}

/** Turn what needs buying into one draft per vendor. */
export async function draftPurchaseRequests(
	db: Db,
	userId: number,
	input: DraftInput
): Promise<DraftResult> {
	return guarded(async () => {
		const [row] = await db.asUser(userId, (tx) =>
			tx.sql<{ r: { request_ids: number[]; drafted: number; skipped: number; replayed: boolean } }>`
				select nl.draft_purchase_requests(${input.vendorNo}, ${input.requestId}, 'ui') as r`
		);
		return {
			requestIds: row.r.request_ids ?? [],
			drafted: row.r.drafted,
			skipped: row.r.skipped,
			replayed: row.r.replayed === true
		};
	});
}

export interface SetLineResult {
	purchaseRequestId: number;
	lineId: number;
	subtotal: number;
	updatedAt: string;
	replayed: boolean;
}

/** Change a quantity or a delivery date on a draft. */
export async function setRequestLine(
	db: Db,
	userId: number,
	input: SetLineInput
): Promise<SetLineResult> {
	return guarded(async () => {
		const [row] = await db.asUser(userId, (tx) =>
			tx.sql<{
				r: {
					request_id: number;
					line_id: number;
					subtotal: number;
					updated_at: string;
					replayed: boolean;
				};
			}>`
				select nl.set_purchase_request_line(
					${input.lineId}, ${input.quantity}, ${input.requestedOn},
					${input.expectedUpdatedAt}::timestamptz, ${input.requestId}, 'ui') as r`
		);
		return {
			purchaseRequestId: row.r.request_id,
			lineId: row.r.line_id,
			subtotal: row.r.subtotal,
			updatedAt: row.r.updated_at,
			replayed: row.r.replayed === true
		};
	});
}

export interface ApproveResult {
	purchaseRequestId: number;
	orderNo: string;
	lines: number;
	/** True when the order was also written into the supply forecast's tables. */
	mirrored: boolean;
	/** Which queue the vendor email reached. */
	queue: 'mail_drafts' | 'procurement';
	subject: string;
	replayed: boolean;
}

interface ApprovalContextDb extends Row {
	vendor_no: string;
	vendor_name: string;
	terms: string;
	freight_note: string;
	to_email: string | null;
	to_name: string | null;
	from_name: string;
	from_title: string;
	from_email: string;
}

/**
 * Everything the email needs, and everything it must not say, read in one
 * place so the disclosure scan has the real figures to check against and not
 * a guess.
 *
 * The forbidden lists are gathered from the database for THESE parts:
 *   * the accounts that have open orders or open commitments for them,
 *   * what those accounts pay (nl.price_for, migration 0018),
 *   * our margin at that price,
 *   * what any OTHER vendor charges us for the same part.
 * That is the set a leak would come from, and it is small enough to scan the
 * finished text against on every approval.
 */
async function approvalContext(tx: Tx, purchaseRequestId: number) {
	const [head] = await tx.sql<ApprovalContextDb>`
		select
			pr.vendor_no, v.name as vendor_name, pr.terms, pr.freight_note,
			vc.email as to_email, vc.full_name as to_name,
			me.full_name as from_name, me.title as from_title, me.email as from_email
		from nl.purchase_requests pr
		join nl.vendors v on v.vendor_no = pr.vendor_no
		join nl.users me on me.id = nl.current_user_id()
		-- The vendor's primary contact, or any active one with an address.
		left join lateral (
			select c.full_name, c.email
			from nl.vendor_contacts c
			where c.vendor_no = pr.vendor_no and c.active and c.email is not null
			order by c.is_primary desc, c.id
			limit 1
		) vc on true
		where pr.id = ${purchaseRequestId}`;

	const lines = await tx.sql<{
		item_no: string;
		description: string;
		quantity: number;
		unit_cost: number;
		requested_on: string;
	}>`
		select l.item_no, i.description, l.quantity, l.unit_cost, l.requested_on
		from nl.purchase_request_lines l
		join nl.items i on i.item_no = l.item_no
		where l.request_id = ${purchaseRequestId}
		order by l.line_no`;

	// The accounts behind the demand for these parts, and what they pay.
	const exposure = await tx.sql<{
		customer_name: string;
		selling_price: number | null;
		margin_pct: number | null;
	}>`
		with parts as (
			select distinct l.item_no from nl.purchase_request_lines l where l.request_id = ${purchaseRequestId}
		),
		accounts as (
			select distinct ol.customer_no, p.item_no
			from nl.open_order_lines ol
			join parts p on p.item_no = ol.item_no
			union
			select distinct cm.customer_no, p.item_no
			from nl.commitments cm
			join nl.commitment_items ci on ci.commitment_id = cm.id
			join parts p on p.item_no = ci.item_no
			where cm.ends_on >= nl.today()
		)
		select cu.name as customer_name, pf.price as selling_price, pf.margin_pct
		from accounts a
		join nl.customers cu on cu.customer_no = a.customer_no
		cross join lateral nl.price_for(a.customer_no, a.item_no, null) pf
		limit 200`;

	// What any other vendor charges us for the same parts.
	const otherVendors = await tx.sql<{ name: string | null; unit_cost: number | null }>`
		select distinct v.name, ic.unit_cost
		from nl.purchase_request_lines l
		join nl.item_costs ic on ic.item_no = l.item_no
		left join nl.vendors v on v.vendor_no = ic.vendor_no
		where l.request_id = ${purchaseRequestId}
		  and ic.vendor_no is not null
		  and ic.vendor_no <> ${head.vendor_no}
		limit 200`;

	return { head, lines, exposure, otherVendors };
}

/**
 * Approve a draft: raise the purchase order, then build and queue the vendor
 * email. Both happen in ONE transaction, and the disclosure scan runs between
 * them, so an email that would say too much rolls the order back with it.
 */
export async function approvePurchaseRequest(
	db: Db,
	userId: number,
	input: ApproveInput
): Promise<ApproveResult> {
	return guarded(async () =>
		db.asUser(userId, async (tx) => {
			const context = await approvalContext(tx, input.purchaseRequestId);
			if (!context.head) {
				// The SQL function raises the same refusal; getting here means the
				// row was not readable at all.
				throw Object.assign(new Error('That purchase request does not exist.'), { code: 'NL404' });
			}
			if (!context.head.to_email) {
				throw Object.assign(
					new Error(
						`${context.head.vendor_name} has nobody with an email address on file. Add a contact on the vendor page first.`
					),
					{ code: 'NL422' }
				);
			}

			const [approved] = await tx.sql<{
				r: { order_no: string; lines: number; mirrored: boolean; replayed: boolean };
			}>`
				select nl.approve_purchase_request(
					${input.purchaseRequestId}, ${input.expectedUpdatedAt}::timestamptz,
					${input.requestId}, 'ui') as r`;

			// A resend of the same form: the order already exists and so does
			// its draft, so there is nothing more to do.
			if (approved.r.replayed === true) {
				const [existing] = await tx.sql<{ subject: string; mail_draft_id: number | null }>`
					select subject, mail_draft_id from nl.purchase_request_drafts
					where request_id = ${input.purchaseRequestId}`;
				return {
					purchaseRequestId: input.purchaseRequestId,
					orderNo: approved.r.order_no,
					lines: approved.r.lines,
					mirrored: approved.r.mirrored,
					queue: existing?.mail_draft_id ? ('mail_drafts' as const) : ('procurement' as const),
					subject: existing?.subject ?? '',
					replayed: true
				};
			}

			const emailLines: VendorEmailLine[] = context.lines.map((line) => ({
				itemNo: line.item_no,
				description: line.description,
				quantity: line.quantity,
				unitCost: line.unit_cost,
				requestedOn: line.requested_on
			}));

			const queued = await queueVendorDraft(tx, {
				requestRowId: input.purchaseRequestId,
				toEmail: context.head.to_email,
				toName: context.head.to_name ?? '',
				email: {
					vendorName: context.head.vendor_name,
					contactName: context.head.to_name ?? '',
					orderNo: approved.r.order_no,
					terms: context.head.terms,
					freightNote: context.head.freight_note,
					lines: emailLines,
					fromName: context.head.from_name,
					fromTitle: context.head.from_title,
					fromEmail: context.head.from_email
				},
				disclosure: {
					vendorNo: context.head.vendor_no,
					vendorName: context.head.vendor_name,
					customerNames: [...new Set(context.exposure.map((e) => e.customer_name))],
					sellingPrices: [
						...new Set(
							context.exposure
								.map((e) => e.selling_price)
								.filter((price): price is number => price !== null)
						)
					],
					marginPcts: [
						...new Set(
							context.exposure.map((e) => e.margin_pct).filter((pct): pct is number => pct !== null)
						)
					],
					otherVendorPrices: [
						...new Set(
							context.otherVendors
								.map((v) => v.unit_cost)
								.filter((cost): cost is number => cost !== null)
						)
					],
					otherVendorNames: [
						...new Set(
							context.otherVendors.map((v) => v.name).filter((name): name is string => name !== null)
						)
					]
				},
				// The email's own write needs its own request id, and it has to be
				// the same on a resend, so it is derived from the form's.
				requestId: `${input.requestId}-mail`
			});

			return {
				purchaseRequestId: input.purchaseRequestId,
				orderNo: approved.r.order_no,
				lines: approved.r.lines,
				mirrored: approved.r.mirrored,
				queue: queued.queue,
				subject: queued.subject,
				replayed: false
			};
		})
	);
}
