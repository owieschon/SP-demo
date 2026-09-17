// The quote a draft would become, as a PDF, before anyone has approved it.
//
// Same builder and same drawing as an approved quote (see
// /quotes/[id]/pdf), from the draft's stored validation, so what a person
// sends a customer while a request is still being settled is the document
// they were looking at on the review page.
//
// It says DRAFT QUOTE across the top and carries a line saying nothing has
// been approved, because a draft going out unmarked is how a price nobody
// agreed to becomes a price somebody expects.
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { fileResponse } from '$lib/server/documents/http';
import { loadDraftQuoteDoc } from '$lib/server/documents/quote';
import { quoteFileName, quotePdf } from '$lib/server/documents/quotePdf';
import { getDraft } from '$lib/server/rfq/drafts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const db = await getDb();
	const userId = locals.user!.id;
	const draft = await getDraft(db, userId, Number(params.id));
	// Someone else's draft looks exactly like one that does not exist.
	if (!draft) error(404, `Draft R-${params.id} does not exist.`);

	// An approved draft has a real quote; send people to that one.
	if (draft.quoteId !== null) {
		return new Response(null, { status: 303, headers: { location: `/quotes/${draft.quoteId}/pdf` } });
	}

	const doc = await loadDraftQuoteDoc(db, userId, draft);
	if (!doc) {
		error(409, 'This request has no customer settled yet, so there is nothing to quote.');
	}
	if (doc.lines.length === 0) {
		error(409, 'No line on this request is settled enough to quote yet.');
	}

	return fileResponse(await quotePdf(doc), 'application/pdf', quoteFileName(doc));
};
