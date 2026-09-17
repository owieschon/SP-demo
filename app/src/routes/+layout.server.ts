import type { LayoutServerLoad } from './$types';

// Every page gets the signed-in user (or null) for the header.
export const load: LayoutServerLoad = ({ locals }) => {
	return { user: locals.user };
};
