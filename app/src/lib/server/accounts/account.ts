// One account: everything its page shows, in pieces the page can stream.
//
// getAccountHeader is awaited (the page cannot exist without it). The other
// readers each run in their own transaction and are handed to the page as
// promises, so each section appears when its own query is done.
//
// "Family" means the account plus every account billed to it
// (nl.customer_family) plus the head office it bills to
// (nl.customer_ancestors): a commitment on the head office counts this
// branch's orders, so it belongs on the branch's page too.
import type { Db } from '../db/types.ts';
import { place } from '$lib/format';
import type {
	AccountHeader,
	AccountNumbers,
	BuyerChoice,
	Contact,
	Deals,
	NextStep,
	Orders,
	Timeline
} from '$lib/components/accounts/types';

/** How many branches the header lists by name; the rest are counted. */
export const BRANCH_LIST_LIMIT = 40;
/** How many activities the timeline shows. */
export const TIMELINE_LIMIT = 60;

export async function getAccountHeader(db: Db, userId: number, customerNo: string): Promise<AccountHeader | null> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{
			customer_no: string;
			name: string;
			bill_to_no: string | null;
			parent_name: string | null;
			city: string;
			state: string;
			country: string;
			email_domain: string | null;
			owner_id: number | null;
			owner_name: string | null;
			agency_name: string | null;
			territory: string | null;
			price_group: string;
			price_group_label: string;
			discount: number;
			blocked: boolean;
			closed: boolean;
			ships_own_carrier: boolean;
			customer_since: string;
			branch_count: number;
			today: string;
		}>`
			select c.customer_no, c.name, c.bill_to_no, parent.name as parent_name,
			       c.city, c.state, c.country, c.email_domain,
			       c.owner_id, u.full_name as owner_name, a.name as agency_name, a.territory,
			       c.price_group, pg.label as price_group_label, pg.discount,
			       c.blocked, c.closed, c.ships_own_carrier, c.customer_since,
			       (select count(*)::int from nl.customers b where b.bill_to_no = c.customer_no) as branch_count,
			       nl.today() as today
			from nl.customers c
			join nl.price_groups pg on pg.code = c.price_group
			left join nl.customers parent on parent.customer_no = c.bill_to_no
			left join nl.users u on u.id = c.owner_id
			left join nl.agencies a on a.id = c.agency_id
			where c.customer_no = ${customerNo}`;
		if (!head) return null;

		const branches = await tx.sql<{
			customer_no: string;
			name: string;
			city: string;
			state: string;
			country: string;
			blocked: boolean;
		}>`
			select customer_no, name, city, state, country, blocked
			from nl.customers
			where bill_to_no = ${customerNo}
			order by blocked, name, customer_no
			limit ${BRANCH_LIST_LIMIT}`;

		const people = await tx.sql<{ id: number; full_name: string }>`
			select id, full_name from nl.users where active order by full_name`;

		return {
			customerNo: head.customer_no,
			name: head.name,
			billToNo: head.bill_to_no,
			parentName: head.parent_name,
			city: head.city,
			state: head.state,
			country: head.country,
			emailDomain: head.email_domain,
			ownerId: head.owner_id,
			ownerName: head.owner_name,
			agencyName: head.agency_name,
			agencyTerritory: head.territory,
			priceGroup: head.price_group,
			priceGroupLabel: head.price_group_label,
			discount: head.discount,
			blocked: head.blocked,
			closed: head.closed,
			shipsOwnCarrier: head.ships_own_carrier,
			customerSince: head.customer_since,
			today: head.today,
			branchCount: head.branch_count,
			branches: branches.map((b) => ({
				customerNo: b.customer_no,
				name: b.name,
				place: place(b.city, b.state, b.country),
				blocked: b.blocked
			})),
			people: people.map((p) => ({ id: p.id, fullName: p.full_name }))
		};
	});
}

/** Revenue, rhythm and open business, plus 24 months of revenue for the bars. */
export async function getAccountNumbers(db: Db, userId: number, customerNo: string): Promise<AccountNumbers> {
	return db.asUser(userId, async (tx) => {
		// The same figures the accounts list shows, from the same view.
		const [row] = await tx.sql<{
			revenue_ytd: number;
			revenue_prior_ytd: number;
			revenue_last_year: number;
			branch_count: number;
			last_order_on: string | null;
			typical_gap_days: number | null;
			days_quiet: number | null;
			gone_quiet: boolean;
			open_commitments: number;
			open_committed: number;
			open_expected: number;
		}>`
			select revenue_ytd, revenue_prior_ytd, revenue_last_year, branch_count, last_order_on,
			       typical_gap_days, days_quiet, gone_quiet, open_commitments, open_committed, open_expected
			from nl.account_list
			where customer_no = ${customerNo}`;

		// One bar per calendar month, the empty ones included.
		const months = await tx.sql<{ month: string; revenue: number }>`
			with span as (
			  select (date_trunc('month', nl.today()) - interval '23 months')::date as first_month,
			         nl.today() as today
			),
			series as (
			  select generate_series(s.first_month, s.today, interval '1 month')::date as month
			  from span s
			),
			sums as (
			  select date_trunc('month', i.posted_on)::date as month, sum(i.subtotal) as revenue
			  from nl.invoices i, span s
			  where i.customer_no = ${customerNo}
			    and i.posted_on >= s.first_month
			    and i.posted_on <= s.today
			  group by 1
			)
			select to_char(se.month, 'YYYY-MM-DD') as month, coalesce(su.revenue, 0) as revenue
			from series se
			left join sums su on su.month = se.month
			order by se.month`;

		let familyRevenueYtd: number | null = null;
		if (row && row.branch_count > 0) {
			const [family] = await tx.sql<{ revenue: number }>`
				select coalesce(sum(i.subtotal), 0) as revenue
				from nl.customer_family(${customerNo}) f
				join nl.invoices i on i.customer_no = f.customer_no
				where i.posted_on >= date_trunc('year', nl.today())::date
				  and i.posted_on <= nl.today()`;
			familyRevenueYtd = family.revenue;
		}

		return {
			revenueYtd: row?.revenue_ytd ?? 0,
			revenuePriorYtd: row?.revenue_prior_ytd ?? 0,
			revenueLastYear: row?.revenue_last_year ?? 0,
			familyRevenueYtd,
			lastOrderOn: row?.last_order_on ?? null,
			typicalGapDays: row?.typical_gap_days ?? null,
			daysQuiet: row?.days_quiet ?? null,
			goneQuiet: row?.gone_quiet ?? false,
			openCommitments: row?.open_commitments ?? 0,
			openCommitted: row?.open_committed ?? 0,
			openExpected: row?.open_expected ?? 0,
			months
		};
	});
}

/** Current people first (the primary on top), then the ones who left. */
export async function getContacts(db: Db, userId: number, customerNo: string): Promise<Contact[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			id: number;
			full_name: string;
			title: string;
			email: string | null;
			phone: string | null;
			mobile: string | null;
			notes: string;
			is_primary: boolean;
			left_on: string | null;
			can_edit: boolean;
			updated_at: Date;
		}>`
			select id, full_name, title, email, phone, mobile, notes, is_primary, left_on,
			       nl.may_change_contact(id) as can_edit, updated_at
			from nl.contacts
			where customer_no = ${customerNo}
			order by left_on is not null, is_primary desc, left_on desc, full_name, id`
	);
	return rows.map((r) => ({
		id: r.id,
		fullName: r.full_name,
		title: r.title,
		email: r.email,
		phone: r.phone,
		mobile: r.mobile,
		notes: r.notes,
		isPrimary: r.is_primary,
		leftOn: r.left_on,
		canEdit: r.can_edit,
		updatedAt: r.updated_at.toISOString()
	}));
}

/** Calls, emails, meetings and notes on this account, newest first. */
export async function getTimeline(db: Db, userId: number, customerNo: string): Promise<Timeline> {
	return db.asUser(userId, async (tx) => {
		const entries = await tx.sql<{
			id: number;
			kind: Timeline['entries'][number]['kind'];
			call_outcome: Timeline['entries'][number]['callOutcome'];
			body: string;
			occurred_at: Date;
			author_name: string;
			contact_name: string | null;
			commitment_id: number | null;
			commitment_title: string | null;
			via: string;
		}>`
			select a.id, a.kind, a.call_outcome, a.body, a.occurred_at, u.full_name as author_name,
			       ct.full_name as contact_name, a.commitment_id, cm.title as commitment_title, a.via
			from nl.activities a
			join nl.users u on u.id = a.author_id
			left join nl.contacts ct on ct.id = a.contact_id
			left join nl.commitments cm on cm.id = a.commitment_id
			where a.customer_no = ${customerNo}
			order by a.occurred_at desc, a.id desc
			limit ${TIMELINE_LIMIT}`;
		const [counted] = await tx.sql<{ total: number }>`
			select count(*)::int as total from nl.activities where customer_no = ${customerNo}`;
		return {
			total: counted.total,
			entries: entries.map((e) => ({
				id: e.id,
				kind: e.kind,
				callOutcome: e.call_outcome,
				body: e.body,
				occurredAt: e.occurred_at.toISOString(),
				authorName: e.author_name,
				contactName: e.contact_name,
				commitmentId: e.commitment_id,
				commitmentTitle: e.commitment_title,
				via: e.via
			}))
		};
	});
}

/** Every open step, then the ones done in the last 90 days. */
export async function getNextSteps(db: Db, userId: number, customerNo: string): Promise<NextStep[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			id: number;
			title: string;
			due_on: string | null;
			owner_name: string;
			overdue: boolean;
			done: boolean;
			completed_at: Date | null;
			completed_by: string | null;
			commitment_id: number | null;
			can_complete: boolean;
			updated_at: Date;
		}>`
			select s.id, s.title, s.due_on, o.full_name as owner_name,
			       s.completed_at is null and s.due_on < nl.today() as overdue,
			       s.completed_at is not null as done,
			       s.completed_at, d.full_name as completed_by, s.commitment_id,
			       -- The same rule nl.complete_next_step enforces.
			       (s.owner_id = ${userId}::int or cu.owner_id = ${userId}::int or nl.is_admin()) as can_complete,
			       s.updated_at
			from nl.next_steps s
			join nl.users o on o.id = s.owner_id
			join nl.customers cu on cu.customer_no = s.customer_no
			left join nl.users d on d.id = s.completed_by
			where s.customer_no = ${customerNo}
			  and (s.completed_at is null or s.completed_at >= now() - interval '90 days')
			order by s.completed_at is not null, s.due_on nulls last, s.completed_at desc, s.id`
	);
	return rows.map((r) => ({
		id: r.id,
		title: r.title,
		dueOn: r.due_on,
		ownerName: r.owner_name,
		overdue: r.overdue,
		done: r.done,
		completedAt: r.completed_at ? r.completed_at.toISOString() : null,
		completedBy: r.completed_by,
		commitmentId: r.commitment_id,
		canComplete: r.can_complete && !r.done,
		updatedAt: r.updated_at.toISOString()
	}));
}

/** Commitments, quotes and (when the reader may see them) RFQ drafts across the family. */
export async function getDeals(db: Db, userId: number, customerNo: string): Promise<Deals> {
	return db.asUser(userId, async (tx) => {
		const commitments = await tx.sql<{
			id: number;
			title: string;
			customer_no: string;
			customer_name: string;
			status: Deals['commitments'][number]['status'];
			committed_value: number;
			delivered: number;
			delivered_ratio: number;
			starts_on: string;
			ends_on: string;
			buyer_name: string | null;
			owner_name: string;
			needs_outcome: boolean;
		}>`
			with family as (
			  select customer_no from nl.customer_family(${customerNo})
			  union
			  select customer_no from nl.customer_ancestors(${customerNo})
			)
			select p.id, p.title, p.customer_no, cu.name as customer_name, p.status, p.committed_value,
			       p.delivered, p.delivered_ratio, p.starts_on, p.ends_on, ct.full_name as buyer_name,
			       u.full_name as owner_name, p.needs_outcome
			from nl.commitment_progress p
			join family f on f.customer_no = p.customer_no
			join nl.customers cu on cu.customer_no = p.customer_no
			join nl.users u on u.id = p.owner_id
			left join nl.contacts ct on ct.id = p.buyer_contact_id
			order by p.is_settled, p.needs_outcome desc, p.ends_on desc, p.id desc
			limit 40`;

		const quotes = await tx.sql<{
			id: number;
			customer_no: string;
			quoted_on: string;
			valid_until: string | null;
			total: number;
			lines: number;
			contact_name: string | null;
			commitment_id: number | null;
		}>`
			select q.id, q.customer_no, q.quoted_on, q.valid_until,
			       coalesce(sum(ql.quantity * ql.unit_price), 0) as total,
			       count(ql.line_no)::int as lines,
			       ct.full_name as contact_name, q.commitment_id
			from nl.quotes q
			left join nl.quote_lines ql on ql.quote_id = q.id
			left join nl.contacts ct on ct.id = q.contact_id
			where q.customer_no in (select customer_no from nl.customer_family(${customerNo}))
			group by q.id, ct.full_name
			order by q.quoted_on desc, q.id desc
			limit 20`;

		// Row-level security shows a person their own drafts (an admin sees all).
		const drafts = await tx.sql<{
			id: number;
			status: Deals['rfqDrafts'][number]['status'];
			created_at: Date;
			needs_review: number;
		}>`
			select id, status, created_at, needs_review
			from nl.rfq_drafts
			where customer_no in (select customer_no from nl.customer_family(${customerNo}))
			order by created_at desc
			limit 10`;

		return {
			commitments: commitments.map((c) => ({
				id: c.id,
				title: c.title,
				customerNo: c.customer_no,
				customerName: c.customer_name,
				status: c.status,
				committedValue: c.committed_value,
				delivered: c.delivered,
				deliveredRatio: c.delivered_ratio,
				startsOn: c.starts_on,
				endsOn: c.ends_on,
				buyerName: c.buyer_name,
				ownerName: c.owner_name,
				needsOutcome: c.needs_outcome
			})),
			quotes: quotes.map((q) => ({
				id: q.id,
				customerNo: q.customer_no,
				quotedOn: q.quoted_on,
				validUntil: q.valid_until,
				total: q.total,
				lines: q.lines,
				contactName: q.contact_name,
				commitmentId: q.commitment_id
			})),
			rfqDrafts: drafts.map((d) => ({
				id: d.id,
				status: d.status,
				createdAt: d.created_at.toISOString(),
				needsReview: d.needs_review
			}))
		};
	});
}

/** Open order lines (with their bucket) and the last 20 invoices, with their biggest parts. */
export async function getOrders(db: Db, userId: number, customerNo: string): Promise<Orders> {
	return db.asUser(userId, async (tx) => {
		const openLines = await tx.sql<{
			document_no: string;
			line_no: number;
			customer_no: string;
			item_no: string;
			description: string;
			ship_date: string;
			quantity: number;
			short: number;
			open_value: number;
			bucket: Orders['openLines'][number]['bucket'];
		}>`
			select l.document_no, l.line_no, l.customer_no, l.item_no, l.description, l.ship_date,
			       l.quantity, l.short, l.open_value, l.bucket
			from nl.open_line_allocation l
			where l.customer_no in (select customer_no from nl.customer_family(${customerNo}))
			order by l.ship_date, l.document_no, l.line_no
			limit 50`;

		const invoices = await tx.sql<{
			invoice_no: string;
			doc_type: 'invoice' | 'credit_memo';
			posted_on: string;
			customer_po: string | null;
			subtotal: number;
			freight: number;
			lines: number;
			top_parts: string[] | null;
		}>`
			select i.invoice_no, i.doc_type, i.posted_on, i.customer_po, i.subtotal, i.freight,
			       parts.lines, parts.top_parts
			from nl.invoices i
			cross join lateral (
			  select count(*)::int as lines,
			         (array_agg(l.item_no order by abs(l.amount) desc, l.line_no))[1:3] as top_parts
			  from nl.invoice_lines l
			  where l.invoice_no = i.invoice_no
			) parts
			where i.customer_no = ${customerNo}
			order by i.posted_on desc, i.invoice_no desc
			limit 20`;

		return {
			openLines: openLines.map((l) => ({
				documentNo: l.document_no,
				lineNo: l.line_no,
				customerNo: l.customer_no,
				itemNo: l.item_no,
				description: l.description,
				shipDate: l.ship_date,
				quantity: l.quantity,
				short: l.short,
				openValue: l.open_value,
				bucket: l.bucket
			})),
			invoices: invoices.map((i) => ({
				invoiceNo: i.invoice_no,
				docType: i.doc_type,
				postedOn: i.posted_on,
				customerPo: i.customer_po,
				subtotal: i.subtotal,
				freight: i.freight,
				lines: i.lines,
				topParts: i.top_parts ?? []
			}))
		};
	});
}

/**
 * People who can be named buyer on a commitment: still at the commitment's
 * customer, one of its branches, or its head office. Buyers and parts people
 * first. Mirrors the rule in nl.set_commitment_buyer.
 */
export async function listBuyerChoices(db: Db, userId: number, commitmentId: number): Promise<BuyerChoice[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{ id: number; full_name: string; title: string; customer_no: string; customer_name: string }>`
			with family as (
			  select f.customer_no
			  from nl.commitments c, nl.customer_family(c.customer_no) f
			  where c.id = ${commitmentId}
			  union
			  select a.customer_no
			  from nl.commitments c, nl.customer_ancestors(c.customer_no) a
			  where c.id = ${commitmentId}
			)
			select ct.id, ct.full_name, ct.title, ct.customer_no, cu.name as customer_name
			from nl.contacts ct
			join family f on f.customer_no = ct.customer_no
			join nl.customers cu on cu.customer_no = ct.customer_no
			where ct.left_on is null
			order by (ct.customer_no = (select customer_no from nl.commitments where id = ${commitmentId})) desc,
			         (ct.title ~* 'buyer|purchas|parts') desc,
			         ct.is_primary desc, ct.full_name
			limit 100`
	);
	return rows.map((r) => ({
		id: r.id,
		fullName: r.full_name,
		title: r.title,
		customerNo: r.customer_no,
		customerName: r.customer_name
	}));
}
