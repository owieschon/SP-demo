import { fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { GATE_COOKIE, GATE_DAYS, gateEnabled, passwordMatches, signGateCookie, verifyGateCookie } from '$lib/server/gate';
import { safeNext } from '$lib/server/redirects';
import { sessionSecret } from '$lib/server/session';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies, url }) => {
	const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
	const next = safeNext(url.searchParams.get('next'));

	// With no password configured, or the curtain already open, there is
	// nothing to ask for.
	if (!gateEnabled(env.SITE_PASSWORD) || verifyGateCookie(cookies.get(GATE_COOKIE), secret)) {
		redirect(303, next);
	}
	return { next, days: GATE_DAYS };
};

export const actions: Actions = {
	default: async ({ cookies, request }) => {
		const form = await request.formData();
		const given = String(form.get('password') ?? '');
		const next = safeNext(String(form.get('next') ?? ''));

		if (!passwordMatches(given, env.SITE_PASSWORD)) {
			// A wrong guess costs a moment, which makes guessing in bulk slow
			// without punishing the person who mistyped once.
			await new Promise((resolve) => setTimeout(resolve, 600));
			return fail(401, { message: 'That is not the password.' });
		}

		const secret = sessionSecret(env.SESSION_SECRET, Boolean(env.VERCEL));
		cookies.set(GATE_COOKIE, signGateCookie(secret), {
			path: '/',
			httpOnly: true, // page scripts cannot read it
			sameSite: 'lax',
			secure: !dev,
			maxAge: GATE_DAYS * 24 * 60 * 60
		});
		redirect(303, next);
	}
};
