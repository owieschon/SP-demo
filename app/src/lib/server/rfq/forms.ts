// Form actions for the RFQ pages. Each one checks the form's shape with zod,
// calls the write, and turns a refusal from the database into a message the
// page can show (same pattern as ../forms.ts).
//
// Approve and reject read only the fields their schema names. Anything else a
// tampered form sends (a different item, a lower price, another customer) is
// dropped by zod before it gets anywhere near the database.
import { fail, type ActionFailure } from '@sveltejs/kit';
import type { SessionUser } from '$lib/types';
import type { Db } from '../db/types.ts';
import { readRequest, type StoredFile } from '../documents/read.ts';
import { nameOf } from '../documents/request.ts';
import type { ParsedDocument } from '../documents/types.ts';
import { toAppError } from '../errors.ts';
import { approveDraft, approveInput, rejectDraft, rejectInput, reviseDraft, reviseInput, type DraftWriteResult } from './drafts.ts';

export type RfqFormFailure = { message: string; conflict?: boolean };

/** More than this in the paste box is not an email anybody typed. */
export const MAX_PASTE_CHARS = 200_000;

async function run(
	work: () => Promise<DraftWriteResult>,
	done: (result: DraftWriteResult) => string
): Promise<({ message: string } & DraftWriteResult) | ActionFailure<RfqFormFailure>> {
	try {
		const result = await work();
		return { ...result, message: done(result) };
	} catch (error) {
		const refusal = toAppError(error);
		if (!refusal) throw error;
		return fail(refusal.status, { message: refusal.message, conflict: refusal.status === 409 });
	}
}

function formObject(data: FormData): Record<string, string> {
	// Files are never part of these forms; keep text fields only.
	const out: Record<string, string> = {};
	for (const [key, value] of data) {
		if (typeof value === 'string') out[key] = value;
	}
	return out;
}

export async function reviseAction(db: Db, user: SessionUser, request: Request) {
	const parsed = reviseInput.safeParse(formObject(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'That change is not valid. Check the value and try again.' } satisfies RfqFormFailure);
	}
	return run(
		() => reviseDraft(db, user.id, parsed.data),
		() => 'Saved and checked again.'
	);
}

export async function approveAction(db: Db, user: SessionUser, request: Request) {
	const parsed = approveInput.safeParse(formObject(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Reload the draft and approve again.' } satisfies RfqFormFailure);
	}
	return run(
		() => approveDraft(db, user.id, parsed.data),
		(r) => `Approved. Quote SQ-${r.quoteId} and commitment C-${r.commitmentId} were created.`
	);
}

export async function rejectAction(db: Db, user: SessionUser, request: Request) {
	const parsed = rejectInput.safeParse(formObject(await request.formData()));
	if (!parsed.success) {
		return fail(400, { message: 'Reload the draft and reject again.' } satisfies RfqFormFailure);
	}
	return run(
		() => rejectDraft(db, user.id, parsed.data),
		() => 'Rejected. Nothing was created.'
	);
}

/**
 * The request from the intake form: whatever was pasted, plus every file
 * that was attached, each read by the reader for its format (see
 * ../documents/read.ts).
 *
 * A file that cannot be read stops the whole submission, and the page lists
 * every reason at once. Half a request is worse than none: a quote missing
 * the lines that were on the PDF nobody could read is a quote that goes out
 * wrong.
 */
export async function requestFromForm(
	data: FormData
): Promise<
	| { ok: true; documents: ParsedDocument[]; stored: StoredFile[]; sourceName: string }
	| { ok: false; message: string }
> {
	const paste = data.get('email');
	const pasted = typeof paste === 'string' ? paste : '';
	if (pasted.length > MAX_PASTE_CHARS) {
		return { ok: false, message: `That email is longer than ${MAX_PASTE_CHARS.toLocaleString('en-US')} characters.` };
	}

	const files = data.getAll('files').filter((value): value is File => value instanceof File && value.size > 0);
	if (pasted.trim() === '' && files.length === 0) {
		return {
			ok: false,
			message: 'Paste an email, attach a .txt, .eml, .pdf, .xlsx, .xls or .csv file, or load a sample.'
		};
	}

	const read = await readRequest({ paste: pasted, files });
	if (read.problems.length > 0) {
		return { ok: false, message: read.problems.join(' ') };
	}
	if (read.documents.length === 0) {
		return { ok: false, message: 'Nothing could be read out of that. Paste the request as text instead.' };
	}

	// A sample loaded from the list keeps its name, which is what the drafts
	// list shows.
	const sample = data.get('sampleName');
	const sourceName =
		read.stored.length === 0 && typeof sample === 'string' && sample ? sample : nameOf(read.documents);
	return { ok: true, documents: read.documents, stored: read.stored, sourceName };
}
