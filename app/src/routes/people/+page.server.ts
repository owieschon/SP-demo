import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { listPeople, scopeValues } from '$lib/server/roles/policy';
import {
	grantAuthority,
	grantAuthorityInput,
	revokeAuthority,
	revokeAuthorityInput,
	setDisclosure,
	setDisclosureInput,
	setPreset,
	setPresetInput,
	setScope,
	setScopeInput
} from '$lib/server/roles/writes';
import { SCOPE_DIMENSIONS, type ScopeDimension } from '$lib/roles/types';
import type { Actions, PageServerLoad } from './$types';

/*
  The one policy surface: who exists, what each of them is responsible for,
  what they may approve and up to what, and what they may see. Agents are in
  the same list, because they are principals in the same three tables.

  Reading is open to everybody. Who may approve what is not a secret inside a
  company, and it is the thing people need in order to know who to ask.
  Writing needs the change_policy authority or admin, which the database
  checks; the page only decides whether to draw the controls.
*/
function dimensionParam(value: string | null): ScopeDimension | null {
	return SCOPE_DIMENSIONS.includes(value as ScopeDimension) ? (value as ScopeDimension) : null;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();

	// "?scope=10:account" opens one person's named values. They are not in the
	// list itself: an account manager's slice is hundreds of customer numbers
	// and no list shows them all at once.
	const open = url.searchParams.get('scope');
	const [openIdText, openDimension] = (open ?? '').split(':');
	const openId = Number(openIdText);
	const dimension = dimensionParam(openDimension ?? null);
	const showing =
		Number.isInteger(openId) && openId > 0 && dimension ? { id: openId, dimension } : null;

	return {
		list: await listPeople(db, user.id),
		showing,
		values: showing ? await scopeValues(db, showing.id, showing.dimension) : [],
		// One id per page load. Each form makes its own id from it, so sending
		// the same form twice sends the same id and the database writes once.
		requestId: randomUUID()
	};
};

/** Turn a refusal from the database into something the page can show. */
async function run<T>(work: () => Promise<T>, done: string) {
	try {
		await work();
		return { message: done };
	} catch (error) {
		const refusal = toAppError(error);
		if (!refusal) throw error;
		return fail(refusal.status, {
			message: refusal.message,
			code: refusal.code,
			conflict: refusal.status === 409
		});
	}
}

export const actions: Actions = {
	preset: async ({ locals, request }) => {
		const parsed = setPresetInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Pick a preset and keep the line short.' });
		const db = await getDb();
		return run(
			() => setPreset(db, locals.user!.id, parsed.data),
			'Saved what they are responsible for.'
		);
	},

	scope: async ({ locals, request }) => {
		const parsed = setScopeInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Pick a dimension.' });
		const db = await getDb();
		return run(() => setScope(db, locals.user!.id, parsed.data), 'Saved their scope.');
	},

	/*
	  The write this whole branch exists to show off. Raising a person's
	  approval limit and raising an agent's autonomy come through here, with
	  the same fields, into the same table, leaving the same audit row. There
	  is no agent-shaped variant of it.
	*/
	grant: async ({ locals, request }) => {
		const parsed = grantAuthorityInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return fail(400, { message: 'A limit is a number, and a date is YYYY-MM-DD.' });
		}
		const db = await getDb();
		const when = parsed.data.startsOn ? ` from ${parsed.data.startsOn}` : '';
		return run(() => grantAuthority(db, locals.user!.id, parsed.data), `Saved the grant${when}.`);
	},

	revoke: async ({ locals, request }) => {
		const parsed = revokeAuthorityInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Pick an authority to take away.' });
		const db = await getDb();
		return run(() => revokeAuthority(db, locals.user!.id, parsed.data), 'Took the authority away.');
	},

	disclosure: async ({ locals, request }) => {
		const parsed = setDisclosureInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) return fail(400, { message: 'Pick one of the three levels.' });
		const db = await getDb();
		return run(
			() => setDisclosure(db, locals.user!.id, parsed.data),
			'Saved what they may be shown.'
		);
	}
};
