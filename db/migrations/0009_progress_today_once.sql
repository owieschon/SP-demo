-- 0009 Ask for today's date once per query, not once per commitment.
--
-- nl.today() pins its search_path, so Postgres never inlines it and calls it
-- for every row. On the full world that was 15 of the board's 22 ms. As a
-- scalar subquery it becomes an InitPlan: evaluated once, then reused.
-- Same columns and results as 0008.

create or replace view nl.commitment_progress with (security_invoker = true) as
with latest_outcome as (
  select commitment_id, outcome, source, answered_by, answered_at, note
  from (
    select
      o.*,
      row_number() over (
        partition by o.commitment_id
        order by o.answered_at desc, o.id desc
      ) as answer_rank
    from nl.commitment_outcomes o
  ) ranked
  where answer_rank = 1
),
quoted as (
  select commitment_id, count(*) as quote_count, max(quoted_on) as last_quoted_on
  from nl.quotes
  where commitment_id is not null
  group by commitment_id
),
measured as (
  select
    c.*,
    coalesce(d.delivered, 0)     as delivered,
    coalesce(d.matched_lines, 0) as matched_lines,
    d.last_delivery_on,
    coalesce(q.quote_count, 0)   as quote_count,
    q.last_quoted_on,
    lo.outcome,
    lo.source      as outcome_source,
    lo.answered_by,
    lo.answered_at,
    lo.note        as outcome_note,
    coalesce(d.delivered, 0) >= c.committed_value * nl.kept_ratio() as kept_by_measure,
    (select nl.today()) as today
  from nl.commitments c
  left join nl.commitment_delivery d on d.commitment_id = c.id
  left join quoted q on q.commitment_id = c.id
  left join latest_outcome lo on lo.commitment_id = c.id
),
classified as (
  select
    m.*,
    case
      when m.outcome is not null then m.outcome   -- someone answered
      when m.kept_by_measure then 'kept'          -- the ledger says so
      when m.delivered > 0 then 'delivering'
      when m.quote_count > 0 then 'quoted'
      else 'promised'
    end as status,
    greatest(m.committed_value - m.delivered, 0) as remaining
  from measured m
)
select
  k.id,
  k.title,
  k.customer_no,
  k.buyer_contact_id,
  k.owner_id,
  k.committed_value,
  k.starts_on,
  k.ends_on,
  k.confidence,
  k.notes,
  k.created_by,
  k.created_at,
  k.updated_at,
  k.delivered,
  k.remaining,
  round(k.delivered / k.committed_value, 4) as delivered_ratio,
  k.matched_lines,
  k.last_delivery_on,
  k.quote_count,
  k.last_quoted_on,
  k.status,
  k.status in ('kept', 'pushed', 'broken') as is_settled,
  k.kept_by_measure,
  k.outcome,
  k.outcome_source,
  k.answered_by,
  k.answered_at,
  k.outcome_note,
  (k.outcome is null and not k.kept_by_measure and k.ends_on < k.today) as needs_outcome,
  case when k.ends_on < k.today then k.today - k.ends_on end as days_since_close,
  least(greatest((k.today - k.starts_on)::numeric / (k.ends_on - k.starts_on + 1), 0), 1)
    as window_elapsed_ratio,
  round(
    k.delivered
    + case when k.status in ('kept', 'pushed', 'broken') then 0
           else k.confidence / 100.0 * k.remaining end,
    2) as expected_value
from classified k;
