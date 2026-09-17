import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { LETTERHEAD } from '$lib/server/documents/letterhead';
import { quoteMail } from '$lib/server/documents/mailto';
import { loadQuoteDoc } from '$lib/server/documents/quote';
import { quoteFileName } from '$lib/server/documents/quotePdf';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const doc = await loadQuoteDoc(await getDb(), locals.user!.id, Number(params.id));
	if (!doc) error(404, `Quote SQ-${params.id} does not exist.`);

	return {
		// The page, the PDF and the email all come from this one object.
		quote: doc,
		mail: quoteMail(doc),
		pdfFileName: quoteFileName(doc),
		// Our own details travel with the page: a component in the browser
		// cannot import from $lib/server.
		letterhead: LETTERHEAD,
		year: new Date().getFullYear()
	};
};
