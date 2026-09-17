// A quote as a PDF, built on the server with pdf-lib.
//
// It reads the same QuoteDoc the quote page reads, so the file and the page
// can only ever show the same numbers.
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { fileResponse } from '$lib/server/documents/http';
import { loadQuoteDoc } from '$lib/server/documents/quote';
import { quoteFileName, quotePdf } from '$lib/server/documents/quotePdf';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
	const doc = await loadQuoteDoc(await getDb(), locals.user!.id, Number(params.id));
	if (!doc) error(404, `Quote SQ-${params.id} does not exist.`);

	return fileResponse(await quotePdf(doc), 'application/pdf', quoteFileName(doc));
};
