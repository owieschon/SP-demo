// The history behind a commitment: the quotes that shaped it and how each
// version ended, the conditions those quotes carry, the trail of answers its
// closed windows got, and the next steps somebody still owes.
//
// Everything here is a read. The shapes come from migration 0027's views, and
// the one piece of work done in JavaScript is comparing two versions of a
// quote to say what changed between them, because that reads better as plain
// code than as SQL.
import type { Db } from '../db/types.ts';
import type {
	AccountRecord,
	CommitmentDepth,
	DepthStep,
	NextStepKind,
	OutcomeEntry,
	QuoteHistory,
	QuoteOutcome,
	QuoteRevision,
	RequirementKind,
	RequirementRow,
	RevisionChange,
	RevisionLine
} from '$lib/components/commitments/types';

/**
 * Write out a requirement's structured attribute as a phrase. The attribute
 * columns are the truth; this is only how a person reads them.
 */
function attributeOf(row: {
	kind: RequirementKind;
	party: string | null;
	quantity: number | null;
	amount: number | null;
	terms_code: string | null;
	holds_until: string | null;
}): string | null {
	switch (row.kind) {
		case 'minimum_order': {
			const parts: string[] = [];
			if (row.quantity !== null) parts.push(`${row.quantity} pieces`);
			if (row.amount !== null) parts.push(`$${row.amount.toLocaleString('en-US')}`);
			return parts.join(' or ') || null;
		}
		case 'delivery_terms':
			return row.terms_code;
		case 'price_hold':
			return row.holds_until ? `through ${row.holds_until}` : null;
		case 'freight_paid_by':
			return row.party === 'us' ? 'we pay' : row.party === 'customer' ? 'they pay' : 'their carrier';
		default:
			return null;
	}
}

/**
 * What changed between one version of a quote and the version before it.
 *
 * The revision already carries the reason somebody gave. This says what the
 * numbers actually did, which is the part a reply has to get right: a price
 * that moved, a quantity that moved, a part that came off the list.
 */
function changesBetween(previous: RevisionLine[], current: RevisionLine[]): RevisionChange[] {
	const before = new Map(previous.map((line) => [line.itemNo, line]));
	const after = new Map(current.map((line) => [line.itemNo, line]));
	const changes: RevisionChange[] = [];

	for (const line of current) {
		const was = before.get(line.itemNo);
		if (!was) {
			changes.push({ itemNo: line.itemNo, text: `${line.itemNo} added, ${line.quantity} at $${line.unitPrice}` });
			continue;
		}
		if (was.unitPrice !== line.unitPrice) {
			const direction = line.unitPrice > was.unitPrice ? 'up' : 'down';
			const move = Math.abs((line.unitPrice - was.unitPrice) / was.unitPrice);
			changes.push({
				itemNo: line.itemNo,
				text: `${line.itemNo} price ${direction} ${Math.round(move * 100)}%, $${was.unitPrice} to $${line.unitPrice}`
			});
		}
		if (was.quantity !== line.quantity) {
			changes.push({
				itemNo: line.itemNo,
				text: `${line.itemNo} quantity ${was.quantity} to ${line.quantity}`
			});
		}
		if (was.leadDays !== line.leadDays && line.leadDays !== null && was.leadDays !== null) {
			changes.push({
				itemNo: line.itemNo,
				text: `${line.itemNo} lead time ${was.leadDays} to ${line.leadDays} days`
			});
		}
	}
	for (const line of previous) {
		if (!after.has(line.itemNo)) {
			changes.push({ itemNo: line.itemNo, text: `${line.itemNo} taken off the quote` });
		}
	}
	return changes;
}

interface RevisionRow {
	id: number;
	quote_id: number;
	version: number;
	revised_on: string;
	sent_by_name: string;
	valid_from: string | null;
	valid_until: string | null;
	change_reason: string;
	change_note: string;
	outcome: QuoteOutcome;
	outcome_reason: string | null;
	outcome_note: string;
	decided_on: string | null;
	total: number;
	line_count: number;
	is_latest: boolean;
	still_valid: boolean;
}

/**
 * The quotes, conditions, answers and next steps behind one commitment.
 *
 * Five indexed queries rather than one wide join, because each list is a
 * different shape and joining them would multiply rows out and then need
 * undoing in JavaScript.
 */
export async function getCommitmentDepth(db: Db, userId: number, id: number): Promise<CommitmentDepth> {
	return db.asUser(userId, async (tx) => {
		const [{ today }] = await tx.sql<{ today: string }>`select nl.today() as today`;

		// Quotes written for this commitment, plus any other quote to the same
		// customer family that asks for its parts. The second kind is how a
		// reader finds the quote that carried the business somewhere else.
		const quotes = await tx.sql<{
			id: number;
			quoted_on: string;
			contact_name: string | null;
			outcome: QuoteOutcome;
			lost_reason: string | null;
			versions: number;
			total: number;
			linked: boolean;
		}>`
			select q.id, q.quoted_on, ct.full_name as contact_name, q.outcome, q.lost_reason,
			       q.versions::int as versions, q.total,
			       q.commitment_id is not distinct from ${id}::bigint as linked
			from nl.quote_state q
			left join nl.contacts ct on ct.id = q.contact_id
			where q.commitment_id = ${id}
			   or (q.customer_no in (select f.customer_no from nl.commitment_family f where f.commitment_id = ${id})
			       and exists (
			         select 1
			         from nl.quote_lines ql
			         join nl.commitment_items ci on ci.commitment_id = ${id} and ci.item_no = ql.item_no
			         where ql.quote_id = q.id))
			order by q.quoted_on desc, q.id desc
			limit 20`;

		const quoteIds = quotes.map((q) => q.id);

		const revisions = quoteIds.length
			? await tx.sql<RevisionRow>`
					select r.id, r.quote_id, r.version, r.revised_on, u.full_name as sent_by_name,
					       r.valid_from, r.valid_until, r.change_reason, r.change_note,
					       r.outcome, r.outcome_reason, r.outcome_note, r.decided_on,
					       r.total, r.line_count::int as line_count, r.is_latest, r.still_valid
					from nl.quote_revision_state r
					join nl.users u on u.id = r.sent_by
					-- Param only carries scalars, so a list goes in as text and is split
					-- in SQL, the same way lib/server/mcp/tokens.ts does it.
					where r.quote_id = any (string_to_array(${quoteIds.join(',')}, ',')::bigint[])
					order by r.quote_id, r.version`
			: [];

		const revisionLines = revisions.length
			? await tx.sql<{
					revision_id: number;
					line_no: number;
					item_no: string;
					description: string;
					quantity: number;
					unit_price: number;
					extended: number;
					price_rule: string | null;
					lead_days: number | null;
				}>`
					select rl.revision_id, rl.line_no, rl.item_no, i.description, rl.quantity,
					       rl.unit_price, rl.extended, rl.price_rule, rl.lead_days
					from nl.quote_revision_lines rl
					join nl.items i on i.item_no = rl.item_no
					where rl.revision_id = any (string_to_array(${revisions.map((r) => r.id).join(',')}, ',')::bigint[])
					order by rl.revision_id, rl.line_no`
			: [];

		const requirements = await tx.sql<{
			id: number;
			kind: RequirementKind;
			party: 'us' | 'customer' | 'carrier' | null;
			quantity: number | null;
			amount: number | null;
			terms_code: string | null;
			holds_until: string | null;
			detail: string;
			required_by: string | null;
			satisfied: boolean;
			satisfied_on: string | null;
			satisfied_by_name: string | null;
			satisfied_note: string;
			overdue: boolean;
			lapsed: boolean;
			on_commitment: boolean;
			quote_id: number | null;
		}>`
			select rs.id, rs.kind, rs.party, rs.quantity, rs.amount, rs.terms_code, rs.holds_until,
			       rs.detail, rs.required_by, rs.satisfied, rs.satisfied_on,
			       u.full_name as satisfied_by_name, rs.satisfied_note,
			       rs.overdue, rs.lapsed, rs.on_commitment, rs.quote_id
			from nl.requirement_state rs
			left join nl.users u on u.id = rs.satisfied_by
			where rs.commitment_id = ${id}
			-- Unsatisfied first, then the ones due soonest: a checklist reads
			-- top down and the top is what is still owed.
			order by rs.satisfied, rs.required_by nulls last, rs.id`;

		const outcomes = await tx.sql<{
			id: number;
			outcome: 'kept' | 'pushed' | 'broken';
			source: 'person' | 'nightly';
			answered_by_name: string | null;
			answered_at: Date;
			note: string;
			reason: string | null;
			window_starts_on: string | null;
			window_ends_on: string | null;
			committed_value: number | null;
			delivered_value: number | null;
			pushed_to_starts_on: string | null;
			pushed_to_ends_on: string | null;
			next_commitment_id: number | null;
		}>`
			select o.id, o.outcome, o.source, u.full_name as answered_by_name, o.answered_at, o.note,
			       o.reason, o.window_starts_on, o.window_ends_on, o.committed_value, o.delivered_value,
			       o.pushed_to_starts_on, o.pushed_to_ends_on, o.next_commitment_id
			from nl.commitment_outcomes o
			left join nl.users u on u.id = o.answered_by
			where o.commitment_id = ${id}
			-- Oldest first: a trail is read forwards.
			order by o.answered_at, o.id`;

		const steps = await tx.sql<{
			id: number;
			title: string;
			kind: NextStepKind;
			source: 'person' | 'agent';
			agent: string | null;
			note: string;
			due_on: string | null;
			owner_name: string;
			created_by_name: string;
			done: boolean;
			completed_at: Date | null;
			overdue: boolean;
			due_today: boolean;
			done_late: boolean;
			requirement_id: number | null;
		}>`
			select s.id, s.title, s.kind, s.source, s.agent, s.note, s.due_on,
			       owner.full_name as owner_name, author.full_name as created_by_name,
			       s.completed_at is not null as done, s.completed_at,
			       -- Overdue means overdue to the business, so it is measured
			       -- against nl.today() and never against the server's clock.
			       (s.completed_at is null and s.due_on < (select nl.today())) as overdue,
			       (s.completed_at is null and s.due_on = (select nl.today())) as due_today,
			       (s.completed_at is not null and s.completed_at::date > s.due_on) as done_late,
			       s.requirement_id
			from nl.next_steps s
			join nl.users owner on owner.id = s.owner_id
			join nl.users author on author.id = s.created_by
			where s.commitment_id = ${id}
			order by s.completed_at is not null, s.due_on nulls last, s.id`;

		// Hang the lines off their revision, then work out what each version
		// changed from the one before it.
		const linesByRevision = new Map<number, RevisionLine[]>();
		for (const line of revisionLines) {
			const list = linesByRevision.get(line.revision_id) ?? [];
			list.push({
				lineNo: line.line_no,
				itemNo: line.item_no,
				description: line.description,
				quantity: line.quantity,
				unitPrice: line.unit_price,
				extended: line.extended,
				priceRule: line.price_rule,
				leadDays: line.lead_days
			});
			linesByRevision.set(line.revision_id, list);
		}

		const revisionsByQuote = new Map<number, QuoteRevision[]>();
		for (const row of revisions) {
			const lines = linesByRevision.get(row.id) ?? [];
			const earlier = revisionsByQuote.get(row.quote_id) ?? [];
			const previous = earlier.at(-1);
			earlier.push({
				id: row.id,
				version: row.version,
				revisedOn: row.revised_on,
				sentByName: row.sent_by_name,
				validFrom: row.valid_from,
				validUntil: row.valid_until,
				changeReason: row.change_reason,
				changeNote: row.change_note,
				outcome: row.outcome,
				outcomeReason: row.outcome_reason,
				outcomeNote: row.outcome_note,
				decidedOn: row.decided_on,
				total: row.total,
				lineCount: row.line_count,
				isLatest: row.is_latest,
				stillValid: row.still_valid,
				lines,
				changes: previous ? changesBetween(previous.lines, lines) : []
			});
			revisionsByQuote.set(row.quote_id, earlier);
		}

		const history: QuoteHistory[] = quotes.map((q) => ({
			id: q.id,
			quotedOn: q.quoted_on,
			contactName: q.contact_name,
			outcome: q.outcome,
			lostReason: q.lost_reason,
			versions: q.versions,
			total: q.total,
			linked: q.linked,
			// Newest version first, which is the one that counts.
			revisions: (revisionsByQuote.get(q.id) ?? []).slice().reverse()
		}));

		const requirementRows: RequirementRow[] = requirements.map((r) => ({
			id: r.id,
			kind: r.kind,
			party: r.party,
			attribute: attributeOf(r),
			detail: r.detail,
			requiredBy: r.required_by,
			satisfied: r.satisfied,
			satisfiedOn: r.satisfied_on,
			satisfiedByName: r.satisfied_by_name,
			satisfiedNote: r.satisfied_note,
			overdue: r.overdue,
			lapsed: r.lapsed,
			onCommitment: r.on_commitment,
			quoteId: r.quote_id
		}));

		const outcomeRows: OutcomeEntry[] = outcomes.map((o) => ({
			id: o.id,
			outcome: o.outcome,
			source: o.source,
			answeredByName: o.answered_by_name,
			answeredAt: o.answered_at.toISOString(),
			note: o.note,
			reason: o.reason,
			windowStartsOn: o.window_starts_on,
			windowEndsOn: o.window_ends_on,
			committedValue: o.committed_value,
			deliveredValue: o.delivered_value,
			pushedToStartsOn: o.pushed_to_starts_on,
			pushedToEndsOn: o.pushed_to_ends_on,
			nextCommitmentId: o.next_commitment_id
		}));

		const stepRows: DepthStep[] = steps.map((s) => ({
			id: s.id,
			title: s.title,
			kind: s.kind,
			source: s.source,
			agent: s.agent,
			note: s.note,
			dueOn: s.due_on,
			ownerName: s.owner_name,
			createdByName: s.created_by_name,
			done: s.done,
			completedAt: s.completed_at ? s.completed_at.toISOString() : null,
			overdue: s.overdue,
			dueToday: s.due_today,
			doneLate: s.done_late,
			requirementId: s.requirement_id
		}));

		return { quotes: history, requirements: requirementRows, outcomes: outcomeRows, steps: stepRows, today };
	});
}

/**
 * An account's record: how its settled commitments ended, how its quotes
 * went, and why the losses were lost.
 *
 * Measured over the account's billing family, the same way the commitments
 * section of the account page is, so the two agree: a commitment made with a
 * head office is part of its branches' record too.
 */
export async function getAccountRecord(db: Db, userId: number, customerNo: string): Promise<AccountRecord> {
	return db.asUser(userId, async (tx) => {
		const [counts] = await tx.sql<{
			settled_count: number;
			kept: number;
			pushed: number;
			broken: number;
			last_settled_on: string | null;
			quotes: number;
			quotes_won: number;
			quotes_lost: number;
			quotes_open: number;
			pattern: ('kept' | 'pushed' | 'broken')[];
		}>`
			with family as (
			  select customer_no from nl.customer_family(${customerNo})
			  union
			  select customer_no from nl.customer_ancestors(${customerNo})
			),
			-- The last eight answers, oldest first, so the inline mark reads
			-- left to right like a calendar.
			recent as (
			  select array_agg(p.status order by p.settled_on, p.id) as pattern
			  from (
			    select p.id, p.status, coalesce(p.answered_at::date, p.ends_on) as settled_on
			    from nl.commitment_progress p
			    join family f on f.customer_no = p.customer_no
			    where p.is_settled
			    order by coalesce(p.answered_at::date, p.ends_on) desc, p.id desc
			    limit 8
			  ) p
			)
			select
			  coalesce(sum(r.settled_count), 0)::int as settled_count,
			  coalesce(sum(r.kept), 0)::int          as kept,
			  coalesce(sum(r.pushed), 0)::int        as pushed,
			  coalesce(sum(r.broken), 0)::int        as broken,
			  max(r.last_settled_on)                 as last_settled_on,
			  coalesce(sum(r.quotes), 0)::int        as quotes,
			  coalesce(sum(r.quotes_won), 0)::int    as quotes_won,
			  coalesce(sum(r.quotes_lost), 0)::int   as quotes_lost,
			  coalesce(sum(r.quotes_open), 0)::int   as quotes_open,
			  coalesce((select pattern from recent), '{}'::text[]) as pattern
			from family f
			join nl.account_sales_record r on r.customer_no = f.customer_no`;

		// Why the losses were lost, biggest reason first.
		const reasons = await tx.sql<{ reason: string; n: number }>`
			with family as (
			  select customer_no from nl.customer_family(${customerNo})
			  union
			  select customer_no from nl.customer_ancestors(${customerNo})
			)
			select q.lost_reason as reason, count(*)::int as n
			from nl.quote_state q
			join family f on f.customer_no = q.customer_no
			where q.outcome = 'lost' and q.lost_reason is not null
			group by q.lost_reason
			order by n desc, q.lost_reason`;

		const [owed] = await tx.sql<{ open: number; overdue: number }>`
			with family as (
			  select customer_no from nl.customer_family(${customerNo})
			  union
			  select customer_no from nl.customer_ancestors(${customerNo})
			)
			select count(*) filter (where not rs.satisfied)::int as open,
			       count(*) filter (where rs.overdue)::int       as overdue
			from nl.requirement_state rs
			join family f on f.customer_no = rs.customer_no`;

		const settled = counts?.settled_count ?? 0;
		return {
			settledCount: settled,
			kept: counts?.kept ?? 0,
			pushed: counts?.pushed ?? 0,
			broken: counts?.broken ?? 0,
			keptRate: settled > 0 ? (counts?.kept ?? 0) / settled : null,
			pattern: counts?.pattern ?? [],
			lastSettledOn: counts?.last_settled_on ?? null,
			quotes: counts?.quotes ?? 0,
			quotesWon: counts?.quotes_won ?? 0,
			quotesLost: counts?.quotes_lost ?? 0,
			quotesOpen: counts?.quotes_open ?? 0,
			topLossReason: reasons[0]?.reason ?? null,
			lossReasons: reasons.map((r) => ({ reason: r.reason, count: r.n })),
			requirementsOpen: owed?.open ?? 0,
			requirementsOverdue: owed?.overdue ?? 0
		};
	});
}
