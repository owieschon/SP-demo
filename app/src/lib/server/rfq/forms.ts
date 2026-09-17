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
import { toAppError } from '../errors.ts';
import { approveDraft, approveInput, rejectDraft, rejectInput, reviseDraft, reviseInput, type DraftWriteResult } from './drafts.ts';

export type RfqFormFailure = { message: string; conflict?: boolean };

/** Uploads bigger than this are not emails anyone pastes by hand. */
export const MAX_UPLOAD_BYTES = 200_000;

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
 * The email from the intake form: an uploaded .txt or .eml file wins over the
 * paste box. PDFs and other files are refused with a plain reason.
 */
export async function emailFromForm(
	data: FormData
): Promise<{ ok: true; text: string; name: string } | { ok: false; message: string }> {
	const file = data.get('file');
	if (file instanceof File && file.size > 0) {
		const name = file.name || 'upload';
		if (/\.pdf$/i.test(name) || file.type === 'application/pdf') {
			return { ok: false, message: 'PDF attachments are not supported yet. Paste the email text instead.' };
		}
		if (!/\.(txt|eml)$/i.test(name)) {
			return { ok: false, message: 'Upload a .txt or .eml file, or paste the email text.' };
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			return { ok: false, message: 'That file is larger than 200 KB. Paste the part of the email that matters.' };
		}
		return { ok: true, text: await file.text(), name };
	}
	const text = data.get('email');
	if (typeof text === 'string' && text.trim().length > 0) {
		if (text.length > MAX_UPLOAD_BYTES) {
			return { ok: false, message: 'That email is longer than 200,000 characters.' };
		}
		const sample = data.get('sampleName');
		return { ok: true, text, name: typeof sample === 'string' && sample ? sample : 'pasted email' };
	}
	return { ok: false, message: 'Paste an email, upload a .txt or .eml file, or load a sample.' };
}
