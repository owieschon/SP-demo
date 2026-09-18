/*
  What needs a person right now, and nothing else.

  This is the front door of the app, and it is deliberately not a dashboard.
  The agents do the work; a person's time goes on the handful of decisions
  only a person can make. So this file counts exceptions, one group per kind
  of decision, and it counts what the agents got through on their own so the
  empty case can say so.

  Every group is a count of rows the database already holds, and each one
  links to the screen where the decision is made. When a group is zero it is
  left out entirely: zero is not news.

  WHOSE EXCEPTIONS. The first version of this file narrowed three of its
  groups with `owner_id = userId` and showed the other three to everybody, so
  a salesperson was told about stock counts and a buyer was told about
  commitment windows on somebody else's book. It now asks
  nl.work_waiting_for (migration 0031), which answers the question properly:
  an item is here when it sits inside this person's scope AND is waiting on an
  authority they actually hold. A quote above somebody's ceiling is not their
  decision, so it is not on their page.

  The shape of what this returns has not changed, so the page above it did not
  have to.
*/
import type { Db } from './db/types.ts';
import { workWaitingFor } from './roles/work.ts';
import type { WorkItem, WorkKind } from '$lib/roles/types';

/** What kind of decision a group asks for. The page groups by this. */
export type DecisionKind = 'answer' | 'approve' | 'release' | 'schedule' | 'count';

export interface TodayGroup {
	id: string;
	kind: DecisionKind;
	/** What is waiting, as a noun phrase. */
	title: string;
	/** The decision itself, in the words a person would use. */
	decision: string;
	count: number;
	href: string;
	/** The oldest thing waiting, so a person can see what is going stale. */
	oldest: string | null;
}

export interface TodayData {
	/** The world's today, so every date on the page can say what it is against. */
	today: string;
	groups: TodayGroup[];
	/** Everything waiting, across the groups. */
	waiting: number;
	/**
	 * What the agents did in the last day without asking anybody: mail the
	 * order desk read and answered or set aside, automation rules that fired,
	 * and lookups the assistant ran. It is the honest denominator for the
	 * empty state, not a score.
	 */
	agentActions: number;
}

/**
 * One entry per kind of work nl.work_waiting_for can return: what to call it,
 * what the decision is in a person's words, and which of the five shapes of
 * decision it is. The order of this map is the order of the page, so it does
 * not rearrange itself between loads.
 */
const GROUPS: Record<WorkKind, { kind: DecisionKind; title: string; decision: string }> = {
	commitment_answer: {
		kind: 'answer',
		title: 'Commitment windows that closed short',
		decision: 'Say whether it is still coming, close enough, or lost'
	},
	mail_draft: {
		kind: 'approve',
		title: 'Replies the order desk drafted',
		decision: 'Send it, correct it first, or reject it'
	},
	mail_exception: {
		kind: 'approve',
		title: 'Replies the desk would not send on its own',
		decision: 'Read why it stopped, then write it or let it go'
	},
	mail_unanswered: {
		kind: 'answer',
		title: 'Messages the desk could not read',
		decision: 'Answer it, or tell the desk what it was'
	},
	quote_request: {
		kind: 'approve',
		title: 'Quotes drafted from an emailed request',
		decision: 'Approve the quote, or fix a line and approve'
	},
	quote_expiring: {
		kind: 'answer',
		title: 'Quotes about to run out',
		decision: 'Chase it, extend it, or let it lapse'
	},
	agent_proposal: {
		kind: 'approve',
		title: 'Changes the assistant proposed',
		decision: 'Approve the change, or reject it'
	},
	purchase_request: {
		kind: 'release',
		title: 'Purchases the procurement desk proposed',
		decision: 'Release the order, or reject it'
	},
	coverage_purchase: {
		kind: 'release',
		title: 'Lines with nothing on order',
		decision: 'Raise the purchase order, or give the customer a real date'
	},
	coverage_production: {
		kind: 'schedule',
		title: 'Lines with nothing planned',
		decision: 'Schedule the work, or give the customer a real date'
	},
	price_increase: {
		kind: 'approve',
		title: 'Costs a supplier has put up',
		decision: 'Accept the new cost, or go back to them'
	},
	pick: {
		kind: 'count',
		title: 'Shipments still being picked',
		decision: 'Pick it, pack it and confirm'
	},
	receipt: {
		kind: 'count',
		title: 'Transfers due in',
		decision: 'Receive it, or say what did not arrive'
	},
	count: {
		kind: 'count',
		title: 'Stock counts due',
		decision: 'Count the zone and post the sheet'
	},
	import_decision: {
		kind: 'release',
		title: "This morning's export is waiting",
		decision: 'Apply it, or hold it and say why'
	}
};

const ORDER = Object.keys(GROUPS) as WorkKind[];

/** The date part of whatever the database handed back for `waiting_since`. */
function dayOf(value: string): string {
	return value.slice(0, 10);
}

export async function getToday(db: Db, userId: number): Promise<TodayData> {
	const items = await workWaitingFor(db, userId);

	const { today, agentActions } = await db.asUser(userId, async (tx) => {
		const [{ today }] = await tx.sql<{ today: string }>`select nl.today() as today`;
		const [agent] = await tx.sql<{ count: number }>`
			select (
				(select count(*) from nl.mail_runs r
				  where r.finished_at > now() - interval '1 day'
				    and r.outcome in ('drafted', 'ignored'))
				+ (select count(*) from nl.automation_firings f
				    where f.fired_at > now() - interval '1 day')
				+ (select count(*) from nl.assistant_tool_calls c
				    where c.created_at > now() - interval '1 day' and c.outcome = 'ran')
			)::int as count`;
		return { today, agentActions: agent.count };
	});

	const byKind = new Map<WorkKind, WorkItem[]>();
	for (const item of items) {
		const list = byKind.get(item.kind);
		if (list) list.push(item);
		else byKind.set(item.kind, [item]);
	}

	const groups: TodayGroup[] = [];
	for (const kind of ORDER) {
		const list = byKind.get(kind);
		if (!list || list.length === 0) continue;
		const label = GROUPS[kind];
		// Every item in a group links to the same screen, so the group takes
		// the first one's link rather than keeping a second copy of the map.
		groups.push({
			id: `work-${kind}`,
			kind: label.kind,
			title: label.title,
			decision: label.decision,
			count: list.length,
			href: list[0].href,
			oldest: list.reduce(
				(oldest, item) => (oldest === null || dayOf(item.waitingSince) < oldest ? dayOf(item.waitingSince) : oldest),
				null as string | null
			)
		});
	}

	return {
		today,
		groups,
		waiting: items.length,
		agentActions
	};
}
