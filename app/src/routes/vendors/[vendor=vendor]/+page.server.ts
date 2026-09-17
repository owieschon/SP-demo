import { randomUUID } from 'node:crypto';
import { error, fail, redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import {
	addVendorContact,
	getVendor,
	getVendorParts,
	resolveVendorNo,
	vendorContactInput
} from '$lib/server/catalog/vendors';
import { vendorHref } from '$lib/components/catalog/types';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const user = locals.user!;
	const db = await getDb();

	const vendorNo = await resolveVendorNo(db, user.id, params.vendor);
	if (!vendorNo) error(404, `Vendor ${params.vendor} is not in the vendor list.`);
	if (vendorNo !== params.vendor) redirect(308, vendorHref(vendorNo));

	// The card and its contacts are awaited (they decide between a page and a
	// 404, and the form needs the row version); the parts stream in.
	const vendor = await getVendor(db, user.id, vendorNo);
	if (!vendor) error(404, `Vendor ${vendorNo} is not in the vendor list.`);

	return {
		vendor,
		parts: getVendorParts(db, user.id, vendorNo),
		// Operations and admins keep the vendor list; the database says so too.
		canAddContact: user.role !== 'account_manager',
		// A fresh id per page load: sending the same form twice writes once.
		requestId: randomUUID(),
		year: new Date().getFullYear()
	};
};

export const actions: Actions = {
	addContact: async ({ locals, request }) => {
		const parsed = vendorContactInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Something in the form is missing.',
				failed: true
			});
		}
		try {
			const result = await addVendorContact(await getDb(), locals.user!.id, parsed.data);
			return {
				message: result.replayed
					? `${parsed.data.fullName} was already added.`
					: `Added ${parsed.data.fullName}.`,
				failed: false
			};
		} catch (err) {
			const refusal = toAppError(err);
			if (!refusal) throw err;
			return fail(refusal.status, { message: refusal.message, failed: true });
		}
	}
};
