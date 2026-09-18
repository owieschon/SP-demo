// The home page: what is waiting on the signed-in principal's authority.
//
// nl.work_waiting_for does the deciding. This file does one thing the
// database deliberately does not: it turns (kind, ref) into a URL, through
// the route registry in $lib/routes. The registry exists because URLs used to
// be built in nineteen places; putting a second copy in SQL would have
// undone that.
import { routes } from '$lib/routes';
import type { Db } from '../db/types.ts';
import type { WorkItem, WorkKind } from '$lib/roles/types';

interface WorkRow {
	kind: string;
	ref: string;
	subject: string;
	amount: number | null;
	waiting_since: string;
	age_days: number;
	why: string;
}

/**
 * Where a row of work sends somebody. Anything the registry does not have an
 * entry for lands on the section's own page, which is still the right place:
 * a warehouse pick is worked from the warehouse screen, not from a page of
 * its own.
 */
function hrefFor(kind: WorkKind, ref: string): string {
	switch (kind) {
		case 'mail_draft':
		case 'mail_exception':
			return routes.workspace('mail');
		case 'mail_unanswered':
			return routes.deskMessage(Number(ref));
		case 'quote_request':
			return routes.quoteRequest(Number(ref));
		case 'quote_expiring':
			return routes.quote(Number(ref));
		case 'agent_proposal':
			return routes.workspace('assistant');
		case 'purchase_request':
			return routes.workspace('purchase');
		case 'commitment_answer':
			return routes.commitmentAnswer(Number(ref));
		case 'coverage_purchase':
		case 'coverage_production':
			return routes.forecast();
		case 'price_increase':
			// "L3515@2026-09-10": the part is the half before the date.
			return routes.part(ref.split('@')[0]);
		case 'pick':
		case 'receipt':
		case 'count':
			return routes.warehouse();
		case 'import_decision':
			return routes.operations();
	}
}

/** One person's home page, oldest first, as the database ordered it. */
export async function workWaitingFor(db: Db, userId: number): Promise<WorkItem[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<WorkRow>`
			select kind, ref, subject, amount, waiting_since, age_days, why
			from nl.work_waiting_for(${userId})
			order by age_days desc, kind, ref`
	);
	return rows.map((row) => {
		const kind = row.kind as WorkKind;
		return {
			kind,
			ref: row.ref,
			subject: row.subject,
			amount: row.amount === null ? null : Number(row.amount),
			waitingSince: row.waiting_since,
			ageDays: row.age_days,
			why: row.why,
			href: hrefFor(kind, row.ref)
		};
	});
}

/** The home page, grouped by kind, so each group can be one short list. */
export interface WorkGroup {
	kind: WorkKind;
	items: WorkItem[];
}

export function groupWork(items: WorkItem[]): WorkGroup[] {
	const groups = new Map<WorkKind, WorkItem[]>();
	for (const item of items) {
		const list = groups.get(item.kind);
		if (list) list.push(item);
		else groups.set(item.kind, [item]);
	}
	// Biggest group first: it is what the person is going to spend the day on.
	return [...groups.entries()]
		.map(([kind, list]) => ({ kind, items: list }))
		.sort((a, b) => b.items.length - a.items.length || a.kind.localeCompare(b.kind));
}
