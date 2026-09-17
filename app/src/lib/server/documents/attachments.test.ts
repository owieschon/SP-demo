// Documents against a real database: storing what a customer sent, who may
// read it back, and the quote that goes out the other side.
//
// The world is the small test world with the eval customers and parts loaded
// on top (evals/rfq/world.json), and "today" is pinned to 2026-09-17, the
// same setup ../rfq/rfq.test.ts uses. The request files are the committed
// fixtures in fixtures/rfq/.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractText } from 'unpdf';
import { findDbDir } from '../db/files.ts';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { approveDraft, createDraft, getDraft, listDrafts, type DraftView } from '../rfq/drafts.ts';
import { loadEvalWorld } from '../rfq/evals.ts';
import type { Validation } from '../rfq/schema.ts';
import { quoteMail } from './mailto.ts';
import { loadDraftQuoteDoc, loadQuoteDoc, storedSubtotal } from './quote.ts';
import { quotePdf } from './quotePdf.ts';
import { readRequest, readUploadedFile, type StoredFile } from './read.ts';
import { draftsHolding, listAttachments, readAttachment, saveAttachments } from './store.ts';
import { extractRequest } from './request.ts';

const ADMIN = 1;
const DANA = 2;
const MARCUS = 3;
const TODAY = '2026-09-17';

const FIXTURES = resolve(findDbDir(), '..', 'fixtures', 'rfq');
const bytesOf = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

function upload(name: string, bytes: Uint8Array = bytesOf(name)): File {
	const buffer = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buffer).set(bytes);
	return new File([buffer], name);
}

/** The covering email both the spreadsheet and the text request arrive with. */
const COVER = [
	'From: Cameron Kowalski <cameron.kowalski@coastalpartsdepot.example>',
	'To: quotes@northline.example',
	'Subject: Quote request, two builds',
	'Date: Wed, 16 Sep 2026 09:12:00 -0500',
	'',
	'Please quote the attached list. Ship to our Houston counter.',
	'',
	'Thanks,',
	'Cameron Kowalski',
	'Coastal Parts Depot',
	'Houston, TX'
].join('\n');

const CSV_COVER = [
	'From: Micah Crowley <micah.crowley@driftlessmachinefab.example>',
	'Subject: parts list',
	'Date: Wed, 16 Sep 2026 14:02:00 -0500',
	'',
	'Here is the list for the next release. Please quote.',
	'',
	'Thanks,',
	'Micah Crowley',
	'Driftless Machine & Fab'
].join('\n');

let db: Db;

beforeAll(async () => {
	db = await createTestDb({ today: TODAY });
	await loadEvalWorld(db);
});

afterAll(async () => {
	await db?.close();
});

/** Read a request the way the intake page does, and store the draft. */
async function intake(userId: number, paste: string | null, files: File[]): Promise<DraftView> {
	const read = await readRequest({ paste, files });
	expect(read.problems).toEqual([]);
	const extraction = await extractRequest(read.documents, { mode: 'rules', today: TODAY });
	const { draftId } = await createDraft(db, userId, {
		source: extraction.sourceText,
		sourceName: files.length > 0 ? files[0].name : 'pasted email',
		extraction,
		attachments: read.stored,
		requestId: randomUUID()
	});
	const draft = await getDraft(db, userId, draftId);
	if (!draft) throw new Error(`draft R-${draftId} was not readable after being written`);
	return draft;
}

/** What would actually be quoted: the customer, the lines and the total. */
function quotable(validation: Validation) {
	return {
		customer: validation.customer.customer_no,
		lines: validation.lines
			.filter((line) => !line.removed)
			.map((line) => ({ itemNo: line.item_no, quantity: line.quantity, unitPrice: line.unit_price })),
		subtotal: validation.totals.subtotal,
		needsReview: validation.needs_review
	};
}

// ---------------------------------------------------------------------------
// A spreadsheet request, end to end
// ---------------------------------------------------------------------------

describe('a spreadsheet request', () => {
	let draft: DraftView;

	beforeAll(async () => {
		draft = await intake(DANA, COVER, [upload('emailed-spreadsheet-request.xlsx')]);
	});

	it('resolves the customer from the covering email and the parts from the sheet', () => {
		const v = draft.validation;
		expect(v.customer.customer_no).toBe('10072');
		expect(v.customer.name).toBe('Coastal Parts Depot');
		expect(v.customer.contact_name).toBe('Cameron Kowalski');
		expect(v.lines.map((line) => line.item_no)).toEqual([
			'S6-96BC',
			'CL6SZ',
			'FL6-36SS',
			'L660-1018SC',
			'HS6-30S'
		]);
		expect(v.lines.map((line) => line.quantity)).toEqual([4, 12, 2, 6, 3]);
	});

	it('keeps the sheet and row every line came from', () => {
		expect(draft.draft.lines.map((line) => line.source)).toEqual([
			'attachment 1, sheet Quote Request, row 5',
			'attachment 1, sheet Quote Request, row 6',
			'attachment 1, sheet Quote Request, row 7',
			'attachment 1, sheet Quote Request, row 8',
			'attachment 1, sheet Quote Request, row 9'
		]);
	});

	it('needs nothing reviewed: their prices are ours and the dates are ahead', () => {
		expect(draft.validation.needs_review).toBe(0);
		expect(draft.validation.totals.stated_subtotal).toBe(1898.04);
		expect(draft.validation.totals.subtotal).toBe(1898.04);
	});

	it('stores the file, with what was read out of it', async () => {
		const files = await listAttachments(db, DANA, draft.id);
		expect(files).toHaveLength(1);
		expect(files[0].fileName).toBe('emailed-spreadsheet-request.xlsx');
		expect(files[0].kind).toBe('xlsx');
		expect(files[0].mediaType).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
		expect(files[0].sheetCount).toBe(3);
		expect(files[0].rowCount).toBe(5);
		expect(files[0].summary).toBe('3 sheets, 5 rows');
		expect(files[0].byteSize).toBe(bytesOf('emailed-spreadsheet-request.xlsx').byteLength);
	});

	it('hands the bytes back to its owner, unchanged', async () => {
		const [file] = await listAttachments(db, DANA, draft.id);
		const got = await readAttachment(db, DANA, draft.id, file.id);
		expect(got).not.toBeNull();
		expect(got!.bytes.byteLength).toBe(file.byteSize);
		expect(Buffer.from(bytesOf('emailed-spreadsheet-request.xlsx')).equals(got!.bytes)).toBe(true);
		// The type served is the one that was stored, decided from the bytes.
		expect(got!.mediaType).toBe(file.mediaType);
	});

	it('hides it from everybody else, and shows it to an admin', async () => {
		const [file] = await listAttachments(db, DANA, draft.id);
		// Another account manager gets nothing back, which the route answers
		// as a 404: the same answer a file that does not exist gets.
		expect(await readAttachment(db, MARCUS, draft.id, file.id)).toBeNull();
		expect(await listAttachments(db, MARCUS, draft.id)).toEqual([]);
		expect(await readAttachment(db, ADMIN, draft.id, file.id)).not.toBeNull();
	});

	it('counts the file on the drafts list', async () => {
		const drafts = await listDrafts(db, DANA);
		const mine = drafts.find((d) => d.id === draft.id);
		expect(mine?.attachments).toBe(1);
	});

	it('recognizes the same file if it comes round again', async () => {
		const { stored } = await readUploadedFile(upload('emailed-spreadsheet-request.xlsx'), 1);
		const held = await draftsHolding(db, DANA, [stored.sha256]);
		expect(held.get(stored.sha256)).toBe(draft.id);
		// Somebody else's draft is not somebody else's business.
		expect(await draftsHolding(db, MARCUS, [stored.sha256])).toEqual(new Map());
	});

	it('reads the same request the same way when it is pasted as text instead', async () => {
		const asText = await intake(DANA, COVER, [upload('emailed-spreadsheet-request.txt')]);
		expect(quotable(asText.validation)).toEqual(quotable(draft.validation));
		// The text one has no sheet, so its lines name a line of the file.
		expect(asText.draft.lines[0].source).toBe('attachment 1, line 2');
	});
});

// ---------------------------------------------------------------------------
// The caps, enforced in the database as well as in the reader
// ---------------------------------------------------------------------------

describe('the caps on a draft', () => {
	/** Four readable CSV files that differ by one byte, plus a fifth. */
	async function copies(count: number): Promise<StoredFile[]> {
		const base = bytesOf('parts-list.csv');
		const files: StoredFile[] = [];
		for (let n = 0; n < count; n++) {
			const copy = new Uint8Array(base);
			copy[copy.length - 1] = 0x20 + n;
			const { stored } = await readUploadedFile(upload(`list-${n}.csv`, copy), n + 1);
			files.push(stored);
		}
		return files;
	}

	it('refuses a fifth file, in the database, whatever the page did', async () => {
		const draft = await intake(DANA, 'Please quote these.', []);
		const five = await copies(5);
		await expect(
			db.asUser(DANA, (tx) => saveAttachments(tx, draft.id, five, randomUUID()))
		).rejects.toThrow(/four files/);

		// The four that fit were written; the transaction that failed was the
		// caller's, so nothing here is left half done in a real request.
		const kept = await db.asUser(DANA, (tx) => saveAttachments(tx, draft.id, five.slice(0, 4), randomUUID()));
		expect(kept.stored).toBe(4);
	});

	it('recognizes the same bytes twice and writes them once', async () => {
		const draft = await intake(DANA, 'Please quote these too.', []);
		const [one] = await copies(1);
		const first = await db.asUser(DANA, (tx) => saveAttachments(tx, draft.id, [one], randomUUID()));
		expect(first).toEqual({ stored: 1, duplicates: 0 });

		const again = await db.asUser(DANA, (tx) => saveAttachments(tx, draft.id, [one], randomUUID()));
		expect(again).toEqual({ stored: 0, duplicates: 1 });
		expect(await listAttachments(db, DANA, draft.id)).toHaveLength(1);
	});

	it('will not let anyone add a file to a draft that is not theirs', async () => {
		const draft = await intake(DANA, 'Mine, not yours.', []);
		const [one] = await copies(1);
		await expect(
			db.asUser(MARCUS, (tx) => saveAttachments(tx, draft.id, [one], randomUUID()))
		).rejects.toThrow(/does not exist/);
	});
});

// ---------------------------------------------------------------------------
// The quote that goes out
// ---------------------------------------------------------------------------

describe('a CSV request, approved into a quote', () => {
	let draft: DraftView;
	let quoteId: number;

	beforeAll(async () => {
		draft = await intake(DANA, CSV_COVER, [upload('parts-list.csv')]);
		expect(draft.validation.needs_review).toBe(0);
		const result = await approveDraft(db, DANA, {
			draftId: draft.id,
			expectedUpdatedAt: draft.updatedAt,
			requestId: randomUUID()
		});
		quoteId = result.quoteId!;
	});

	it('quotes the parts the CSV listed, at our prices', async () => {
		const doc = await loadQuoteDoc(db, DANA, quoteId);
		expect(doc).not.toBeNull();
		expect(doc!.customerNo).toBe('10012');
		expect(doc!.customerName).toBe('Driftless Machine & Fab');
		expect(doc!.buyerName).toBe('Micah Crowley');
		expect(doc!.lines.map((line) => line.itemNo)).toEqual(['P6-60CX', 'CL7BZ', 'HS8-36C']);
		expect(doc!.lines.map((line) => line.quantity)).toEqual([10, 24, 3]);
		expect(doc!.validUntil).toBe('2026-10-17');
	});

	it('shows the same total the database derives', async () => {
		const doc = await loadQuoteDoc(db, DANA, quoteId);
		// The page reads loadQuoteDoc; nl.quote_document sums the lines in SQL.
		// The two are worked out separately and must agree to the cent.
		expect(doc!.subtotal).toBe(await storedSubtotal(db, DANA, quoteId));
		expect(doc!.subtotal).toBe(draft.validation.totals.subtotal);
	});

	it('draws a PDF that reads back with the same parts, quantities and total', async () => {
		const doc = (await loadQuoteDoc(db, DANA, quoteId))!;
		const bytes = await quotePdf(doc);
		expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');

		const { text } = await extractText(new Uint8Array(bytes), { mergePages: true });
		const flat = text.replace(/\s+/g, ' ');
		expect(flat).toContain(String(quoteId));
		expect(flat).toContain('Driftless Machine & Fab');
		for (const line of doc.lines) {
			expect(flat, line.itemNo).toContain(line.itemNo);
			expect(flat, `${line.itemNo} qty`).toContain(String(line.quantity));
		}
		const money = new Intl.NumberFormat('en-US', {
			style: 'currency',
			currency: 'USD',
			minimumFractionDigits: 2
		});
		expect(flat).toContain(money.format(doc.subtotal));
	});

	it('writes an email addressed to the buyer, with the same total', async () => {
		const doc = (await loadQuoteDoc(db, DANA, quoteId))!;
		const mail = quoteMail(doc);
		expect(mail.to).toBe('micah.crowley@driftlessmachinefab.example');
		expect(mail.subject).toContain(`Quote ${quoteId}`);
		expect(mail.subject).toContain('for 3 parts');
		expect(mail.body).toContain('P6-60CX');
		expect(mail.body).toContain('The quote PDF is attached.');
		expect(mail.href).toContain('mailto:micah.crowley@driftlessmachinefab.example?');
	});

	it('leaves nothing for a stranger to read', async () => {
		// Quotes are readable by anyone signed in (migration 0003); the draft
		// they came from is not.
		expect(await loadQuoteDoc(db, MARCUS, quoteId)).not.toBeNull();
		expect(await getDraft(db, MARCUS, draft.id)).toBeNull();
	});
});

describe('a draft quote, before anyone approves it', () => {
	it('shows the numbers the review page shows', async () => {
		const draft = await intake(DANA, CSV_COVER, [upload('parts-list.csv')]);
		const doc = await loadDraftQuoteDoc(db, DANA, draft);
		expect(doc).not.toBeNull();
		expect(doc!.kind).toBe('draft');
		expect(doc!.reference).toBe(`R-${draft.id}`);
		expect(doc!.quoteId).toBeNull();
		expect(doc!.quotedOn).toBe(TODAY);
		expect(doc!.validUntil).toBe('2026-10-17');
		expect(doc!.subtotal).toBe(draft.validation.totals.subtotal);
		expect(doc!.lines.map((line) => line.itemNo)).toEqual(['P6-60CX', 'CL7BZ', 'HS8-36C']);

		const { text } = await extractText(new Uint8Array(await quotePdf(doc!)), { mergePages: true });
		const flat = text.replace(/\s+/g, ' ');
		expect(flat).toContain('DRAFT QUOTE');
		expect(flat).toContain('has not been approved');
	});

	it('is nothing at all until a customer is settled', async () => {
		// No sender, no company: the customer cannot be resolved, so there is
		// nothing to quote and the page offers no PDF.
		const draft = await intake(DANA, 'Please quote 4 S6-96BC.', []);
		expect(draft.validation.customer.customer_no).toBeNull();
		expect(await loadDraftQuoteDoc(db, DANA, draft)).toBeNull();
	});
});
