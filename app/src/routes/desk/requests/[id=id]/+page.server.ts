// One quote request: what was read, what the checks decided, the fixes a
// person can make, and the proposal to approve or reject.
//
// This used to be a screen of its own at /rfq/<id>, reached from a page
// where a person uploaded a file. A quote request arrives at the order desk
// and the agent reads it, so it lives under the desk now and /rfq/<id>
// redirects here. The two file endpoints stayed where they were, so old
// links to a stored attachment or a draft PDF still serve.
import { randomUUID } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { findDeskItem } from '$lib/server/agentruns/desk';
import { getRunForQuoteRequest } from '$lib/server/agentruns/read';
import { quoteMail } from '$lib/server/documents/mailto';
import { loadDraftQuoteDoc } from '$lib/server/documents/quote';
import { quoteFileName } from '$lib/server/documents/quotePdf';
import { getDraft } from '$lib/server/rfq/drafts';
import { approveAction, rejectAction, reviseAction } from '$lib/server/rfq/forms';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const db = await getDb();
	const userId = locals.user!.id;
	const id = Number(params.id);
	const draft = await getDraft(db, userId, id);
	// Someone else's request looks exactly like one that does not exist.
	if (!draft) error(404, `Quote request R-${params.id} does not exist.`);

	// The quote this request would become, so it can be sent before approval.
	// Null until a customer is settled and at least one line prices.
	const quote = await loadDraftQuoteDoc(db, userId, draft);
	const sendable = quote && quote.lines.length > 0 ? quote : null;

	return {
		draft,
		// The desk item it came in on, and the run that read it.
		item: await findDeskItem(db, userId, id),
		run: await getRunForQuoteRequest(db, userId, id),
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
