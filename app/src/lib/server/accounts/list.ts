// The accounts list: nl.account_list, searched, filtered, sorted and paged
// in SQL. Every value from the URL travels as a query parameter; the sort is
// picked from a fixed list, never pasted into the SQL.
import type { Db } from '../db/types.ts';
import type {
	AccountFilters,
	AccountPage,
	AccountRow,
	AccountSort
} from '$lib/components/accounts/types';

export const PAGE_SIZE = 50;

const SORTS: AccountSort[] = ['revenue', 'quiet', 'name'];

/**
 * Read the filters from the page's URL. Anything unexpected falls back to
 * the default, so a hand-edited URL never breaks the page.
 */
export function readFilters(params: URLSearchParams, defaultWho: 'mine' | 'all'): AccountFilters {
	const who = params.get('who');
	const sort = params.get('sort') as AccountSort | null;
	const page = Number(params.get('page') ?? '1');
	return {
		q: (params.get('q') ?? '').trim().slice(0, 80),
		who: who === 'mine' || who === 'all' ? who : defaultWho,
		state: (params.get('state') ?? '').trim().slice(0, 10),
		group: (params.get('group') ?? '').trim().slice(0, 10),
		quiet: params.get('quiet') === '1',
		open: params.get('open') === '1',
		sort: sort && SORTS.includes(sort) ? sort : 'revenue',
		page: Number.isSafeInteger(page) && page >= 1 && page <= 1000 ? page : 1
	};
}

/** Escape the characters ILIKE treats as wildcards, so a search for "50%" means 50%. */
function likeText(text: string): string {
	return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

interface ListRow {
	customer_no: string;
	name: string;
	parent_name: string | null;
	branch_count: number;
	city: string;
	state: string;
	country: string;
	owner_name: string | null;
	agency_name: string | null;
	price_group_label: string;
	blocked: boolean;
	closed: boolean;
	revenue_ytd: number;
	revenue_prior_ytd: number;
	last_order_on: string | null;
	typical_gap_days: number | null;
	days_quiet: number | null;
	gone_quiet: boolean;
	open_commitments: number;
	open_committed: number;
	open_steps: number;
	overdue_steps: number;
	primary_contact_name: string | null;
	total: number;
}

export async function listAccounts(db: Db, userId: number, filters: AccountFilters): Promise<AccountPage> {
	const search = filters.q ? `%${likeText(filters.q)}%` : null;
	const prefix = filters.q ? `${likeText(filters.q)}%` : null;
	const offset = (filters.page - 1) * PAGE_SIZE;

	const rows = await db.asUser(userId, (tx) =>
		tx.sql<ListRow>`
			select a.customer_no, a.name, a.parent_name, a.branch_count, a.city, a.state, a.country,
			       a.owner_name, a.agency_name, a.price_group_label, a.blocked, a.closed,
			       a.revenue_ytd, a.revenue_prior_ytd, a.last_order_on, a.typical_gap_days, a.days_quiet,
			       a.gone_quiet, a.open_commitments, a.open_committed, a.open_steps, a.overdue_steps,
			       a.primary_contact_name,
			       -- The number of matches before paging, carried on every row.
			       (count(*) over ())::int as total
			from nl.account_list a
			where (${filters.who}::text <> 'mine' or a.owner_id = ${userId}::int)
			  and (${search}::text is null
			       or a.name ilike ${search}::text
			       or a.city ilike ${search}::text
			       or a.customer_no ilike ${prefix}::text)
			  and (${filters.state}::text = '' or a.state = ${filters.state}::text)
			  and (${filters.group}::text = '' or a.price_group = ${filters.group}::text)
			  and (not ${filters.quiet}::boolean or a.gone_quiet)
			  and (not ${filters.open}::boolean or a.open_commitments > 0)
			order by
			  case when ${filters.sort}::text = 'name' then a.name end,
			  case when ${filters.sort}::text = 'quiet' then a.days_quiet end desc nulls last,
			  case when ${filters.sort}::text = 'revenue' then a.revenue_ytd end desc,
			  a.revenue_last_year desc,
			  a.name,
			  a.customer_no
			limit ${PAGE_SIZE} offset ${offset}`
	);

	return {
		rows: rows.map(toRow),
		total: rows[0]?.total ?? 0,
		page: filters.page,
		pageSize: PAGE_SIZE
	};
}

function toRow(r: ListRow): AccountRow {
	return {
		customerNo: r.customer_no,
		name: r.name,
		parentName: r.parent_name,
		branchCount: r.branch_count,
		city: r.city,
		state: r.state,
		country: r.country,
		ownerName: r.owner_name,
		agencyName: r.agency_name,
		priceGroupLabel: r.price_group_label,
		blocked: r.blocked,
		closed: r.closed,
		revenueYtd: r.revenue_ytd,
		revenuePriorYtd: r.revenue_prior_ytd,
		lastOrderOn: r.last_order_on,
		typicalGapDays: r.typical_gap_days,
		daysQuiet: r.days_quiet,
		goneQuiet: r.gone_quiet,
		openCommitments: r.open_commitments,
		openCommitted: r.open_committed,
		openSteps: r.open_steps,
		overdueSteps: r.overdue_steps,
		primaryContact: r.primary_contact_name
	};
}

/** The choices for the state and price group filters. */
export async function listFilterOptions(
	db: Db,
	userId: number
): Promise<{ states: string[]; groups: { code: string; label: string }[] }> {
	return db.asUser(userId, async (tx) => {
		const states = await tx.sql<{ state: string }>`
			select distinct state from nl.customers where state <> '' order by state`;
		const groups = await tx.sql<{ code: string; label: string }>`
			select code, label from nl.price_groups order by discount`;
		return { states: states.map((s) => s.state), groups };
	});
}
