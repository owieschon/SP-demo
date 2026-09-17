// Attachments in the database: store them, list them, hand one back.
//
// The bytes travel as base64 text in both directions. That is not about
// size; it is because base64 is an ordinary text parameter, so the Supabase
// driver and PGlite treat it identically and neither one guesses a type
// (the same reasoning as the jsonb parameters, see DECISIONS.md).
//
// Every read runs as the signed-in user, so row-level security decides what
// is visible: an attachment belongs to its draft, and a draft belongs to the
// person who made it or to an admin. Another person asking for the same
// attachment id gets nothing back, which the route turns into a 404.
import type { Db, Tx } from '../db/types.ts';
import { guarded } from '../errors.ts';
import type { StoredFile } from './read.ts';
import type { StoredKind } from './types.ts';

export interface AttachmentSummary {
	id: number;
	draftId: number;
	ordinal: number;
	fileName: string;
	kind: StoredKind;
	mediaType: string;
	byteSize: number;
	sha256: string;
	pageCount: number | null;
	sheetCount: number | null;
	rowCount: number | null;
	/** "3 sheets, 42 rows". */
	summary: string;
	createdAt: string;
}

interface IndexRow {
	id: number;
	draft_id: number;
	ordinal: number;
	file_name: string;
	kind: StoredKind;
	media_type: string;
	byte_size: number;
	sha256: string;
	page_count: number | null;
	sheet_count: number | null;
	row_count: number | null;
	summary: string;
	created_at: Date;
}

function toSummary(row: IndexRow): AttachmentSummary {
	return {
		id: row.id,
		draftId: row.draft_id,
		ordinal: row.ordinal,
		fileName: row.file_name,
		kind: row.kind,
		mediaType: row.media_type,
		byteSize: row.byte_size,
		sha256: row.sha256,
		pageCount: row.page_count,
		sheetCount: row.sheet_count,
		rowCount: row.row_count,
		summary: row.summary,
		createdAt: row.created_at.toISOString()
	};
}

const INDEX_COLUMNS = `
	a.id, a.draft_id, a.ordinal, a.file_name, a.kind, a.media_type, a.byte_size, a.sha256,
	a.page_count, a.sheet_count, a.row_count, a.summary, a.created_at`;

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export interface SaveAttachmentsResult {
	stored: number;
	/** Files already held by this draft, which were not stored again. */
	duplicates: number;
}

/**
 * Store a draft's files. Runs inside the transaction that made the draft, so
 * a draft and its attachments arrive together or not at all.
 *
 * Each file gets its own request id, derived from the page's: sending the
 * same form twice replays the same ids and writes once.
 */
export async function saveAttachments(
	tx: Tx,
	draftId: number,
	files: StoredFile[],
	requestId: string
): Promise<SaveAttachmentsResult> {
	let stored = 0;
	let duplicates = 0;
	for (const file of files) {
		const [row] = await tx.sql<{ result: { attachment_id: number; duplicate: boolean } }>`
			select nl.add_rfq_attachment(
				${draftId}, ${file.ordinal}, ${file.fileName}, ${file.kind}, ${file.mediaType},
				${Buffer.from(file.bytes).toString('base64')}, ${file.sha256},
				${file.pageCount}, ${file.sheetCount}, ${file.rowCount}, ${file.summary},
				${`${requestId}-a${file.ordinal}`}) as result`;
		if (row.result.duplicate) duplicates += 1;
		else stored += 1;
	}
	return { stored, duplicates };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** A draft's attachments, in the order they were uploaded. Never the bytes. */
export async function listAttachments(db: Db, userId: number, draftId: number): Promise<AttachmentSummary[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<IndexRow>(
			`select ${INDEX_COLUMNS}
			 from nl.rfq_attachment_index a
			 where a.draft_id = $1
			 order by a.ordinal`,
			[draftId]
		)
	);
	return rows.map(toSummary);
}

/** The same list, inside a transaction that is already open. */
export async function listAttachmentsIn(tx: Tx, draftId: number): Promise<AttachmentSummary[]> {
	const rows = await tx.query<IndexRow>(
		`select ${INDEX_COLUMNS}
		 from nl.rfq_attachment_index a
		 where a.draft_id = $1
		 order by a.ordinal`,
		[draftId]
	);
	return rows.map(toSummary);
}

export interface AttachmentFile extends AttachmentSummary {
	bytes: Buffer;
}

/**
 * One attachment with its bytes, or null when this person may not see it.
 * The draft id is part of the lookup so a mistyped URL cannot wander into
 * another draft's file even when both belong to the same person.
 */
export async function readAttachment(
	db: Db,
	userId: number,
	draftId: number,
	attachmentId: number
): Promise<AttachmentFile | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.query<IndexRow & { bytes_b64: string }>(
			`select ${INDEX_COLUMNS}, encode(a.bytes, 'base64') as bytes_b64
			 from nl.rfq_attachments a
			 where a.id = $1 and a.draft_id = $2`,
			[attachmentId, draftId]
		)
	);
	if (!row) return null;
	return { ...toSummary(row), bytes: Buffer.from(row.bytes_b64, 'base64') };
}

/**
 * Drafts of this person's that already hold a file with these bytes. Used to
 * tell them "you read this same file into R-7003 on Tuesday" instead of
 * quietly making a second draft of the same request.
 */
export async function draftsHolding(db: Db, userId: number, hashes: string[]): Promise<Map<string, number>> {
	if (hashes.length === 0) return new Map();
	const rows = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.query<{ sha256: string; draft_id: number }>(
				`select a.sha256, min(a.draft_id)::int as draft_id
				 from nl.rfq_attachment_index a
				 where a.sha256 in (select value from jsonb_array_elements_text($1::jsonb))
				 group by a.sha256`,
				[JSON.stringify(hashes)]
			)
		)
	);
	return new Map(rows.map((r) => [r.sha256, r.draft_id]));
}
