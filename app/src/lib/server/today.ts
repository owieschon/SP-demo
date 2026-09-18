/*
  What needs a person right now, and nothing else.

  This is the front door of the app, and it is deliberately not a dashboard.
  The agents do the work; a person's time goes on the handful of decisions
  only a person can make. So this file counts exceptions, one group per kind
  of decision, and it counts what the agents got through on their own so the
  empty case can say so.

  Nothing here is invented. Every group is a count of rows the database
  already holds, and each one links to the screen where the decision is made.
  When a group is zero it is left out entirely: zero is not news.

  Every count runs as the signed-in person, so row-level security decides
  what is in it. The three groups that have an owner are narrowed to that
  person's own work as well, because "needs me" means me.
*/
import type { Db } from './db/types.ts';

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

interface CountRow {
	count: number;
	oldest: string | null;
}

/** The label and the link for each of the four queue sources. */
const QUEUE_GROUPS: Record<string, { title: string; decision: string }> = {
	mail: {
		title: 'Replies the order desk drafted',
		decision: 'Send it, correct it first, or reject it'
	},
	rfq: {
		title: 'Quotes drafted from an emailed request',
		decision: 'Approve the quote, or fix a line and approve'
	},
	assistant: {
		title: 'Changes the assistant proposed',
		decision: 'Approve the change, or reject it'
	},
	purchase: {
		title: 'Purchases the procurement desk proposed',
		decision: 'Approve the order, or reject it'
	}
};

export async function getToday(db: Db, userId: number): Promise<TodayData> {
	return db.asUser(userId, async (tx) => {
		const [{ today }] = await tx.sql<{ today: string }>`select nl.today() as today`;

		/*
		  One trip per group. They are all counts over views this app already
		  reads elsewhere, and none of them is the sort of query that needs a
		  plan explained: the row counts here are the number of things waiting
		  for a person, which is a small number or the product is not working.
		*/
		const [closedShort] = await tx.sql<CountRow>`
			select count(*)::int as count, min(p.ends_on)::text as oldest
			from nl.commitment_progress p
			where p.needs_outcome and p.owner_id = ${userId}`;

		// The one queue every agent proposal lands in (migration 0023).
		const queue = await tx.sql<{ source: string; count: number; oldest: string | null }>`
			select q.source, count(*)::int as count, min(q.created_at)::date::text as oldest
			from nl.agent_queue q
			group by q.source`;

		const [heldExport] = await tx.sql<CountRow>`
			select count(*)::int as count, min(s.staged_at)::date::text as oldest
			from nl.export_snapshots s
			where s.status in ('staged', 'held')`;

		// A line whose parts will not be there in time, on an account this
		// person owns. The projection view works out the date and the reason.
		const [lateLines] = await tx.sql<CountRow>`
			select count(*)::int as count, min(l.ship_date)::text as oldest
			from nl.open_line_projection l
			where l.days_late > 0 and l.customer_owner_id = ${userId}`;

		const [countsDue] = await tx.sql<CountRow>`
			select count(*)::int as count, min(c.due_on)::text as oldest
			from nl.count_sessions c
			where c.status = 'open' and c.due_on <= (select nl.today())`;

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

		const groups: TodayGroup[] = [];

		if (closedShort.count > 0) {
			groups.push({
				id: 'closed-short',
				kind: 'answer',
				title: 'Commitment windows that closed short',
				decision: 'Say whether it is still coming, close enough, or lost',
				count: closedShort.count,
				href: '/commitments/answer',
				oldest: closedShort.oldest
			});
		}

		// Newest source order is not useful here; the fixed order is, so the
		// page does not rearrange itself between loads.
		for (const source of ['mail', 'rfq', 'assistant', 'purchase']) {
			const row = queue.find((item) => item.source === source);
			const label = QUEUE_GROUPS[source];
			if (!row || row.count === 0 || !label) continue;
			groups.push({
				id: `queue-${source}`,
				kind: 'approve',
				title: label.title,
				decision: label.decision,
				count: row.count,
				href: `/workspace?source=${source}`,
				oldest: row.oldest
			});
		}

		if (heldExport.count > 0) {
			groups.push({
				id: 'export-held',
				kind: 'release',
				title: "This morning's export is waiting",
				decision: 'Apply it, or hold it and say why',
				count: heldExport.count,
				href: '/operations',
				oldest: heldExport.oldest
			});
		}

		if (lateLines.count > 0) {
			groups.push({
				id: 'late-lines',
				kind: 'schedule',
				title: 'Order lines that will not ship on time',
				decision: 'Call the customer with the real date, or expedite the supply',
				count: lateLines.count,
				href: '/operations/forecast',
				oldest: lateLines.oldest
			});
		}

		if (countsDue.count > 0) {
			groups.push({
				id: 'counts-due',
				kind: 'count',
				title: 'Stock counts due',
				decision: 'Count the zone and post the sheet',
				count: countsDue.count,
				href: '/warehouse',
				oldest: countsDue.oldest
			});
		}

		return {
			today,
			groups,
			waiting: groups.reduce((sum, group) => sum + group.count, 0),
			agentActions: agent.count
		};
	});
}
