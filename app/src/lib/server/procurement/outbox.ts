// Where a vendor email goes once a purchase request is approved.
//
// The order desk's mail agent (migration 0021) owns nl.mail_drafts, the human
// review queue everything outbound is supposed to sit in. That migration is
// being written on another branch, so this module works either way:
//
//   * nl.purchase_request_drafts (0022, this desk's own table) ALWAYS gets the
//     draft. It is the record, and the /procurement page reads it.
//   * When nl.mail_drafts exists AND has the columns named in
//     MAIL_DRAFT_COLUMNS below, the same draft is mirrored into it and the id
//     it came back with is stored on our row (mail_draft_id).
//
// Joining the two up later is therefore one change in ONE place: make
// mirrorToMailQueue below match 0021's real column names. Nothing else in the
// desk, and no data already written, has to move.
//
// Nothing here sends anything. There is no mail client in this app at all.
import { assertVendorSafe, type VendorDisclosureContext } from './disclosure.ts';
import { buildVendorEmail, type VendorEmailInput } from './email.ts';
import type { Tx } from '../db/types.ts';

/**
 * The columns this module would write into 0021's nl.mail_drafts. They are a
 * guess at that migration's shape, checked against the live table before
 * anything is written, so a wrong guess costs a missing mirror and not a
 * failed approval.
 */
const MAIL_DRAFT_COLUMNS = {
	to: ['to_email', 'to_address', 'recipient_email'],
	subject: ['subject'],
	body: ['body', 'body_text', 'text'],
	/** Optional: which mailbox it goes out from, when 0021 has mailboxes. */
	mailbox: ['mailbox_id'],
	/** Optional: what the draft is about, for 0021's own review queue. */
	about: ['about', 'kind', 'topic']
} as const;

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

	// Every column name comes from MAIL_DRAFT_COLUMNS and has been found in
	// the live table, so the only thing interpolated into this statement is a
	// name from that fixed list. The values are still parameters.
	const columns = [to, subject, body];
	const [row] = await tx.query<{ id: number }>(
		`insert into nl.mail_drafts (${columns.join(', ')}) values ($1, $2, $3) returning id`,
		[draft.toEmail, draft.subject, draft.body]
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
