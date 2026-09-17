// Reading the workspace queue.
//
// Everything here is a read. One view, nl.agent_queue (migrations 0023 and
// 0025), puts every waiting agent request into one row shape; this file turns
// those rows into the shape the page uses and loads the detail behind each one.
//
// Reads run as the signed-in person, so row-level security decides what is in
// the queue at all: an unapproved quote request belongs to the person who made
// it (or an admin), an assistant proposal belongs to the person who asked. The
// queue does not widen that by a single row.
import type { Db, Tx } from '../db/types.ts';
import {
	QUEUE_SOURCES,
	type QueueDecisionRow,
	type QueueDetail,
	type QueueItem,
	type QueueLine,
	type QueueOption,
	type QueueSource,
	type QueueSourcePresence,
	type QueueStatus
} from '$lib/workspace/types';
import type { Validation } from '../rfq/schema.ts';

/** How many waiting items one page load reads. */
export const QUEUE_LIMIT = 100;

interface QueueRow {
	source: QueueSource;
	source_id: number;
	summary: string;
	subject_kind: 'account' | 'vendor' | null;
	subject_no: string | null;
	subject_name: string | null;
	value: number | null;
	created_by_id: number | null;
	created_by: string | null;
	created_via: 'person' | 'assistant' | 'agent';
	created_at: Date;
	row_version: Date;
	reviewer_id: number | null;
	status: QueueStatus;
}

export interface QueueFilters {
	/** Only this source, or every source. */
	source?: QueueSource | null;
	/** Only items about this account or vendor (its number). */
	subjectNo?: string | null;
}

/** Which of the four sources this database has. */
export async function queueSources(db: Db, userId: number): Promise<QueueSourcePresence> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ sources: Record<string, boolean> }>`select nl.agent_queue_sources() as sources`
	);
	const present = row?.sources ?? {};
	// Say false rather than undefined for anything the function did not name.
	return {
		rfq: present.rfq === true,
		assistant: present.assistant === true,
		mail: present.mail === true,
		purchase: present.purchase === true
	};
}

/**
 * The whole queue, newest first, with the detail behind each row.
 *
 * The filters are applied in SQL so a big queue does not travel to the server
 * only to be thrown away. "Newest first" is by when the agent made the
 * request, which is the order a person works through them.
 */
export async function listQueue(
	db: Db,
	user: { id: number },
	filters: QueueFilters = {}
): Promise<QueueItem[]> {
	const source = filters.source ?? null;
	const subjectNo = filters.subjectNo ?? null;

	return db.asUser(user.id, async (tx) => {
		const rows = await tx.sql<QueueRow>`
			select q.source, q.source_id, q.summary, q.subject_kind, q.subject_no, q.subject_name,
			       q.value, q.created_by_id, q.created_by, q.created_via, q.created_at,
			       q.row_version, q.reviewer_id, q.status
			from nl.agent_queue q
			where (${source}::text is null or q.source = ${source})
			  and (${subjectNo}::text is null or q.subject_no = ${subjectNo})
			order by q.created_at desc, q.source, q.source_id desc
			limit ${QUEUE_LIMIT}`;

		const details = await loadDetails(tx, rows);
		return rows.map((row) => ({
			source: row.source,
			sourceId: row.source_id,
			summary: row.summary,
			subjectKind: row.subject_kind,
			subjectNo: row.subject_no,
			subjectName: row.subject_name,
			value: row.value,
			createdById: row.created_by_id,
			createdBy: row.created_by ?? 'an agent',
			createdVia: row.created_via,
			createdAt: row.created_at.toISOString(),
			// ISO text keeps the millisecond the database stored, which is what
			// a decision has to send back.
			rowVersion: row.row_version.toISOString(),
			reviewerId: row.reviewer_id,
			status: row.status,
			needsYou: row.reviewer_id === user.id || row.created_by_id === user.id,
			detail: details.get(key(row.source, row.source_id)) ?? emptyDetail()
		}));
	});
}

// The counting and grouping live in $lib/workspace/summary.ts, because the
// page needs them too and nothing in $lib/server may reach the browser. They
// are re-exported here so the server side has one import for the queue.
export { countQueue, subjectsOf, type QueueCounts } from '$lib/workspace/summary';

// ---------------------------------------------------------------------------
// The detail behind each row
// ---------------------------------------------------------------------------

function key(source: QueueSource, id: number): string {
	return `${source}:${id}`;
}

function emptyDetail(): QueueDetail {
	return { facts: [], lines: [], options: [], neededBy: null, subject: null, body: null, href: null };
}

/**
 * One query per source that has rows on this page, rather than one per row.
 * Ids go in as a JSON array of numbers, which both drivers pass through as one
 * parameter (see db/types.ts).
 */
async function loadDetails(tx: Tx, rows: QueueRow[]): Promise<Map<string, QueueDetail>> {
	const out = new Map<string, QueueDetail>();
	const idsBySource = new Map<QueueSource, number[]>();
	for (const row of rows) {
		const list = idsBySource.get(row.source) ?? [];
		list.push(row.source_id);
		idsBySource.set(row.source, list);
	}

	for (const source of QUEUE_SOURCES) {
		const ids = idsBySource.get(source);
		if (!ids || ids.length === 0) continue;
		if (source === 'rfq') await rfqDetails(tx, ids, out);
		if (source === 'assistant') await assistantDetails(tx, ids, out);
		if (source === 'mail') await mailDetails(tx, ids, out);
		if (source === 'purchase') await genericDetails(tx, source, ids, out);
	}
	return out;
}

async function rfqDetails(tx: Tx, ids: number[], out: Map<string, QueueDetail>): Promise<void> {
	const rows = await tx.sql<{
		id: number;
		validation: Validation;
		source_name: string;
		extractor: string;
		needs_review: number;
	}>`
		select d.id, d.validation, d.source_name, d.extractor, d.needs_review
		from nl.rfq_drafts d
		where d.id in (select (value #>> '{}')::bigint from jsonb_array_elements(${JSON.stringify(ids)}::jsonb))`;

	for (const row of rows) {
		const v = row.validation;
		const lines: QueueLine[] = (v?.lines ?? [])
			.filter((line) => !line.removed)
			.map((line) => ({
				line: line.index,
				itemNo: line.item_no,
				description: line.description,
				quantity: line.quantity,
				unitPrice: line.unit_price,
				amount: line.line_total,
				needsReview:
					line.item_check?.status === 'needs_review' ||
					line.quantity_check?.status === 'needs_review' ||
					line.price_check?.status === 'needs_review'
			}));

		const facts: QueueFactList = [];
		if (v?.customer?.name) facts.push({ label: 'Account', value: v.customer.name });
		facts.push({ label: 'Read from', value: `${row.source_name} (${row.extractor} extractor)` });
		if (v?.needed_by?.text || v?.needed_by?.date) {
			facts.push({ label: 'Needed by', value: v.needed_by.date ?? v.needed_by.text ?? '' });
		}
		if (row.needs_review > 0) {
			facts.push({
				label: 'Still to settle',
				value: `${row.needs_review} ${row.needs_review === 1 ? 'field' : 'fields'}`
			});
		}
		for (const warning of v?.warnings ?? []) facts.push({ label: 'Worth knowing', value: warning });

		out.set(key('rfq', row.id), {
			facts,
			lines,
			options: [],
			neededBy: v?.needed_by?.date ?? null,
			subject: null,
			body: null,
			href: null
		});
	}
}

type QueueFactList = { label: string; value: string }[];

async function assistantDetails(tx: Tx, ids: number[], out: Map<string, QueueDetail>): Promise<void> {
	const rows = await tx.sql<{
		id: number;
		conversation_id: number;
		status: string;
		error: string | null;
		options: { label: string; tool: string; input: Record<string, unknown>; version?: string | null }[];
	}>`
		select p.id, p.conversation_id, p.status, p.error, p.options
		from nl.assistant_proposals p
		where p.id in (select (value #>> '{}')::bigint from jsonb_array_elements(${JSON.stringify(ids)}::jsonb))`;

	for (const row of rows) {
		const options: QueueOption[] = (row.options ?? []).map((option, index) => ({
			index,
			label: option.label,
			tool: option.tool,
			input: JSON.stringify(option.input, null, 2)
		}));
		const facts: QueueFactList = [
			{ label: 'From', value: `conversation ${row.conversation_id}` },
			{
				label: 'What it would run',
				value: [...new Set(options.map((o) => o.tool))].join(', ') || 'nothing'
			}
		];
		if (row.error) facts.push({ label: 'The last attempt failed', value: row.error });

		out.set(key('assistant', row.id), {
			facts,
			lines: [],
			options,
			neededBy: null,
			subject: null,
			body: null,
			href: null
		});
	}
}

/**
 * Mail drafts (migration 0021). The whole team may read these tables, so the
 * facts are the ones a reviewer needs: who it goes to, what the agent decided
 * the message was about, and every fact the body rests on, which is the list
 * the desk's own disclosure check ran over.
 */
async function mailDetails(tx: Tx, ids: number[], out: Map<string, QueueDetail>): Promise<void> {
	const rows = await tx.sql<{
		id: number;
		mailbox: string;
		subject: string;
		body: string;
		intent: string;
		to_addresses: string[];
		cc_addresses: string[];
		blocked_reason: string;
		in_reply_to_id: number | null;
		message_subject: string | null;
		facts: { kind?: string; subject?: string; text?: string }[];
		attachments: { name?: string; kind?: string }[];
	}>`
		select d.id, mb.label as mailbox, d.subject, d.body, d.intent, d.to_addresses, d.cc_addresses,
		       d.blocked_reason, d.in_reply_to_id, m.subject as message_subject, d.facts, d.attachments
		from nl.mail_drafts d
		join nl.mailboxes mb on mb.id = d.mailbox_id
		left join nl.mail_messages m on m.id = d.in_reply_to_id
		where d.id in (select (value #>> '{}')::bigint from jsonb_array_elements(${JSON.stringify(ids)}::jsonb))`;

	const INTENT_LABEL: Record<string, string> = {
		rfq: 'a request for a quote',
		purchase_order: 'a purchase order',
		price_question: 'a question about price',
		stock_question: 'a question about stock',
		order_status: 'a question about an order',
		other: 'something else'
	};

	for (const row of rows) {
		const facts: QueueFactList = [
			{ label: 'Desk', value: row.mailbox },
			{ label: 'To', value: row.to_addresses.join(', ') },
			{ label: 'About', value: INTENT_LABEL[row.intent] ?? row.intent }
		];
		if (row.cc_addresses.length > 0) facts.push({ label: 'Copied to', value: row.cc_addresses.join(', ') });
		if (row.message_subject) facts.push({ label: 'In reply to', value: row.message_subject });
		if (row.blocked_reason) facts.push({ label: 'The agent held this', value: row.blocked_reason });
		for (const attachment of row.attachments ?? []) {
			if (attachment.name) facts.push({ label: 'Attached', value: attachment.name });
		}
		// Every claim the reply makes, with what it was taken from.
		for (const fact of row.facts ?? []) {
			if (fact.text) facts.push({ label: `Rests on ${fact.kind ?? 'a fact'}`, value: fact.text });
		}

		out.set(key('mail', row.id), {
			facts,
			lines: [],
			options: [],
			neededBy: null,
			subject: row.subject,
			body: row.body,
			// The desk page lists a draft under the message it answers.
			href: row.in_reply_to_id === null ? '/desk' : `/desk/${row.in_reply_to_id}`
		});
	}
}

/**
 * Purchase requests (migration 0022), which is not in this database yet. Its
 * table belongs to another part of the project, so this takes only the columns
 * it can see and says nothing about the ones it cannot. Whatever is missing
 * simply does not appear. When that work lands, write this out the way
 * mailDetails above was once migration 0021 arrived.
 */
async function genericDetails(
	tx: Tx,
	source: 'purchase',
	ids: number[],
	out: Map<string, QueueDetail>
): Promise<void> {
	const [table] = await tx.sql<{ name: string | null }>`
		select nl.agent_queue_table('{purchase_requests,purchase_request_drafts}'::text[]) as name`;
	if (!table?.name) return;

	// The columns worth showing, if the table has them.
	const wanted = ['subject', 'body', 'summary', 'to_address', 'vendor_no', 'customer_no', 'reason'];
	const present = await tx.sql<{ attname: string }>`
		select a.attname
		from pg_catalog.pg_attribute a
		where a.attrelid = pg_catalog.to_regclass('nl.' || pg_catalog.quote_ident(${table.name}))
		  and a.attnum > 0 and not a.attisdropped
		  and a.attname in (select (value #>> '{}')::text from jsonb_array_elements(${JSON.stringify(wanted)}::jsonb))`;
	const columns = present.map((p) => p.attname);
	if (columns.length === 0) return;

	// The column list is built from names the catalog just returned, so it can
	// only ever be one of the seven above.
	const select = columns.map((c) => `d."${c}"`).join(', ');
	const rows = await tx.query<Record<string, unknown>>(
		`select d.id, ${select}
		 from nl."${table.name}" d
		 where d.id in (select (value #>> '{}')::bigint from jsonb_array_elements($1::jsonb))`,
		[JSON.stringify(ids)]
	);

	const LABELS: Record<string, string> = {
		subject: 'Subject',
		body: 'Body',
		summary: 'Summary',
		to_address: 'To',
		vendor_no: 'Vendor',
		customer_no: 'Account',
		reason: 'Why'
	};
	for (const row of rows) {
		const facts: QueueFactList = [];
		for (const column of columns) {
			// The body and the subject are shown on their own, editable.
			if (column === 'body' || column === 'subject') continue;
			const value = row[column];
			if (value === null || value === undefined || value === '') continue;
			facts.push({ label: LABELS[column] ?? column, value: String(value) });
		}
		out.set(key(source, Number(row.id)), {
			facts,
			lines: [],
			options: [],
			neededBy: null,
			subject: typeof row.subject === 'string' ? row.subject : null,
			body: typeof row.body === 'string' ? row.body : null,
			href: null
		});
	}
}

// ---------------------------------------------------------------------------
// The workspace's own history
// ---------------------------------------------------------------------------

/** Recent decisions, newest first. The whole team reads this. */
export async function listDecisions(db: Db, userId: number, limit = 30): Promise<QueueDecisionRow[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			id: number;
			source: QueueSource;
			source_id: number;
			decision: QueueDecisionRow['decision'];
			decided_by: number;
			decided_by_name: string;
			decided_at: Date;
			note: string;
		}>`
			select d.id, d.source, d.source_id, d.decision, d.decided_by,
			       u.full_name as decided_by_name, d.decided_at, d.note
			from nl.queue_decisions d
			join nl.users u on u.id = d.decided_by
			order by d.decided_at desc, d.id desc
			limit ${limit}`
	);
	return rows.map((row) => ({
		id: row.id,
		source: row.source,
		sourceId: row.source_id,
		decision: row.decision,
		decidedBy: row.decided_by_name,
		decidedById: row.decided_by,
		decidedAt: row.decided_at.toISOString(),
		note: row.note
	}));
}
