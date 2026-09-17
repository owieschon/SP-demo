-- 0003 Commitments: a named buyer's promise to buy specific parts, worth a
-- stated value, inside a date window. Plus the quotes that back them and the
-- notes and next steps a sales team leaves behind.
--
-- The rules that shape this migration:
--   * Status is derived, never stored and never picked:
--       promised -> quoted -> delivering -> kept | pushed | broken
--   * Delivered is measured from the invoice ledger, never typed.
--   * When a window closes short, a person answers one question (pushed,
--     kept or broken). The nightly job may answer "pushed", and only with
--     evidence. It can never answer "broken"; the table itself refuses.

-- A commitment counts as kept once delivered reaches this share of its value.
create function nl.kept_ratio() returns numeric
language sql immutable
as $$ select 0.95::numeric $$;

-- ---------------------------------------------------------------------------
-- Commitments
-- ---------------------------------------------------------------------------

create table nl.commitments (
  id               bigint generated always as identity (start with 3001) primary key,
  title            text not null,
  customer_no      text not null references nl.customers (customer_no),
  buyer_contact_id bigint references nl.contacts (id),
  owner_id         int not null references nl.users (id),
  committed_value  numeric(12, 2) not null check (committed_value > 0),
  starts_on        date not null,
  ends_on          date not null,
  -- The owner's confidence that the rest will arrive, 0 to 100.
  confidence       int not null default 50 check (confidence between 0 and 100),
  notes            text not null default '',
  created_by       int not null references nl.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default nl.now_ms(),
  constraint commitments_window_in_order check (ends_on >= starts_on)
);

create index commitments_customer_idx on nl.commitments (customer_no);
create index commitments_owner_idx on nl.commitments (owner_id);
create index commitments_buyer_idx on nl.commitments (buyer_contact_id);
create index commitments_created_by_idx on nl.commitments (created_by);

create trigger commitments_touch before update on nl.commitments
  for each row execute function nl.touch_updated_at();

-- The parts in scope. Delivery is matched on item number alone, because the
-- parts arrive mixed into whatever orders the customer happens to place.
create table nl.commitment_items (
  commitment_id bigint not null references nl.commitments (id) on delete cascade,
  item_no       text not null references nl.items (item_no),
  quantity      int check (quantity > 0),   -- what the buyer said, when they said it
  primary key (commitment_id, item_no)
);

create index commitment_items_item_idx on nl.commitment_items (item_no);

-- Answers to "the window closed short: what happened?". Append-only: a later
-- answer replaces an earlier one, and both stay on record.
create table nl.commitment_outcomes (
  id            bigint generated always as identity primary key,
  commitment_id bigint not null references nl.commitments (id) on delete cascade,
  outcome       text not null check (outcome in ('kept', 'pushed', 'broken')),
  source        text not null check (source in ('person', 'nightly')),
  answered_by   int references nl.users (id),
  answered_at   timestamptz not null default now(),
  note          text not null default '',
  evidence      jsonb,
  -- A person's answer carries their name.
  constraint outcomes_person_is_named check (source <> 'person' or answered_by is not null),
  -- The nightly job only ever says "pushed", and only with evidence.
  constraint outcomes_nightly_pushed_with_evidence
    check (source <> 'nightly' or (outcome = 'pushed' and evidence is not null and answered_by is null))
);

create index commitment_outcomes_latest_idx on nl.commitment_outcomes (commitment_id, answered_at desc, id desc);
create index commitment_outcomes_answered_by_idx on nl.commitment_outcomes (answered_by);

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------

create table nl.quotes (
  id            bigint generated always as identity (start with 448001) primary key,
  customer_no   text not null references nl.customers (customer_no),
  contact_id    bigint references nl.contacts (id),
  -- The commitment this quote was written for, if any.
  commitment_id bigint references nl.commitments (id) on delete set null,
  quoted_on     date not null,
  valid_until   date,
  source        text not null default 'manual' check (source in ('manual', 'rfq', 'seed')),
  created_by    int not null references nl.users (id),
  created_at    timestamptz not null default now()
);

create index quotes_customer_quoted_idx on nl.quotes (customer_no, quoted_on);
create index quotes_commitment_idx on nl.quotes (commitment_id);
create index quotes_contact_idx on nl.quotes (contact_id);
create index quotes_created_by_idx on nl.quotes (created_by);

create table nl.quote_lines (
  quote_id   bigint not null references nl.quotes (id) on delete cascade,
  line_no    int not null,
  item_no    text not null references nl.items (item_no),
  quantity   int not null check (quantity > 0),
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  primary key (quote_id, line_no)
);

create index quote_lines_item_idx on nl.quote_lines (item_no);

-- ---------------------------------------------------------------------------
-- Notes, calls and next steps
-- ---------------------------------------------------------------------------

create table nl.activities (
  id            bigint generated always as identity primary key,
  customer_no   text not null references nl.customers (customer_no),
  commitment_id bigint references nl.commitments (id) on delete set null,
  kind          text not null check (kind in ('note', 'call', 'email', 'meeting')),
  call_outcome  text check (call_outcome in ('reached', 'voicemail', 'no_answer', 'callback')),
  body          text not null,
  author_id     int not null references nl.users (id),
  via           text not null default 'ui' check (via in ('ui', 'assistant', 'seed')),
  occurred_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  constraint activities_call_outcome_only_on_calls check (call_outcome is null or kind = 'call')
);

create index activities_customer_idx on nl.activities (customer_no, occurred_at desc);
create index activities_commitment_idx on nl.activities (commitment_id);
create index activities_author_idx on nl.activities (author_id);

create table nl.next_steps (
  id            bigint generated always as identity primary key,
  customer_no   text not null references nl.customers (customer_no),
  commitment_id bigint references nl.commitments (id) on delete set null,
  title         text not null,
  due_on        date,
  owner_id      int not null references nl.users (id),
  created_by    int not null references nl.users (id),
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  completed_by  int references nl.users (id),
  updated_at    timestamptz not null default nl.now_ms()
);

create index next_steps_customer_idx on nl.next_steps (customer_no);
create index next_steps_commitment_idx on nl.next_steps (commitment_id);
create index next_steps_owner_open_idx on nl.next_steps (owner_id, due_on) where completed_at is null;
create index next_steps_created_by_idx on nl.next_steps (created_by);
create index next_steps_completed_by_idx on nl.next_steps (completed_by);

create trigger next_steps_touch before update on nl.next_steps
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Measuring progress
-- ---------------------------------------------------------------------------

-- Who counts as "the customer" for each commitment: its own account plus
-- every account billed to it, at any depth (a head office and its branches).
create view nl.commitment_family with (security_invoker = true) as
with recursive family (commitment_id, customer_no, depth, path) as (
  select c.id, c.customer_no, 0, array[c.customer_no]
  from nl.commitments c
  union all
  select f.commitment_id, child.customer_no, f.depth + 1, f.path || child.customer_no
  from family f
  join nl.customers child on child.bill_to_no = f.customer_no
  -- Bad data with a billing loop must not recurse forever.
  where not child.customer_no = any (f.path)
)
select commitment_id, customer_no, depth
from family;

-- Every invoice line that counts toward a commitment: the right customer
-- family, an item in scope, posted inside the window. Credit memo lines
-- are negative, so returns take delivery back off.
create view nl.commitment_lines with (security_invoker = true) as
select
  c.id as commitment_id,
  il.invoice_no,
  il.line_no,
  il.posted_on,
  il.customer_no,
  f.depth as family_depth,
  il.item_no,
  il.quantity,
  il.unit_price,
  il.amount
from nl.commitments c
join nl.commitment_family f on f.commitment_id = c.id
join nl.commitment_items ci on ci.commitment_id = c.id
join nl.invoice_lines il
  on il.customer_no = f.customer_no
 and il.item_no = ci.item_no
 and il.posted_on between c.starts_on and c.ends_on;

-- One row per commitment with everything the board needs, computed in one
-- set-based pass. docs/sql.md walks through it.
create view nl.commitment_progress with (security_invoker = true) as
with delivered as (
  select
    commitment_id,
    sum(amount)    as delivered,
    count(*)       as matched_lines,
    max(posted_on) as last_delivery_on
  from nl.commitment_lines
  group by commitment_id
),
-- The latest answer wins; earlier ones stay in the table as history.
latest_outcome as (
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
    nl.today()     as today
  from nl.commitments c
  left join delivered d on d.commitment_id = c.id
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
  -- The window closed, the value did not arrive, and nobody has said why.
  (k.outcome is null and not k.kept_by_measure and k.ends_on < k.today) as needs_outcome,
  case when k.ends_on < k.today then k.today - k.ends_on end as days_since_close,
  -- How far through its window the commitment is, 0 to 1 (the pace mark).
  least(greatest((k.today - k.starts_on)::numeric / (k.ends_on - k.starts_on + 1), 0), 1)
    as window_elapsed_ratio,
  -- What has landed, plus the owner's confidence in the rest. A settled
  -- commitment expects nothing more.
  round(
    k.delivered
    + case when k.status in ('kept', 'pushed', 'broken') then 0
           else k.confidence / 100.0 * k.remaining end,
    2) as expected_value
from classified k;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- A person answers the window-closed question. Called by the answer screen
-- and, after a person approves it, by the assistant.
create function nl.record_outcome(
  p_commitment_id       bigint,
  p_outcome             text,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_note                text default '',
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
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

  select id, owner_id, ends_on, kept_by_measure, delivered, committed_value, outcome
    into v_progress
  from nl.commitment_progress
  where id = p_commitment_id;
  if not found then
    raise exception 'Commitment % does not exist.', p_commitment_id using errcode = 'NL404';
  end if;

  -- Field rule: an outcome is the owner's judgment (or an admin's).
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

  -- Optimistic lock: the row must still be the version the person looked
  -- at. The trigger moves updated_at forward, so a second answer made from
  -- the same stale page fails here instead of silently landing twice.
  update nl.commitments
     set updated_at = updated_at
   where id = p_commitment_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'Commitment % changed since it was loaded. Reload it and decide again.', p_commitment_id
      using errcode = 'NL409';
  end if;

  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, note)
  values (p_commitment_id, p_outcome, 'person', v_actor.id, coalesce(p_note, ''));

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

-- The owner changes how confident they are that the rest will arrive.
create function nl.set_confidence(
  p_commitment_id       bigint,
  p_confidence          int,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_progress   record;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_confidence');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_confidence is null or p_confidence < 0 or p_confidence > 100 then
    raise exception 'Confidence is a whole number from 0 to 100.' using errcode = 'NL422';
  end if;
  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;

  select id, owner_id, confidence, status, is_settled
    into v_progress
  from nl.commitment_progress
  where id = p_commitment_id;
  if not found then
    raise exception 'Commitment % does not exist.', p_commitment_id using errcode = 'NL404';
  end if;
  if v_progress.owner_id <> v_actor.id and v_actor.role <> 'admin' then
    raise exception 'Only the owner of commitment % or an admin can change its confidence.', p_commitment_id
      using errcode = 'NL403';
  end if;
  if v_progress.is_settled then
    raise exception 'Commitment % is already %, so its confidence no longer counts.',
      p_commitment_id, v_progress.status
      using errcode = 'NL422';
  end if;

  update nl.commitments
     set confidence = p_confidence
   where id = p_commitment_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'Commitment % changed since it was loaded. Reload it and try again.', p_commitment_id
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'set_confidence', 'commitment', p_commitment_id::text, p_request_id,
          jsonb_build_object('from', v_progress.confidence, 'to', p_confidence));

  v_result := jsonb_build_object(
    'commitment_id', p_commitment_id,
    'confidence', p_confidence,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Nightly: answer "pushed" for a window that closed short, but only when
-- there is evidence the business is still coming: a quote for the same
-- customer family, dated after the window closed, asking for at least one
-- of the same parts. Never "broken": that is a person's call, and the
-- outcomes table would refuse it anyway. Runs as the job, not as a user.
create function nl.answer_pushed_windows() returns jsonb
language plpgsql
as $$
declare
  v_answered jsonb;
begin
  with evidence as (
    select distinct on (p.id)
      p.id as commitment_id,
      p.ends_on,
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
    insert into nl.commitment_outcomes (commitment_id, outcome, source, note, evidence)
    select
      e.commitment_id,
      'pushed',
      'nightly',
      format('Quote %s (%s) asks for parts from this commitment after its window closed.', e.quote_id, e.quoted_on),
      jsonb_build_object(
        'kind', 'quote_after_window',
        'quote_id', e.quote_id,
        'quoted_on', e.quoted_on,
        'window_closed_on', e.ends_on)
    from evidence e
    returning commitment_id, evidence
  ),
  -- Move the row version so a page opened before the job cannot answer on
  -- top of it without reloading.
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

alter table nl.commitments enable row level security;
alter table nl.commitment_items enable row level security;
alter table nl.commitment_outcomes enable row level security;
alter table nl.quotes enable row level security;
alter table nl.quote_lines enable row level security;
alter table nl.activities enable row level security;
alter table nl.next_steps enable row level security;

-- Everyone reads everything a sales team shares.
create policy commitments_read on nl.commitments for select to nl_app, nl_readonly using (true);
create policy commitment_items_read on nl.commitment_items for select to nl_app, nl_readonly using (true);
create policy commitment_outcomes_read on nl.commitment_outcomes for select to nl_app, nl_readonly using (true);
create policy quotes_read on nl.quotes for select to nl_app, nl_readonly using (true);
create policy quote_lines_read on nl.quote_lines for select to nl_app, nl_readonly using (true);
create policy activities_read on nl.activities for select to nl_app using (true);
create policy next_steps_read on nl.next_steps for select to nl_app, nl_readonly using (true);

-- Commitments: created in your own name, for yourself unless you are an
-- admin; changed only by their owner or an admin. Handing one to someone
-- else is allowed, but only to an active user.
create policy commitments_insert on nl.commitments for insert to nl_app
  with check (
    created_by = (select nl.current_user_id())
    and (owner_id = (select nl.current_user_id()) or (select nl.is_admin())));
create policy commitments_update on nl.commitments for update to nl_app
  using (owner_id = (select nl.current_user_id()) or (select nl.is_admin()))
  with check (exists (select 1 from nl.users u where u.id = owner_id and u.active));

create policy commitment_items_insert on nl.commitment_items for insert to nl_app
  with check (exists (
    select 1 from nl.commitments c
    where c.id = commitment_id
      and (c.owner_id = (select nl.current_user_id()) or (select nl.is_admin()))));
create policy commitment_items_delete on nl.commitment_items for delete to nl_app
  using (exists (
    select 1 from nl.commitments c
    where c.id = commitment_id
      and (c.owner_id = (select nl.current_user_id()) or (select nl.is_admin()))));

-- An outcome from a user is always that user's own answer, on a commitment
-- they own (or any, for an admin).
create policy commitment_outcomes_insert on nl.commitment_outcomes for insert to nl_app
  with check (
    source = 'person'
    and answered_by = (select nl.current_user_id())
    and exists (
      select 1 from nl.commitments c
      where c.id = commitment_id
        and (c.owner_id = (select nl.current_user_id()) or (select nl.is_admin()))));

create policy quotes_insert on nl.quotes for insert to nl_app
  with check (created_by = (select nl.current_user_id()));
create policy quote_lines_insert on nl.quote_lines for insert to nl_app
  with check (exists (
    select 1 from nl.quotes q
    where q.id = quote_id and q.created_by = (select nl.current_user_id())));

-- Notes and calls: anyone may add one, in their own name. Nobody edits them.
create policy activities_insert on nl.activities for insert to nl_app
  with check (author_id = (select nl.current_user_id()));

-- Next steps: anyone may add one in their own name. The step's owner, the
-- customer's owner or an admin may change it (complete it, move it).
create policy next_steps_insert on nl.next_steps for insert to nl_app
  with check (created_by = (select nl.current_user_id()));
create policy next_steps_update on nl.next_steps for update to nl_app
  using (
    owner_id = (select nl.current_user_id())
    or (select nl.is_admin())
    or exists (
      select 1 from nl.customers cu
      where cu.customer_no = next_steps.customer_no
        and cu.owner_id = (select nl.current_user_id())))
  with check (exists (select 1 from nl.users u where u.id = owner_id and u.active));

grant select, insert on nl.commitments, nl.commitment_items, nl.commitment_outcomes,
  nl.quotes, nl.quote_lines, nl.activities, nl.next_steps to nl_app;
grant update (title, buyer_contact_id, owner_id, committed_value, starts_on, ends_on,
  confidence, notes, updated_at) on nl.commitments to nl_app;
grant delete on nl.commitment_items to nl_app;
grant update (title, due_on, owner_id, completed_at, completed_by, updated_at) on nl.next_steps to nl_app;
grant select on nl.commitment_family, nl.commitment_lines, nl.commitment_progress to nl_app;

-- Activities are what people wrote about people, so the read-only role does
-- not get them.
grant select on nl.commitments, nl.commitment_items, nl.commitment_outcomes,
  nl.quotes, nl.quote_lines, nl.next_steps,
  nl.commitment_family, nl.commitment_lines, nl.commitment_progress to nl_readonly;

grant execute on function nl.kept_ratio() to nl_app, nl_readonly;
grant execute on function nl.today() to nl_readonly;
grant execute on function
  nl.record_outcome(bigint, text, timestamptz, text, text, text),
  nl.set_confidence(bigint, int, timestamptz, text, text)
to nl_app;
-- nl.answer_pushed_windows() is for the nightly job only: no grant.
