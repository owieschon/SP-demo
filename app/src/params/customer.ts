import type { ParamMatcher } from '@sveltejs/kit';

// /accounts/[customer=customer] takes an ERP customer number: digits, and in
// the load tests also letters, dots and dashes (10012, 10012.2). Anything
// else is not a customer number, so the route does not match at all and
// SvelteKit answers 404 without touching the database.
export const match = ((param: string) => /^[A-Za-z0-9][A-Za-z0-9.-]{0,19}$/.test(param)) satisfies ParamMatcher;
