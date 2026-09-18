// One quote request used to live at /rfq/<id>. It lives under the desk now,
// because that is where it arrives. Old links (an email, a bookmark, the
// account page before it was rebuilt) keep working through here.
//
// The two file endpoints below this one, /rfq/<id>/quote and
// /rfq/<id>/attachments/<attachment>, stayed exactly where they were and
// still serve the bytes.
import { redirect } from '@sveltejs/kit';
import { routes } from '$lib/routes';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	redirect(308, routes.quoteRequest(Number(params.id)));
};
