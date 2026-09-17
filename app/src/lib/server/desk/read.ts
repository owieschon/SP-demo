// What the /desk pages read. Queries only: every one of them runs as the
// signed-in person, so row-level security decides what comes back.
import type {
	AttachmentView,
	DraftStatus,
	DraftView,
	Fact,
	Intent,
	MailboxView,
	MessageDetail,
	MessageStatus,
	MessageSummary,
	RunView
} from '$lib/desk/types';
import type { Db, Tx } from '../db/types.ts';
import { blockedRecipients, type Allowlist } from './send.ts';

export async function listMailboxViews(db: Db, userId: number): Promise<MailboxView[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			mailbox_id: number;
			address: string;
			kind: 'orders' | 'procurement';
			label: string;
			purpose: string;
			reviewer_id: number;
			reviewer_name: string;
			disclosure: MailboxView['disclosure'];
			active: boolean;
			waiting: number;
			needs_person: number;
			messages: number;
			queued: number;
			approved: number;
			sent: number;
			runs_today: number;
			runs_cap: number;
		}>`
			select c.*, b.purpose, u.full_name as reviewer_name
			from nl.mail_desk_counts c
			join nl.mailboxes b on b.id = c.mailbox_id
			join nl.users u on u.id = c.reviewer_id
			order by c.mailbox_id`
	);
	return rows.map((r) => ({
		id: r.mailbox_id,
		address: r.address,
		kind: r.kind,
		label: r.label,
		purpose: r.purpose,
		reviewerId: r.reviewer_id,
		reviewerName: r.reviewer_name,
		disclosure: r.disclosure,
		active: r.active,
		waiting: r.waiting,
		needsPerson: r.needs_person,
		messages: r.messages,
		queued: r.queued,
		approved: r.approved,
		sent: r.sent,
		runsToday: r.runs_today,
		runsCap: r.runs_cap
	}));
}

interface MessageRow {
	id: number;
	mailbox_id: number;
	mailbox_label: string;
	from_address: string;
	from_name: string;
	subject: string;
	received_at: Date;
	status: MessageStatus;
	intent: Intent | null;
	intent_confidence: number | null;
	summary: string;
	customer_no: string | null;
	customer_name: string | null;
	vendor_no: string | null;
	vendor_name: string | null;
	contact_name: string | null;
	match_reason: string;
	attachments: number;
	draft_id: number | null;
	draft_status: DraftStatus | null;
	rfq_draft_id: number | null;
}

const MESSAGE_COLUMNS = `
	m.id, m.mailbox_id, b.label as mailbox_label, m.from_address, m.from_name, m.subject,
	m.received_at, m.status, m.intent, m.intent_confidence, m.summary,
	m.customer_no, c.name as customer_name, m.vendor_no, v.name as vendor_name,
	ct.full_name as contact_name, m.match_reason, m.rfq_draft_id,
	(select count(*)::int from nl.mail_attachments a where a.message_id = m.id) as attachments,
	d.id as draft_id, d.status as draft_status`;

const MESSAGE_JOINS = `
	from nl.mail_messages m
	join nl.mailboxes b on b.id = m.mailbox_id
	left join nl.customers c on c.customer_no = m.customer_no
	left join nl.vendors v on v.vendor_no = m.vendor_no
	left join nl.contacts ct on ct.id = m.contact_id
	-- The newest draft on this message, which is the one a person acts on.
	left join lateral (
	  select id, status from nl.mail_drafts dr
	  where dr.in_reply_to_id = m.id
	  order by dr.id desc limit 1
	) d on true`;

function toMessage(r: MessageRow): MessageSummary {
	return {
		id: r.id,
		mailboxId: r.mailbox_id,
		mailboxLabel: r.mailbox_label,
		fromAddress: r.from_address,
		fromName: r.from_name,
		subject: r.subject,
		receivedAt: r.received_at.toISOString(),
		status: r.status,
		intent: r.intent,
		intentConfidence: r.intent_confidence,
		summary: r.summary,
		customerNo: r.customer_no,
		customerName: r.customer_name,
		vendorNo: r.vendor_no,
		vendorName: r.vendor_name,
		contactName: r.contact_name,
		matchReason: r.match_reason,
		attachments: r.attachments,
		draftId: r.draft_id,
		draftStatus: r.draft_status,
		rfqDraftId: r.rfq_draft_id
	};
}

/** The inbox: newest first, optionally one desk only. */
export async function listMessages(
	db: Db,
	userId: number,
	options: { mailboxId?: number | null; limit?: number } = {}
): Promise<MessageSummary[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<MessageRow>(
			`select ${MESSAGE_COLUMNS} ${MESSAGE_JOINS}
			 where ($1::int is null or m.mailbox_id = $1::int)
			 order by m.received_at desc, m.id desc
			 limit $2`,
			[options.mailboxId ?? null, options.limit ?? 40]
		)
	);
	return rows.map(toMessage);
}

interface DraftRow {
	id: number;
	mailbox_id: number;
	mailbox_label: string;
	mailbox_address: string;
	disclosure: DraftView['disclosure'];
	reviewer_id: number;
	reviewer_name: string;
	in_reply_to_id: number | null;
	reply_subject: string | null;
	reply_from: string | null;
	to_addresses: string[];
	cc_addresses: string[];
	subject: string;
	body: string;
	intent: Intent;
	facts: Fact[];
	attachments: { kind: string; name: string; quoteId?: number }[];
	blocked_reason: string;
	status: DraftStatus;
	edited: boolean;
	reviewed_by_name: string | null;
	reviewed_at: Date | null;
	reject_reason: string;
	provider_message_id: string | null;
	sent_at: Date | null;
	send_attempts: number;
	error: string | null;
	created_at: Date;
	updated_at: Date;
}

const DRAFT_SELECT = `
	select d.id, d.mailbox_id, b.label as mailbox_label, b.address as mailbox_address, b.disclosure,
	       b.reviewer_id, u.full_name as reviewer_name,
	       d.in_reply_to_id, m.subject as reply_subject, m.from_address as reply_from,
	       d.to_addresses, d.cc_addresses, d.subject, d.body, d.intent, d.facts, d.attachments,
	       d.blocked_reason, d.status, d.edited, r.full_name as reviewed_by_name, d.reviewed_at,
	       d.reject_reason, d.provider_message_id, d.sent_at, d.send_attempts, d.error,
	       d.created_at, d.updated_at
	from nl.mail_drafts d
	join nl.mailboxes b on b.id = d.mailbox_id
	join nl.users u on u.id = b.reviewer_id
	left join nl.users r on r.id = d.reviewed_by
	left join nl.mail_messages m on m.id = d.in_reply_to_id`;

function toDraft(r: DraftRow, allowlist: Allowlist): DraftView {
	const blocked = blockedRecipients(r.to_addresses.concat(r.cc_addresses), allowlist);
	return {
		id: r.id,
		mailboxId: r.mailbox_id,
		mailboxLabel: r.mailbox_label,
		mailboxAddress: r.mailbox_address,
		disclosure: r.disclosure,
		reviewerId: r.reviewer_id,
		reviewerName: r.reviewer_name,
		inReplyToId: r.in_reply_to_id,
		replySubject: r.reply_subject,
		replyFrom: r.reply_from,
		to: r.to_addresses,
		cc: r.cc_addresses,
		subject: r.subject,
		body: r.body,
		intent: r.intent,
		facts: Array.isArray(r.facts) ? r.facts : [],
		attachments: Array.isArray(r.attachments) ? r.attachments : [],
		blockedReason: r.blocked_reason,
		status: r.status,
		edited: r.edited,
		reviewedByName: r.reviewed_by_name,
		reviewedAt: r.reviewed_at?.toISOString() ?? null,
		rejectReason: r.reject_reason,
		providerMessageId: r.provider_message_id,
		sentAt: r.sent_at?.toISOString() ?? null,
		sendAttempts: r.send_attempts,
		error: r.error,
		createdAt: r.created_at.toISOString(),
		updatedAt: r.updated_at.toISOString(),
		recipientsAllowed: blocked.length === 0,
		blockedRecipients: blocked
	};
}

/** The review queue. Waiting first, then what has been decided. */
export async function listQueue(
	db: Db,
	userId: number,
	allowlist: Allowlist,
	options: { mailboxId?: number | null; status?: DraftStatus | 'open' | 'all'; limit?: number } = {}
): Promise<DraftView[]> {
	const status = options.status ?? 'open';
	const rows = await db.asUser(userId, (tx) =>
		tx.query<DraftRow>(
			`${DRAFT_SELECT}
			 where ($1::int is null or d.mailbox_id = $1::int)
			   and ($2::text = 'all'
			        or ($2::text = 'open' and d.status in ('draft', 'approved', 'failed'))
			        or d.status = $2::text)
			 order by (case d.status when 'draft' then 0 when 'approved' then 1 when 'failed' then 2 else 3 end),
			          d.created_at desc, d.id desc
			 limit $3`,
			[options.mailboxId ?? null, status, options.limit ?? 40]
		)
	);
	return rows.map((row) => toDraft(row, allowlist));
}

export async function getDraft(
	db: Db,
	userId: number,
	id: number,
	allowlist: Allowlist
): Promise<DraftView | null> {
	const [row] = await db.asUser(userId, (tx) => tx.query<DraftRow>(`${DRAFT_SELECT} where d.id = $1`, [id]));
	return row ? toDraft(row, allowlist) : null;
}

async function readRuns(tx: Tx, messageId: number): Promise<RunView[]> {
	const rows = await tx.sql<{
		id: number;
		mode: 'mock' | 'live';
		model: string | null;
		started_at: Date;
		finished_at: Date | null;
		lookups: RunView['lookups'];
		lookup_count: number;
		rounds: number;
		input_tokens: number;
		output_tokens: number;
		outcome: RunView['outcome'];
		draft_id: number | null;
		error: string | null;
	}>`
		select id, mode, model, started_at, finished_at, lookups, lookup_count, rounds,
		       input_tokens, output_tokens, outcome, draft_id, error
		from nl.mail_runs
		where message_id = ${messageId}
		order by id desc`;
	return rows.map((r) => ({
		id: r.id,
		mode: r.mode,
		model: r.model,
		startedAt: r.started_at.toISOString(),
		finishedAt: r.finished_at?.toISOString() ?? null,
		lookups: Array.isArray(r.lookups) ? r.lookups : [],
		lookupCount: r.lookup_count,
		rounds: r.rounds,
		inputTokens: r.input_tokens,
		outputTokens: r.output_tokens,
		outcome: r.outcome,
		draftId: r.draft_id,
		error: r.error
	}));
}

/** One message, everything about it: the mail, its runs and its drafts. */
export async function getMessage(
	db: Db,
	userId: number,
	id: number,
	allowlist: Allowlist
): Promise<MessageDetail | null> {
	return db.asUser(userId, async (tx) => {
		const [row] = await tx.query<MessageRow & { body_text: string; to_addresses: string[]; cc_addresses: string[] }>(
			`select ${MESSAGE_COLUMNS}, m.body_text, m.to_addresses, m.cc_addresses ${MESSAGE_JOINS} where m.id = $1`,
			[id]
		);
		if (!row) return null;

		const attachments = await tx.sql<{
			id: number;
			file_name: string;
			media_type: string;
			size_bytes: number;
			document_attachment_id: number | null;
		}>`
			select id, file_name, media_type, size_bytes, document_attachment_id
			from nl.mail_attachments where message_id = ${id} order by id`;

		const drafts = await tx.query<DraftRow>(
			`${DRAFT_SELECT} where d.in_reply_to_id = $1 order by d.id desc`,
			[id]
		);

		return {
			message: toMessage(row),
			bodyText: row.body_text,
			toAddresses: row.to_addresses,
			ccAddresses: row.cc_addresses,
			attachments: attachments.map(
				(a): AttachmentView => ({
					id: a.id,
					fileName: a.file_name,
					mediaType: a.media_type,
					sizeBytes: a.size_bytes,
					documentAttachmentId: a.document_attachment_id
				})
			),
			runs: await readRuns(tx, id),
			drafts: drafts.map((draft) => toDraft(draft, allowlist))
		};
	});
}

/** How many drafts are waiting for this person to look at them. */
export async function countWaiting(db: Db, userId: number): Promise<number> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ n: number }>`
			select count(*)::int as n
			from nl.mail_drafts d
			where d.status = 'draft'`
	);
	return row?.n ?? 0;
}
