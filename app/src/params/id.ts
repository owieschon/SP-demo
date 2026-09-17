import type { ParamMatcher } from '@sveltejs/kit';

// /commitments/[id=id] only matches whole numbers, so /commitments/answer is its own page.
export const match = ((param: string) => /^\d{1,12}$/.test(param)) satisfies ParamMatcher;
