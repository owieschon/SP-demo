// Where a vendor email goes once a purchase request is approved.
//
// The order desk's mail agent (migration 0021) owns nl.mail_drafts, the human
// review queue everything outbound is supposed to sit in. That migration was
// being written on another branch at the same time as this one, so this
// module works either way:
//
//   * nl.purchase_request_drafts (0022, this desk's own table) ALWAYS gets the
//     draft. It is the record, and the /procurement page reads it.
//   * When nl.mail_drafts is there and shaped the way MAIL_DRAFT_COLUMNS
//     expects, the same draft is mirrored into it and the id it came back
//     with is stored on our row (mail_draft_id).
//
// Nothing here sends anything. There is no mail client in this app at all.
//
// WHAT THE LEAD HAS TO DECIDE BEFORE THE MIRROR CAN BE TURNED ON
//
// 0021 landed on main while this branch was being written, so its real shape
// is known and is recorded in MAIL_DRAFT_COLUMNS below. Three of its columns
// are required and are not things this module can invent:
//
//   mailbox_id    0021 already seeds a mailbox with kind 'procurement' and
//                 disclosure 'vendor', which is exactly where these drafts
//                 belong. That is the row to look up.
//   to_addresses  a text[], not a single address.
//   intent        'purchase_order' is in its allowed list.
//   facts         the list of facts the body rests on. 0021's own policy
//                 (app/src/lib/server/desk/policy.ts) runs over exactly this
//                 list, and its 'vendor' level currently allows
//                 part_description, vendor_supply, vendor_lead_time and
//                 lead_time. None of those is a PRICE.
//
// That last line is the decision. A purchase order has to state the price we
// are paying, and this desk's own policy says a vendor may hear it (it is
// their price to us). 0021's vendor level has no fact kind for it yet, so
// mirroring a purchase order into that queue today would put a dollar figure
// in front of its reviewer with nothing to back it. Either 0021 grows a
// vendor-level fact kind for our purchase price, or these drafts stay in this
// desk's own queue. Rather than pick for another feature, the mirror is
// written and left switched off by the shape check, and this comment is the
// handover.
import { assertVendorSafe, type VendorDisclosureContext } from './disclosure.ts';
import { buildVendorEmail, type VendorEmailInput } from './email.ts';
import type { Tx } from '../db/types.ts';

/**
 * The columns this module writes into 0021's nl.mail_drafts, checked against
 * the live table before anything is attempted, so a shape that does not match
 * costs a missing mirror and never a failed approval.
 *
 * The first name in each list is 0021's real one. The others are the guesses
 * this file was written with before 0021 landed, kept so a rename there does
 * not silently stop the mirror.
 */
const MAIL_DRAFT_COLUMNS = {
	/** A text[] in 0021, so the value goes in as an array of one. */
	to: ['to_addresses', 'to_email', 'to_address', 'recipient_email'],
	subject: ['subject'],
	body: ['body', 'body_text', 'text'],
	/** Required, and must be the mailbox whose kind is 'procurement'. */
	mailbox: ['mailbox_id'],
	/** Required, and 'purchase_order' is one of 0021's allowed values. */
	intent: ['intent', 'about', 'kind', 'topic']
} as const;

/** What 0021 calls a purchase order, in its own `intent` vocabulary. */
const PURCHASE_ORDER_INTENT = 'purchase_order';

/**
 * The first of these column names the table actually has, or null. The same
 * question nl.first_column answers in SQL (migration 0022); asking it from
 * here keeps the candidate lists next to the code that uses them.
 */
async function firstColumn(tx: Tx, table: string, candidates: readonly string[]): Promise<string | null> {
	const [row] = await tx.query<{ name: string | null }>(
		'select nl.first_column($1, $2::text[]) as name',
		[table, `{${candidates.join(',')}}`]
	);
	return row?.name ?? null;
}

export interface QueueVendorDraftInput {
	/** The nl.purchase_requests row this email is about. */
	requestRowId: number;
	toEmail: string;
	toName: string;
	email: VendorEmailInput;
	/** The things this particular email must not mention. */
	disclosure: VendorDisclosureContext;
	/** The form's request id, so a double submit writes one draft. */
	requestId: string;
	via?: 'ui' | 'assistant';
}

export interface QueuedDraft {
	draftId: number;
	mailDraftId: number | null;
	subject: string;
	body: string;
	/** Which queue the draft reached, for the page to say so plainly. */
	queue: 'mail_drafts' | 'procurement';
}

/**
 * Mirror a draft into 0021's mail queue, if that queue is there and shaped
 * the way MAIL_DRAFT_COLUMNS expects. Returns the new row's id, or null when
 * there was nothing to write to.
 *
 * Any failure returns null rather than throwing: the desk's own table already
 * holds the draft, so a mirror that does not fit is a missing convenience and
 * not a lost order. A failed statement would abort the transaction, so the
 * shape is checked BEFORE anything is attempted rather than after.
 */
async function mirrorToMailQueue(
	tx: Tx,
	draft: { toEmail: string; subject: string; body: string }
): Promise<number | null> {
	const [present] = await tx.sql<{ there: boolean }>`
		select to_regclass('nl.mail_drafts') is not null as there`;
	if (!present?.there) return null;

	const to = await firstColumn(tx, 'mail_drafts', MAIL_DRAFT_COLUMNS.to);
	const subject = await firstColumn(tx, 'mail_drafts', MAIL_DRAFT_COLUMNS.subject);
	const body = await firstColumn(tx, 'mail_drafts', MAIL_DRAFT_COLUMNS.body);
	if (!to || !subject || !body) return null;

	// A queue with mailboxes has to be told which one, and the only right
	// answer is the procurement desk's own. Until the disclosure question at
	// the top of this file is settled, a mail queue that has mailboxes is a
	// queue this module declines to write to: the draft stays in this desk's
	// own table, where it is still read, reviewed and sent by a person.
	//
	// 0021's nl.mail_drafts has mailbox_id, so today this is the branch that
	// runs. It is one line to delete once the decision is made.
	if (await firstColumn(tx, 'mail_drafts', MAIL_DRAFT_COLUMNS.mailbox)) return null;

	const intent = await firstColumn(tx, 'mail_drafts', MAIL_DRAFT_COLUMNS.intent);
	const columns = [to, subject, body, ...(intent ? [intent] : [])];
	const params = [draft.toEmail, draft.subject, draft.body, ...(intent ? [PURCHASE_ORDER_INTENT] : [])];

	// Every column name comes from MAIL_DRAFT_COLUMNS and has been found in
	// the live table, so the only thing interpolated into this statement is a
	// name from that fixed list. The values are still parameters.
	const [row] = await tx.query<{ id: number }>(
		`insert into nl.mail_drafts (${columns.join(', ')})
		 values (${params.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
		params
	);
	return row?.id ?? null;
}

/**
 * Build the vendor email, refuse it if it would say something a vendor may
 * not hear, then store it for a person.
 *
 * Called inside the same transaction as nl.approve_purchase_request, so a
 * refusal here rolls the approval back with it: there is no state in which an
 * order exists and its email was quietly dropped.
 */
export async function queueVendorDraft(tx: Tx, input: QueueVendorDraftInput): Promise<QueuedDraft> {
	const { subject, body } = buildVendorEmail(input.email);

	// The gate. Both parts of the email are scanned, because a subject line
	// is the easiest place to put a customer's name without thinking.
	assertVendorSafe(`${subject}\n${body}`, input.disclosure);

	const mailDraftId = await mirrorToMailQueue(tx, { toEmail: input.toEmail, subject, body });

	const [row] = await tx.sql<{ r: { draft_id: number; mail_draft_id: number | null } }>`
		select nl.queue_purchase_request_draft(
			${input.requestRowId}, ${input.toEmail}, ${input.toName}, ${subject}, ${body},
			${mailDraftId}, ${input.requestId}, ${input.via ?? 'ui'}) as r`;

	return {
		draftId: row.r.draft_id,
		mailDraftId: row.r.mail_draft_id,
		subject,
		body,
		queue: mailDraftId === null ? 'procurement' : 'mail_drafts'
	};
}
