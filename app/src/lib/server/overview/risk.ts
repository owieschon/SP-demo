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
import type { Db, Tx } from '../db/types.ts';
import { links } from './links.ts';
import type {
	BeyondAuthorityRow,
	CoverageDetail,
	CoverageSection,
	Figure,
	GapRow,
	RiskSection
} from './types.ts';

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
  One trip, and one pass per view.

  The first version asked each view once per figure: four scans of
  nl.open_line_projection, three of nl.procurement_late_supply and three of
  nl.account_list, all of which are expensive views. That was 1,371 ms on the
  small world, nearly all of it the same rows read ten times. Each view now
  gets one CTE and the figures are `filter` clauses over it.

  Every one of these is meant to be a small number: if "what is at risk" is a
  big number then the page has done its job and the business has not.
*/
const RISK_SQL = `
	with lines as (
		select count(*)::int                                            as open_lines,
		       count(*) filter (where status = 'no_supply')::int          as no_supply,
		       coalesce(sum(open_value) filter (where status = 'no_supply'), 0) as no_supply_value
		from nl.open_line_projection
	),
	supply as (
		select count(*)::int                                            as docs,
		       count(*) filter (where past_due)::int                     as past_due,
		       count(*) filter (where slipped)::int                      as slipped,
		       max(days_late)                                            as worst_days_late
		from nl.procurement_late_supply
	),
	queue as (
		select count(*)::int                                            as waiting,
		       min(created_at)::date::text                               as oldest
		from nl.agent_queue
	),
	book as (
		select count(*) filter (where gone_quiet)::int                   as quiet_accounts,
		       coalesce(sum(revenue_last_year) filter (where gone_quiet), 0) as quiet_revenue,
		       max(days_quiet) filter (where gone_quiet)                 as quiet_worst_days,
		       count(*) filter (where not closed)::int                   as accounts
		from nl.account_list
	)
	select nl.today()::text as today,
	       l.open_lines, l.no_supply, l.no_supply_value,
	       s.docs as late_supply_docs, s.past_due as late_supply_past_due,
	       s.slipped as late_supply_slipped, s.worst_days_late,
	       q.waiting as queue_waiting, q.oldest as queue_oldest,
	       b.quiet_accounts, b.quiet_revenue, b.quiet_worst_days, b.accounts
	from lines l, supply s, queue q, book b`;

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
	const { risk: r, coverage } = await db.asUser(userId, async (tx) => ({
		risk: (await tx.query<RiskRow>(RISK_SQL))[0],
		coverage: await readCoverageFigures(tx)
	}));

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

	return { today: r.today, figures, coverage };
}

// ---------------------------------------------------------------------------
// Coverage of responsibility: who is answering for what
// ---------------------------------------------------------------------------

/*
  The kinds of gap, in the order an executive would ask about them, with the
  authority question last because it is the only one that is not about scope.

  Feature detection first. nl.responsibility_gaps is this migration's own view
  and nl.highest_ceiling its own function, but both read the roles model
  (nl.user_scope, nl.authority_grants), and a roles-gaps branch is adding the
  same idea as kinds on nl.work_waiting_for. So: if the view is not there, the
  whole section is left out silently rather than shown as four zeros, which
  would read as good news.
*/
const GAP_KINDS = [
	{ kind: 'account' as const, one: 'account', many: 'Accounts nobody is answerable for' },
	{ kind: 'part_family' as const, one: 'part family', many: 'Part families nobody plans' },
	{ kind: 'mailbox' as const, one: 'inbox', many: 'Inboxes nobody reads' }
];

/** The amount authorities, and the queue each one decides. */
const AMOUNT_AUTHORITIES = [
	{
		authority: 'approve_quote',
		label: 'Approve a quote',
		what: 'drafted quotes waiting in the approval queue',
		source: 'rfq' as const
	},
	{
		authority: 'release_purchase_order',
		label: 'Release a purchase order',
		what: 'purchase requests the procurement desk proposed',
		source: 'purchase' as const
	}
];

interface GapCount {
	kind: string;
	count: number;
	amount: number;
}

/** Is the roles model, and this migration's view over it, in this database? */
async function gapsPresent(tx: Tx): Promise<boolean> {
	const [row] = await tx.sql<{ ok: boolean }>`
		select pg_catalog.to_regclass('nl.responsibility_gaps') is not null
		   and pg_catalog.to_regprocedure('nl.highest_ceiling(text)') is not null as ok`;
	return row?.ok === true;
}

/** The counts behind each amount authority: what is waiting above every ceiling. */
async function beyondAuthority(tx: Tx): Promise<BeyondAuthorityRow[]> {
	const out: BeyondAuthorityRow[] = [];
	for (const item of AMOUNT_AUTHORITIES) {
		const [row] = await tx.sql<{ ceiling: number | null; waiting: number; value: number }>`
			with top as (select nl.highest_ceiling(${item.authority}) as ceiling),
			items as (
				select q.value
				from nl.agent_queue q, top
				where q.source = ${item.source}
				  and top.ceiling is not null
				  and coalesce(q.value, 0) > top.ceiling
			)
			select (select ceiling from top)                        as ceiling,
			       (select count(*) from items)::int                as waiting,
			       (select coalesce(sum(value), 0) from items)      as value`;
		out.push({
			authority: item.authority,
			label: item.label,
			ceiling: row.ceiling === null ? null : Number(row.ceiling),
			waiting: Number(row.waiting),
			value: Number(row.value),
			what: item.what,
			href: links.queue(item.source)
		});
	}
	return out;
}

/** The four coverage figures, or null when the model is not here. */
async function readCoverageFigures(tx: Tx): Promise<CoverageSection | null> {
	if (!(await gapsPresent(tx))) return null;

	const counts = await tx.sql<GapCount>`
		select kind, count(*)::int as count, coalesce(sum(amount), 0) as amount
		from nl.responsibility_gaps
		group by kind`;
	const beyond = await beyondAuthority(tx);

	const figures: Figure[] = GAP_KINDS.map(({ kind, one, many }) => {
		const found = counts.find((c) => c.kind === kind);
		const count = found ? Number(found.count) : 0;
		const amount = found ? Number(found.amount) : 0;
		return {
			id: `coverage-${kind}`,
			label: many,
			value: count,
			unit: 'count' as const,
			compare:
				count === 0
					? `every live ${one} has somebody named against it`
					: amount > 0
						? `worth ${money(amount)} of invoice lines in the last year`
						: 'nothing has been billed against them in the last year',
			source: 'named scope, not oversight',
			href: links.coverage(kind),
			hrefLabel: 'Which ones',
			tone: count > 0 ? 'warn' : 'plain',
			toneWord: count > 0 ? 'nobody answers for them' : undefined
		};
	});

	// The authority gap, as one figure across the amount authorities, because
	// "a decision nobody can make" is one problem however it arrives.
	const stuck = beyond.reduce((sum, row) => sum + row.waiting, 0);
	const stuckValue = beyond.reduce((sum, row) => sum + row.value, 0);
	const uncapped = beyond.filter((row) => row.ceiling === null).map((row) => row.label);
	figures.push({
		id: 'coverage-authority',
		label: 'Decisions above every ceiling',
		value: stuck,
		unit: 'count',
		compare:
			stuck === 0
				? uncapped.length === beyond.length
					? 'somebody holds every amount authority with no ceiling, so nothing can be stuck above one'
					: 'nothing waiting is above the highest ceiling anybody active holds'
				: `worth ${money(stuckValue)}, waiting on an amount nobody active can approve`,
		source: 'live authority grants',
		href: links.coverage(),
		hrefLabel: 'What is stuck',
		tone: stuck > 0 ? 'danger' : 'plain',
		toneWord: stuck > 0 ? 'nobody can decide them' : undefined
	});

	return {
		figures,
		note:
			'Scope says who may see and touch a thing; this counts who is answerable for it. Holding a whole ' +
			'dimension is oversight, so the chief executive holding every account does not make an unowned ' +
			'account covered.'
	};
}

/** The list behind the coverage figures. `kind` opens one of the three. */
export async function readCoverage(
	db: Db,
	userId: number,
	kind: 'account' | 'part_family' | 'mailbox' | null
): Promise<CoverageDetail | null> {
	return db.asUser(userId, async (tx) => {
		if (!(await gapsPresent(tx))) return null;
		const [{ today }] = await tx.sql<{ today: string }>`select nl.today()::text as today`;

		const counts = await tx.sql<GapCount>`
			select kind, count(*)::int as count, coalesce(sum(amount), 0) as amount
			from nl.responsibility_gaps
			group by kind`;

		const rows = kind
			? await tx.sql<{
					kind: GapRow['kind'];
					ref: string;
					subject: string;
					why: string;
					amount: number;
					lines: number;
				}>`
					select kind, ref, subject, why, amount, lines
					from nl.responsibility_gaps
					where kind = ${kind}
					order by amount desc, lines desc, ref
					limit 200`
			: [];

		return {
			today,
			kind,
			counts: GAP_KINDS.map(({ kind: k, many }) => {
				const found = counts.find((c) => c.kind === k);
				return {
					kind: k,
					label: many,
					count: found ? Number(found.count) : 0,
					amount: found ? Number(found.amount) : 0,
					href: links.coverage(k)
				};
			}),
			rows: rows.map(
				(r): GapRow => ({
					kind: r.kind,
					ref: r.ref,
					subject: r.subject,
					why: r.why,
					amount: Number(r.amount),
					lines: Number(r.lines),
					// A part family and an inbox have no record page of their own;
					// an account does, and that is where somebody is assigned.
					href: r.kind === 'account' ? links.account(r.ref) : null,
					hrefLabel: r.kind === 'account' ? 'The account' : null
				})
			),
			beyondAuthority: await beyondAuthority(tx),
			note:
				'Named scope, not oversight. A principal who holds a whole dimension can see everything in it and ' +
				'is answerable for none of it, which is the right way round and is why this list is not empty.',
			peopleHref: links.people()
		};
	});
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
