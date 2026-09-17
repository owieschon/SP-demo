import { redirect } from '@sveltejs/kit';
import { readTheme, THEME_COOKIE } from '$lib/components/theme';
import { safeNext } from '$lib/server/redirects';
import type { RequestHandler } from './$types';

// A POST from the theme toggle. The toggle sends it with fetch and changes
// the page itself; without JavaScript it is a plain form post, and the
// visitor is sent back to the page they were on.
export const POST: RequestHandler = async ({ request, cookies }) => {
	const form = await request.formData();
	const theme = readTheme(String(form.get('theme') ?? ''));

	cookies.set(THEME_COOKIE, theme, {
		path: '/',
		httpOnly: true, // only the server needs to read it
		sameSite: 'lax',
		maxAge: 365 * 24 * 60 * 60
	});

	if (request.headers.get('accept')?.includes('application/json')) {
		return new Response(null, { status: 204 });
	}
	redirect(303, safeNext(String(form.get('next') ?? '')));
};
