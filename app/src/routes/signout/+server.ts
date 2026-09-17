import { redirect } from '@sveltejs/kit';
import { SESSION_COOKIE } from '$lib/server/session';
import type { RequestHandler } from './$types';

// A POST from the "Sign out" button. SvelteKit refuses cross-site form posts,
// so another website cannot sign a visitor out.
export const POST: RequestHandler = ({ cookies }) => {
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/signin');
};
