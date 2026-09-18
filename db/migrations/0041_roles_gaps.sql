-- 0041 Roles, the five gaps.
--
-- 0031 said a role is three things: scope (which slice is mine), authority
-- (what I may decide and up to what amount) and disclosure (what I may be
-- shown). That model held, and then five holes in it turned up when somebody
-- actually tried to run a day out of it.
--
--   1. THE ESCALATION HOLE, and it is a bug rather than a missing feature.
--      Every amount branch of nl.work_waiting_for ends with
--      `and amount <= v_ceiling`. So a quote above the reviewer's ceiling
--      appeared on the reviewer's home page (no, it was filtered out) and on
--      nobody else's either, because no other branch looked for it. Work fell
--      into a gap in silence. This migration routes it: to the smallest
--      ceiling that clears it, and, when no ceiling clears it, to whoever
--      holds change_policy, labelled as what it is.
--
--   2. ORPHAN WORK. An account nobody is named on, a part family nobody
--      plans, a mailbox nobody reads. The three catch-all holders (the admin,
--      the ops manager, the chief executive) hold the whole dimension, so
--      strictly these rows are "in scope" for them, which is exactly how they
--      stayed invisible: a catch-all is not accountability. They now surface
--      as their own kind of work, with a count, and can be assigned from a
--      screen, audited.
--
--   3. THE DIMENSIONS THE WORLD ACTUALLY USES. nl.customers carries an
--      agency_id and has since 0002, and nothing could be scoped by it. So
--      'agency' becomes the sixth dimension. TERRITORY IS NOT ADDED, and the
--      reason is that nl.agencies.territory is an attribute of the agency
--      rather than of a customer: a territory scope is already sayable as the
--      agencies in that territory, and two ways to say one thing is how a
--      model starts disagreeing with itself.
--
--   4. COVERING FOR SOMEBODY. Already possible: a grant with an end date is
--      cover, and nl.grant_authority has taken ends_on since 0031. It was
--      simply never shown anywhere, and an item somebody is holding for a
--      colleague looked identical to their own. nl.work_waiting_for grows one
--      column, on_behalf_of, and a view collects the covers in force.
--
--   5. MANAGER ROLLUP. A person over other people's work wants their queues,
--      not only their own. nl.team_queue is that, read-only.
--
-- One shape note, because it is the thing most likely to confuse a reader of
-- nl.work_waiting_for: almost every row it returns is ONE ITEM. The orphan
-- row is not. It is one row per dimension carrying a count, because an
-- account nobody owns is not a decision waiting on somebody, it is a hole in
-- the map, and four hundred separate rows about it would push every real
-- decision off the page. Its `ref` is the dimension name and not a record id.

-- ---------------------------------------------------------------------------
-- Gap 3: the sixth dimension
-- ---------------------------------------------------------------------------

-- 'agency' joins the list. The value stored is nl.agencies.id as text, not
-- the agency's code, because nl.customers already carries agency_id: an id
-- means the "is this account mine" test is a comparison and not a join. The
-- mailbox dimension stores its id as text for the same reason.
--
-- This function is immutable and nl.user_scope has a check constraint that
-- calls it. Widening the list is safe: existing rows still pass, and the
-- constraint accepts the new value from here on.
create or replace function nl.scope_dimensions() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    'account',      -- nl.customers.customer_no
    'warehouse',    -- nl.locations.code
    'vendor',       -- nl.vendors.vendor_no
    'part_family',  -- nl.items.family
    'mailbox',      -- nl.mailboxes.id, as text
    'agency'        -- nl.agencies.id, as text (nl.customers.agency_id)
  ]
$$;

-- ---------------------------------------------------------------------------
-- Gap 2: what is in nobody's scope
-- ---------------------------------------------------------------------------

-- Only three of the six dimensions are ever assigned by NAME in this world.
-- Accounts have owners, planners hold particular part families, and a mailbox
-- has readers. The other three are held whole: the buyer holds every vendor,
-- the warehouse lead holds every building, a regional manager holds whole
-- agencies. So "nobody is named on this one" is a gap in those three and the
-- ordinary state of affairs in the others, and asking the question of a
-- vendor would report all twelve hundred of them as orphans.
create function nl.orphan_dimensions() returns text[]
language sql immutable
set search_path = ''
as $$ select array['account', 'part_family', 'mailbox'] $$;

comment on function nl.orphan_dimensions() is
  'The dimensions where a value with no named holder is a gap rather than the norm (migration 0041).';

-- The values in one dimension that no ACTIVE principal names.
--
-- "Names" is the load-bearing word. A scope row with a null value means
-- every value in the dimension, now and in future, and three people hold
-- exactly that. It is a catch-all so that nothing is unreachable, and it is
-- deliberately NOT counted here: if holding everything counted as owning each
-- thing, this function would always return nothing and the hole it exists to
-- find would stay hidden. An inactive principal does not count either, which
-- is what makes a departed rep's book show up.
--
-- plpgsql with one branch per dimension rather than a union of three, for the
-- reason nl.work_waiting_for gives at length: each `return query` is planned
-- on its own the first time it runs, so asking about mailboxes does not plan
-- a scan of the customer book.
create function nl.scope_orphans(p_dimension text)
returns table (value text, label text, detail text, since timestamptz)
language plpgsql stable
set search_path = ''
as $$
begin
  if p_dimension = 'account' then
    -- Live accounts only. A closed or blocked account with no owner is not
    -- work that fell into a gap, it is a closed account.
    return query
    select c.customer_no,
           c.name,
           trim(c.city || ' ' || c.state)
             || coalesce(', last owned by ' || u.full_name, ', never assigned'),
           c.updated_at
    from nl.customers c
    left join nl.users u on u.id = c.owner_id
    where not c.closed
      and not c.blocked
      and not exists (
        select 1 from nl.user_scope s
        join nl.users su on su.id = s.user_id
        where s.dimension = 'account' and s.value = c.customer_no and su.active)
    order by c.customer_no;

  elsif p_dimension = 'part_family' then
    return query
    select i.family,
           i.family,
           count(*)::text || ' parts, ' ||
             count(*) filter (where i.replenishment = 'Purchase')::text || ' bought in',
           null::timestamptz
    from nl.items i
    where not exists (
      select 1 from nl.user_scope s
      join nl.users su on su.id = s.user_id
      where s.dimension = 'part_family' and s.value = i.family and su.active)
    group by i.family
    order by i.family;

  elsif p_dimension = 'mailbox' then
    return query
    select mb.id::text,
           mb.label,
           mb.address,
           mb.updated_at
    from nl.mailboxes mb
    where mb.active
      and not exists (
        select 1 from nl.user_scope s
        join nl.users su on su.id = s.user_id
        where s.dimension = 'mailbox' and s.value = mb.id::text and su.active)
    order by mb.id;
  end if;
  -- Any other dimension returns nothing, on purpose: see
  -- nl.orphan_dimensions() for why the question does not apply there.
end $$;

comment on function nl.scope_orphans(text) is
  'The values in one dimension that no active principal names. A catch-all "all" row does not count as naming one (migration 0041).';

-- One row per dimension that has any, for a home page.
create function nl.scope_orphan_counts()
returns table (dimension text, n int, oldest timestamptz)
language sql stable
set search_path = ''
as $$
  select d.dimension, o.n, o.oldest
  from unnest(nl.orphan_dimensions()) as d(dimension)
  cross join lateral (
    select count(*)::int as n, min(s.since) as oldest
    from nl.scope_orphans(d.dimension) s) o
  where o.n > 0
$$;

-- ---------------------------------------------------------------------------
-- Gap 1: who a decision escalates to
-- ---------------------------------------------------------------------------

-- The smallest ceiling that clears this amount, and who holds it.
--
-- Smallest and not largest: an approval chain hands a decision up one step,
-- not straight to whoever has no limit at all. Ties go to the lower user id
-- so the answer is stable between calls. A person with no ceiling at all
-- (nl.authority_ceiling returns infinity) sorts last and so is the answer
-- only when nobody narrower will do.
--
-- Agents are excluded. An agent's amount grant is its autonomy LEVEL, not a
-- dollar ceiling, and handing a person's quote to a level is nonsense.
create function nl.escalation_holder(p_authority text, p_amount numeric)
returns int
language sql stable
set search_path = ''
as $$
  select u.id
  from nl.users u
  where u.active
    and u.kind = 'person'
    and nl.has_authority(u.id, p_authority)
    and nl.authority_ceiling(u.id, p_authority) >= coalesce(p_amount, 0)
  order by nl.authority_ceiling(u.id, p_authority), u.id
  limit 1
$$;

comment on function nl.escalation_holder(text, numeric) is
  'Who a decision of this size goes to: the smallest ceiling that clears it. Null when nobody''s does (migration 0041).';

-- ---------------------------------------------------------------------------
-- Gap 4: the covers in force
-- ---------------------------------------------------------------------------

-- A grant with an end date IS cover. There is no second mechanism and there
-- should not be one: an authority that ends on a date is somebody holding
-- something until a day, which is what cover means.
create view nl.active_cover with (security_invoker = true) as
select g.user_id,
       u.full_name,
       u.title,
       g.authority,
       g.limit_amount,
       g.starts_on,
       g.ends_on,
       (g.ends_on - nl.today())::int as days_left,
       g.note,
       g.granted_by,
       b.full_name as granted_by_name
from nl.authority_grants g
join nl.users u on u.id = g.user_id
left join nl.users b on b.id = g.granted_by
where g.ends_on is not null
  and g.starts_on <= nl.today()
  and g.ends_on >= nl.today();

comment on view nl.active_cover is
  'Authority grants that end on a date: somebody covering, and until when (migration 0041).';

-- ---------------------------------------------------------------------------
-- Gap 5: a manager's team, and what is waiting on each of them
-- ---------------------------------------------------------------------------

-- Who is in somebody's team.
--
-- There were two facts to derive this from and only one of them is actually
-- in the data. SCOPE OVERLAP would have made every inside salesperson the
-- manager of the rep whose book they cover, because covering a book and
-- running it look identical in nl.user_scope. nl.customers.owner_id is the
-- other, and it is the accountability fact the world already holds: the
-- people in my team are the people who OWN accounts inside my scope.
--
-- That gives the right answer for the three shapes that exist here. Somebody
-- holding every account gets every rep. Somebody holding whole agencies gets
-- the reps who own accounts in them. A rep holding their own book gets
-- themselves, and themselves excluded is nobody, which is correct: they
-- manage no one.
--
-- The one-person case is deliberately left to the caller and not filtered
-- here. An inside salesperson covering one rep's book resolves to a team of
-- exactly that rep, and that is cover rather than management, so the screen
-- draws a rollup only at two or more (see nl.team_queue's comment).
create function nl.team_members(p_user_id int)
returns setof int
language sql stable
set search_path = ''
as $$
  select distinct c.owner_id
  from nl.customers c
  join nl.users o on o.id = c.owner_id
  where o.active
    and o.kind = 'person'
    and c.owner_id <> p_user_id
    and (
      nl.scope_is_all(p_user_id, 'account')
      or nl.scope_is_all(p_user_id, 'agency')
      or exists (select 1 from nl.user_scope s
                 where s.user_id = p_user_id and s.dimension = 'account'
                   and s.value = c.customer_no)
      or exists (select 1 from nl.user_scope s
                 where s.user_id = p_user_id and s.dimension = 'agency'
                   and s.value = c.agency_id::text))
$$;

comment on function nl.team_members(int) is
  'The active people who own accounts inside this principal''s scope. Derived from nl.customers.owner_id, not from scope overlap (migration 0041).';

-- How much is waiting on each of them. Read-only, and it is the same
-- function their own home page is built from, so the count a manager sees is
-- the count the person sees and there is no second definition of "waiting".
--
-- One call of nl.work_waiting_for per team member. That is the cost, and it
-- is why the screen draws this behind its own await rather than blocking the
-- page: see the timing in docs/roles.md.
create function nl.team_queue(p_user_id int)
returns table (user_id int, full_name text, title text, waiting int, oldest_days int)
language sql stable
set search_path = ''
as $$
  select u.id, u.full_name, u.title, q.waiting, q.oldest_days
  from nl.team_members(p_user_id) as m(id)
  join nl.users u on u.id = m.id
  cross join lateral (
    select count(*)::int as waiting, coalesce(max(w.age_days), 0)::int as oldest_days
    from nl.work_waiting_for(u.id) w) q
  order by q.waiting desc, u.full_name
$$;

comment on function nl.team_queue(int) is
  'For somebody over other people''s work: how much is waiting on each of them, from their own home page function (migration 0041).';

-- ---------------------------------------------------------------------------
-- Gap 2, the write: give somebody a value they were not holding
-- ---------------------------------------------------------------------------

-- nl.set_user_scope REPLACES a whole dimension, which is the wrong tool for
-- handing one orphaned account to one person: doing it with that function
-- means reading their existing four hundred values and sending them all back,
-- and losing the lot if two people do it at once. This adds one row.
--
-- The row-level security on nl.user_scope still applies and is the interesting
-- part: an insert is allowed only when the value is in the ACTOR's own scope
-- (nl.may_act_on), so somebody holding change_policy over one agency cannot
-- hand out an account in another. An admin is not held to that.
create function nl.assign_scope(
  p_user_id    int,
  p_dimension  text,
  p_value      text,
  p_request_id text,
  p_via        text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_target nl.users;
  v_value  text;
  v_added  boolean;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'assign_scope');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);
  perform nl.require_role_authority();

  if p_dimension is null or not (p_dimension = any (nl.scope_dimensions())) then
    raise exception '% is not a scope dimension.', coalesce(p_dimension, 'empty') using errcode = 'NL422';
  end if;

  v_value := trim(coalesce(p_value, ''));
  if length(v_value) between 1 and 60 then
    null;
  else
    raise exception 'A scope value is between 1 and 60 characters.' using errcode = 'NL422';
  end if;

  select * into v_target from nl.users where id = p_user_id;
  if not found then
    raise exception 'There is nobody with id %.', p_user_id using errcode = 'NL404';
  end if;
  -- Handing work to somebody who has left is how it got lost the first time.
  if not v_target.active then
    raise exception '% is no longer active, so work cannot be assigned to them.', v_target.full_name
      using errcode = 'NL422';
  end if;

  insert into nl.user_scope (user_id, dimension, value, granted_by)
  values (p_user_id, p_dimension, v_value, v_actor.id)
  on conflict (user_id, dimension, coalesce(value, '*')) do nothing;
  v_added := found;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'assign_scope', 'user', p_user_id::text, p_request_id,
          jsonb_build_object('dimension', p_dimension, 'value', v_value,
                             'added', v_added, 'to', v_target.full_name));

  v_result := jsonb_build_object(
    'user_id', p_user_id, 'dimension', p_dimension, 'value', v_value, 'added', v_added);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

comment on function nl.assign_scope(int, text, text, text, text) is
  'Add one scope value to one principal, audited. The single-row counterpart to nl.set_user_scope (migration 0041).';

-- ---------------------------------------------------------------------------
-- The home page, with the gaps closed
-- ---------------------------------------------------------------------------

-- Recreated rather than replaced, because the return type grows a column and
-- Postgres will not replace a function's output shape. Nothing depends on it
-- (no view selects from it), so the drop is safe; the execute grant is
-- reinstated at the foot of this file.
drop function nl.work_waiting_for(int);

-- What changed from 0031, in one list, so a reader can diff it by eye:
--
--   * a new last column, on_behalf_of: the name of the person whose account
--     this is, when it is not the reader's own. Null on everything that has
--     no owner (a pick, a count, a load) and on a reader's own work.
--   * the two account-shaped branches (an expiring quote, a window that
--     closed short) now accept an account through the AGENCY dimension as
--     well as the account dimension.
--   * three new branches: 3b a quote escalated to this person, 3c a quote
--     above everybody's ceiling, 13 the orphan counts.
--
-- Everything else is 0031's text, unchanged apart from the null::text each
-- branch now carries in the new last column.
create function nl.work_waiting_for(p_user_id int)
returns table (
  kind          text,
  ref           text,
  subject       text,
  amount        numeric,
  waiting_since timestamptz,
  age_days      int,
  why           text,
  -- Null when it is this person's own. A name when they are holding it for
  -- somebody: covering a book, or holding a whole agency the account sits in.
  on_behalf_of  text
)
language plpgsql stable
set search_path = ''
as $$
declare
  v_today   date := nl.today();
  v_ceiling numeric;
  -- Whether this principal holds a whole dimension, read once. Without this
  -- the "is it mine" test was a function call per candidate row, which on the
  -- demo world was most of the time this function took.
  v_all_accounts  boolean := nl.scope_is_all(p_user_id, 'account');
  v_all_vendors   boolean := nl.scope_is_all(p_user_id, 'vendor');
  v_all_families  boolean := nl.scope_is_all(p_user_id, 'part_family');
  v_all_stores    boolean := nl.scope_is_all(p_user_id, 'warehouse');
  v_all_mailboxes boolean := nl.scope_is_all(p_user_id, 'mailbox');
  -- The agency dimension, read once into an array. A dozen agencies at most,
  -- so `= any (...)` on it is cheaper than a second exists() per row, and it
  -- keeps the scope test in the branches to one extra comparison.
  v_all_agencies  boolean := nl.scope_is_all(p_user_id, 'agency');
  v_agencies      text[]  := coalesce((
    select array_agg(s.value) from nl.user_scope s
    where s.user_id = p_user_id and s.dimension = 'agency' and s.value is not null),
    array[]::text[]);
begin
  -- 1. An agent's drafted reply, waiting to be sent.
  if nl.has_authority(p_user_id, 'approve_reply') then
    return query
    select 'mail_draft'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'A drafted reply is waiting for you to send it.'::text,
           null::text
    from nl.agent_queue q
    join nl.mail_drafts d on d.id = q.source_id
    where q.source = 'mail'
      and q.status = 'waiting'
      and (v_all_mailboxes or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'mailbox'
              and sc.value = d.mailbox_id::text));
  end if;

  -- 2. What the desk could not finish: a draft its own disclosure policy
  --    refused, or a message it would not guess at. These are the exceptions
  --    that escaped, and they belong to whoever reviews exceptions.
  if nl.has_authority(p_user_id, 'review_exception') then
    return query
    select 'mail_exception'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'The agent stopped and asked for a person.'::text,
           null::text
    from nl.agent_queue q
    join nl.mail_drafts d on d.id = q.source_id
    where q.source = 'mail'
      and q.status = 'needs_review'
      and (v_all_mailboxes or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'mailbox'
              and sc.value = d.mailbox_id::text));

    return query
    select 'mail_unanswered'::text,
           m.id::text,
           m.subject,
           null::numeric,
           m.received_at,
           (v_today - m.received_at::date)::int,
           'This message needs a person to answer it.'::text,
           null::text
    from nl.mail_messages m
    where m.status = 'needs_person'
      and (v_all_mailboxes or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'mailbox'
              and sc.value = m.mailbox_id::text));
  end if;

  -- 3. A quote read out of a customer's email, waiting to go out, and a quote
  --    already sent that is about to run out. Both need the same authority,
  --    and the ceiling is read once here rather than per row.
  if nl.has_authority(p_user_id, 'approve_quote') then
    v_ceiling := nl.authority_ceiling(p_user_id, 'approve_quote');

    return query
    select 'quote_request'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'A quote is drafted and waiting for your approval.'::text,
           null::text
    from nl.agent_queue q
    where q.source = 'rfq'
      and q.status in ('waiting', 'needs_review')
      and q.reviewer_id = p_user_id
      and coalesce(q.value, 0) <= v_ceiling;

    -- 3b. GAP 1. A quote whose value is over the ceiling of the person it was
    --     put in front of. The branch above drops it and, before this one
    --     existed, no other branch picked it up: it sat in the queue on
    --     nobody's home page. nl.escalation_holder hands it to the smallest
    --     ceiling that clears it, which is this person when this row appears.
    --
    --     coalesce(reviewer_id, 0) is deliberate. A queue row with no reviewer
    --     has a ceiling of zero (nobody holds an authority as user 0), so it
    --     escalates rather than vanishing, which is the same hole wearing a
    --     different hat.
    return query
    select 'quote_escalated'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           case when r.id is null
                then 'This quote had nobody to approve it and your limit covers it.'
                else 'Over ' || r.full_name || '''s limit, and your limit covers it.' end::text,
           r.full_name
    from nl.agent_queue q
    left join nl.users r on r.id = q.reviewer_id
    where q.source = 'rfq'
      and q.status in ('waiting', 'needs_review')
      and coalesce(q.value, 0) > nl.authority_ceiling(coalesce(q.reviewer_id, 0), 'approve_quote')
      and nl.escalation_holder('approve_quote', coalesce(q.value, 0)) = p_user_id;

    -- Nothing is technically waiting on a decision here, which is the point:
    -- it is the item a rep finds out about too late.
    return query
    select 'quote_expiring'::text,
           q.id::text,
           q.customer_name || ': quote ' || q.id::text,
           q.subtotal,
           q.valid_until::timestamptz,
           (q.valid_until - v_today)::int,
           'This quote runs out within a fortnight.'::text,
           case when cu.owner_id is distinct from p_user_id then o.full_name end
    from nl.quote_document q
    join nl.customers cu on cu.customer_no = q.customer_no
    left join nl.users o on o.id = cu.owner_id
    where q.valid_until is not null
      and q.valid_until >= v_today
      and q.valid_until <= v_today + 14
      and (v_all_accounts
           or v_all_agencies
           or cu.agency_id::text = any (v_agencies)
           or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'account'
              and sc.value = q.customer_no));
  end if;

  -- 3c. GAP 1, the honest end of it. A quote nobody's ceiling clears at all.
  --     It goes to whoever holds change_policy, because they are the one
  --     person who can fix it: raise a ceiling, or take the decision. It is
  --     labelled as what it is rather than dressed up as an ordinary
  --     approval, because "nobody can approve this" is a different fact from
  --     "you can approve this".
  if nl.has_authority(p_user_id, 'change_policy') then
    return query
    select 'escalation_stuck'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'Nobody has a limit big enough for this. Raise one, or decide it yourself.'::text,
           r.full_name
    from nl.agent_queue q
    left join nl.users r on r.id = q.reviewer_id
    where q.source = 'rfq'
      and q.status in ('waiting', 'needs_review')
      and coalesce(q.value, 0) > nl.authority_ceiling(coalesce(q.reviewer_id, 0), 'approve_quote')
      and nl.escalation_holder('approve_quote', coalesce(q.value, 0)) is null;
  end if;

  -- 4. Something the assistant proposed and will not run on its own.
  if nl.has_authority(p_user_id, 'approve_agent_proposal') then
    return query
    select 'agent_proposal'::text,
           q.source_id::text,
           q.summary,
           q.value::numeric,
           q.created_at,
           (v_today - q.created_at::date)::int,
           'The assistant proposed this and is waiting for your decision.'::text,
           null::text
    from nl.agent_queue q
    where q.source = 'assistant'
      and q.status in ('waiting', 'retry')
      and q.reviewer_id = p_user_id;
  end if;

  -- 5. A commitment window that closed short and has not been answered.
  if nl.has_authority(p_user_id, 'answer_commitment') then
    return query
    select 'commitment_answer'::text,
           p.id::text,
           p.title,
           p.committed_value,
           p.ends_on::timestamptz,
           coalesce(p.days_since_close, 0)::int,
           'The window closed short and nobody has said what happened.'::text,
           case when p.owner_id is distinct from p_user_id then o.full_name end
    from nl.commitment_progress p
    join nl.customers cu on cu.customer_no = p.customer_no
    left join nl.users o on o.id = p.owner_id
    where p.needs_outcome
      and (v_all_accounts
           or v_all_agencies
           or cu.agency_id::text = any (v_agencies)
           or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'account'
              and sc.value = p.customer_no));
  end if;

  -- 6. A short line whose supply would be a purchase order: the buyer's.
  --    Inside the month only. A line that ships in eight weeks is not waiting
  --    on anybody today, and putting it on a home page is how a home page
  --    stops being read.
  if nl.has_authority(p_user_id, 'release_purchase_order') then
    v_ceiling := nl.authority_ceiling(p_user_id, 'release_purchase_order');

    return query
    select 'coverage_purchase'::text,
           l.document_no || '/' || l.line_no::text,
           l.item_no || ' for ' || l.customer_no || ', ' || l.status,
           l.open_value,
           l.ship_date::timestamptz,
           coalesce(l.days_late, 0)::int,
           'This line has no supply and the part is bought in.'::text,
           null::text
    from nl.open_line_projection l
    join nl.items i on i.item_no = l.item_no
    where l.status in ('past_due', 'no_supply')
      and l.ship_date <= v_today + 30
      and i.replenishment = 'Purchase'
      and i.vendor_no is not null
      and (v_all_vendors or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'vendor'
              and sc.value = i.vendor_no))
      and coalesce(l.open_value, 0) <= v_ceiling;
  end if;

  -- 7. The same shortage when the part is made here: the planner's.
  if nl.has_authority(p_user_id, 'resolve_shortage') then
    return query
    select 'coverage_production'::text,
           l.document_no || '/' || l.line_no::text,
           l.item_no || ' for ' || l.customer_no || ', ' || l.status,
           l.open_value,
           l.ship_date::timestamptz,
           coalesce(l.days_late, 0)::int,
           'This line has no supply and the part is made here.'::text,
           null::text
    from nl.open_line_projection l
    join nl.items i on i.item_no = l.item_no
    where l.status in ('past_due', 'no_supply')
      and l.ship_date <= v_today + 30
      and i.replenishment in ('Prod. Order', 'Assembly')
      and (v_all_families or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'part_family'
              and sc.value = i.family));
  end if;

  -- 8. A supplier's new cost above the one before it. A material rise in the
  --    last fortnight: rounding noise on a cost revision is not a decision.
  if nl.has_authority(p_user_id, 'accept_price_increase') then
    v_ceiling := nl.authority_ceiling(p_user_id, 'accept_price_increase');

    return query
    select 'price_increase'::text,
           c.item_no || '@' || c.effective_from::text,
           c.item_no || ': cost up to ' || c.unit_cost::text,
           c.unit_cost,
           c.effective_from::timestamptz,
           (v_today - c.effective_from)::int,
           'A supplier has raised a cost and nobody has accepted it.'::text,
           null::text
    from nl.item_cost_timeline c
    where c.is_current
      and c.source = 'vendor quote'
      and c.change_pct >= 0.02
      and c.effective_from >= v_today - 14
      and c.vendor_no is not null
      and (v_all_vendors or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'vendor'
              and sc.value = c.vendor_no))
      and c.unit_cost <= v_ceiling;
  end if;

  -- 9. A shipment on the floor waiting to be picked.
  if nl.has_authority(p_user_id, 'confirm_pick') then
    return query
    select 'pick'::text,
           s.shipment_no,
           s.shipment_no || ' for ' || s.customer_no,
           null::numeric,
           s.created_at,
           (v_today - s.created_at::date)::int,
           'This shipment is still being picked.'::text,
           null::text
    from nl.shipments s
    where s.status = 'picking'
      and (v_all_stores or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'warehouse'
              and sc.value = s.location_code));
  end if;

  -- 10. A transfer due in that has not been received.
  if nl.has_authority(p_user_id, 'receive_stock') then
    return query
    select 'receipt'::text,
           t.transfer_no,
           t.transfer_no || ' from ' || t.from_location,
           null::numeric,
           t.expected_on::timestamptz,
           (v_today - t.expected_on)::int,
           'This transfer was due in and has not been received.'::text,
           null::text
    from nl.transfers t
    where t.status = 'in transit'
      and t.expected_on <= v_today
      and (v_all_stores or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'warehouse'
              and sc.value = t.to_location));
  end if;

  -- 11. A cycle count that is due.
  if nl.has_authority(p_user_id, 'count_stock') then
    return query
    select 'count'::text,
           c.session_no,
           c.session_no || ', zone ' || c.zone,
           null::numeric,
           c.due_on::timestamptz,
           (v_today - c.due_on)::int,
           'This count is due and not posted.'::text,
           null::text
    from nl.count_sessions c
    where c.status = 'open'
      and c.due_on <= v_today
      and (v_all_stores or exists (
            select 1 from nl.user_scope sc
            where sc.user_id = p_user_id and sc.dimension = 'warehouse'
              and sc.value = c.location_code));
  end if;

  -- 12. A daily ERP export staged or held, waiting to be applied. No scope
  --     dimension: there is one company and one load.
  if nl.has_authority(p_user_id, 'run_import') then
    return query
    select 'import_decision'::text,
           s.id::text,
           s.kind || ': ' || s.file_name,
           s.total_value,
           s.staged_at,
           (v_today - s.staged_at::date)::int,
           case when s.status = 'held'
                then 'This load is held and needs a decision.'
                else 'This load is staged and waiting to be applied.' end::text,
           null::text
    from nl.export_snapshots s
    where s.status in ('staged', 'held');
  end if;

  -- 13. GAP 2. What is in nobody's scope, as ONE ROW PER DIMENSION carrying a
  --     count. Not one row per orphan: four hundred accounts nobody owns
  --     would bury every real decision on the page, and an unowned account is
  --     not a decision anyway. It is a hole in the map, and the decision it
  --     asks for is "give these to somebody", which is one decision.
  --
  --     `ref` is the dimension name, which is the one place in this function
  --     where it is not a record id. The screen it links to reads it as one.
  --
  --     A part family has no timestamp anywhere in the schema, so `oldest` is
  --     null there and the age reads zero rather than inventing a date.
  if nl.has_authority(p_user_id, 'review_exception') then
    return query
    select 'orphan_scope'::text,
           o.dimension,
           o.n::text || ' ' ||
             case o.dimension
               when 'account' then 'live account' when 'part_family' then 'part family'
               else 'mailbox' end ||
             case when o.n = 1 then '' when o.dimension = 'part_family' then ' families'
                  else 's' end ||
             ' nobody is named on',
           null::numeric,
           coalesce(o.oldest, now()),
           case when o.oldest is null then 0 else (v_today - o.oldest::date)::int end,
           'Only the people who hold every one of these at once can see them. Give them an owner.'::text,
           null::text
    from nl.scope_orphan_counts() o;
  end if;
end $$;

comment on function nl.work_waiting_for(int) is
  'Everything inside a principal''s scope that is waiting on an authority they hold, what escalated to them, and what is in nobody''s scope. The home page (migrations 0031, 0041).';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant select on nl.active_cover to nl_app;

grant execute on function
  nl.orphan_dimensions(),
  nl.scope_orphans(text),
  nl.scope_orphan_counts(),
  nl.escalation_holder(text, numeric),
  nl.team_members(int),
  nl.team_queue(int),
  nl.assign_scope(int, text, text, text, text),
  nl.work_waiting_for(int)
to nl_app;
