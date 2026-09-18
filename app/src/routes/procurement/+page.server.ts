import { randomUUID } from 'node:crypto';
import { fail, type ActionFailure } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { getProcurementDesk } from '$lib/server/procurement/desk';
import {
	approveInput,
	approvePurchaseRequest,
	draftInput,
	draftPurchaseRequests,
	setLineInput,
	setRequestLine,
	sweepInput,
	sweepSignals
} from '$lib/server/procurement/requests';
import type { Actions, PageServerLoad } from './$types';

// The procurement desk. Everything on the page is derived in SQL (migration
// 0022); the four actions below are the only writes.
export const load: PageServerLoad = async ({ locals }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();

	return {
		// Not awaited on purpose: the page arrives first and the desk streams
		// in behind it. The buying list reads the whole catalog, so it is the
		// slowest thing on the page by a long way.
		desk: getProcurementDesk(db, user.id),
		canBuy: user.role !== 'account_manager',
		// Fresh ids for each form on this page load. Sending the same form
		// twice sends the same id, so the database writes once.
		requestIds: {
			sweep: randomUUID(),
			draft: randomUUID(),
			line: randomUUID(),
			approve: randomUUID()
		},
		year: new Date().getFullYear()
	};
};

/** Each action says which one answered, so the page shows it in the right place. */
type From = 'sweep' | 'draft' | 'line' | 'approve';

interface Answer {
	from: From;
	message: string;
	failed: boolean;
	conflict: boolean;
}

/** A database refusal, as the answer the page shows next to that form. */
function refuse(from: From, error: unknown): ActionFailure<Answer> {
	const refusal = toAppError(error);
	if (!refusal) throw error;
	return fail(refusal.status, {
		from,
		message: refusal.message,
		failed: true,
		conflict: refusal.status === 409
	});
}

/** The form itself did not make sense, so it never reached the database. */
function badForm(from: From, message: string): ActionFailure<Answer> {
	return fail(400, { from, message, failed: true, conflict: false });
}

export const actions: Actions = {
	// Look for anything new and record it.
	sweep: async ({ locals, request }) => {
		const parsed = sweepInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return badForm('sweep', 'The form is out of date. Reload the page.');
		try {
			const result = await sweepSignals(await getDb(), locals.user!.id, parsed.data);
			const raised = Object.entries(result.raised)
				.filter(([, n]) => n > 0)
				.map(([signal, n]) => `${n} ${signal.replace(/_/g, ' ')}`)
				.join(', ');
			const message = result.replayed
				? 'Already swept. Nothing was recorded twice.'
				: result.total === 0
					? `Nothing new. ${result.cleared > 0 ? `${result.cleared} cleared.` : 'The log is up to date.'}`
					: `${result.total} new: ${raised}.${result.cleared > 0 ? ` ${result.cleared} cleared.` : ''}`;
			return { from: 'sweep' as const, message, failed: false, conflict: false };
		} catch (error) {
			return refuse('sweep', error);
		}
	},

	// Turn what needs buying into one draft per vendor.
	draft: async ({ locals, request }) => {
		const parsed = draftInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return badForm('draft', 'The form is out of date. Reload the page.');
		try {
			const result = await draftPurchaseRequests(await getDb(), locals.user!.id, parsed.data);
			const skipped =
				result.skipped > 0
					? ` ${result.skipped} ${result.skipped === 1 ? 'part was' : 'parts were'} left out: no vendor or no cost on the item card.`
					: '';
			const message = result.replayed
				? 'Already drafted. Nothing was drafted twice.'
				: result.drafted === 0
					? `Nothing to draft.${skipped || ' Every vendor with short parts already has an open draft.'}`
					: `${result.drafted} ${result.drafted === 1 ? 'draft' : 'drafts'} ready to look at.${skipped}`;
			return { from: 'draft' as const, message, failed: false, conflict: false };
		} catch (error) {
			return refuse('draft', error);
		}
	},

	// Change a quantity or a delivery date on a draft.
	line: async ({ locals, request }) => {
		const parsed = setLineInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return badForm('line', parsed.error.issues[0]?.message ?? 'Check the quantity and the date.');
		}
		try {
			const result = await setRequestLine(await getDb(), locals.user!.id, parsed.data);
			return {
				from: 'line' as const,
				message: result.replayed ? 'Already saved.' : 'Saved.',
				failed: false,
				conflict: false
			};
		} catch (error) {
			return refuse('line', error);
		}
	},

	// Approve a draft: raise the order and queue the vendor email.
	approve: async ({ locals, request }) => {
		const parsed = approveInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return badForm('approve', 'The form is out of date. Reload the page.');
		try {
			const result = await approvePurchaseRequest(await getDb(), locals.user!.id, parsed.data);
			const where =
				result.queue === 'mail_drafts'
					? 'The vendor email is in the mail review queue.'
					: 'The vendor email is below, waiting for you to send it.';
			const message = result.replayed
				? `Already approved as ${result.orderNo}.`
				: `${result.orderNo} raised, ${result.lines} ${result.lines === 1 ? 'line' : 'lines'}. ${where}`;
			return { from: 'approve' as const, message, failed: false, conflict: false };
		} catch (error) {
			return refuse('approve', error);
		}
	}
};
