/**
 * Where to go after signing in, or after the password curtain.
 *
 * Only paths on this site are allowed, so a crafted link cannot bounce a
 * visitor to another website.
 *
 * And only paths a browser can GET. A redirect is a GET, so sending one at an
 * endpoint that only answers POST produces a blank page reading "GET method
 * not allowed". That is exactly what happened: signing out while the curtain
 * had expired sent the person to /gate?next=/signout, and typing the right
 * password then bounced them into the POST-only sign-out endpoint. Anything
 * that is an endpoint rather than a page belongs on this list.
 */
const NOT_A_PAGE = ['/signin', '/signout', '/api'];

export function safeNext(value: string | null | undefined, fallback = '/commitments'): string {
	if (!value || !value.startsWith('/')) return fallback;
	// "//host" and "/\host" are both read as another site by some browsers.
	if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
	if (NOT_A_PAGE.some((path) => value === path || value.startsWith(`${path}/`))) {
		return fallback;
	}
	return value;
}
