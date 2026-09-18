-- Depth behind the commitments: the quotes that shaped them, the conditions
-- those quotes carry, a trail of answers for every window that closed, the
-- next steps somebody still owes, and the calls and emails around all of it.
--
-- Before this file the demo world held 192 commitments with 8 quotes, 15
-- next steps and one answer each. A commitment like that gives an agent
-- nothing to reason from: it cannot say what was promised and missed, what
-- the last quote said, or what this customer's record actually looks like.
--
-- Needs migration 0031. Runs after the base world and after
-- db/seed.d/10_accounts_depth.sql, so the people and the account activity
-- are already there. Everything is keyed randomness, so every database
-- builds the same world, and every count is a per-row draw rather than a
-- quota, so the shapes hold at all three sizes.
--
-- The one rule worth stating: nothing here is uniform. A future change that
-- gives every commitment one quote and one next step would read as generated
-- data, so app/src/lib/server/commitments/depth.test.ts asserts the spread.

-- ---------------------------------------------------------------------------
-- Pricing a quote line
-- ---------------------------------------------------------------------------

-- Quote lines are priced through the app's own pricing precedence rather than
-- a second path invented here, so a quote in the demo world agrees with what
-- the pricing screens would say. The order desk's quantity breaks are used
-- when that migration has landed, the plain precedence when only it has, and
-- the group discount when neither is there yet: this file is read by branches
-- that may not carry them.
create or replace function nl_seed.quote_price(
  p_customer text,
  p_item     text,
  p_qty      int,
  p_on       date
) returns table (unit_price numeric, rule text)
language plpgsql
stable
set search_path = ''
as $$
begin
  if to_regprocedure('nl.desk_price_for(text,text,int,date)') is not null then
    return query
      select d.unit_price,
             d.rule || case when d.break_quantity is not null then ' with a quantity break' else '' end
      from nl.desk_price_for(p_customer, p_item, p_qty, p_on) d;
    return;
  end if;
  if to_regprocedure('nl.price_for(text,text,date)') is not null then
    return query select p.price, p.rule from nl.price_for(p_customer, p_item, p_on) p;
    return;
  end if;
  return query select nl_seed.net_price(p_customer, p_item), 'group discount'::text;
end $$;

-- ---------------------------------------------------------------------------
-- The extras
-- ---------------------------------------------------------------------------

create or replace function nl_seed.extra_90_commitment_depth() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set   nl_seed.settings;
  v_today date;
begin
  select * into v_set from nl_seed.settings;
  v_today := v_set.today;

  -- =========================================================================
  -- 1. More settled history, so an account has a record to read
  -- =========================================================================
  --
  -- The base world gives an account one to three settled commitments, which
  -- is not enough to see a pattern in. This adds nought to three more per
  -- account, on windows the account really bought in, over the last three
  -- years. About one account in seven is a difficult one whose windows mostly
  -- did not hold: that is the account an agent should cite when it declines
  -- to promise a date.

  drop table if exists pg_temp.depth_record;
  create temporary table depth_record as
  with accounts as (
    select c.customer_no,
           coalesce(c.owner_id, 1) as owner_id,
           h.hard,
           -- A difficult account gets more history, because its record is
           -- the thing worth reading and two rows is not a record.
           case when h.hard then nl_seed.ri(2, 4, 'depth.record.n|' || c.customer_no)
                else nl_seed.ri(1, 3, 'depth.record.n|' || c.customer_no) end as want
    from nl.customers c
    cross join lateral (
      select nl_seed.chance(0.14, 'depth.hard|' || c.customer_no) as hard
    ) h
    where c.bill_to_no is null
      and not c.closed
      -- Only accounts the world already has a commitment for, so the extra
      -- history lands where a reader is likely to look.
      and exists (select 1 from nl.commitments cm where cm.customer_no = c.customer_no)
      and nl_seed.chance(0.6, 'depth.record?|' || c.customer_no)
  ),
  planned as (
    select
      a.customer_no, a.owner_id, a.hard, g.n,
      w.starts_on,
      w.starts_on + nl_seed.ri(60, 150, 'depth.rec.len|' || a.customer_no || '|' || g.n) as ends_on
    from accounts a
    cross join lateral generate_series(1, a.want) as g(n)
    cross join lateral (
      select v_today - nl_seed.ri(200, 1050, 'depth.rec.start|' || a.customer_no || '|' || g.n) as starts_on
    ) w
  ),
  -- The window has to have closed a while ago, and the parts have to be ones
  -- the family actually shipped in it.
  scoped as (
    select p.*,
           i.items,
           nl_seed.family_delivered(p.customer_no, i.items, p.starts_on, p.ends_on) as delivered
    from planned p
    cross join lateral (
      select (nl_seed.family_items(p.customer_no, p.starts_on, p.ends_on,
                                   'depth.rec.items|' || p.customer_no || '|' || p.n)
             )[1:nl_seed.ri(2, 6, 'depth.rec.parts|' || p.customer_no || '|' || p.n)] as items
    ) i
    where p.ends_on < v_today - 25
  )
  select distinct on (s.customer_no, s.starts_on, s.ends_on)
    s.customer_no, s.owner_id, s.hard, s.n, s.starts_on, s.ends_on, s.items, s.delivered,
    'depth.rec|' || s.customer_no || '|' || s.n as key,
    -- How the window ended. A difficult account keeps far fewer of them.
    case
      when s.hard then
        (array['kept', 'pushed', 'broken', 'broken'])[
          1 + width_bucket(nl_seed.u('depth.rec.end|' || s.customer_no || '|' || s.n),
                           array[0.16, 0.46, 0.73]::double precision[])]
      else
        (array['kept', 'kept', 'pushed', 'broken'])[
          1 + width_bucket(nl_seed.u('depth.rec.end|' || s.customer_no || '|' || s.n),
                           array[0.40, 0.74, 0.89]::double precision[])]
    end as ending
  from scoped s
  where cardinality(s.items) >= 2
    and s.delivered >= 400
    -- Never collide with a window the base world already made.
    and not exists (
      select 1 from nl.commitments cm
      where cm.customer_no = s.customer_no
        and cm.starts_on = s.starts_on
        and cm.ends_on = s.ends_on)
  order by s.customer_no, s.starts_on, s.ends_on, s.n;

  -- A kept window asked for roughly what arrived, so the ledger settles it on
  -- its own. A window that did not hold asked for two to four times as much.
  insert into nl.commitments (title, customer_no, buyer_contact_id, owner_id, committed_value,
                              starts_on, ends_on, confidence, created_by, created_at)
  select
    nl_seed.title_for(r.items, r.key),
    r.customer_no,
    (select ct.id from nl.contacts ct
      where ct.customer_no = r.customer_no
      order by ct.is_primary desc, ct.id limit 1),
    r.owner_id,
    case when r.ending = 'kept'
         then round(r.delivered * (0.86 + 0.13 * nl_seed.u(r.key || '|value'))::numeric, 2)
         else round(r.delivered * (2.0 + 2.0 * nl_seed.u(r.key || '|value'))::numeric, 2) end,
    r.starts_on,
    r.ends_on,
    case when r.ending = 'kept' then nl_seed.ri(7, 9, r.key || '|conf') * 10
         else nl_seed.ri(3, 6, r.key || '|conf') * 10 end,
    r.owner_id,
    (r.starts_on + time '09:30') at time zone 'America/Chicago'
  from depth_record r;

  -- Which rows became which commitments. The window plus the account is the
  -- natural key: the plan made each one unique and skipped any the base world
  -- already had.
  drop table if exists pg_temp.depth_made;
  create temporary table depth_made as
  select cm.id, r.*
  from depth_record r
  join nl.commitments cm
    on cm.customer_no = r.customer_no
   and cm.starts_on = r.starts_on
   and cm.ends_on = r.ends_on;

  create index depth_made_id_idx on pg_temp.depth_made (id);

  insert into nl.commitment_items (commitment_id, item_no, quantity)
  select m.id, x.item_no,
         nl_seed.typical_qty(x.item_no, m.key || '|qty|' || x.item_no) * nl_seed.ri(2, 8, m.key || '|mult')
  from depth_made m
  cross join lateral unnest(m.items) as x(item_no)
  on conflict do nothing;

  -- The answer the owner gave when the window closed short, with the figures
  -- as they stood and a reason from the vocabulary.
  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note,
                                      window_starts_on, window_ends_on,
                                      committed_value, delivered_value, reason)
  select
    m.id, m.ending, 'person', m.owner_id,
    (m.ends_on + nl_seed.ri(2, 21, m.key || '|answered') + time '15:20') at time zone 'America/Chicago',
    case
      when m.ending = 'pushed' and nl_seed.chance(0.7, m.key || '|note?')
        then nl_seed.pick(array[
               'Buyer confirmed the parts are still wanted; their build slot moved.',
               'Fleet delivery slipped, so the order sits with them until it lands.',
               'Purchasing has the number approved and is waiting on a release.'], m.key || '|note')
      when m.ending = 'broken' and nl_seed.chance(0.65, m.key || '|note?')
        then nl_seed.pick(array[
               'They took the whole line elsewhere on price.',
               'The project was shelved when the contract went the other way.',
               'They consolidated vendors and we were not on the list.'], m.key || '|note')
      else ''
    end,
    m.starts_on, m.ends_on, cm.committed_value, coalesce(d.delivered, 0),
    case m.ending
      when 'pushed' then nl_seed.pick(array['no decision', 'lead time', 'no decision'], m.key || '|reason')
      when 'broken' then nl_seed.pick(array['price', 'competitor', 'price',
                                            'customer cancelled the project',
                                            'requirement we could not meet'], m.key || '|reason')
    end
  from depth_made m
  join nl.commitments cm on cm.id = m.id
  left join nl.commitment_delivery d on d.commitment_id = m.id
  where m.ending in ('pushed', 'broken');

  -- =========================================================================
  -- 2. The answers the base world already wrote get their snapshot
  -- =========================================================================
  --
  -- An answer read two years later has to carry the window it was about and
  -- the figures as they stood, because both move afterwards. The reason is
  -- read back out of the note the base world wrote.

  update nl.commitment_outcomes o
     set window_starts_on = c.starts_on,
         window_ends_on   = c.ends_on,
         committed_value  = c.committed_value,
         delivered_value  = coalesce(d.delivered, 0),
         reason = case o.outcome
                    when 'pushed' then
                      case when o.note ilike '%quarter%' or o.note ilike '%release%'
                           then 'no decision' else 'lead time' end
                    when 'broken' then
                      case when o.note ilike '%price%' or o.note ilike '%competitor%' then 'price'
                           when o.note ilike '%consolidat%' then 'competitor'
                           else 'customer cancelled the project' end
                  end
    from nl.commitments c
    left join nl.commitment_delivery d on d.commitment_id = c.id
   where c.id = o.commitment_id
     and o.window_ends_on is null;

  -- =========================================================================
  -- 3. A trail, not one answer
  -- =========================================================================
  --
  -- A window that was pushed long enough ago got a second look. Some of those
  -- second answers name the window the business moved to, and migration 0031
  -- then opens that follow-on commitment: the same customer, the same parts,
  -- worth what the first window did not deliver.

  drop table if exists pg_temp.depth_again;
  create temporary table depth_again as
  select
    o.id as outcome_id,
    o.commitment_id,
    coalesce(o.answered_by, 1) as answered_by,
    o.window_starts_on,
    o.window_ends_on,
    o.committed_value,
    o.delivered_value,
    a.key,
    a.verdict,
    a.again_on
  from nl.commitment_outcomes o
  cross join lateral (
    select
      'depth.again|' || o.id as key,
      -- What the second look said.
      (array['moved', 'broken', 'nothing'])[
        1 + width_bucket(nl_seed.u('depth.again|' || o.id),
                         array[0.34, 0.64]::double precision[])] as verdict,
      o.answered_at::date + nl_seed.ri(21, 110, 'depth.again.when|' || o.id) as again_on
  ) a
  where o.outcome = 'pushed'
    and o.window_ends_on < v_today - 75
    and o.next_commitment_id is null
    -- A second look that has not happened yet is not a second look.
    and a.again_on <= v_today;

  -- "The business moved to this window." The trigger in 0031 opens it.
  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note,
                                      window_starts_on, window_ends_on,
                                      committed_value, delivered_value, reason,
                                      pushed_to_starts_on, pushed_to_ends_on)
  select
    a.commitment_id, 'pushed', 'person', a.answered_by,
    (a.again_on + time '11:15') at time zone 'America/Chicago',
    'Buyer named a new window for the same parts, so the balance moves with it.',
    a.window_starts_on, a.window_ends_on, a.committed_value, a.delivered_value,
    'no decision',
    w.starts_on,
    w.starts_on + nl_seed.ri(60, 160, a.key || '|len')
  from depth_again a
  cross join lateral (
    select a.window_ends_on + nl_seed.ri(20, 120, a.key || '|gap') as starts_on
  ) w
  where a.verdict = 'moved';

  -- "It is not coming after all." The same commitment, answered again later.
  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note,
                                      window_starts_on, window_ends_on,
                                      committed_value, delivered_value, reason)
  select
    a.commitment_id, 'broken', 'person', a.answered_by,
    (a.again_on + time '11:15') at time zone 'America/Chicago',
    case when nl_seed.chance(0.6, a.key || '|note?')
         then nl_seed.pick(array[
                'Chased it twice more and then they told us it had gone elsewhere.',
                'The build was cancelled, so the parts are not wanted at all.',
                'Never got past purchasing. Calling it what it is.'], a.key || '|note')
         else '' end,
    a.window_starts_on, a.window_ends_on, a.committed_value, a.delivered_value,
    nl_seed.pick(array['competitor', 'customer cancelled the project', 'no decision'], a.key || '|reason')
  from depth_again a
  where a.verdict = 'broken';

  -- A follow-on window that has itself already closed gets an answer, so the
  -- "closed short, nobody has said why" list stays the size the base world
  -- deliberately made it.
  insert into nl.commitment_outcomes (commitment_id, outcome, source, answered_by, answered_at, note,
                                      window_starts_on, window_ends_on,
                                      committed_value, delivered_value, reason)
  select
    p.id, e.ending, 'person', p.owner_id,
    (p.ends_on + nl_seed.ri(4, 18, 'depth.follow|' || p.id) + time '14:40') at time zone 'America/Chicago',
    case e.ending
      when 'kept' then 'The moved order landed inside the new window.'
      else 'Second window closed short as well. Not chasing it further.'
    end,
    p.starts_on, p.ends_on, p.committed_value, p.delivered,
    case when e.ending = 'broken'
         then nl_seed.pick(array['no decision', 'competitor', 'price'], 'depth.follow|' || p.id) end
  from nl.commitment_progress p
  cross join lateral (
    select case when nl_seed.chance(0.35, 'depth.follow.end|' || p.id) then 'kept' else 'broken' end as ending
  ) e
  where p.needs_outcome
    and exists (
      select 1 from nl.commitment_outcomes o where o.next_commitment_id = p.id);

  -- =========================================================================
  -- 4. Quotes, and the revisions that shaped them
  -- =========================================================================
  --
  -- A commitment carries nought to three quotes. Nought is the standing
  -- arrangement: the customer buys on an agreed price sheet and nobody quotes
  -- anything. A commitment still at "promised" is left alone on purpose,
  -- because a quote on the record is what makes it "quoted".

  drop table if exists pg_temp.depth_quote_plan;
  create temporary table depth_quote_plan as
  select
    p.id as commitment_id,
    p.customer_no,
    p.owner_id,
    p.status,
    p.starts_on,
    p.ends_on,
    g.k,
    'depth.q|' || p.id || '|' || g.k as key,
    -- How many versions this quote went through.
    1 + width_bucket(nl_seed.u('depth.q.rev|' || p.id || '|' || g.k),
                     array[0.45, 0.75, 0.92]::double precision[]) as versions,
    -- The last quote on a commitment is the one that decided it; an earlier
    -- one was replaced, which is a loss of its own.
    g.k = w.wanted as is_last
  from nl.commitment_progress p
  cross join lateral (
    select width_bucket(nl_seed.u('depth.q.n|' || p.id),
                        array[0.34, 0.78, 0.94]::double precision[]) as wanted
  ) w
  cross join lateral generate_series(1, w.wanted) as g(k)
  where p.status <> 'promised'
    -- The base world already put a quote on some commitments; leave those be
    -- and give the revisions to the quote it wrote.
    and not exists (select 1 from nl.quotes q where q.commitment_id = p.id);

  insert into nl.quotes (customer_no, contact_id, commitment_id, quoted_on, valid_until,
                         source, created_by, created_at)
  select
    pl.customer_no,
    (select ct.id from nl.contacts ct
      where ct.customer_no = pl.customer_no
      order by ct.is_primary desc, ct.id limit 1),
    pl.commitment_id,
    d.quoted_on,
    d.quoted_on + nl_seed.ri(15, 60, pl.key || '|valid'),
    'seed',
    pl.owner_id,
    (d.quoted_on + time '14:00') at time zone 'America/Chicago'
  from depth_quote_plan pl
  cross join lateral (
    select
      -- Quotes go out around the start of the window and never after it
      -- closes: a quote dated after the close is the nightly job's evidence
      -- that business moved, and this file must not manufacture that.
      least(
        greatest(pl.starts_on - nl_seed.ri(0, 21, pl.key || '|before'), pl.starts_on - 30)
          + (pl.k - 1) * nl_seed.ri(18, 55, pl.key || '|spacing'),
        least(pl.ends_on, v_today)
      ) as quoted_on
  ) d;

  -- Which quote came from which plan row: the k-th quote on a commitment, in
  -- date order, is the k-th plan row. Only the commitments this file quoted
  -- for are in range, because the plan skipped any that already had a quote.
  drop table if exists pg_temp.depth_quotes;
  create temporary table depth_quotes as
  with numbered as (
    select q.id, q.customer_no, q.quoted_on, q.valid_until, q.commitment_id,
           row_number() over (partition by q.commitment_id order by q.quoted_on, q.id) as k
    from nl.quotes q
    where q.source = 'seed'
      and q.commitment_id in (select pl2.commitment_id from depth_quote_plan pl2)
  )
  select
    n.id as quote_id, n.customer_no, n.quoted_on, n.valid_until,
    pl.commitment_id, pl.owner_id, pl.status, pl.starts_on, pl.ends_on,
    pl.k, pl.key, pl.versions, pl.is_last
  from depth_quote_plan pl
  join numbered n on n.commitment_id = pl.commitment_id and n.k = pl.k;

  -- The base world's own quotes are quotes too, and they get a first issue
  -- and sometimes a revision, on the commitment they were written for.
  insert into pg_temp.depth_quotes (quote_id, customer_no, quoted_on, valid_until, commitment_id,
                                    owner_id, status, starts_on, ends_on, k, key, versions, is_last)
  select
    q.id, q.customer_no, q.quoted_on, q.valid_until, q.commitment_id,
    p.owner_id, p.status, p.starts_on, p.ends_on, 1,
    'depth.base.q|' || q.id,
    1 + width_bucket(nl_seed.u('depth.base.rev|' || q.id), array[0.4, 0.74, 0.92]::double precision[]),
    true
  from nl.quotes q
  join nl.commitment_progress p on p.id = q.commitment_id
  where q.commitment_id is not null
    and not exists (select 1 from pg_temp.depth_quotes dq where dq.quote_id = q.id);

  create index depth_quotes_idx on pg_temp.depth_quotes (quote_id);

  -- One row per version of every quote.
  drop table if exists pg_temp.depth_revisions;
  create temporary table depth_revisions as
  select
    dq.quote_id, dq.commitment_id, dq.customer_no, dq.owner_id, dq.status,
    dq.starts_on, dq.ends_on, dq.versions, dq.is_last,
    v.version,
    dq.key || '|v' || v.version as key,
    v.version = dq.versions as is_latest,
    -- Each version goes out a little after the one before it.
    least(dq.quoted_on + (v.version - 1) * nl_seed.ri(5, 26, dq.key || '|step'),
          least(dq.ends_on + 10, v_today)) as revised_on,
    case
      when v.version = 1 then 'first issue'
      else (array['price increase', 'quantity break', 'lead time', 'freight added',
                  'scope change', 'customer request'])[
             1 + width_bucket(nl_seed.u(dq.key || '|why|' || v.version),
                              array[0.22, 0.44, 0.60, 0.72, 0.86]::double precision[])]
    end as change_reason
  from pg_temp.depth_quotes dq
  cross join lateral generate_series(1, dq.versions) as v(version);

  insert into nl.quote_revisions (quote_id, version, revised_on, sent_by, valid_from, valid_until,
                                  change_reason, change_note, outcome, outcome_reason, outcome_note,
                                  decided_on, created_at)
  select
    r.quote_id,
    r.version,
    r.revised_on,
    r.owner_id,
    r.revised_on,
    r.revised_on + nl_seed.ri(15, 60, r.key || '|valid'),
    r.change_reason,
    -- A note on most revisions but not all: a rep who is in a hurry writes
    -- the version and nothing else, and that is the honest shape of the data.
    case when nl_seed.chance(0.72, r.key || '|note?') then
      case r.change_reason
        when 'first issue'      then 'First pass off the parts list the buyer read out.'
        when 'price increase'   then 'Mill cost moved, so the price moved with it.'
        when 'quantity break'   then 'They took the next break up, so the unit price came down.'
        when 'lead time'        then 'Lead time moved out, so the dates on the quote moved with it.'
        when 'freight added'    then 'Freight added: they are under the prepaid threshold on this one.'
        when 'scope change'     then 'Buyer dropped a part off the list.'
        else                         'Reissued at the buyer''s request with their own part numbers.'
      end
    else '' end,
    o.outcome,
    o.reason,
    case when o.outcome in ('lost', 'withdrawn') and nl_seed.chance(0.55, r.key || '|onote?')
         then case o.reason
                when 'price'          then 'Beaten by about six points. They showed us nothing in writing.'
                when 'lead time'      then 'They needed it inside two weeks and we could not say yes.'
                when 'competitor'     then 'Went to the vendor they already buy their filters from.'
                when 'no decision'    then 'Sat with purchasing until the quote ran out.'
                when 'requirement we could not meet'
                                      then 'They wanted a first article we are not set up to certify.'
                else                       'Their project was cancelled before anybody decided.'
              end
         else '' end,
    o.decided_on,
    (r.revised_on + time '14:10') at time zone 'America/Chicago'
  from pg_temp.depth_revisions r
  cross join lateral (
    select
      case
        -- Every version but the last was replaced by the next one.
        when not r.is_latest then 'superseded'
        -- An earlier quote on the same commitment lost to the one after it.
        when not r.is_last then
          case when nl_seed.chance(0.6, r.key || '|end') then 'lost' else 'expired' end
        when r.status in ('kept', 'delivering') then 'won'
        when r.status = 'broken' then 'lost'
        when r.status = 'pushed' then
          (array['expired', 'lost', 'open'])[
            1 + width_bucket(nl_seed.u(r.key || '|end'), array[0.55, 0.85]::double precision[])]
        else
          (array['open', 'open', 'expired', 'withdrawn'])[
            1 + width_bucket(nl_seed.u(r.key || '|end'), array[0.5, 0.72, 0.9]::double precision[])]
      end as outcome
  ) picked
  cross join lateral (
    select
      picked.outcome,
      -- A loss needs a reason from the vocabulary; a win never has one.
      case when picked.outcome = 'lost'
           then nl_seed.pick(array['price', 'price', 'competitor', 'lead time',
                                   'no decision', 'requirement we could not meet',
                                   'customer cancelled the project'], r.key || '|reason')
           when picked.outcome = 'withdrawn' and nl_seed.chance(0.5, r.key || '|wreason')
           then 'customer cancelled the project'
      end as reason,
      case when picked.outcome = 'open' then null
           else r.revised_on + nl_seed.ri(3, 40, r.key || '|decided') end as decided_on
  ) o;

  -- The lines of each version. Version 1 is priced through the app's own
  -- precedence; later versions move off it for the reason they carry.
  insert into nl.quote_revision_lines (revision_id, line_no, item_no, quantity, unit_price,
                                       price_rule, lead_days)
  select
    rev.id,
    x.n,
    x.item_no,
    q.quantity,
    -- The reason a version exists is visible in its prices.
    greatest(round(pr.unit_price * f.price_factor, 2), 0.01),
    pr.rule,
    nl_seed.ri(5, 21, rev_key.key || '|lead') + f.extra_lead
  from nl.quote_revisions rev
  join pg_temp.depth_quotes dq on dq.quote_id = rev.quote_id
  cross join lateral (select dq.key || '|v' || rev.version as key) rev_key
  cross join lateral (
    -- Scope changes drop a part or add one, so the line list is not identical
    -- across versions.
    select array_agg(ci.item_no order by ci.item_no) as items
    from nl.commitment_items ci
    where ci.commitment_id = dq.commitment_id
  ) scope
  cross join lateral unnest(
    scope.items[1:greatest(1, cardinality(scope.items)
      - case when rev.change_reason = 'scope change' then 1 else 0 end)]
  ) with ordinality as x(item_no, n)
  cross join lateral (
    select case rev.change_reason
             when 'price increase' then 1.0 + 0.03 + 0.06 * nl_seed.u(rev_key.key || '|up')
             when 'quantity break' then 1.0 - 0.02 - 0.05 * nl_seed.u(rev_key.key || '|down')
             else 1.0
           end::numeric as price_factor,
           case when rev.change_reason = 'lead time'
                then nl_seed.ri(10, 30, rev_key.key || '|slip') else 0 end as extra_lead
  ) f
  cross join lateral (
    select nl_seed.typical_qty(x.item_no, rev_key.key || '|qty|' || x.item_no)
           * nl_seed.ri(2, 9, rev_key.key || '|mult')
           * case when rev.change_reason = 'quantity break' then 2 else 1 end as quantity
  ) q
  cross join lateral nl_seed.quote_price(dq.customer_no, x.item_no, q.quantity, rev.revised_on) pr
  where cardinality(scope.items) > 0;

  -- nl.quote_lines holds the quote as it now stands, which is its latest
  -- version. The revisions hold how it got there. The RFQ and order desk
  -- paths write nl.quote_lines directly and know nothing about revisions, so
  -- this keeps the two agreeing for anything they read. The base world's own
  -- lines are replaced rather than merged, because a revision can carry
  -- fewer lines than the version before it.
  delete from nl.quote_lines ql
   where ql.quote_id in (select dq.quote_id from pg_temp.depth_quotes dq);

  insert into nl.quote_lines (quote_id, line_no, item_no, quantity, unit_price)
  select rev.quote_id, rl.line_no, rl.item_no, rl.quantity, rl.unit_price
  from nl.quote_revisions rev
  join nl.quote_revision_lines rl on rl.revision_id = rev.id
  where rev.version = (select max(r2.version) from nl.quote_revisions r2 where r2.quote_id = rev.quote_id);

  -- =========================================================================
  -- 5. The conditions a quote or a commitment carries
  -- =========================================================================
  --
  -- Structured rows, never prose, because an agent can only honour a
  -- condition it can read. Some are met and signed off, some are still owed,
  -- and a few are owed past the day they were due.

  -- On quotes.
  insert into nl.requirements (quote_id, kind, party, quantity, amount, terms_code, holds_until,
                               detail, required_by, satisfied_on, satisfied_by, satisfied_note,
                               created_by, created_at)
  select
    dq.quote_id,
    k.kind,
    case k.kind
      when 'freight_paid_by' then nl_seed.pick(array['us', 'customer', 'customer', 'carrier'], r.key || '|party')
      when 'first_article_inspection' then 'us'
      when 'certificate_of_conformance' then 'us'
      when 'packaging_and_marking' then 'us'
    end,
    case when k.kind = 'minimum_order' then nl_seed.ri(4, 40, r.key || '|minq') end,
    case when k.kind = 'minimum_order' and nl_seed.chance(0.4, r.key || '|mina')
         then nl_seed.ri(5, 40, r.key || '|minv') * 100 end,
    case when k.kind = 'delivery_terms'
         then nl_seed.pick(array['FOB origin', 'FOB destination', 'delivered duty paid',
                                 'collect on their carrier'], r.key || '|terms') end,
    case when k.kind = 'price_hold'
         then dq.quoted_on + nl_seed.ri(30, 150, r.key || '|hold') end,
    case k.kind
      when 'first_article_inspection'   then 'One piece off the first run, dimensional report with it.'
      when 'certificate_of_conformance' then 'Certificate with every shipment, referencing their purchase order.'
      when 'packaging_and_marking'      then 'Their label on each carton, part number and quantity on the outside.'
      when 'delivery_terms'             then 'Terms as agreed with purchasing, not our standard terms.'
      when 'freight_paid_by'            then 'Freight on this quote, agreed before it went out.'
      when 'minimum_order'              then 'Below this quantity the price on this quote does not hold.'
      else                                   'Price held through the date on this quote.'
    end,
    case when nl_seed.chance(0.55, r.key || '|by?')
         then dq.quoted_on + nl_seed.ri(10, 90, r.key || '|by') end,
    case when s.met then dq.quoted_on + nl_seed.ri(5, 60, r.key || '|met') end,
    case when s.met then dq.owner_id end,
    case when s.met and nl_seed.chance(0.5, r.key || '|mnote?')
         then nl_seed.pick(array['Sent with the first shipment.',
                                 'Buyer signed it off on the phone.',
                                 'Their quality group has the paperwork.'], r.key || '|mnote')
         else '' end,
    dq.owner_id,
    (dq.quoted_on + time '15:05') at time zone 'America/Chicago'
  from pg_temp.depth_quotes dq
  cross join lateral (select 'depth.req.q|' || dq.quote_id as key) r
  cross join lateral generate_series(1,
    case when nl_seed.chance(0.38, r.key || '|any?')
         then nl_seed.ri(1, 2, r.key || '|n') else 0 end) as g(n)
  cross join lateral (
    select (array['delivery_terms', 'freight_paid_by', 'certificate_of_conformance',
                  'first_article_inspection', 'packaging_and_marking', 'minimum_order',
                  'price_hold'])[
             1 + width_bucket(nl_seed.u(r.key || '|kind|' || g.n),
                              array[0.22, 0.42, 0.58, 0.70, 0.82, 0.92]::double precision[])] as kind
  ) k
  cross join lateral (
    -- A won quote's conditions are mostly met by now; a lost one's never were.
    select nl_seed.chance(
      case when qs.outcome = 'won' then 0.6
           when qs.outcome = 'open' then 0.3
           else 0.12 end,
      r.key || '|met?|' || g.n) as met
    from nl.quote_state qs where qs.id = dq.quote_id
  ) s;

  -- On commitments, where a condition outlives any one quote.
  insert into nl.requirements (commitment_id, kind, party, quantity, amount, terms_code, holds_until,
                               detail, required_by, satisfied_on, satisfied_by, satisfied_note,
                               created_by, created_at)
  select
    p.id,
    k.kind,
    case k.kind
      when 'freight_paid_by' then nl_seed.pick(array['us', 'customer', 'customer'], r.key || '|party')
      else 'us'
    end,
    case when k.kind = 'minimum_order' then nl_seed.ri(6, 60, r.key || '|minq') end,
    null,
    case when k.kind = 'delivery_terms'
         then nl_seed.pick(array['FOB origin', 'FOB destination', 'delivered duty paid'], r.key || '|terms') end,
    case when k.kind = 'price_hold' then p.starts_on + nl_seed.ri(60, 300, r.key || '|hold') end,
    case k.kind
      when 'first_article_inspection'   then 'First article on the first release of this program.'
      when 'certificate_of_conformance' then 'Certificate on every release under this program.'
      when 'packaging_and_marking'      then 'Program labelling, agreed with their receiving dock.'
      when 'delivery_terms'             then 'Program terms, for every release inside the window.'
      when 'freight_paid_by'            then 'Freight arrangement for the whole program.'
      when 'minimum_order'              then 'Minimum release quantity for the program price.'
      else                                   'Program price held through this date.'
    end,
    case when nl_seed.chance(0.6, r.key || '|by?')
         then p.starts_on + nl_seed.ri(5, 120, r.key || '|by') end,
    case when s.met then p.starts_on + nl_seed.ri(3, 80, r.key || '|met') end,
    case when s.met then p.owner_id end,
    '',
    p.owner_id,
    (p.starts_on + time '10:20') at time zone 'America/Chicago'
  from nl.commitment_progress p
  cross join lateral (select 'depth.req.c|' || p.id as key) r
  cross join lateral generate_series(1,
    case when nl_seed.chance(0.24, r.key || '|any?')
         then nl_seed.ri(1, 2, r.key || '|n') else 0 end) as g(n)
  cross join lateral (
    select (array['delivery_terms', 'certificate_of_conformance', 'freight_paid_by',
                  'first_article_inspection', 'minimum_order', 'packaging_and_marking',
                  'price_hold'])[
             1 + width_bucket(nl_seed.u(r.key || '|kind|' || g.n),
                              array[0.24, 0.44, 0.60, 0.72, 0.84, 0.93]::double precision[])] as kind
  ) k
  cross join lateral (
    select nl_seed.chance(case when p.is_settled then 0.7 else 0.35 end, r.key || '|met?|' || g.n) as met
  ) s;

  -- =========================================================================
  -- 6. Next steps that behave like real ones
  -- =========================================================================

  -- What the base world already wrote gets a kind, read off its own title.
  update nl.next_steps s
     set kind = case
                  when s.title ilike '%quote%' or s.title ilike '%pricing%'
                    or s.title ilike '%price%'                              then 'send_quote'
                  when s.title ilike '%backorder%' or s.title ilike '%release%'
                    or s.title ilike '%order%' or s.title ilike '%claim%'   then 'chase_po'
                  when s.title ilike '%stock%'                              then 'check_stock'
                  when s.title ilike '%drawing%' or s.title ilike '%spec%'  then 'confirm_requirement'
                  when s.title ilike '%visit%' or s.title ilike '%training%'
                    or s.title ilike '%forecast%' or s.title ilike '%check in%'
                    or s.title ilike '%follow up%' or s.title ilike '%ask%'
                    or s.title ilike '%call%'                               then 'call'
                  else 'other'
                end
   where s.kind = 'other';

  -- Nought to three of its own on each commitment, which leaves a good share
  -- of commitments with none: an even spread is the tell of generated data.
  insert into nl.next_steps (customer_no, commitment_id, title, kind, source, agent, note,
                             due_on, owner_id, created_by, created_at, completed_at, completed_by,
                             requirement_id)
  select
    p.customer_no,
    p.id,
    t.title,
    k.kind,
    src.source,
    src.agent,
    case when nl_seed.chance(0.45, r.key || '|note?') then t.note else '' end,
    w.due_on,
    p.owner_id,
    p.owner_id,
    (w.created_on + time '08:40') at time zone 'America/Chicago',
    -- Done on the day it was due, or done late. Never before it was written.
    case when w.state in ('done', 'done_late')
         then (w.due_on + case when w.state = 'done_late'
                               then nl_seed.ri(3, 25, r.key || '|late') else 0 end
               + time '16:30') at time zone 'America/Chicago' end,
    case when w.state in ('done', 'done_late') then p.owner_id end,
    case when k.kind = 'confirm_requirement' then (
      select rq.id from nl.requirement_state rq
      where rq.commitment_id = p.id and not rq.satisfied
      order by rq.id limit 1) end
  from nl.commitment_progress p
  cross join lateral (select 'depth.step|' || p.id as key) r
  cross join lateral generate_series(1,
    width_bucket(nl_seed.u(r.key || '|n'), array[0.42, 0.74, 0.92]::double precision[])) as g(n)
  cross join lateral (
    select
      -- Most work is not urgent. A few are overdue, a few are due today, and
      -- a few were simply never done.
      (array['open', 'open', 'open', 'due_today', 'overdue', 'forgotten', 'done', 'done', 'done_late'])[
        1 + width_bucket(nl_seed.u(r.key || '|state|' || g.n),
                         array[0.30, 0.44, 0.52, 0.62, 0.67, 0.80, 0.90, 0.96]::double precision[])] as state
  ) st
  cross join lateral (
    select
      st.state,
      case st.state
        when 'due_today'  then v_today
        when 'overdue'    then v_today - nl_seed.ri(2, 30, r.key || '|due|' || g.n)
        when 'forgotten'  then v_today - nl_seed.ri(60, 240, r.key || '|due|' || g.n)
        when 'open'       then v_today + nl_seed.ri(1, 21, r.key || '|due|' || g.n)
        else v_today - nl_seed.ri(10, 200, r.key || '|due|' || g.n)
      end as due_on
  ) w0
  cross join lateral (
    select w0.state, w0.due_on,
           w0.due_on - nl_seed.ri(2, 20, r.key || '|made|' || g.n) as created_on
  ) w
  cross join lateral (
    select
      case
        when p.status = 'promised'   then nl_seed.pick(array['send_quote', 'call', 'call'], r.key || '|kind|' || g.n)
        when p.status = 'quoted'     then nl_seed.pick(array['chase_po', 'call', 'confirm_requirement', 'send_quote'], r.key || '|kind|' || g.n)
        when p.status = 'delivering' then nl_seed.pick(array['check_stock', 'chase_po', 'call', 'confirm_requirement'], r.key || '|kind|' || g.n)
        else nl_seed.pick(array['call', 'send_quote', 'other'], r.key || '|kind|' || g.n)
      end as kind
  ) k
  cross join lateral (
    -- A meaningful share are proposals an agent made, so the trust surfaces
    -- have something to measure. The rest a person typed.
    select
      case when nl_seed.chance(0.34, r.key || '|who|' || g.n) then 'agent' else 'person' end as source,
      case when nl_seed.chance(0.34, r.key || '|who|' || g.n)
           then nl_seed.pick(array['order desk', 'order desk', 'assistant', 'procurement desk'],
                             r.key || '|agent|' || g.n) end as agent
  ) src
  cross join lateral (
    select
      case k.kind
        when 'call'                then 'Call the buyer about this window'
        when 'send_quote'          then 'Get a quote in front of the buyer'
        when 'chase_po'            then 'Chase the purchase order'
        when 'confirm_requirement' then 'Confirm the condition on the quote'
        when 'check_stock'         then 'Check stock before the next release'
        else                            'Tidy up the parts list on this one'
      end as title,
      case k.kind
        when 'call'                then 'They prefer the morning. Ask about the second half of the window.'
        when 'send_quote'          then 'Price it off their sheet, not list.'
        when 'chase_po'            then 'Purchasing said the number was approved; no paperwork yet.'
        when 'confirm_requirement' then 'Their quality group has to sign this off before we ship.'
        when 'check_stock'         then 'Two of the parts run thin at the end of the quarter.'
        else                            'Two part numbers on here were superseded.'
      end as note
  ) t;

  -- =========================================================================
  -- 7. Calls, emails and visits around the quotes and the answers
  -- =========================================================================
  --
  -- Activity comes in bursts around a quote and then stops. There is nothing
  -- after a loss, on purpose: silence is the signal, and a world where every
  -- account is equally busy is a world nobody recognises.

  insert into nl.activities (customer_no, commitment_id, contact_id, kind, call_outcome, body, author_id, via,
                             occurred_at, created_at)
  select
    dq.customer_no,
    dq.commitment_id,
    -- Activity was with somebody, not with the account in the abstract.
    who.contact_id,
    case a.kind when 'voicemail' then 'call' else a.kind end,
    case a.kind
      when 'voicemail' then 'voicemail'
      when 'call' then nl_seed.pick(array['reached', 'reached', 'callback', 'no_answer'], a.key)
    end,
    case a.kind
      when 'email' then nl_seed.pick(array[
        'Sent the revised quote with the new lead time on the stacks.',
        'Emailed the quote across and asked for their part numbers.',
        'Forwarded the certificate they asked for with the quote.'], a.key)
      when 'meeting' then nl_seed.pick(array[
        'Went through the quote at their counter. They want one line split.',
        'Sat with purchasing and walked the whole parts list.'], a.key)
      when 'voicemail' then 'Left a message about the quote that went out this week.'
      when 'note' then nl_seed.pick(array[
        'Buyer wants the freight line broken out before they take it upstairs.',
        'They are comparing us against one other vendor on this one.',
        'Quantities on the quote are their yearly usage, not one order.'], a.key)
      else nl_seed.pick(array[
        'Talked through the quote. They asked what happens if they double the quantity.',
        'Called about the quote. Purchasing is out until next week.',
        'Went over the revision and why the price moved.'], a.key)
    end,
    dq.owner_id,
    'seed',
    a.at,
    a.at
  from pg_temp.depth_quotes dq
  join nl.quote_revisions rev on rev.quote_id = dq.quote_id
  -- Quiet accounts stay quiet.
  cross join lateral (select nl_seed.chance(0.78, 'depth.busy|' || dq.customer_no) as busy) busy
  left join lateral (
    select ct.id as contact_id
    from nl.contacts ct
    where ct.customer_no = dq.customer_no
    order by ct.is_primary desc, ct.id
    limit 1
  ) who on true
  cross join lateral generate_series(1,
    case when busy.busy
         then nl_seed.ri(0, 3, 'depth.act.n|' || rev.id) else 0 end) as g(n)
  cross join lateral (
    select
      'depth.act|' || rev.id || '|' || g.n as key,
      nl_seed.pick(array['call', 'call', 'email', 'email', 'note', 'meeting', 'voicemail'],
                   'depth.act.kind|' || rev.id || '|' || g.n) as kind,
      -- Up to nine days after the version went out, and never in the future:
      -- the world is always "as of today".
      (least(rev.revised_on + nl_seed.ri(0, 9, 'depth.act.day|' || rev.id || '|' || g.n), v_today)
        + time '09:00'
        + make_interval(mins => nl_seed.ri(0, 480, 'depth.act.min|' || rev.id || '|' || g.n)))
        at time zone 'America/Chicago' as at
  ) a
  -- The world carries a year of activity, not seven. A revision from three
  -- years ago is history; nobody needs the call log behind it, and
  -- accounts.test.ts holds the whole seed to that window.
  where rev.revised_on between v_today - 350 and v_today;

  -- One note against each answer, in the answerer's own words. This is the
  -- thing a person reads first when they open a settled commitment.
  insert into nl.activities (customer_no, commitment_id, contact_id, kind, body, author_id, via,
                             occurred_at, created_at)
  select
    c.customer_no,
    o.commitment_id,
    who.contact_id,
    'note',
    case o.outcome
      when 'pushed' then 'Window closed short. Buyer says the parts are still wanted, so it moves.'
      when 'broken' then 'Window closed short and it is not coming. Recorded it as broken.'
      else 'Close enough on delivery. Counting the window as kept.'
    end,
    coalesce(o.answered_by, c.owner_id),
    'seed',
    o.answered_at,
    o.answered_at
  from nl.commitment_outcomes o
  join nl.commitments c on c.id = o.commitment_id
  left join lateral (
    select ct.id as contact_id
    from nl.contacts ct
    where ct.customer_no = c.customer_no
    order by ct.is_primary desc, ct.id
    limit 1
  ) who on true
  where o.source = 'person'
    and nl_seed.chance(0.6, 'depth.answer.note|' || o.id)
    -- Same window as the rest of the activity: a year, not seven.
    and o.answered_at::date between v_today - 350 and v_today;

  drop table if exists pg_temp.depth_record;
  drop table if exists pg_temp.depth_made;
  drop table if exists pg_temp.depth_again;
  drop table if exists pg_temp.depth_quote_plan;
  drop table if exists pg_temp.depth_quotes;
  drop table if exists pg_temp.depth_revisions;
end $$;
