/*
  Question two: are we keeping our promises?

  Three promises, three sources, and none of them invented:

  1. A commitment window. nl.commitment_progress derives kept, pushed and
     broken from the ledger and from the one answer a rep gives when a window
     closes short (docs/sql.md). Only windows that have already closed are
     counted: a window still open has not been kept or broken yet.
  2. A ship date. nl.open_line_projection holds the date we gave the customer
     (ship_date) and the date the parts will actually be there
     (projected_ship_date), with days_late as the difference. That is a promise
     about to be broken rather than one already broken, which is the version
     somebody can still do something about.
  3. A quote. The only request in this database with a time on it is an
     emailed one: nl.rfq_drafts.created_at is when it landed and decided_at is
     when a person approved or rejected the draft quote. So turnaround here
     means emailed requests only, and the figure says so. A quote somebody
     typed has no request to measure from, and this page does not guess one.
*/
import type { Db } from '../db/types.ts';
import { links } from './links.ts';
import type { Figure, PromiseSection, SlippingAccount } from './types.ts';

interface WindowRow {
	today: string;
	closed: number;
	kept: number;
	pushed: number;
	broken: number;
	unanswered: number;
	committed: number;
	kept_value: number;
	missed_value: number;
	delivered: number;
}

const WINDOWS_SQL = `
	with clock as (select nl.today() as today),
	closed as (
		select p.*
		from nl.commitment_progress p, clock k
		where p.ends_on > k.today - 365 and p.ends_on <= k.today
	)
	select (select today::text from clock)                                          as today,
	       count(*)::int                                                            as closed,
	       count(*) filter (where status = 'kept')::int                             as kept,
	       count(*) filter (where status = 'pushed')::int                           as pushed,
	       count(*) filter (where status = 'broken')::int                           as broken,
	       count(*) filter (where needs_outcome)::int                               as unanswered,
	       coalesce(sum(committed_value), 0)                                        as committed,
	       coalesce(sum(committed_value) filter (where status = 'kept'), 0)          as kept_value,
	       coalesce(sum(committed_value) filter (where status in ('pushed', 'broken')), 0)
	                                                                                as missed_value,
	       coalesce(sum(delivered), 0)                                              as delivered
	from closed`;

interface ShipRow {
	open_lines: number;
	late_lines: number;
	no_supply: number;
	open_value: number;
	late_value: number;
	worst_days: number | null;
}

const SHIP_SQL = `
	select count(*)::int                                            as open_lines,
	       count(*) filter (where l.days_late > 0)::int              as late_lines,
	       count(*) filter (where l.status = 'no_supply')::int       as no_supply,
	       coalesce(sum(l.open_value), 0)                            as open_value,
	       coalesce(sum(l.open_value) filter (where l.days_late > 0), 0) as late_value,
	       max(l.days_late) filter (where l.days_late > 0)           as worst_days
	from nl.open_line_projection l`;

interface QuoteRow {
	answered: number;
	median_hours: number | null;
	slowest_hours: number | null;
	waiting: number;
	oldest_waiting_hours: number | null;
}

/*
  Turnaround on emailed quote requests. The window is 90 days rather than a
  year because the figure is meant to describe how the desk is working now.
  A median, not a mean: one request that sat over a holiday would move a mean
  and tell nobody anything.
*/
const QUOTE_SQL = `
	with clock as (select nl.today() as today),
	answered as (
		select extract(epoch from (d.decided_at - d.created_at)) / 3600.0 as hours
		from nl.rfq_drafts d, clock k
		where d.status = 'approved'
		  and d.decided_at is not null
		  and d.decided_at > (k.today - 90)::timestamptz
	),
	open_now as (
		select extract(epoch from (now() - d.created_at)) / 3600.0 as hours
		from nl.rfq_drafts d
		where d.status = 'draft'
	)
	select (select count(*) from answered)::int                                as answered,
	       (select round((percentile_cont(0.5) within group (order by hours))::numeric, 1)
	          from answered)                                                   as median_hours,
	       (select round(max(hours)::numeric, 1) from answered)                as slowest_hours,
	       (select count(*) from open_now)::int                                as waiting,
	       (select round(max(hours)::numeric, 1) from open_now)                as oldest_waiting_hours`;

interface SlippingRow {
	customer_no: string;
	customer_name: string;
	windows: number;
	pushed: number;
	broken: number;
	committed: number;
	delivered: number;
	last_closed_on: string;
}

/*
  Accounts whose recently closed windows did not hold. Ordered by how many
  went wrong and then by the money, so "the customer whose last three windows
  slipped" is the first row rather than something to hunt for.
*/
const SLIPPING_SQL = `
	with clock as (select nl.today() as today),
	closed as (
		select p.customer_no, p.status, p.committed_value, p.delivered, p.ends_on
		from nl.commitment_progress p, clock k
		where p.ends_on > k.today - 365 and p.ends_on <= k.today
	)
	select c.customer_no,
	       cu.name                                                    as customer_name,
	       count(*)::int                                              as windows,
	       count(*) filter (where c.status = 'pushed')::int           as pushed,
	       count(*) filter (where c.status = 'broken')::int            as broken,
	       coalesce(sum(c.committed_value) filter (where c.status in ('pushed', 'broken')), 0)
	                                                                  as committed,
	       coalesce(sum(c.delivered) filter (where c.status in ('pushed', 'broken')), 0)
	                                                                  as delivered,
	       max(c.ends_on)::text                                       as last_closed_on
	from closed c
	join nl.customers cu on cu.customer_no = c.customer_no
	group by c.customer_no, cu.name
	having count(*) filter (where c.status in ('pushed', 'broken')) > 0
	order by count(*) filter (where c.status in ('pushed', 'broken')) desc,
	         coalesce(sum(c.committed_value) filter (where c.status in ('pushed', 'broken')), 0) desc,
	         c.customer_no
	limit $1`;

function money(value: number): string {
	const size = Math.abs(value);
	const sign = value < 0 ? '-' : '';
	if (size >= 1_000_000) return `${sign}$${(size / 1_000_000).toFixed(1)}M`;
	if (size >= 1_000) return `${sign}$${Math.round(size / 1_000)}K`;
	return `${sign}$${Math.round(size)}`;
}

export async function readPromises(db: Db, userId: number): Promise<PromiseSection> {
	return db.asUser(userId, async (tx) => {
		const [w] = await tx.query<WindowRow>(WINDOWS_SQL);
		const [s] = await tx.query<ShipRow>(SHIP_SQL);
		const [q] = await tx.query<QuoteRow>(QUOTE_SQL);
		const slipping = await tx.query<SlippingRow>(SLIPPING_SQL, [12]);

		const closed = Number(w.closed);
		const kept = Number(w.kept);
		const missed = Number(w.pushed) + Number(w.broken);
		const keptShare = closed === 0 ? 0 : kept / closed;

		const openLines = Number(s.open_lines);
		const lateLines = Number(s.late_lines);

		const figures: Figure[] = [
			{
				id: 'windows-kept',
				label: 'Commitment windows kept',
				value: kept,
				unit: 'count',
				compare:
					closed === 0
						? 'no window has closed in the last year, so nothing has been kept or missed yet'
						: `of ${closed} that closed in the last year, worth ${money(Number(w.kept_value))} of ` +
							`${money(Number(w.committed))} committed`,
				source: 'the commitment board',
				href: links.promises({ outcome: 'kept' }),
				hrefLabel: 'Which ones',
				tone: closed > 0 && keptShare < 0.8 ? 'warn' : 'plain',
				toneWord: closed > 0 && keptShare < 0.8 ? `${Math.round(keptShare * 100)}% of windows` : undefined
			},
			{
				id: 'windows-missed',
				label: 'Pushed or broken',
				value: missed,
				unit: 'count',
				compare:
					closed === 0
						? 'nothing has closed in the last year'
						: `${Number(w.pushed)} pushed and ${Number(w.broken)} broken, worth ` +
							`${money(Number(w.missed_value))} promised against ${money(Number(w.delivered))} delivered`,
				source: 'the rep answer on each closed window',
				href: links.promises({ outcome: 'broken' }),
				hrefLabel: 'Who slipped',
				tone: missed > 0 ? 'warn' : 'plain',
				toneWord: missed > 0 ? 'answered short' : undefined
			},
			{
				id: 'late-lines',
				label: 'Open lines that will miss the date we gave',
				value: lateLines,
				unit: 'count',
				compare:
					openLines === 0
						? 'there are no open order lines'
						: `of ${openLines} open lines, worth ${money(Number(s.late_value))} of ` +
							`${money(Number(s.open_value))} on the book` +
							(s.worst_days ? `, the worst by ${Number(s.worst_days)} days` : ''),
				source: "the forecast over this morning's export",
				href: links.late(),
				hrefLabel: 'Which lines',
				tone: lateLines > 0 ? 'danger' : 'plain',
				toneWord: lateLines > 0 ? 'already known to be late' : undefined
			},
			{
				id: 'quote-turnaround',
				label: 'Quote turnaround, emailed requests',
				value: Number(q.median_hours ?? 0),
				unit: 'hours',
				compare:
					Number(q.answered) === 0
						? 'no emailed request has been answered in the last 90 days, so there is nothing to time yet' +
							(Number(q.waiting) > 0 ? `, and ${Number(q.waiting)} are waiting` : '')
						: `median over ${Number(q.answered)} answered in the last 90 days; the slowest took ` +
							`${Number(q.slowest_hours)} hours` +
							(Number(q.waiting) > 0
								? `, and ${Number(q.waiting)} are still waiting, the oldest ${Number(q.oldest_waiting_hours)} hours`
								: ''),
				source: 'emailed requests, from landing to the quote being approved',
				href: links.quoteRequests(),
				hrefLabel: 'The requests',
				tone: Number(q.waiting) > 0 ? 'warn' : 'plain',
				toneWord: Number(q.waiting) > 0 ? 'some still waiting' : undefined
			}
		];

		return {
			today: w.today,
			figures,
			slipping: slipping.map(
				(r): SlippingAccount => ({
					customerNo: r.customer_no,
					customerName: r.customer_name,
					windows: Number(r.windows),
					pushed: Number(r.pushed),
					broken: Number(r.broken),
					committed: Number(r.committed),
					delivered: Number(r.delivered),
					lastClosedOn: r.last_closed_on,
					href: links.promises({ customer: r.customer_no }),
					accountHref: links.account(r.customer_no)
				})
			)
		};
	});
}

// ---------------------------------------------------------------------------
// The segment page: windows by outcome, and one account's windows
// ---------------------------------------------------------------------------

export interface WindowRowOut {
	id: number;
	title: string;
	customerNo: string;
	customerName: string;
	status: string;
	committed: number;
	delivered: number;
	deliveredRatio: number;
	startsOn: string;
	endsOn: string;
	daysSinceClose: number | null;
	outcomeNote: string;
	needsOutcome: boolean;
	/** The commitment's own page, which lists the invoice lines that counted. */
	href: string;
	accountHref: string;
}

export interface PromiseDetail {
	today: string;
	outcome: 'kept' | 'pushed' | 'broken' | null;
	customerNo: string | null;
	customerName: string | null;
	rows: WindowRowOut[];
	slipping: SlippingAccount[];
	/** What this list is, in one line, including the window it covers. */
	note: string;
}

export async function readPromiseDetail(
	db: Db,
	userId: number,
	options: { outcome: 'kept' | 'pushed' | 'broken' | null; customer: string | null }
): Promise<PromiseDetail> {
	return db.asUser(userId, async (tx) => {
		const [{ today }] = await tx.sql<{ today: string }>`select nl.today()::text as today`;

		/*
		  One query for both filters. The parameters are compared inside the
		  where clause rather than assembled into it, so the statement is the
		  same shape however a person arrived here.
		*/
		const rows = await tx.sql<{
			id: number;
			title: string;
			customer_no: string;
			customer_name: string;
			status: string;
			committed_value: number;
			delivered: number;
			delivered_ratio: number;
			starts_on: string;
			ends_on: string;
			days_since_close: number | null;
			outcome_note: string;
			needs_outcome: boolean;
		}>`
			select p.id, p.title, p.customer_no, c.name as customer_name, p.status,
			       p.committed_value, p.delivered, p.delivered_ratio,
			       p.starts_on::text as starts_on, p.ends_on::text as ends_on,
			       p.days_since_close, coalesce(p.outcome_note, '') as outcome_note, p.needs_outcome
			from nl.commitment_progress p
			join nl.customers c on c.customer_no = p.customer_no
			where p.ends_on > nl.today() - 365
			  and p.ends_on <= nl.today()
			  and (${options.outcome}::text is null or p.status = ${options.outcome}::text)
			  and (${options.customer}::text is null or p.customer_no = ${options.customer}::text)
			order by p.ends_on desc, p.committed_value desc
			limit 100`;

		const slipping = await tx.query<SlippingRow>(SLIPPING_SQL, [12]);
		const customerName = options.customer
			? (rows.find((r) => r.customer_no === options.customer)?.customer_name ?? options.customer)
			: null;

		const what = options.outcome ? `windows answered ${options.outcome}` : 'windows that closed';
		return {
			today,
			outcome: options.outcome,
			customerNo: options.customer,
			customerName,
			note:
				`${what} in the year to ${today}` +
				(options.customer ? `, for ${customerName}` : '') +
				'. A window is kept when the ledger shows 95% of what was committed, or when the rep said so.',
			rows: rows.map((r) => ({
				id: Number(r.id),
				title: r.title,
				customerNo: r.customer_no,
				customerName: r.customer_name,
				status: r.status,
				committed: Number(r.committed_value),
				delivered: Number(r.delivered),
				deliveredRatio: Number(r.delivered_ratio),
				startsOn: r.starts_on,
				endsOn: r.ends_on,
				daysSinceClose: r.days_since_close === null ? null : Number(r.days_since_close),
				outcomeNote: r.outcome_note,
				needsOutcome: r.needs_outcome === true,
				href: links.commitment(Number(r.id)),
				accountHref: links.account(r.customer_no)
			})),
			slipping: slipping.map(
				(r): SlippingAccount => ({
					customerNo: r.customer_no,
					customerName: r.customer_name,
					windows: Number(r.windows),
					pushed: Number(r.pushed),
					broken: Number(r.broken),
					committed: Number(r.committed),
					delivered: Number(r.delivered),
					lastClosedOn: r.last_closed_on,
					href: links.promises({ customer: r.customer_no }),
					accountHref: links.account(r.customer_no)
				})
			)
		};
	});
}
