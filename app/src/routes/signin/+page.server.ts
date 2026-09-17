import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { safeNext } from '$lib/server/redirects';
import { SESSION_COOKIE, SESSION_DAYS, sessionSecret, signSession } from '$lib/server/session';
import { findActiveUser, listUsers } from '$lib/server/users';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	return {
		users: await listUsers(await getDb()),
		signedInAs: locals.user,
		next: safeNext(url.searchParams.get('next'))
	};
};

export const actions: Actions = {
	// "Sign in as": no password, on purpose. See the note on the page.
	default: async ({ request, cookies }) => {
		const form = await request.formData();
		const userId = Number(form.get('userId'));
		if (!Number.isInteger(userId)) return fail(400, { message: 'Pick someone to sign in as.' });

		const user = await findActiveUser(await getDb(), userId);
		if (!user) return fail(403, { message: 'That person is no longer active.' });

		const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
		cookies.set(SESSION_COOKIE, signSession(user.id, secret), {
			path: '/',
			httpOnly: true, // page scripts cannot read it
			sameSite: 'lax', // not sent on cross-site form posts
			secure: !dev,
			maxAge: SESSION_DAYS * 24 * 60 * 60
		});
		redirect(303, safeNext(String(form.get('next') ?? '')));
	}
};
