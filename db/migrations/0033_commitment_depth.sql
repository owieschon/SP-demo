-- 0027 Depth behind a commitment: the quotes that shaped it, the conditions
-- those quotes carry, the trail of answers each closed window got, and the
-- next steps somebody still owes.
--
-- Why this exists. The app's claim is that an agent can answer a customer
-- correctly from what the business already knows. Before this migration a
-- commitment knew four thin things about its own past:
--
--   * a quote was one flat row, so "what changed between revisions and why"
--     was not a question the database could answer;
--   * the conditions a quote carries (first article, a certificate, who pays
--     freight, a price held through a date) lived in nobody's table, so a
--     reply could promise something the quote had already ruled out;
--   * a commitment had one outcome answer per window, so a customer with
--     three years of history looked the same as one with none;
--   * a next step was a title, a due date and an owner, with no kind and no
--     record of whether a person or an agent proposed it.
--
-- Everything here is history, read far more often than it is written. Nothing
-- stored is derived: totals, satisfaction and the outcome pattern come from
-- views over the rows, the same way nl.commitment_progress derives status.
--
-- What it adds
--   nl.quote_revisions        one row per version of a quote, with what
--                             changed, why, and how the version ended
--   nl.quote_revision_lines   the lines of one version
--   nl.requirements           conditions attached to a quote or a commitment,
--                             as structured rows rather than prose
--   columns on nl.commitment_outcomes  what was promised and delivered when
--                             the window closed, the reason, and the window
--                             the business moved to
--   columns on nl.next_steps  kind, whether a person or an agent proposed it,
--                             and a note
--   five views                nl.quote_revision_state, nl.quote_state,
--                             nl.requirement_state, nl.commitment_depth,
--                             nl.account_sales_record

-- ---------------------------------------------------------------------------
-- The two controlled vocabularies
-- ---------------------------------------------------------------------------

-- Why a quote did not become business. Six answers, because a sales team
-- that can pick from twenty picks a different one every time and the counts
-- never add up to anything a person can act on.
create function nl.loss_reasons() returns text[]
language sql immutable
set search_path = ''
as $$ select array[
  'price',
  'lead time',
  'no decision',
  'competitor',
  'requirement we could not meet',
  'customer cancelled the project'
]::text[] $$;

-- Why a revision replaced the one before it.
create function nl.revision_reasons() returns text[]
language sql immutable
set search_path = ''
as $$ select array[
  'first issue',
  'price increase',
  'quantity break',
  'lead time',
  'freight added',
  'scope change',
  'customer request'
]::text[] $$;

-- ---------------------------------------------------------------------------
-- Quote revisions
-- ---------------------------------------------------------------------------

-- One row per version of a quote. Version 1 is the quote as first issued, so
-- a quote with no revision row at all is simply one nobody has revised: the
-- views below fall back to nl.quote_lines for it, which is what the RFQ and
-- order desk paths still write.
--
-- A revision can lose on its own. A customer who says no to revision 2 and
-- yes to revision 3 is the normal case, and the reason they said no to 2 is
-- the fact worth keeping.
create table nl.quote_revisions (
  id            bigint generated always as identity (start with 9001) primary key,
  quote_id      bigint not null references nl.quotes (id) on delete cascade,
  version       int not null check (version >= 1),
  revised_on    date not null,
  sent_by       int not null references nl.users (id),
  -- The validity window this version promised. valid_from is usually the day
  -- it went out; a price held through a date makes valid_until matter.
  valid_from    date,
  valid_until   date,
  change_reason text not null,
  change_note   text not null default '',
  -- How this version ended. 'open' means nobody has decided yet.
  outcome       text not null default 'open'
                check (outcome in ('open', 'won', 'lost', 'expired', 'superseded', 'withdrawn')),
  outcome_reason text,
  outcome_note   text not null default '',
  decided_on     date,
  created_at     timestamptz not null default now(),

  constraint quote_revisions_one_per_version unique (quote_id, version),
  constraint quote_revisions_window_in_order
    check (valid_from is null or valid_until is null or valid_until >= valid_from),
  constraint quote_revisions_change_reason_known
    check (change_reason = any (nl.revision_reasons())),
  -- Version 1 is the first issue and nothing else is.
  constraint quote_revisions_first_issue_is_version_one
    check ((version = 1) = (change_reason = 'first issue')),
  -- A loss needs a reason from the vocabulary. A paragraph is not a reason:
  -- it cannot be counted, and counting losses by reason is the whole point.
  constraint quote_revisions_loss_has_a_reason
    check (outcome <> 'lost' or outcome_reason is not null),
  constraint quote_revisions_reason_known
    check (outcome_reason is null or outcome_reason = any (nl.loss_reasons())),
  -- A reason only belongs on a version that did not win.
  constraint quote_revisions_reason_where_it_fits
    check (outcome_reason is null or outcome in ('lost', 'withdrawn', 'expired')),
  -- Decided exactly when it is no longer open.
  constraint quote_revisions_decided_when_closed
    check ((outcome = 'open') = (decided_on is null))
);

create index quote_revisions_quote_idx on nl.quote_revisions (quote_id, version desc);
create index quote_revisions_sent_by_idx on nl.quote_revisions (sent_by);
create index quote_revisions_outcome_idx on nl.quote_revisions (outcome, decided_on);

comment on table nl.quote_revisions is
  'One version of a quote: what it said, what changed from the version before, and how it ended (migration 0027).';

-- The lines of one version. Prices come from nl.price_for or
-- nl.desk_price_for, and price_rule records which rule produced them, so a
-- later reader can see a price was the tier price rather than a guess.
create table nl.quote_revision_lines (
  revision_id bigint not null references nl.quote_revisions (id) on delete cascade,
  line_no     int not null,
  item_no     text not null references nl.items (item_no),
  quantity    int not null check (quantity > 0),
  unit_price  numeric(12, 2) not null check (unit_price >= 0),
  -- Which rule in the pricing precedence set this price (agreement, last
  -- paid, group discount, list, plus a quantity break note when one applied).
  price_rule  text,
  lead_days   int check (lead_days >= 0),
  extended    numeric(14, 2) generated always as ((quantity * unit_price)::numeric(14, 2)) stored,
  primary key (revision_id, line_no)
);

create index quote_revision_lines_item_idx on nl.quote_revision_lines (item_no);

-- ---------------------------------------------------------------------------
-- Requirements
-- ---------------------------------------------------------------------------

-- The conditions a quote or a commitment carries. Structured rows, never
-- prose: a reply can only honour a condition the database can read.
--
-- Each kind carries its own attribute, and the check constraints insist on
-- it, so a price hold always has the date it holds through and a minimum
-- order always has the number it is a minimum of. `detail` is for a person's
-- words about the condition, never for the condition itself.
create table nl.requirements (
  id             bigint generated always as identity (start with 7001) primary key,
  -- Attached to exactly one of the two. A condition on a quote travels with
  -- that quote; a condition on a commitment outlives any one quote.
  commitment_id  bigint references nl.commitments (id) on delete cascade,
  quote_id       bigint references nl.quotes (id) on delete cascade,
  kind           text not null check (kind in (
                   'first_article_inspection',
                   'certificate_of_conformance',
                   'packaging_and_marking',
                   'delivery_terms',
                   'freight_paid_by',
                   'minimum_order',
                   'price_hold')),
  -- Who owes it: us, the customer, or the carrier.
  party          text check (party in ('us', 'customer', 'carrier')),
  -- The attributes. One kind uses one of these; the rest stay null.
  quantity       int check (quantity > 0),
  amount         numeric(12, 2) check (amount >= 0),
  terms_code     text,
  holds_until    date,
  detail         text not null default '',
  required_by    date,
  satisfied_on   date,
  satisfied_by   int references nl.users (id),
  satisfied_note text not null default '',
  created_by     int not null references nl.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default nl.now_ms(),

  constraint requirements_attached_to_one
    check ((commitment_id is null) <> (quote_id is null)),
  constraint requirements_satisfied_is_named
    check ((satisfied_on is null) = (satisfied_by is null)),
  -- Each kind carries the attribute that makes it actionable.
  constraint requirements_minimum_order_has_a_figure
    check (kind <> 'minimum_order' or quantity is not null or amount is not null),
  constraint requirements_price_hold_has_a_date
    check (kind <> 'price_hold' or holds_until is not null),
  constraint requirements_delivery_terms_has_a_code
    check (kind <> 'delivery_terms' or terms_code is not null),
  constraint requirements_freight_has_a_payer
    check (kind <> 'freight_paid_by' or party is not null)
);

create index requirements_commitment_idx on nl.requirements (commitment_id);
create index requirements_quote_idx on nl.requirements (quote_id);
create index requirements_open_idx on nl.requirements (required_by) where satisfied_on is null;
create index requirements_satisfied_by_idx on nl.requirements (satisfied_by);
create index requirements_created_by_idx on nl.requirements (created_by);

create trigger requirements_touch before update on nl.requirements
  for each row execute function nl.touch_updated_at();

comment on table nl.requirements is
  'Conditions a quote or a commitment carries, as structured rows (migration 0027). Satisfaction is a date and a name, never a flag on its own.';

-- ---------------------------------------------------------------------------
-- An outcome trail rather than one answer
-- ---------------------------------------------------------------------------

-- nl.commitment_outcomes was already append-only, so the trail was there;
-- what was missing is what each answer was an answer about. An answer read
-- two years later has to carry the window that closed and the figures as
-- they stood, because both move afterwards.
alter table nl.commitment_outcomes
  add column window_starts_on    date,
  add column window_ends_on      date,
  add column committed_value     numeric(12, 2),
  add column delivered_value     numeric(14, 2),
  -- Why, from the same vocabulary the quote losses use, so the counts line up.
  add column reason              text,
  -- A pushed window moved the business somewhere. This is where to.
  add column pushed_to_starts_on date,
  add column pushed_to_ends_on   date,
  add column next_commitment_id  bigint references nl.commitments (id) on delete set null;

alter table nl.commitment_outcomes
  add constraint outcomes_reason_known
    check (reason is null or reason = any (nl.loss_reasons())),
  -- A kept window has no reason to give and nowhere to move to.
  add constraint outcomes_reason_where_it_fits
    check (reason is null or outcome in ('pushed', 'broken')),
  add constraint outcomes_new_window_only_when_pushed
    check (outcome = 'pushed'
           or (pushed_to_starts_on is null and pushed_to_ends_on is null and next_commitment_id is null)),
  add constraint outcomes_new_window_in_order
    check (pushed_to_starts_on is null or pushed_to_ends_on is null
           or pushed_to_ends_on >= pushed_to_starts_on),
  add constraint outcomes_new_window_is_whole
    check ((pushed_to_starts_on is null) = (pushed_to_ends_on is null));

create index commitment_outcomes_next_idx on nl.commitment_outcomes (next_commitment_id);

-- A pushed window creates the next one. When an answer says the business
-- moved to a named new window, the follow-on commitment is the thing the
-- sales team then works, so the database makes it rather than leaving a
-- person to retype the parts list.
--
-- It carries the same customer, buyer, owner and parts, and is worth what the
-- first one did not deliver. Confidence starts at the answer's own level of
-- optimism, not at the old one.
--
-- SECURITY DEFINER for the same reason as nl.measure_commitments: the insert
-- happens inside somebody else's write, and the row-level policies on
-- nl.commitments are written for a person creating their own. The audit row
-- names the answer that caused it, so nothing appears from nowhere.
create function nl.open_pushed_window() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_parent nl.commitments;
  v_new_id bigint;
begin
  -- Only a deliberate answer with a new window opens one, and never twice.
  if new.outcome <> 'pushed'
     or new.pushed_to_starts_on is null
     or new.next_commitment_id is not null then
    return null;
  end if;

  select * into v_parent from nl.commitments where id = new.commitment_id;

  insert into nl.commitments (title, customer_no, buyer_contact_id, owner_id, committed_value,
                              starts_on, ends_on, confidence, notes, created_by)
  values (v_parent.title,
          v_parent.customer_no,
          v_parent.buyer_contact_id,
          v_parent.owner_id,
          -- What the first window did not deliver, and never nothing.
          greatest(v_parent.committed_value - coalesce(new.delivered_value, 0), 1),
          new.pushed_to_starts_on,
          new.pushed_to_ends_on,
          50,
          format('Moved from commitment %s, whose window closed on %s.',
                 v_parent.id, v_parent.ends_on),
          coalesce(new.answered_by, v_parent.owner_id))
  returning id into v_new_id;

  -- The same parts, because it is the same promise in a later window.
  insert into nl.commitment_items (commitment_id, item_no, quantity)
  select v_new_id, ci.item_no, ci.quantity
  from nl.commitment_items ci
  where ci.commitment_id = new.commitment_id;

  update nl.commitment_outcomes set next_commitment_id = v_new_id where id = new.id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, detail)
  values (new.answered_by,
          case when new.source = 'nightly' then 'nightly' else 'ui' end,
          'open_pushed_window', 'commitment', v_new_id::text,
          jsonb_build_object('from_commitment', new.commitment_id,
                             'outcome_id', new.id,
                             'window', jsonb_build_array(new.pushed_to_starts_on, new.pushed_to_ends_on)));
  return null;
end $$;

create trigger commitment_outcomes_open_pushed_window
  after insert on nl.commitment_outcomes
  for each row
  when (new.outcome = 'pushed' and new.pushed_to_starts_on is not null and new.next_commitment_id is null)
  execute function nl.open_pushed_window();

-- ---------------------------------------------------------------------------
-- Next steps that behave like real ones
-- ---------------------------------------------------------------------------

alter table nl.next_steps
  -- What kind of work it is, so a list can be read without opening each one.
  add column kind text not null default 'other'
    check (kind in ('call', 'send_quote', 'chase_po', 'confirm_requirement', 'check_stock', 'other')),
  -- A person wrote it, or an agent proposed it. The trust surfaces count the
  -- second kind, so it has to be a column and not a habit in the title.
  add column source text not null default 'person' check (source in ('person', 'agent')),
  add column agent text,
  add column note text not null default '',
  -- A 'confirm_requirement' step usually points at the condition it is about.
  add column requirement_id bigint references nl.requirements (id) on delete set null;

alter table nl.next_steps
  add constraint next_steps_agent_is_named
    check ((source = 'agent') = (agent is not null));

create index next_steps_kind_idx on nl.next_steps (kind);
create index next_steps_source_idx on nl.next_steps (source) where completed_at is null;
create index next_steps_requirement_idx on nl.next_steps (requirement_id);

-- ---------------------------------------------------------------------------
-- Views: everything derived, nothing stored
-- ---------------------------------------------------------------------------

-- One row per revision, with its money and whether it is the live version.
create view nl.quote_revision_state with (security_invoker = true) as
select
  r.id,
  r.quote_id,
  r.version,
  r.revised_on,
  r.sent_by,
  r.valid_from,
  r.valid_until,
  r.change_reason,
  r.change_note,
  r.outcome,
  r.outcome_reason,
  r.outcome_note,
  r.decided_on,
  coalesce(l.total, 0)      as total,
  coalesce(l.line_count, 0) as line_count,
  l.max_lead_days,
  -- The highest version of a quote is the one that counts. Version numbers
  -- are unique per quote, so this cannot tie.
  r.version = max(r.version) over (partition by r.quote_id) as is_latest,
  -- Still inside its validity window today.
  (r.valid_until is null or r.valid_until >= (select nl.today())) as still_valid,
  r.created_at
from nl.quote_revisions r
left join lateral (
  select sum(rl.extended) as total,
         count(*)         as line_count,
         max(rl.lead_days) as max_lead_days
  from nl.quote_revision_lines rl
  where rl.revision_id = r.id
) l on true;

-- One row per quote, revised or not. A quote nobody has revised has no
-- revision row, so its figures come from nl.quote_lines, which is what the
-- RFQ approval and order desk paths write.
create view nl.quote_state with (security_invoker = true) as
with revised as (
  select
    r.quote_id,
    count(*)::int                  as versions,
    max(r.version)                 as latest_version,
    (array_agg(r.id order by r.version desc))[1]             as latest_revision_id,
    (array_agg(r.total order by r.version desc))[1]          as latest_total,
    (array_agg(r.line_count order by r.version desc))[1]     as latest_line_count,
    (array_agg(r.outcome order by r.version desc))[1]        as latest_outcome,
    (array_agg(r.valid_until order by r.version desc))[1]    as latest_valid_until,
    count(*) filter (where r.outcome = 'won')::int           as won_versions,
    count(*) filter (where r.outcome = 'lost')::int          as lost_versions,
    -- The reason the most recent losing version gave.
    (array_agg(r.outcome_reason order by r.version desc)
       filter (where r.outcome = 'lost'))[1]                 as lost_reason
  from nl.quote_revision_state r
  group by r.quote_id
),
flat as (
  select ql.quote_id,
         sum(ql.quantity * ql.unit_price) as total,
         count(*)::int                    as line_count
  from nl.quote_lines ql
  group by ql.quote_id
)
select
  q.id,
  q.customer_no,
  q.contact_id,
  q.commitment_id,
  q.quoted_on,
  q.valid_until,
  q.source,
  q.created_by,
  coalesce(rv.versions, 0)                    as versions,
  coalesce(rv.latest_version, 1)              as latest_version,
  rv.latest_revision_id,
  coalesce(rv.latest_total, f.total, 0)       as total,
  coalesce(rv.latest_line_count, f.line_count, 0) as line_count,
  -- A quote nobody has decided is open, whether or not it has revisions.
  coalesce(rv.latest_outcome, 'open')         as outcome,
  rv.lost_reason,
  coalesce(rv.won_versions, 0)                as won_versions,
  coalesce(rv.lost_versions, 0)               as lost_versions,
  coalesce(rv.latest_valid_until, q.valid_until) as effective_valid_until
from nl.quotes q
left join revised rv on rv.quote_id = q.id
left join flat f on f.quote_id = q.id;

-- One row per requirement, resolved to the commitment it bears on (its own,
-- or the one its quote was written for) and with satisfaction derived.
create view nl.requirement_state with (security_invoker = true) as
select
  r.id,
  coalesce(r.commitment_id, q.commitment_id) as commitment_id,
  r.quote_id,
  coalesce(r.commitment_id is not null, false) as on_commitment,
  coalesce(cu.customer_no, q.customer_no)    as customer_no,
  r.kind,
  r.party,
  r.quantity,
  r.amount,
  r.terms_code,
  r.holds_until,
  r.detail,
  r.required_by,
  r.satisfied_on,
  r.satisfied_by,
  r.satisfied_note,
  r.satisfied_on is not null                 as satisfied,
  -- Owed, and the day it was owed by has passed.
  (r.satisfied_on is null and r.required_by is not null
     and r.required_by < (select nl.today()))  as overdue,
  -- A price hold that has run out is a condition nobody can still honour.
  (r.kind = 'price_hold' and r.holds_until < (select nl.today())) as lapsed,
  r.created_by,
  r.created_at,
  r.updated_at
from nl.requirements r
left join nl.quotes q on q.id = r.quote_id
left join nl.commitments cu on cu.id = r.commitment_id;

-- One row per commitment: how much history stands behind it. Each piece is
-- one grouped pass over its own table, joined on the commitment id, rather
-- than a correlated subquery per commitment.
create view nl.commitment_depth with (security_invoker = true) as
with clock as (
  select nl.today() as today
),
quote_rollup as (
  select
    s.commitment_id,
    count(*)::int                                     as quote_count,
    sum(s.versions)::int                              as revision_count,
    max(s.quoted_on)                                  as last_quoted_on,
    count(*) filter (where s.outcome = 'won')::int    as quotes_won,
    count(*) filter (where s.outcome = 'lost')::int   as quotes_lost,
    count(*) filter (where s.outcome = 'open')::int   as quotes_open,
    max(s.total) filter (where s.outcome <> 'superseded') as largest_quote
  from nl.quote_state s
  where s.commitment_id is not null
  group by s.commitment_id
),
requirement_rollup as (
  select
    rs.commitment_id,
    count(*)::int                                  as requirements,
    count(*) filter (where rs.satisfied)::int      as requirements_met,
    count(*) filter (where not rs.satisfied)::int  as requirements_open,
    count(*) filter (where rs.overdue)::int        as requirements_overdue
  from nl.requirement_state rs
  where rs.commitment_id is not null
  group by rs.commitment_id
),
outcome_rollup as (
  select
    o.commitment_id,
    count(*)::int                                     as answers,
    count(*) filter (where o.outcome = 'pushed')::int as pushes,
    max(o.answered_at)                                as last_answered_at
  from nl.commitment_outcomes o
  group by o.commitment_id
),
step_rollup as (
  select
    s.commitment_id,
    count(*) filter (where s.completed_at is null)::int as open_steps,
    count(*) filter (where s.completed_at is null and s.due_on < (select today from clock))::int
                                                       as overdue_steps,
    count(*) filter (where s.completed_at is null and s.due_on = (select today from clock))::int
                                                       as steps_due_today,
    count(*) filter (where s.completed_at is null and s.source = 'agent')::int as agent_steps,
    min(s.due_on) filter (where s.completed_at is null) as next_due_on
  from nl.next_steps s
  where s.commitment_id is not null
  group by s.commitment_id
),
activity_rollup as (
  select
    a.commitment_id,
    count(*)::int        as touches,
    max(a.occurred_at)   as last_touch_at
  from nl.activities a
  where a.commitment_id is not null
  group by a.commitment_id
)
select
  c.id                                       as commitment_id,
  c.customer_no,
  coalesce(qr.quote_count, 0)                as quote_count,
  coalesce(qr.revision_count, 0)             as revision_count,
  qr.last_quoted_on,
  coalesce(qr.quotes_won, 0)                 as quotes_won,
  coalesce(qr.quotes_lost, 0)                as quotes_lost,
  coalesce(qr.quotes_open, 0)                as quotes_open,
  qr.largest_quote,
  coalesce(rr.requirements, 0)               as requirements,
  coalesce(rr.requirements_met, 0)           as requirements_met,
  coalesce(rr.requirements_open, 0)          as requirements_open,
  coalesce(rr.requirements_overdue, 0)       as requirements_overdue,
  coalesce(orr.answers, 0)                   as answers,
  coalesce(orr.pushes, 0)                    as pushes,
  orr.last_answered_at,
  coalesce(sr.open_steps, 0)                 as open_steps,
  coalesce(sr.overdue_steps, 0)              as overdue_steps,
  coalesce(sr.steps_due_today, 0)            as steps_due_today,
  coalesce(sr.agent_steps, 0)                as agent_steps,
  sr.next_due_on,
  coalesce(ar.touches, 0)                    as touches,
  ar.last_touch_at,
  -- Nothing behind it at all: no quote, no condition, no answer, no step.
  -- Worth naming, because it is the shape an agent can say least about.
  (coalesce(qr.quote_count, 0) = 0
   and coalesce(rr.requirements, 0) = 0
   and coalesce(orr.answers, 0) = 0
   and coalesce(sr.open_steps, 0) = 0)       as is_bare
from nl.commitments c
left join quote_rollup qr on qr.commitment_id = c.id
left join requirement_rollup rr on rr.commitment_id = c.id
left join outcome_rollup orr on orr.commitment_id = c.id
left join step_rollup sr on sr.commitment_id = c.id
left join activity_rollup ar on ar.commitment_id = c.id;

-- One row per account: the record a person reads in five seconds before they
-- promise anything. Settled commitments by how they ended, quotes by whether
-- they won, and the pattern of the last answers in the order they happened.
create view nl.account_sales_record with (security_invoker = true) as
with settled as (
  select
    p.customer_no,
    p.status,
    coalesce(p.answered_at::date, p.ends_on) as settled_on,
    p.committed_value,
    p.delivered
  from nl.commitment_progress p
  where p.is_settled
),
commitments as (
  select
    s.customer_no,
    count(*)::int                                  as settled_count,
    count(*) filter (where s.status = 'kept')::int    as kept,
    count(*) filter (where s.status = 'pushed')::int  as pushed,
    count(*) filter (where s.status = 'broken')::int  as broken,
    sum(s.committed_value)                         as settled_committed,
    sum(s.delivered)                               as settled_delivered,
    max(s.settled_on)                              as last_settled_on,
    -- The last eight answers, oldest first: the inline mark on the account
    -- page reads left to right like a calendar.
    (array_agg(s.status order by s.settled_on desc, s.customer_no))[1:8] as recent_desc
  from settled s
  group by s.customer_no
),
quote_record as (
  select
    q.customer_no,
    count(*)::int                                   as quotes,
    count(*) filter (where q.outcome = 'won')::int  as quotes_won,
    count(*) filter (where q.outcome = 'lost')::int as quotes_lost,
    count(*) filter (where q.outcome = 'open')::int as quotes_open
  from nl.quote_state q
  group by q.customer_no
),
-- Why this account's quotes were lost, biggest reason first.
loss_mix as (
  select
    q.customer_no,
    jsonb_object_agg(q.lost_reason, q.n order by q.n desc, q.lost_reason) as reasons,
    (array_agg(q.lost_reason order by q.n desc, q.lost_reason))[1] as top_loss_reason
  from (
    select s.customer_no, s.lost_reason, count(*)::int as n
    from nl.quote_state s
    where s.outcome = 'lost' and s.lost_reason is not null
    group by s.customer_no, s.lost_reason
  ) q
  group by q.customer_no
)
select
  cu.customer_no,
  coalesce(cm.settled_count, 0)   as settled_count,
  coalesce(cm.kept, 0)            as kept,
  coalesce(cm.pushed, 0)          as pushed,
  coalesce(cm.broken, 0)          as broken,
  cm.settled_committed,
  cm.settled_delivered,
  cm.last_settled_on,
  -- Kept as a share of everything settled. Null until something has settled,
  -- because zero out of zero is not a bad record.
  case when coalesce(cm.settled_count, 0) > 0
       then round(cm.kept::numeric / cm.settled_count, 4) end as kept_rate,
  -- The pattern, oldest first.
  coalesce((
    select array_agg(x.status order by x.n desc)
    from unnest(cm.recent_desc) with ordinality as x(status, n)
  ), '{}'::text[])                as pattern,
  coalesce(qr.quotes, 0)          as quotes,
  coalesce(qr.quotes_won, 0)      as quotes_won,
  coalesce(qr.quotes_lost, 0)     as quotes_lost,
  coalesce(qr.quotes_open, 0)     as quotes_open,
  lr.top_loss_reason,
  coalesce(lr.reasons, '{}'::jsonb) as loss_reasons
from nl.customers cu
left join commitments cm on cm.customer_no = cu.customer_no
left join quote_record qr on qr.customer_no = cu.customer_no
left join loss_mix lr on lr.customer_no = cu.customer_no;

-- ---------------------------------------------------------------------------
-- nl.record_outcome keeps the snapshot
-- ---------------------------------------------------------------------------

-- Same signature and the same rules as 0003; the answer now carries the
-- window it was about and the figures as they stood when it was given.
create or replace function nl.record_outcome(
  p_commitment_id       bigint,
  p_outcome             text,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_note                text default '',
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_progress   record;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_outcome');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_outcome is null or p_outcome not in ('kept', 'pushed', 'broken') then
    raise exception 'An outcome is kept, pushed or broken, not %.', coalesce(p_outcome, 'empty')
      using errcode = 'NL422';
  end if;
  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;

  select id, owner_id, starts_on, ends_on, kept_by_measure, delivered, committed_value, outcome
    into v_progress
  from nl.commitment_progress
  where id = p_commitment_id;
  if not found then
    raise exception 'Commitment % does not exist.', p_commitment_id using errcode = 'NL404';
  end if;

  if v_progress.owner_id <> v_actor.id and v_actor.role <> 'admin' then
    raise exception 'Only the owner of commitment % or an admin can record its outcome.', p_commitment_id
      using errcode = 'NL403';
  end if;
  if v_progress.ends_on >= nl.today() then
    raise exception 'The window for commitment % is open until %; there is nothing to answer yet.',
      p_commitment_id, v_progress.ends_on
      using errcode = 'NL422';
  end if;
  if v_progress.kept_by_measure then
    raise exception 'Commitment % already delivered enough to count as kept.', p_commitment_id
      using errcode = 'NL422';
  end if;

  update nl.commitments
     set updated_at = updated_at
   where id = p_commitment_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'Commitment % changed since it was loaded. Reload it and decide again.', p_commitment_id
      using errcode = 'NL409';
  end if;

  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, note,
                                      window_starts_on, window_ends_on,
                                      committed_value, delivered_value)
  values (p_commitment_id, p_outcome, 'person', v_actor.id, coalesce(p_note, ''),
          v_progress.starts_on, v_progress.ends_on,
          v_progress.committed_value, v_progress.delivered);

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'record_outcome', 'commitment', p_commitment_id::text, p_request_id,
          jsonb_build_object(
            'outcome', p_outcome,
            'previous_outcome', v_progress.outcome,
            'note', coalesce(p_note, ''),
            'delivered', v_progress.delivered,
            'committed_value', v_progress.committed_value));

  v_result := jsonb_build_object(
    'commitment_id', p_commitment_id,
    'outcome', p_outcome,
    'answered_by', v_actor.id,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- The nightly job's "pushed" answer also keeps the snapshot. It never sets a
-- new window: it only knows that a quote went out afterwards, not what the
-- customer agreed to, so it must not invent one.
create or replace function nl.answer_pushed_windows() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_answered jsonb;
begin
  with evidence as (
    select distinct on (p.id)
      p.id as commitment_id,
      p.starts_on,
      p.ends_on,
      p.committed_value,
      p.delivered,
      q.id as quote_id,
      q.quoted_on
    from nl.commitment_progress p
    join nl.commitment_family f on f.commitment_id = p.id
    join nl.quotes q on q.customer_no = f.customer_no and q.quoted_on > p.ends_on
    join nl.quote_lines ql on ql.quote_id = q.id
    join nl.commitment_items ci on ci.commitment_id = p.id and ci.item_no = ql.item_no
    where p.needs_outcome
    order by p.id, q.quoted_on desc, q.id desc
  ),
  answered as (
    insert into nl.commitment_outcomes (commitment_id, outcome, source, note, evidence,
                                        window_starts_on, window_ends_on,
                                        committed_value, delivered_value)
    select
      e.commitment_id,
      'pushed',
      'nightly',
      format('Quote %s (%s) asks for parts from this commitment after its window closed.', e.quote_id, e.quoted_on),
      jsonb_build_object(
        'kind', 'quote_after_window',
        'quote_id', e.quote_id,
        'quoted_on', e.quoted_on,
        'window_closed_on', e.ends_on),
      e.starts_on,
      e.ends_on,
      e.committed_value,
      e.delivered
    from evidence e
    returning commitment_id, evidence
  ),
  touched as (
    update nl.commitments c
       set updated_at = c.updated_at
      from answered a
     where c.id = a.commitment_id
    returning c.id
  ),
  logged as (
    insert into nl.audit_log (actor_id, via, action, entity, entity_id, detail)
    select null, 'nightly', 'record_outcome', 'commitment', a.commitment_id::text,
           jsonb_build_object('outcome', 'pushed', 'evidence', a.evidence)
    from answered a
    returning entity_id
  )
  select coalesce(jsonb_agg(l.entity_id::bigint order by l.entity_id::bigint), '[]'::jsonb)
    into v_answered
  from logged l;

  return jsonb_build_object('answered_pushed', v_answered);
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.quote_revisions enable row level security;
alter table nl.quote_revision_lines enable row level security;
alter table nl.requirements enable row level security;

-- Everything a sales team shares is readable by everyone in it.
create policy quote_revisions_read on nl.quote_revisions
  for select to nl_app, nl_readonly using (true);
create policy quote_revision_lines_read on nl.quote_revision_lines
  for select to nl_app, nl_readonly using (true);
create policy requirements_read on nl.requirements
  for select to nl_app, nl_readonly using (true);

-- A revision is sent in your own name, on a quote you wrote (or any, as an admin).
create policy quote_revisions_insert on nl.quote_revisions for insert to nl_app
  with check (
    sent_by = (select nl.current_user_id())
    and exists (
      select 1 from nl.quotes q
      where q.id = quote_id
        and (q.created_by = (select nl.current_user_id()) or (select nl.is_admin()))));
create policy quote_revision_lines_insert on nl.quote_revision_lines for insert to nl_app
  with check (exists (
    select 1 from nl.quote_revisions r
    where r.id = revision_id and r.sent_by = (select nl.current_user_id())));

-- A requirement is recorded in your own name. Anyone may then mark one met,
-- because whoever gets the certificate in their hand is the one who knows.
-- What nobody may do is change a condition somebody else already signed off,
-- or put another person's name on the sign-off.
create policy requirements_insert on nl.requirements for insert to nl_app
  with check (created_by = (select nl.current_user_id()));
create policy requirements_update on nl.requirements for update to nl_app
  using (satisfied_on is null or satisfied_by = (select nl.current_user_id()))
  with check (satisfied_by is null or satisfied_by = (select nl.current_user_id()));

grant select, insert on nl.quote_revisions, nl.quote_revision_lines, nl.requirements to nl_app;
grant update (satisfied_on, satisfied_by, satisfied_note, detail, required_by, updated_at)
  on nl.requirements to nl_app;
-- The two new next-step columns a person can change after the fact.
grant update (kind, note) on nl.next_steps to nl_app;

grant select on nl.quote_revisions, nl.quote_revision_lines, nl.requirements to nl_readonly;

grant select on nl.quote_revision_state, nl.quote_state, nl.requirement_state,
  nl.account_sales_record to nl_app, nl_readonly;
-- nl.commitment_depth counts calls, emails and visits, and nl.activities is a
-- table about people that nl_readonly has no grant on. The view is
-- security_invoker, so a grant here would only fail further down.
grant select on nl.commitment_depth to nl_app;

grant execute on function nl.loss_reasons(), nl.revision_reasons() to nl_app, nl_readonly;
-- The trigger function is the trigger's alone.
revoke execute on function nl.open_pushed_window() from public;
