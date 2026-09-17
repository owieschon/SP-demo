import type { ParamMatcher } from '@sveltejs/kit';

// /vendors/[vendor=vendor]: a vendor number is a letter or two and digits,
// for example V10010. Keeping the shape here means a stray path never
// reaches a query.
export const match = ((param: string) => /^[A-Za-z]{0,3}[0-9][A-Za-z0-9-]{0,15}$/.test(param)) satisfies ParamMatcher;
