import { randomUUID } from 'node:crypto';
import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import {
	decideExport,
	decisionInput,
	getOperationsBoard,
	getSnapshotReview,
	latestPendingSnapshotId,
	MAX_FILE_BYTES,
	uploadExport
} from '$lib/server/exports/snapshots';
import { SAMPLE_KINDS, type UploadOutcome } from '$lib/components/exports/types';
import type { Actions, PageServerLoad } from './$types';

// Workflow D: the daily ERP export. Upload a file, look at what it would
// change, then apply, release or discard it. The board underneath shows the
// live open lines.
export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();

	// ?snapshot=N opens that snapshot; otherwise the newest one still waiting
	// for a decision, if there is one.
	const asked = url.searchParams.get('snapshot');
	const snapshotId = asked === null ? await latestPendingSnapshotId(db, user.id) : Number(asked);
	const review =
		snapshotId !== null && Number.isSafeInteger(snapshotId) && snapshotId > 0
			? await getSnapshotReview(db, user.id, snapshotId)
			: null;
	if (asked !== null && !review) error(404, `Snapshot ${asked} does not exist.`);

	return {
		review,
		// Not awaited on purpose: the page arrives first, the board streams in.
		board: getOperationsBoard(db, user.id),
		canRunImports: user.role !== 'account_manager',
		// Fresh ids for each form on this page load. Sending the same form
		// twice sends the same id, so the database writes once.
		requestIds: { upload: randomUUID(), decide: randomUUID() },
		samples: SAMPLE_KINDS,
		maxBytes: MAX_FILE_BYTES,
		year: new Date().getFullYear()
	};
};

// Each action says where its answer came from, so the page shows it in the right place.
type UploadFailure = { from: 'upload'; message: string; upload?: UploadOutcome };

export const actions: Actions = {
	upload: async ({ locals, request }) => {
		const form = await request.formData();
		const file = form.get('file');
		const requestId = String(form.get('requestId') ?? '');

		if (requestId.length < 8 || requestId.length > 100) {
			return fail(400, { from: 'upload', message: 'The form is out of date. Reload the page and try again.' } satisfies UploadFailure);
		}
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { from: 'upload', message: 'Choose a CSV file to upload.' } satisfies UploadFailure);
		}
		if (file.size > MAX_FILE_BYTES) {
			return fail(413, {
				from: 'upload',
				message: `That file is ${(file.size / 1_000_000).toFixed(1)} MB. An open lines export is well under ${MAX_FILE_BYTES / 1_000_000} MB; is it the right file?`
			} satisfies UploadFailure);
		}
		const text = await file.text();
		// A spreadsheet saved as .xlsx, or any other binary file, has zero bytes in it.
		if (text.includes(String.fromCharCode(0))) {
			return fail(422, {
				from: 'upload',
				message: 'That is not a text file. Export the report as CSV, or save the spreadsheet as CSV first.'
			} satisfies UploadFailure);
		}

		let outcome: UploadOutcome;
		try {
			outcome = await uploadExport(await getDb(), locals.user!.id, { name: file.name, text }, requestId);
		} catch (err) {
			const refusal = toAppError(err);
			if (!refusal) throw err;
			return fail(refusal.status, { from: 'upload', message: refusal.message } satisfies UploadFailure);
		}

		if (outcome.kind === 'refused') {
			return fail(422, { from: 'upload', message: outcome.refusal.message, upload: outcome } satisfies UploadFailure);
		}
		if (outcome.kind === 'duplicate') return { from: 'upload' as const, message: '', upload: outcome };
		// Staged: open it. The redirect also hands the page fresh request ids.
		redirect(303, `/operations?snapshot=${outcome.snapshotId}`);
	},

	decide: async ({ locals, request }) => {
		const parsed = decisionInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return fail(400, {
				from: 'decide' as const,
				message: parsed.error.issues[0]?.message ?? 'Something in the form is missing.',
				failed: true,
				conflict: false
			});
		}
		const input = parsed.data;
		try {
			const result = await decideExport(await getDb(), locals.user!.id, input);
			const s = result.summary;
			const message =
				input.decision === 'discard'
					? `Discarded snapshot ${input.snapshotId}. Nothing changed in the live data.`
					: `${input.decision === 'release' ? 'Released' : 'Applied'} snapshot ${input.snapshotId}: ` +
						`${s?.added ?? 0} new, ${s?.changed ?? 0} changed, ${s?.removed ?? 0} gone.`;
			return { from: 'decide' as const, message, failed: false, conflict: false };
		} catch (err) {
			const refusal = toAppError(err);
			if (!refusal) throw err;
			return fail(refusal.status, {
				from: 'decide' as const,
				message: refusal.message,
				failed: true,
				conflict: refusal.status === 409
			});
		}
	}
};
