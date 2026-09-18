// /policies: every policy the app reads, what it says right now, and why.
//
// The page answers three questions, in this order:
//   1. What is the company-wide value of each policy today?
//   2. Who has an exception, since when, and what did they say about it?
//   3. For this account and this part, which policy wins, and what did it
//      beat? That last one is the trace, and it is the reason the engine
//      exists: a figure nobody can account for is a figure nobody trusts.
//
// Who may change what comes from the policy type itself (its edit_role), and
// the database checks it again in nl.set_policy(). The page only decides
// whether to draw the form.
import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { parsePolicyValue } from '$lib/policy/value';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import {
	allocationSummary,
	listPolicies,
	listPolicyTypes,
	mayChangePolicy,
	resolvePolicies,
	traceFor,
	type PolicyContext
} from '$lib/server/policy/read';
import { endPolicy, endPolicyInput, setPolicy, setPolicyInput } from '$lib/server/policy/write';
import type { Actions, PageServerLoad } from './$types';

/** The context boxes at the top of the page, as read from the query string. */
function contextFrom(url: URL): PolicyContext {
	const asked = (name: string) => (url.searchParams.get(name) ?? '').trim();
	const onDate = asked('date');
	return {
		customerNo: asked('customer') || null,
		itemNo: asked('item') || null,
		// A date is only passed on when it reads like one, so a half-typed box
		// does not turn into a refusal from the database.
		onDate: /^\d{4}-\d{2}-\d{2}$/.test(onDate) ? onDate : null
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees somebody is signed in on this page.
	const user = locals.user!;
	const db = await getDb();

	const types = await listPolicyTypes(db, user.id);
	const chosenKey = url.searchParams.get('type') ?? '';
	const chosen = types.find((one) => one.key === chosenKey) ?? null;
	const context = contextFrom(url);
	// ?edit=N fills the form with that row instead of an empty one. The row
	// itself is found in the list the page already has, so opening the form
	// costs no second query.
	const askedEdit = Number(url.searchParams.get('edit') ?? '');
	const editId = Number.isSafeInteger(askedEdit) && askedEdit > 0 ? askedEdit : null;

	return {
		types,
		chosen,
		editId,
		context: {
			customerNo: context.customerNo ?? '',
			itemNo: context.itemNo ?? '',
			onDate: context.onDate ?? ''
		},
		role: user.role,
		// The change_policy authority (migration 0031), not the person's role
		// title. The database is asked the same question again on the write.
		mayChange: await mayChangePolicy(db, user.id),
		// Fresh ids for this page load. Each form makes a new one per submit as
		// well, so a second try is a second write and not a replay of the first.
		requestIds: { set: randomUUID(), end: randomUUID() },
		// Everything below arrives a moment after the page (see +page.svelte).
		// The company-wide value of every policy, in one round trip.
		global: resolvePolicies(
			db,
			user.id,
			types.map((one) => one.key)
		),
		// And the same list resolved against the context in the boxes, so the
		// page can show what changes for this account and this part.
		here: resolvePolicies(
			db,
			user.id,
			types.map((one) => one.key),
			context
		),
		rows: listPolicies(db, user.id, chosen?.key),
		trace: chosen ? traceFor(db, user.id, chosen.key, context) : Promise.resolve([]),
		allocation: allocationSummary(db, user.id)
	};
};

type Answer = { from: 'set' | 'end'; message: string; ok: boolean };

function refusal(from: Answer['from'], error: unknown) {
	const app = toAppError(error);
	if (!app) throw error;
	return fail(app.status, { from, message: app.message, ok: false } satisfies Answer);
}

export const actions: Actions = {
	// Add a scoped override, or change one that is already there.
	set: async ({ locals, request }) => {
		const user = locals.user!;
		const form = Object.fromEntries(await request.formData());
		const db = await getDb();

		const types = await listPolicyTypes(db, user.id);
		const type = types.find((one) => one.key === String(form.policyType ?? ''));
		if (!type) {
			return fail(404, { from: 'set', ok: false, message: 'There is no policy by that name.' } satisfies Answer);
		}
		// The same two rules the database checks, checked here so the answer
		// reads like a sentence rather than a refusal.
		if (!type.editable) {
			return fail(422, {
				from: 'set',
				ok: false,
				message: `${type.name} is not something the app can change yet.`
			} satisfies Answer);
		}
		if (!(await mayChangePolicy(db, user.id))) {
			return fail(403, {
				from: 'set',
				ok: false,
				message: `Changing ${type.name} needs the change policy authority.`
			} satisfies Answer);
		}

		const parsedValue = parsePolicyValue(type, String(form.valueText ?? ''));
		if (!parsedValue.ok) {
			return fail(422, { from: 'set', ok: false, message: parsedValue.message } satisfies Answer);
		}

		const parsed = setPolicyInput.safeParse({
			policyId: form.policyId === '' ? null : form.policyId,
			policyType: type.key,
			scopeKind: form.scopeKind,
			scopeId: form.scopeId,
			value: JSON.stringify(parsedValue.value),
			effectiveFrom: form.effectiveFrom,
			effectiveTo: String(form.effectiveTo ?? '') === '' ? null : form.effectiveTo,
			priority: form.priority === '' ? 0 : form.priority,
			note: form.note,
			expectedUpdatedAt: String(form.expectedUpdatedAt ?? '') === '' ? null : form.expectedUpdatedAt,
			requestId: form.requestId
		});
		if (!parsed.success) {
			return fail(400, {
				from: 'set',
				ok: false,
				message: parsed.error.issues[0]?.message ?? 'Something in the form is missing.'
			} satisfies Answer);
		}

		try {
			await setPolicy(db, user.id, parsed.data);
		} catch (error) {
			return refusal('set', error);
		}
		return {
			from: 'set' as const,
			ok: true,
			message: `${type.name} is set for ${parsed.data.scopeKind === 'global' ? 'everyone' : parsed.data.scopeId}.`
		};
	},

	// Stop an override applying. The row stays, so the trace can still
	// explain a figure from before today.
	end: async ({ locals, request }) => {
		const form = Object.fromEntries(await request.formData());
		const parsed = endPolicyInput.safeParse({
			policyId: form.policyId,
			effectiveTo: String(form.effectiveTo ?? '') === '' ? null : form.effectiveTo,
			expectedUpdatedAt: form.expectedUpdatedAt,
			requestId: form.requestId
		});
		if (!parsed.success) {
			return fail(400, {
				from: 'end',
				ok: false,
				message: parsed.error.issues[0]?.message ?? 'Something in the form is missing.'
			} satisfies Answer);
		}
		try {
			const ended = await endPolicy(await getDb(), locals.user!.id, parsed.data);
			return { from: 'end' as const, ok: true, message: `That policy now ends on ${ended.effectiveTo}.` };
		} catch (error) {
			return refusal('end', error);
		}
	}
};
