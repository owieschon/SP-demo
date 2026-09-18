// /policies/backtest: what a margin floor would have done to us.
//
// The question somebody always asks before they change a number is "what
// would this have done?", and for the margin floor the answer is already in
// the ledger: every invoice line carries the cost that applied on the day it
// was posted, so the margin on every line ever sold is a fact.
//
// Read only, and it never writes the floor it is trying. Setting it is a
// separate, audited decision on /policies.
import { getDb } from '$lib/server/db';
import { backtestMarginFloor, resolvePolicy } from '$lib/server/policy/read';
import type { PageServerLoad } from './$types';

/** The three months before today, which is the window somebody means by "last quarter". */
function defaultWindow(today: Date): { from: string; to: string } {
	const to = new Date(today);
	const from = new Date(today);
	from.setMonth(from.getMonth() - 3);
	return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

function asDate(value: string | null, fallback: string): string {
	return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	const user = locals.user!;
	const db = await getDb();

	// The floor in force today, so the page can start from it and say what is
	// being compared against what.
	const inForce = await resolvePolicy(db, user.id, 'commercial.min_margin', {});
	const now = Number(inForce.value);

	const window = defaultWindow(new Date(inForce.onDate));
	const from = asDate(url.searchParams.get('from'), window.from);
	const to = asDate(url.searchParams.get('to'), window.to);

	// A percentage or a ratio, both accepted, because both get typed.
	const asked = Number(url.searchParams.get('floor') ?? '');
	const proposed = Number.isFinite(asked) && asked > 0 && asked < 100
		? asked > 1
			? asked / 100
			: asked
		: Math.round((now + 0.05) * 1000) / 1000;

	return {
		floorNow: now,
		floorNowWords: inForce.valueWords,
		floorExplanation: inForce.explanation,
		proposed,
		from,
		to,
		// Not awaited: the page arrives first and the two runs stream in.
		// Both are worked out the same way, so the difference between them is
		// the policy and nothing else.
		atNow: backtestMarginFloor(db, user.id, { floor: now, from, to }),
		atProposed: backtestMarginFloor(db, user.id, { floor: proposed, from, to })
	};
};
