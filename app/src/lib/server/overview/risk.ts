/*
  Question four: what is at risk right now?

  Four things, each already a view somewhere in this schema, each linking to a
  screen that lists the records rather than to a screen that says the same
  number again:

  - coverage gaps: nl.open_line_projection rows with status 'no_supply', which
    means nothing on hand or on order reaches that line at all;
  - late purchase orders: nl.procurement_late_supply, which unions the ERP's
    open purchase and production orders with the ones the procurement desk
    raised, and marks past_due and slipped;
  - exceptions nobody has answered: nl.agent_queue, the one queue every agent
    proposal lands in, with the age of the oldest;
  - accounts gone quiet: nl.account_list.gone_quiet, which is an account at
    twice its own usual gap between orders and at least three weeks silent.

  One honest wrinkle is worth knowing and is said on the page: gone_quiet is
  false for an account with fewer than three orders in two years, because
  nl.account_cadence cannot work out a usual gap from two orders. So the
  figure is accounts that had a rhythm and stopped, not every dead account.
*/
import type { Db } from '../db/types.ts';
import { links } from './links.ts';
import type { Figure, RiskSection } from './types.ts';

interface RiskRow {
	today: string;
	open_lines: number;
	no_supply: number;
	no_supply_value: number;
	late_supply_docs: number;
	late_supply_past_due: number;
	late_supply_slipped: number;
	worst_days_late: number | null;
	queue_waiting: number;
	queue_oldest: string | null;
	quiet_accounts: number;
	quiet_revenue: number;
	quiet_worst_days: number | null;
	accounts: number;
}

/*
  One trip. Each subquery is a count over a view this app already reads
  elsewhere, and every one of them is meant to be a small number: if "what is
  at risk" is a big number then the page has done its job and the business
  has not.
*/
const RISK_SQL = `
	select
		nl.today()::text                                                             as today,
		(select count(*) from nl.open_line_projection)::int                          as open_lines,
		(select count(*) from nl.open_line_projection where status = 'no_supply')::int
		                                                                             as no_supply,
		(select coalesce(sum(open_value), 0) from nl.open_line_projection
		  where status = 'no_supply')                                                as no_supply_value,
		(select count(*) from nl.procurement_late_supply)::int                        as late_supply_docs,
		(select count(*) from nl.procurement_late_supply where past_due)::int         as late_supply_past_due,
		(select count(*) from nl.procurement_late_supply where slipped)::int          as late_supply_slipped,
		(select max(days_late) from nl.procurement_late_supply)                       as worst_days_late,
		(select count(*) from nl.agent_queue)::int                                    as queue_waiting,
		(select min(created_at)::date::text from nl.agent_queue)                      as queue_oldest,
		(select count(*) from nl.account_list where gone_quiet)::int                   as quiet_accounts,
		(select coalesce(sum(revenue_last_year), 0) from nl.account_list
		  where gone_quiet)                                                          as quiet_revenue,
		(select max(days_quiet) from nl.account_list where gone_quiet)                as quiet_worst_days,
		(select count(*) from nl.account_list where not closed)::int                  as accounts`;

function money(value: number): string {
	const size = Math.abs(value);
	const sign = value < 0 ? '-' : '';
	if (size >= 1_000_000) return `${sign}$${(size / 1_000_000).toFixed(1)}M`;
	if (size >= 1_000) return `${sign}$${Math.round(size / 1_000)}K`;
	return `${sign}$${Math.round(size)}`;
}

/** Whole days between two ISO dates, which is all this needs. */
function daysBetween(fromIso: string, toIso: string): number {
	return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export async function readRisk(db: Db, userId: number): Promise<RiskSection> {
	const [r] = await db.asUser(userId, (tx) => tx.query<RiskRow>(RISK_SQL));

	const noSupply = Number(r.no_supply);
	const openLines = Number(r.open_lines);
	const lateDocs = Number(r.late_supply_past_due);
	const queue = Number(r.queue_waiting);
	const quiet = Number(r.quiet_accounts);

	const figures: Figure[] = [
		{
			id: 'no-supply',
			label: 'Order lines with no supply at all',
			value: noSupply,
			unit: 'count',
			compare:
				openLines === 0
					? 'there are no open order lines'
					: `of ${openLines} open lines, worth ${money(Number(r.no_supply_value))}. Nothing on hand and ` +
						`nothing on order reaches them`,
			source: 'the time-phased forecast',
			href: links.noSupply(),
			hrefLabel: 'Which lines',
			tone: noSupply > 0 ? 'danger' : 'plain',
			toneWord: noSupply > 0 ? 'nothing coming' : undefined
		},
		{
			id: 'late-supply',
			label: 'Supply orders past their due date',
			value: lateDocs,
			unit: 'count',
			compare:
				Number(r.late_supply_docs) === 0
					? 'no purchase or production order is late or has slipped'
					: `of ${Number(r.late_supply_docs)} late or slipped, ${Number(r.late_supply_slipped)} moved ` +
						`after they were promised` +
						(r.worst_days_late ? `, the worst by ${Number(r.worst_days_late)} days` : ''),
			source: 'purchase and production orders, ERP and desk',
			href: links.riskTopic('late-supply'),
			hrefLabel: 'Which orders',
			tone: lateDocs > 0 ? 'warn' : 'plain',
			toneWord: lateDocs > 0 ? 'overdue' : undefined
		},
		{
			id: 'queue',
			label: 'Agent proposals nobody has answered',
			value: queue,
			unit: 'count',
			compare:
				queue === 0
					? 'the queue is empty: nothing an agent proposed is waiting on a person'
					: r.queue_oldest
						? `the oldest has waited ${daysBetween(r.queue_oldest, r.today)} days, since ${r.queue_oldest}`
						: 'all of them arrived today',
			source: 'the one approval queue',
			href: links.queue(),
			hrefLabel: 'The queue',
			tone: queue > 0 ? 'warn' : 'plain',
			toneWord: queue > 0 ? 'waiting on a person' : undefined
		},
		{
			id: 'quiet',
			label: 'Accounts that had a rhythm and stopped',
			value: quiet,
			unit: 'count',
			compare:
				quiet === 0
					? `none of ${Number(r.accounts)} open accounts is past twice its usual gap between orders`
					: `of ${Number(r.accounts)} open accounts, worth ${money(Number(r.quiet_revenue))} last year` +
						(r.quiet_worst_days ? `, the quietest silent for ${Number(r.quiet_worst_days)} days` : ''),
			source: "each account's own order rhythm",
			href: links.quietAccounts(),
			hrefLabel: 'Which accounts',
			tone: quiet > 0 ? 'warn' : 'plain',
			toneWord: quiet > 0 ? 'gone quiet' : undefined
		}
	];

	return { today: r.today, figures };
}

// ---------------------------------------------------------------------------
// Late purchase and production orders: the one risk topic with no page yet
// ---------------------------------------------------------------------------

export interface LateSupplyRow {
	source: string;
	documentNo: string;
	lineNo: number | null;
	itemNo: string;
	description: string;
	quantity: number;
	dueOn: string;
	originalPromisedOn: string | null;
	pastDue: boolean;
	slipped: boolean;
	daysLate: number | null;
	daysSlipped: number | null;
	vendorNo: string | null;
	vendorName: string | null;
	partHref: string;
	vendorHref: string | null;
	/** Where the part's own short position is shown. */
	forecastHref: string;
}

export interface LateSupplyDetail {
	today: string;
	rows: LateSupplyRow[];
	note: string;
}

export async function readLateSupply(db: Db, userId: number): Promise<LateSupplyDetail> {
	return db.asUser(userId, async (tx) => {
		const [{ today }] = await tx.sql<{ today: string }>`select nl.today()::text as today`;
		/*
		  nl.procurement_late_supply carries the document, the part and the two
		  dates. The vendor is not on it, so it is joined here: for an ERP
		  purchase line off nl.open_purchase_lines, and for a desk order off the
		  order. Both are left joins, because a production order has no vendor.
		*/
		const rows = await tx.sql<{
			source: string;
			document_no: string;
			line_no: number | null;
			item_no: string;
			description: string;
			quantity: number;
			due_on: string;
			original_promised_on: string | null;
			past_due: boolean;
			slipped: boolean;
			days_late: number | null;
			days_slipped: number | null;
			vendor_no: string | null;
			vendor_name: string | null;
		}>`
			select l.source, l.document_no, l.line_no, l.item_no, i.description, l.quantity,
			       l.due_on::text as due_on, l.original_promised_on::text as original_promised_on,
			       l.past_due, l.slipped, l.days_late, l.days_slipped,
			       coalesce(pl.vendor_no, po.vendor_no) as vendor_no,
			       v.name as vendor_name
			from nl.procurement_late_supply l
			join nl.items i on i.item_no = l.item_no
			left join nl.open_purchase_lines pl
			  on l.source = 'purchase' and pl.document_no = l.document_no and pl.line_no = l.line_no
			left join nl.procurement_orders po
			  on l.source = 'desk' and po.order_no = l.document_no
			left join nl.vendors v on v.vendor_no = coalesce(pl.vendor_no, po.vendor_no)
			order by l.past_due desc, l.days_late desc nulls last, l.due_on
			limit 100`;

		return {
			today,
			note:
				'Purchase and production orders that are past their own due date, or that moved after they were ' +
				'first promised. Past due does not mean cancelled: the forecast still expects a past due order to ' +
				'arrive, a fixed number of days from today.',
			rows: rows.map((r) => ({
				source: r.source,
				documentNo: r.document_no,
				lineNo: r.line_no === null ? null : Number(r.line_no),
				itemNo: r.item_no,
				description: r.description,
				quantity: Number(r.quantity),
				dueOn: r.due_on,
				originalPromisedOn: r.original_promised_on,
				pastDue: r.past_due === true,
				slipped: r.slipped === true,
				daysLate: r.days_late === null ? null : Number(r.days_late),
				daysSlipped: r.days_slipped === null ? null : Number(r.days_slipped),
				vendorNo: r.vendor_no,
				vendorName: r.vendor_name,
				partHref: links.part(r.item_no),
				vendorHref: r.vendor_no ? links.vendor(r.vendor_no) : null,
				forecastHref: links.lateSupply()
			}))
		};
	});
}
