// Waking up: fetch what has arrived, store it, and start a run per new message.
//
// The agent has no schedule of its own and no loop. It wakes on mail, and
// there are three ways mail reaches it:
//
//   the "Check mail" button on /desk
//   GET /api/mail/poll        (the cron, with the shared CRON_SECRET)
//   POST /api/mail/webhook    (the provider, with MAIL_WEBHOOK_SECRET)
//
// All three land here. The webhook does not trust its own payload for
// anything except "something arrived": it falls back to a poll, so a forged
// body cannot inject a message. Storing is idempotent on the content hash, so
// a webhook and the cron delivering the same mail writes one row.
//
// Each mailbox is worked as its own reviewer, so the agent reads under exactly
// the row-level security a person would, and the drafts land in the queue of
// the person who has to approve them.
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/types.ts';
import { guarded } from '../errors.ts';
import { createAgentMailClient } from './agentmail.ts';
import { classifyWithClaude, DEFAULT_MODEL, messagesApi, type MessagesApi } from './claude.ts';
import type { MailClient } from './mail.ts';
import { createMockClient, type MockWorld } from './mock.ts';
import { runMessage, type LiveClassifier, type RunResult } from './run.ts';
import { recordMessage } from './writes.ts';

/*
  The settings the desk reads out of the environment.

  Every key is optional, which makes this what TypeScript calls a weak
  type: it rejects an argument that has none of these keys. `env` from
  $env/dynamic/private is typed from the variables that actually exist when
  svelte-check runs, so on a machine with no app/.env the check failed with
  "no properties in common" at all four call sites, while passing on a
  machine that happened to have MAIL_INBOX_ORDERS set. The index signature
  says what is true: this is a bag of strings we look named keys up in.
*/
export interface DeskEnv {
	[key: string]: string | undefined;
	AGENTMAIL_API_KEY?: string;
	MAIL_INBOX_ORDERS?: string;
	MAIL_INBOX_PROCUREMENT?: string;
	MAIL_ALLOWLIST?: string;
	MAIL_WEBHOOK_SECRET?: string;
	ANTHROPIC_API_KEY?: string;
	ANTHROPIC_MODEL?: string;
}

export interface MailboxRow {
	id: number;
	address: string;
	kind: 'orders' | 'procurement';
	label: string;
	reviewerId: number;
	active: boolean;
}

/** The desks, newest first, as the poll needs them. Read as the system: the cron has nobody signed in. */
export async function listMailboxes(db: Db): Promise<MailboxRow[]> {
	const rows = await db.asSystem((tx) =>
		tx.sql<{ id: number; address: string; kind: 'orders' | 'procurement'; label: string; reviewer_id: number; active: boolean }>`
			select id, address, kind, label, reviewer_id, active from nl.mailboxes order by id`
	);
	return rows.map((r) => ({
		id: r.id,
		address: r.address,
		kind: r.kind,
		label: r.label,
		reviewerId: r.reviewer_id,
		active: r.active
	}));
}

/**
 * The rows the scripted mailbox writes its messages around: a real account
 * with a named buyer, two parts that account buys, and a supplier we have an
 * order with. Without them the scripted mail would be about nothing, and
 * every lookup the agent made would come back empty.
 */
export async function readMockWorld(db: Db, mailboxes: MailboxRow[], userId: number): Promise<MockWorld> {
	const orders = mailboxes.find((m) => m.kind === 'orders')?.address ?? 'order-desk@agentmail.to';
	const procurement = mailboxes.find((m) => m.kind === 'procurement')?.address ?? 'procurement-desk@agentmail.to';

	return db.asUser(userId, async (tx) => {
		const [today] = await tx.sql<{ today: string }>`select nl.today() as today`;
		// An account with a buyer on file and parts it really buys. Ordered by
		// customer number so the scripted mail is the same every run.
		const [account] = await tx.sql<{
			customer_no: string;
			name: string;
			city: string;
			state: string;
			full_name: string;
			email: string;
			title: string;
		}>`
			select c.customer_no, c.name, c.city, c.state, ct.full_name, ct.email, ct.title
			from nl.customers c
			join nl.contacts ct on ct.customer_no = c.customer_no and ct.email is not null
			where not c.blocked and not c.closed
			  and exists (select 1 from nl.invoice_lines il
			              where il.customer_no = c.customer_no and il.quantity > 0)
			order by c.customer_no, ct.is_primary desc, ct.id
			limit 1`;

		const parts = account
			? await tx.sql<{ item_no: string; description: string }>`
					select il.item_no, i.description
					from nl.invoice_lines il
					join nl.items i on i.item_no = il.item_no
					where il.customer_no = ${account.customer_no} and il.quantity > 0 and not i.blocked
					group by il.item_no, i.description
					order by sum(il.quantity) desc, il.item_no
					limit 2`
			: [];

		const [vendor] = await tx.sql<{ vendor_no: string; name: string }>`
			select v.vendor_no, v.name
			from nl.vendors v
			where exists (select 1 from nl.open_purchase_lines l where l.vendor_no = v.vendor_no)
			order by v.vendor_no
			limit 1`;

		return {
			orderDesk: orders,
			procurementDesk: procurement,
			account: account
				? { customerNo: account.customer_no, name: account.name, city: account.city, state: account.state }
				: null,
			buyer: account ? { fullName: account.full_name, email: account.email, title: account.title } : null,
			parts: parts.map((p) => ({ itemNo: p.item_no, description: p.description })),
			vendor: vendor
				? {
						vendorNo: vendor.vendor_no,
						name: vendor.name,
						domain: `${vendor.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.example`
					}
				: null,
			today: today.today
		};
	});
}

/**
 * Which provider this server talks to. With no key it is the scripted one,
 * which is also what the tests and public visitors get.
 */
export async function chooseClient(
	db: Db,
	env: DeskEnv,
	mailboxes: MailboxRow[],
	userId: number
): Promise<MailClient> {
	if (env.AGENTMAIL_API_KEY) return createAgentMailClient(env.AGENTMAIL_API_KEY);
	return createMockClient(await readMockWorld(db, mailboxes, userId));
}

/** The live classifier, when the server has an Anthropic key. */
export function chooseClassifier(
	env: DeskEnv,
	api: MessagesApi | null
): { mode: 'mock' | 'live'; model: string | null; classify?: LiveClassifier } {
	if (!api || !env.ANTHROPIC_API_KEY) return { mode: 'mock', model: null };
	const model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;
	return {
		mode: 'live',
		model,
		classify: (input) => classifyWithClaude(input, { api, model })
	};
}

export { messagesApi };

export interface PollSummary {
	mailbox: string;
	label: string;
	delivered: number;
	duplicates: number;
	runs: RunResult[];
	/** Set when the provider itself could not be reached. */
	error: string | null;
}

export interface PollOptions {
	client: MailClient;
	mode?: 'mock' | 'live';
	model?: string | null;
	classify?: LiveClassifier;
	/** The most messages to take from one mailbox in one poll. */
	limit?: number;
	/** The most runs to start in one poll, so one press cannot run all night. */
	maxRuns?: number;
}

/**
 * Fetch, store and work one mailbox. New messages are worked in the order
 * they arrived; anything already worked is left alone, which is what makes
 * pressing the button twice safe.
 */
export async function pollMailbox(db: Db, mailbox: MailboxRow, options: PollOptions): Promise<PollSummary> {
	const summary: PollSummary = {
		mailbox: mailbox.address,
		label: mailbox.label,
		delivered: 0,
		duplicates: 0,
		runs: [],
		error: null
	};
	if (!mailbox.active) return summary;

	let incoming;
	try {
		incoming = await options.client.fetchNew(mailbox.address, { limit: options.limit ?? 10 });
	} catch (error) {
		summary.error = error instanceof Error ? error.message : String(error);
		return summary;
	}

	for (const mail of incoming) {
		const request = `mail-${mailbox.id}-${randomUUID()}`;
		const stored = await guarded(() =>
			db.asUser(mailbox.reviewerId, (tx) =>
				recordMessage(
					tx,
					{
						mailboxId: mailbox.id,
						providerMessageId: mail.providerMessageId,
						providerThreadId: mail.providerThreadId,
						fromAddress: mail.from,
						fromName: mail.fromName,
						to: mail.to.length > 0 ? mail.to : [mailbox.address],
						cc: mail.cc,
						subject: mail.subject,
						body: mail.text,
						bodyStripped: mail.strippedText,
						receivedAt: mail.receivedAt,
						attachments: mail.attachments.map((a) => ({
							provider_attachment_id: a.providerAttachmentId,
							file_name: a.fileName,
							media_type: a.mediaType,
							size_bytes: a.sizeBytes,
							...(a.base64 ? { base64: a.base64 } : {})
						}))
					},
					request
				)
			)
		);
		if (stored.duplicate) summary.duplicates += 1;
		else summary.delivered += 1;
	}

	// Everything in this mailbox nobody has worked yet, oldest first, whether
	// it arrived just now or was seeded into the world.
	const waiting = await db.asUser(mailbox.reviewerId, (tx) =>
		tx.sql<{ id: number }>`
			select id from nl.mail_messages
			where mailbox_id = ${mailbox.id} and status in ('new', 'working')
			order by received_at, id
			limit ${options.maxRuns ?? 10}`
	);

	for (const message of waiting) {
		try {
			summary.runs.push(
				await runMessage(db, mailbox.reviewerId, message.id, {
					mode: options.mode ?? 'mock',
					model: options.model ?? null,
					classify: options.classify
				})
			);
		} catch (error) {
			// The desk's daily cap (NL429) lands here, and so would a database
			// that has gone away. Either way the poll stops working this
			// mailbox and says why, instead of failing the whole request:
			// whatever it already worked is real and should be shown.
			summary.error = error instanceof Error ? error.message : String(error);
			break;
		}
	}
	return summary;
}

/** Every active desk. One mailbox failing does not stop the others. */
export async function pollAll(db: Db, options: PollOptions & { only?: number }): Promise<PollSummary[]> {
	const mailboxes = await listMailboxes(db);
	const wanted = mailboxes.filter((m) => m.active && (options.only === undefined || m.id === options.only));
	const summaries: PollSummary[] = [];
	for (const mailbox of wanted) {
		summaries.push(await pollMailbox(db, mailbox, options));
	}
	return summaries;
}
