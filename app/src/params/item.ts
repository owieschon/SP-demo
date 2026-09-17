import type { ParamMatcher } from '@sveltejs/kit';

// /parts/[item=item]: an item number is letters, digits, dots and dashes,
// for example L3515-630SC, CU-41545 or M-1007. Anything else (a path that
// slipped in, a name with spaces) is not a part, so the route does not match
// and SvelteKit answers 404 instead of asking the database.
export const match = ((param: string) => /^[A-Za-z0-9][A-Za-z0-9.-]{0,39}$/.test(param)) satisfies ParamMatcher;
