// Sending, which happens once, after a person has approved, and never before.
//
// The rules, in the order they are checked:
//   1. the draft must be 'approved'. Nothing else is sendable, and the
//      database refuses anyway (nl.mark_mail_sent).
//   2. every recipient must be on MAIL_ALLOWLIST. It is checked here, on the
//      server, against the draft's stored recipients, not against anything
//      the browser sent. An entry starting with @ allows a whole domain.
//   3. the send is idempotent on the draft's request id, which is derived
//      from the draft id and its row version at approval. Two clicks, a
//      double submit and a retry after a timeout all send once.
//   4. success calls nl.mark_mail_sent with the provider's id; failure calls
//      nl.mark_mail_failed. A provider that could not be reached leaves the
//      draft approved so it can be tried again; a provider that refused the
//      request sets 'failed', because sending it again would fail again.
//
// With no API key the client is the scripted one, which records a simulated
// send and says so. Nothing in the tests can reach a real provider: the
// client is always passed in.
import { createHash } from 'node:crypto';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import { loadDraftQuoteDoc } from '../documents/quote.ts';
import { quotePdf } from '../documents/quotePdf.ts';
import { getDraft as getRfqDraft } from '../rfq/drafts.ts';
import type { MailClient, OutboundMail } from './mail.ts';
import { MailProviderError } from './agentmail.ts';
import { markFailed, markSent } from './writes.ts';

export interface Allowlist {
	addresses: Set<string>;
	domains: Set<string>;
	empty: boolean;
	/** What the page shows, so the rule is visible and not folklore. */
	describe: string;
}

/**
 * Read MAIL_ALLOWLIST: a comma-separated list where "buyer@shop.example" is
 * one address and "@shop.example" is every address at that domain.
 */
export function parseAllowlist(value: string | undefined): Allowlist {
	const addresses = new Set<string>();
	const domains = new Set<string>();
	for (const raw of (value ?? '').split(',')) {
		const entry = raw.trim().toLowerCase();
		if (entry.length === 0) continue;
		if (entry.startsWith('@')) {
			domains.add(entry.slice(1));
		} else if (entry.includes('@')) {
			addresses.add(entry);
		}
	}
	const empty = addresses.size === 0 && domains.size === 0;
	const parts = [
		...[...addresses].sort(),
		...[...domains].sort().map((domain) => `anyone at ${domain}`)
	];
	return {
		addresses,
		domains,
		empty,
		describe: empty ? 'MAIL_ALLOWLIST is empty, so no real mail can be sent.' : `Mail may only go to ${parts.join(', ')}.`
	};
}

export function isAllowed(address: string, allowlist: Allowlist): boolean {
	const clean = address.trim().toLowerCase();
	if (allowlist.addresses.has(clean)) return true;
	const domain = clean.split('@')[1] ?? '';
	return domain.length > 0 && allowlist.domains.has(domain);
}

/** Which of these addresses the allowlist would refuse. */
export function blockedRecipients(addresses: string[], allowlist: Allowlist): string[] {
	if (allowlist.empty) return [];
	return addresses.filter((address) => !isAllowed(address, allowlist));
}

export interface SendOptions {
	client: MailClient;
	allowlist: Allowlist;
}

export interface SendResult {
	draftId: number;
	providerMessageId: string;
	simulated: boolean;
	alreadySent: boolean;
}

interface DraftRow {
	id: number;
	mailbox_address: string;
	to_addresses: string[];
	cc_addresses: string[];
	subject: string;
	body: string;
	status: string;
	provider_message_id: string | null;
	reply_provider_id: string | null;
	/** The RFQ draft this reply quoted, when it quoted one. */
	rfq_draft_id: number | null;
	updated_at: Date;
}

/**
 * The quote as a PDF, built from the linked RFQ draft at send time so it can
 * never be stale, through the documents work's own builder (migration 0020).
 *
 * Anything that goes wrong here returns null and the reply goes without the
 * attachment: the prices are in the letter either way, and a missing PDF is a
 * worse reason to leave a customer waiting than an unattached one.
 */
async function quoteAttachment(
	db: Db,
	userId: number,
	rfqDraftId: number | null
): Promise<OutboundMail['attachments']> {
	if (rfqDraftId === null) return [];
	try {
		const rfq = await getRfqDraft(db, userId, rfqDraftId);
		if (!rfq) return [];
		const doc = await loadDraftQuoteDoc(db, userId, {
			id: rfq.id,
			validation: rfq.validation,
			createdByName: rfq.createdByName
		});
		if (!doc) return [];
		const bytes = await quotePdf(doc);
		return [
			{
				fileName: `Quote-R-${rfq.id}.pdf`,
				mediaType: 'application/pdf',
				base64: Buffer.from(bytes).toString('base64')
			}
		];
	} catch {
		return [];
	}
}

/**
 * Send one approved draft. Everything sent comes from the stored row: the
 * recipients, the subject and the body the reviewer approved, never anything
 * from the request that asked for the send.
 */
export async function sendApproved(
	db: Db,
	userId: number,
	draftId: number,
	options: SendOptions
): Promise<SendResult> {
	const [draft] = await db.asUser(userId, (tx) =>
		tx.sql<DraftRow>`
			select d.id, b.address as mailbox_address, d.to_addresses, d.cc_addresses, d.subject, d.body,
			       d.status, d.provider_message_id, m.provider_message_id as reply_provider_id,
			       m.rfq_draft_id, d.updated_at
			from nl.mail_drafts d
			join nl.mailboxes b on b.id = d.mailbox_id
			left join nl.mail_messages m on m.id = d.in_reply_to_id
			where d.id = ${draftId}`
	);
	if (!draft) {
		throw new AppError(404, 'NL404', `Draft M-${draftId} does not exist.`);
	}
	if (draft.status === 'sent') {
		return {
			draftId,
			providerMessageId: draft.provider_message_id ?? '',
			simulated: false,
			alreadySent: true
		};
	}
	if (draft.status !== 'approved') {
		throw new AppError(422, 'NL422', `Draft M-${draftId} is ${draft.status}; only an approved draft can be sent.`);
	}

	// 2. The allowlist, checked again here whatever the page believed.
	const blocked = blockedRecipients(draft.to_addresses.concat(draft.cc_addresses), options.allowlist);
	if (blocked.length > 0) {
		throw new AppError(
			422,
			'NL422',
			`${blocked.join(', ')} ${blocked.length === 1 ? 'is' : 'are'} not on this server's mail allowlist, so nothing was sent.`
		);
	}
	if (options.allowlist.empty && options.client.kind !== 'mock') {
		throw new AppError(422, 'NL422', 'MAIL_ALLOWLIST is empty, so no mail can be sent from this server.');
	}

	// 3. One send per approval. The row version at approval is part of the id,
	// so a draft that was edited and approved again is a different send.
	const request = `send-${draftId}-${createHash('sha256')
		.update(draft.updated_at.toISOString())
		.digest('hex')
		.slice(0, 32)}`;

	try {
		const sent = await options.client.send({
			fromAddress: draft.mailbox_address,
			to: draft.to_addresses,
			cc: draft.cc_addresses,
			subject: draft.subject,
			text: draft.body,
			inReplyToProviderId: draft.reply_provider_id,
			attachments: await quoteAttachment(db, userId, draft.rfq_draft_id)
		});
		const recorded = await markSent(db, userId, {
			draftId,
			providerMessageId: sent.providerMessageId,
			requestId: request
		});
		return {
			draftId,
			providerMessageId: sent.providerMessageId,
			simulated: sent.simulated,
			alreadySent: recorded.status === 'sent' && recorded.replayed
		};
	} catch (error) {
		if (error instanceof AppError) throw error;
		const permanent = error instanceof MailProviderError ? error.permanent : false;
		const message = error instanceof Error ? error.message : String(error);
		// Recording the failure must not swallow it: the page has to say what
		// happened, and the draft has to keep its error.
		await markFailed(db, userId, {
			draftId,
			error: message,
			permanent,
			requestId: `${request}-fail-${Date.now()}`
		});
		throw new AppError(
			502,
			'NL502',
			permanent
				? `${message} The draft is marked failed; rewrite it before trying again.`
				: `${message} The draft is still approved, so you can try again.`
		);
	}
}
