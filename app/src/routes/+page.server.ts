import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The home page is the commitment board.
export const load: PageServerLoad = () => {
	redirect(307, '/commitments');
};
