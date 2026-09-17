import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { quoteMail } from '$lib/server/documents/mailto';
import { loadDraftQuoteDoc } from '$lib/server/documents/quote';
import { quoteFileName } from '$lib/server/documents/quotePdf';
import { getDraft } from '$lib/server/rfq/drafts';
import { approveAction, rejectAction, reviseAction } from '$lib/server/rfq/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const db = await getDb();
	const draft = await getDraft(db, locals.user!.id, Number(params.id));
	// Someone else's draft looks exactly like one that does not exist.
	if (!draft) error(404, `Draft R-${params.id} does not exist.`);

	// The quote this draft would become, so it can be sent before approval.
	// Null until a customer is settled and at least one line prices.
	const quote = await loadDraftQuoteDoc(db, locals.user!.id, draft);
	const sendable = quote && quote.lines.length > 0 ? quote : null;

	return {
		draft,
		draftQuote: sendable
			? { lineCount: sendable.lines.length, subtotal: sendable.subtotal, fileName: quoteFileName(sendable) }
			: null,
		draftMail: sendable ? quoteMail(sendable) : null,
		// Fresh ids for each kind of write on this page load. Sending the same
		// form twice sends the same id, so the database writes once.
		requestIds: { revise: randomUUID(), approve: randomUUID(), reject: randomUUID() },
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	revise: async ({ locals, request }) => reviseAction(await getDb(), locals.user!, request),
	approve: async ({ locals, request }) => approveAction(await getDb(), locals.user!, request),
	reject: async ({ locals, request }) => rejectAction(await getDb(), locals.user!, request)
};
