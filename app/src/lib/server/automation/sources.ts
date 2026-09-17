// The reviewed query behind each trigger. People never write SQL: a rule
// picks one of these and adds conditions on the columns listed in
// $lib/automation/catalog.ts.
//
// Every source returns the same fixed columns, plus one column per field:
//   subject_key      what "once per subject" means for this trigger
//   customer_no      the account the action is about
//   customer_name
//   commitment_id    null when the subject is not a commitment
//   record_owner_id  who owns the thing that matched
//   headline         a short label for the match
import type { TriggerKey } from '$lib/automation/catalog';

export interface Source {
	sql: string;
	/** A safe ORDER BY over the source's own columns: the most urgent first. */
	orderBy: string;
}

export const SOURCES: Record<TriggerKey, Source> = {
	window_closed_short: {
		sql: `
			select 'commitment:' || p.id as subject_key,
			       p.customer_no, cu.name as customer_name, p.id as commitment_id,
			       p.owner_id as record_owner_id, p.title as headline,
			       p.days_since_close, p.committed_value,
			       p.committed_value - p.delivered as shortfall,
			       round(p.delivered_ratio * 100, 1) as delivered_pct,
			       p.confidence, p.owner_id
			from nl.commitment_progress p
			join nl.customers cu on cu.customer_no = p.customer_no
			where p.needs_outcome`,
		orderBy: 'shortfall desc, commitment_id'
	},
	commitment_behind_pace: {
		sql: `
			select 'commitment:' || p.id || ':behind' as subject_key,
			       p.customer_no, cu.name as customer_name, p.id as commitment_id,
			       p.owner_id as record_owner_id, p.title as headline,
			       round((p.window_elapsed_ratio - p.delivered_ratio) * 100, 1) as gap_pts,
			       round(p.window_elapsed_ratio * 100, 1) as elapsed_pct,
			       round(p.delivered_ratio * 100, 1) as delivered_pct,
			       p.ends_on - (select nl.today()) as days_left,
			       p.committed_value, p.confidence, p.owner_id
			from nl.commitment_progress p
			join nl.customers cu on cu.customer_no = p.customer_no
			where not p.is_settled
			  and p.starts_on <= (select nl.today())
			  and p.ends_on >= (select nl.today())
			  and p.window_elapsed_ratio > p.delivered_ratio`,
		orderBy: 'gap_pts desc, commitment_id'
	},
	account_gone_quiet: {
		// The subject includes the last order date, so an account that orders
		// again and then goes quiet again gets a fresh reminder.
		sql: `
			select 'account:' || a.customer_no || ':' || a.last_order_on as subject_key,
			       a.customer_no, cu.name as customer_name, null::bigint as commitment_id,
			       cu.owner_id as record_owner_id, cu.name as headline,
			       a.days_quiet, a.typical_gap_days, a.quiet_ratio, a.longest_gap_days, a.orders_2y,
			       coalesce(r.revenue_12m, 0) as revenue_12m,
			       cu.owner_id
			from nl.account_cadence a
			join nl.customers cu on cu.customer_no = a.customer_no
			left join lateral (
			  select sum(i.subtotal) as revenue_12m
			  from nl.invoices i
			  where i.customer_no = a.customer_no
			    and i.posted_on > (select nl.today()) - 365
			) r on true
			where not cu.closed and not cu.blocked`,
		orderBy: 'revenue_12m desc, customer_no'
	},
	// Workflow D's allocation view (migration 0010). The ship date is part
	// of the subject, so a line that gets a new date can fire again.
	order_line_at_risk: {
		sql: `
			select 'line:' || a.document_no || ':' || a.line_no || ':' || a.ship_date as subject_key,
			       a.customer_no, cu.name as customer_name, null::bigint as commitment_id,
			       cu.owner_id as record_owner_id,
			       a.document_no || ' line ' || a.line_no || ', ' || a.item_no as headline,
			       a.ship_date - (select nl.today()) as days_to_ship,
			       a.short as short_qty, a.open_value as line_value,
			       cu.owner_id
			from nl.open_line_allocation a
			join nl.customers cu on cu.customer_no = a.customer_no
			where a.bucket in ('at_risk', 'past_due')`,
		orderBy: 'days_to_ship, line_value desc, subject_key'
	}
};
