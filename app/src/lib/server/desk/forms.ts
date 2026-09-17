// The form actions behind the review queue. Each one checks the form's shape
// with zod, calls the write, and turns a refusal from the database into a
// message the page can show.
//
// Approving and sending are two steps on purpose. The approval is the
// person's decision and it is recorded whatever happens next; the send is a
// call to somebody else's server that can fail. A failed send therefore
// leaves an approved draft with the provider's own words on it, and the
// button says "Try sending again" rather than asking for the decision twice.
import { fail, type ActionFailure } from '@sveltejs/kit';
import type { Db } from '../db/types.ts';
import { toAppError } from '../errors.ts';
import type { MailClient } from './mail.ts';
import { sendApproved, type Allowlist } from './send.ts';
import { approveDraft, approveInput, rejectDraft, rejectInput } from './writes.ts';

export type DeskFormFailure = { message: string; conflict?: boolean };

export interface DeskFormResult {
	message: string;
	sent?: boolean;
	simulated?: boolean;
}

function refuse(error: unknown): ActionFailure<DeskFormFailure> {
	const refusal = toAppError(error);
	if (!refusal) throw error;
	return fail(refusal.status, { message: refusal.message, conflict: refusal.status === 409 });
}

/**
 * Approve a draft and send it. `send=false` records the approval and stops,
 * which is what the retry button and the "approve only" path use.
 */
export async function approveAction(
	db: Db,
	userId: number,
	form: FormData,
	options: { client: MailClient; allowlist: Allowlist; send: boolean }
): Promise<DeskFormResult | ActionFailure<DeskFormFailure>> {
	const parsed = approveInput.safeParse(Object.fromEntries(form));
	if (!parsed.success) {
		return fail(400, { message: 'That approval was missing something. Reload the page and try again.' });
	}
	const input = parsed.data;

	try {
		await approveDraft(db, userId, input);
	} catch (error) {
		return refuse(error);
	}

	if (!options.send) {
		return { message: `Draft M-${input.draftId} is approved. Nothing has been sent yet.` };
	}

	try {
		const sent = await sendApproved(db, userId, input.draftId, options);
		return {
			message: sent.simulated
				? `Approved. Nothing was actually sent: this server has no mail key, so the send was simulated (${sent.providerMessageId}).`
				: `Approved and sent as ${sent.providerMessageId}.`,
			sent: true,
			simulated: sent.simulated
		};
	} catch (error) {
		return refuse(error);
	}
}

/** Try an approved draft again after a failed send. */
export async function retryAction(
	db: Db,
	userId: number,
	form: FormData,
	options: { client: MailClient; allowlist: Allowlist }
): Promise<DeskFormResult | ActionFailure<DeskFormFailure>> {
	const draftId = Number(form.get('draftId'));
	if (!Number.isSafeInteger(draftId) || draftId <= 0) {
		return fail(400, { message: 'That draft id does not look right.' });
	}
	try {
		const sent = await sendApproved(db, userId, draftId, options);
		return {
			message: sent.alreadySent
				? `Draft M-${draftId} had already gone out as ${sent.providerMessageId}.`
				: sent.simulated
					? `Simulated send recorded (${sent.providerMessageId}). Nothing left the building.`
					: `Sent as ${sent.providerMessageId}.`,
			sent: true,
			simulated: sent.simulated
		};
	} catch (error) {
		return refuse(error);
	}
}

export async function rejectAction(
	db: Db,
	userId: number,
	form: FormData
): Promise<DeskFormResult | ActionFailure<DeskFormFailure>> {
	const parsed = rejectInput.safeParse(Object.fromEntries(form));
	if (!parsed.success) {
		return fail(400, { message: 'That rejection was missing something. Reload the page and try again.' });
	}
	try {
		await rejectDraft(db, userId, parsed.data);
		return { message: `Draft M-${parsed.data.draftId} is rejected and will not be sent.` };
	} catch (error) {
		return refuse(error);
	}
}
