/**
 * Where to go after signing in. Only paths on this site are allowed, so a
 * crafted link cannot bounce a visitor to another website.
 */
export function safeNext(value: string | null | undefined, fallback = '/commitments'): string {
	if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
		return fallback;
	}
	if (value.startsWith('/signin')) return fallback;
	return value;
}
