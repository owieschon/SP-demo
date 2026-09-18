/*
  What the command palette asks for as a person types: accounts, parts and
  vendors that match, as palette rows with their own URLs.

  It is not a public API. It is behind the same session check as every page
  (hooks.server.ts), it runs the search as the signed-in person so row-level
  security decides what comes back, and it answers the one question the
  palette asks. The screens and the actions in the palette are static and
  need no request at all.
*/
import { json } from '@sveltejs/kit';
import { cleanQuery, searchAll } from '$lib/server/catalog/search';
import { getDb } from '$lib/server/db';
import { routes } from '$lib/routes';
import { place } from '$lib/format';
import type { PaletteEntry } from '$lib/components/ui/palette';
import type { RequestHandler } from './$types';

/** Five of each: the palette is a jump box, not a results page. */
const PER_GROUP = 5;

export const GET: RequestHandler = async ({ locals, url }) => {
	const user = locals.user!;
	const q = cleanQuery(url.searchParams.get('q'));
	if (q.length < 2) return json({ entries: [] satisfies PaletteEntry[] });

	const results = await searchAll(await getDb(), user.id, q);

	const entries: PaletteEntry[] = [
		...results.accounts.rows.slice(0, PER_GROUP).map((account) => ({
			id: `account-${account.customerNo}`,
			kind: 'account' as const,
			label: account.name,
			hint: [place(account.city, account.state, account.country), account.closed ? 'closed' : null]
				.filter(Boolean)
				.join(' · '),
			href: routes.account(account.customerNo),
			keywords: account.customerNo
		})),
		...results.parts.rows.slice(0, PER_GROUP).map((part) => ({
			id: `part-${part.itemNo}`,
			kind: 'part' as const,
			label: part.itemNo,
			hint: part.description,
			href: routes.part(part.itemNo),
			keywords: part.description
		})),
		...results.vendors.rows.slice(0, PER_GROUP).map((vendor) => ({
			id: `vendor-${vendor.vendorNo}`,
			kind: 'vendor' as const,
			label: vendor.name,
			hint: place(vendor.city, vendor.state, 'US'),
			href: routes.vendor(vendor.vendorNo),
			keywords: vendor.vendorNo
		}))
	];

	return json({ entries });
};
