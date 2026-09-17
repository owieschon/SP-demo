-- Accounts in depth: the people at each account, a named buyer on most live
-- commitments, and a year of calls, emails, meetings, notes and next steps
-- that read like a real sales team's.
--
-- Runs after the base world (nl_seed.finish_build calls it). Everything is
-- keyed randomness, like db/seed.sql, so every database builds the same
-- world. It only reaches accounts that bought in the last two years (about
-- 1,800 in the full world), so its size follows the world's scale.
--
-- Needs migration 0014 (contacts.left_on, mobile, notes, created_by;
-- activities.contact_id; the one-primary trigger).

create or replace function nl_seed.extra_10_accounts_depth() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_set nl_seed.settings;
begin
  select * into v_set from nl_seed.settings;

  -- -------------------------------------------------------------------------
  -- Who is in scope: accounts with an invoice in the last two years
  -- -------------------------------------------------------------------------
  drop table if exists pg_temp.depth_accounts;
  create temporary table depth_accounts as
  select c.customer_no, c.bill_to_no, c.owner_id, c.email_domain, c.customer_since,
         coalesce(p.z, 0) as z,
         -- Unowned accounts are worked by inside sales.
         coalesce(c.owner_id, (array[10, 11])[1 + floor(nl_seed.u('depth.house|' || c.customer_no) * 2)::int]) as rep_id,
         -- One area code per account, so its people look like they sit together.
         nl_seed.ri(201, 989, 'depth.area|' || c.customer_no) as area
  from nl.customers c
  join nl_seed.portfolio p on p.customer_no = c.customer_no
  where exists (select 1 from nl.invoices i
                where i.customer_no = c.customer_no
                  and i.posted_on > v_set.today - 730
                  and i.posted_on <= v_set.today);

  -- The parts each account actually buys, biggest first, so a note can name one.
  drop table if exists pg_temp.depth_parts;
  create temporary table depth_parts as
  select x.customer_no,
         array_agg(x.item_no order by x.rn) as items,
         array_agg(x.family order by x.rn) as families
  from (
    select il.customer_no, il.item_no, i.family,
           row_number() over (partition by il.customer_no order by sum(il.amount) desc, il.item_no) as rn
    from nl.invoice_lines il
    join nl.items i on i.item_no = il.item_no
    where il.posted_on > v_set.today - 730
      and il.quantity > 0
      and il.customer_no in (select customer_no from depth_accounts)
    group by il.customer_no, il.item_no, i.family
  ) x
  where x.rn <= 6
  group by x.customer_no;

  -- -------------------------------------------------------------------------
  -- People
  -- -------------------------------------------------------------------------

  -- Contacts loaded with the base world are dated as of the build. Date
  -- them to some time after the account opened, like a real customer file.
  update nl.contacts ct
     set created_at = ((least(v_set.today - 30,
                              cu.customer_since + nl_seed.ri(0, 900, 'depth.ct.since|' || ct.id)))
                       + time '10:00') at time zone 'America/Chicago'
    from nl.customers cu
   where cu.customer_no = ct.customer_no
     and ct.created_by is null;

  -- Head offices and independents get 2 to 4 current people, bigger accounts
  -- more; branches keep their branch manager and sometimes a parts lead.
  -- Each person fills a role the account does not have yet, the buyer first.
  insert into nl.contacts (customer_no, full_name, title, email, phone, mobile, notes, is_primary,
                           created_by, created_at)
  with have as (
    select a.customer_no,
           count(ct.id) as n,
           -- The roles already filled (titles the list does not know are dropped).
           array_remove(array_agg(distinct case
             when ct.title in ('Buyer', 'Purchasing', 'Purchasing Agent', 'Purchasing Manager') then 'buy'
             when ct.title in ('Parts Manager', 'Counter Lead', 'Parts Counter Lead', 'Assistant Parts Manager') then 'parts'
             when ct.title in ('Service Manager', 'Fleet Maintenance Manager', 'Shop Foreman') then 'service'
             when ct.title in ('Owner', 'General Manager', 'Operations Manager', 'Branch Manager') then 'boss'
             when ct.title in ('Accounts Payable', 'Office Manager') then 'ap'
           end), null) as roles
    from depth_accounts a
    left join nl.contacts ct on ct.customer_no = a.customer_no
    group by a.customer_no
  ),
  wanted as (
    select a.*, h.n, coalesce(h.roles, '{}') as roles,
           case when a.bill_to_no is null
                then 2 + (a.z > -0.3)::int + (a.z > 0.9)::int
                else 1 + nl_seed.chance(0.45, 'depth.branch.more|' || a.customer_no)::int
           end as target
    from depth_accounts a
    join have h on h.customer_no = a.customer_no
  ),
  roles (role, titles, notes) as (
    values
      ('buy', array['Buyer', 'Purchasing Agent', 'Purchasing Manager'],
              array['Places the stock orders on Tuesdays.',
                    'Wants every quote in writing before a PO goes out.',
                    'Prefers email and copies the parts manager on everything.']),
      ('parts', array['Parts Manager', 'Parts Counter Lead', 'Assistant Parts Manager'],
              array['Knows the chrome line well; ask for them at the counter.',
                    'Counts stock on Fridays, the best day to talk reorders.',
                    'Handles returns and warranty paperwork.']),
      ('service', array['Service Manager', 'Fleet Maintenance Manager', 'Shop Foreman'],
              array['Decides stack lengths and finishes for the shop.',
                    'Plans the fleet refresh and knows the unit count.',
                    'Calls when a truck is down and needs a part the same day.']),
      ('boss', array['Owner', 'General Manager', 'Operations Manager'],
              array['Signs off on anything over five thousand dollars.',
                    'Met at the spring trade show.',
                    'Likes a visit twice a year, not more.']),
      ('ap', array['Accounts Payable', 'Office Manager'],
              array['Send invoices here, not to purchasing.',
                    'Pays on net 30; call before anything goes on credit hold.'])
  ),
  slots as (
    select w.customer_no, w.email_domain, w.area, w.rep_id, w.customer_since, r.role, r.titles, r.notes,
           w.target - w.n as missing,
           row_number() over (
             partition by w.customer_no
             order by (r.role = case when w.bill_to_no is null then 'buy' else 'parts' end) desc,
                      nl_seed.u('depth.slot|' || w.customer_no || '|' || r.role)) as rn
    from wanted w
    cross join roles r
    where not (r.role = any (w.roles))
      and (w.bill_to_no is null or r.role in ('parts', 'buy', 'service'))
  )
  select s.customer_no,
         p.full_name,
         p.title,
         case when s.role = 'ap' and nl_seed.chance(0.5, p.key || '|apbox')
              then 'payables@' || s.email_domain
              else lower(replace(p.full_name, ' ', '.')) || '@' || s.email_domain end,
         '(' || s.area || ') 555-01' || lpad(nl_seed.ri(0, 99, p.key || '|phone')::text, 2, '0')
           || case when nl_seed.chance(0.3, p.key || '|ext') then ' x' || nl_seed.ri(10, 49, p.key || '|extn') else '' end,
         case when s.role <> 'ap' and nl_seed.chance(0.45, p.key || '|mobile')
              then '(' || nl_seed.ri(201, 989, p.key || '|marea') || ') 555-01'
                   || lpad(nl_seed.ri(0, 99, p.key || '|mline')::text, 2, '0') end,
         case when nl_seed.chance(0.3, p.key || '|note?') then nl_seed.pick(s.notes, p.key || '|note') else '' end,
         false,
         case when nl_seed.chance(0.5, p.key || '|by') then s.rep_id end,
         ((least(v_set.today - 3, s.customer_since + nl_seed.ri(30, 2500, p.key || '|since')))
           + time '11:00') at time zone 'America/Chicago'
  from slots s
  cross join lateral (
    select 'depth.contact|' || s.customer_no || '|' || s.role as key,
           nl_seed.person('depth.contact|' || s.customer_no || '|' || s.role) as full_name,
           nl_seed.pick(s.titles, 'depth.title|' || s.customer_no || '|' || s.role) as title
  ) p
  where s.rn <= s.missing
  order by s.customer_no, s.rn;

  -- People who were there once: about one account in five has a former
  -- buyer or parts manager on file, with a note about where they went.
  insert into nl.contacts (customer_no, full_name, title, email, phone, notes, is_primary, left_on, created_at)
  select a.customer_no,
         nl_seed.person('depth.former|' || a.customer_no),
         nl_seed.pick(array['Buyer', 'Parts Manager', 'Purchasing Agent'], 'depth.former.title|' || a.customer_no),
         lower(replace(nl_seed.person('depth.former|' || a.customer_no), ' ', '.')) || '@' || a.email_domain,
         '(' || a.area || ') 555-01' || lpad(nl_seed.ri(0, 99, 'depth.former.phone|' || a.customer_no)::text, 2, '0'),
         nl_seed.pick(array['Retired in the spring.',
                            'Moved to another distributor.',
                            'Left for a fleet job across town.',
                            'No longer with the company; orders go through the new buyer.'],
                      'depth.former.note|' || a.customer_no),
         false,
         l.left_on,
         ((l.left_on - nl_seed.ri(300, 2000, 'depth.former.since|' || a.customer_no)) + time '11:00')
           at time zone 'America/Chicago'
  from depth_accounts a
  cross join lateral (
    select v_set.today - nl_seed.ri(40, 600, 'depth.former.left|' || a.customer_no) as left_on
  ) l
  where a.bill_to_no is null
    and nl_seed.chance(0.22, 'depth.former?|' || a.customer_no)
    -- Not the same name as someone who is still there.
    and not exists (select 1 from nl.contacts ct
                    where ct.customer_no = a.customer_no
                      and ct.full_name = nl_seed.person('depth.former|' || a.customer_no));

  -- Exactly one primary among the current people: an account that has none
  -- gets its buyer (or first person) as primary.
  update nl.contacts ct
     set is_primary = true
    from (
      select distinct on (c2.customer_no) c2.id
      from nl.contacts c2
      join depth_accounts a on a.customer_no = c2.customer_no
      where c2.left_on is null
        and not exists (select 1 from nl.contacts c3
                        where c3.customer_no = c2.customer_no and c3.is_primary)
      order by c2.customer_no,
               (c2.title in ('Buyer', 'Purchasing Agent', 'Purchasing Manager', 'Purchasing', 'Branch Manager')) desc,
               c2.id
    ) pick
   where ct.id = pick.id;

  -- -------------------------------------------------------------------------
  -- Named buyers on live and recent commitments
  -- -------------------------------------------------------------------------

  -- Most open or recently closed commitments name a buyer or parts manager
  -- at the account. About one in ten is left without one, and so is any
  -- promised commitment that was built without one, so the "No buyer named"
  -- button always has work to do.
  update nl.commitments cm
     set buyer_contact_id = case when nl_seed.chance(0.9, 'depth.buyer?|' || cm.id) then b.id end
    from (
      select c.id as commitment_id,
             (select ct.id
              from nl.contacts ct
              where ct.customer_no = c.customer_no
                and ct.left_on is null
                and ct.title in ('Buyer', 'Purchasing Agent', 'Purchasing Manager', 'Purchasing',
                                 'Parts Manager', 'Assistant Parts Manager', 'Parts Counter Lead')
              order by (ct.title in ('Buyer', 'Purchasing Agent', 'Purchasing Manager', 'Purchasing')) desc,
                       nl_seed.u('depth.buyer|' || c.id || '|' || ct.id)
              limit 1) as id
      from nl.commitments c
      where c.ends_on >= v_set.today - 120
    ) b
   where cm.id = b.commitment_id
     and b.id is not null
     and not (cm.buyer_contact_id is null
              and not exists (select 1 from nl.quotes q where q.commitment_id = cm.id)
              and cm.ends_on > v_set.today);

  -- -------------------------------------------------------------------------
  -- A year of calls, emails, meetings and notes
  -- -------------------------------------------------------------------------

  -- Head offices and independents, weighted to bigger accounts; one branch
  -- in four gets a call or two of its own.
  insert into nl.activities (customer_no, commitment_id, contact_id, kind, call_outcome, body,
                             author_id, via, occurred_at, created_at)
  with templates (topic, long_form, email_form, short_form, note_form) as (
    values
      (1, 'Asked for pricing on %2$s pcs of %1$s. Quote goes out today.',
          'Sent %3$s the quote for %2$s pcs of %1$s, good for 30 days.',
          'the %1$s quote',
          '%3$s is comparing our %1$s price with another supplier; the quote needs to be sharp.'),
      (2, 'Went through stack lengths for their new units. They run %4$s inch stacks on the day cabs and want one length across the fleet.',
          'Emailed %3$s the stack length chart and asked which length they want to standardize on.',
          'stack lengths for the new units',
          'They are moving to %4$s inch stacks across the fleet.'),
      (3, 'Talked chrome versus stainless for the %5$s. Drivers want chrome; the shop wants stainless for the winter routes.',
          'Sent %3$s pricing on %5$s in chrome and in stainless, side by side.',
          'chrome versus stainless pricing',
          'The shop prefers stainless for anything on the winter routes; drivers still ask for chrome.'),
      (4, 'Fleet refresh is set for next quarter, about %7$s trucks. %3$s wants %1$s on the shelf before the first units arrive.',
          'Emailed %3$s a stocking plan for the fleet refresh: %1$s plus clamps and gaskets for %7$s trucks.',
          'the fleet refresh',
          'Fleet refresh of about %7$s trucks planned for next quarter. Good time to lock in a stocking order.'),
      (5, 'New truck build starts in %6$s weeks. They need the exhaust layout confirmed before they order, starting with %1$s.',
          'Sent the layout for the new truck build to %3$s and asked for sign-off by Friday.',
          'the new truck build',
          'New truck build coming in %6$s weeks; the exhaust layout is not final yet.'),
      (6, 'Needs a freight quote for a split shipment to both yards. Checked whether the order clears the free-freight threshold.',
          'Emailed a freight quote for the split shipment; the order is a few hundred dollars under the free-freight threshold.',
          'the freight quote',
          'Freight is their main complaint. Worth offering to review the free-freight threshold.'),
      (7, 'Asked about lead time on %1$s. Told them %6$s weeks if it has to be built, two days if it is on the shelf.',
          'Confirmed by email to %3$s: %1$s is %6$s weeks out if it has to be built.',
          'lead time on %1$s',
          'They plan around lead times. Give them dates, not ranges.'),
      (8, 'Requested a sample of %1$s to test fit on one truck before they commit to a stocking order.',
          'Confirmed to %3$s that the sample of %1$s shipped today, tracking attached.',
          'the %1$s sample',
          'Sample of %1$s went out. Ask how the fit went on the next call.'),
      (9, 'Walked through the price increase that takes effect on the first. %3$s will try to get the open order in before then.',
          'Sent %3$s the price increase notice with the new sheet attached, effective the first of next month.',
          'the price increase',
          'Not happy about the price increase, but no talk of moving the business.'),
      (10, 'Followed up from the trade show. %3$s liked the %5$s on display and wants the new catalog.',
          'Thank-you email to %3$s after the trade show, with the catalog and the %5$s price sheet.',
          'the trade show follow-up',
          'Met %3$s at the trade show; interested in our %5$s.'),
      (11, 'Reorder reminder: they usually restock %1$s around now. %3$s will check the shelf and call back with a count.',
          'Reminder to %3$s: they usually reorder %1$s about now. Asked for a count.',
          'reordering %1$s',
          'Orders %1$s every few weeks like clockwork. If they go quiet, call.'),
      (12, 'Their account is on credit hold until two past-due invoices clear. Asked %3$s to get accounts payable on the phone.',
          'Emailed %3$s about the two past-due invoices holding up the next order.',
          'the past-due invoices',
          'On credit hold. Customer service is working it with their accounts payable.'),
      (13, 'Checked on the backorder for %1$s. They will take a partial now and the rest when it comes off the line.',
          'Sent %3$s a ship date for the %1$s backorder.',
          'the %1$s backorder',
          'Partial shipments are fine for them; say so on the order.'),
      (14, 'Return on %1$s: the wrong diameter was ordered. Credit memo goes out once it is back on our dock.',
          'Sent %3$s the return authorization for %1$s.',
          'the %1$s return',
          'Second return this year for a wrong diameter. Confirm sizes on the next order.')
  ),
  planned as (
    select a.customer_no, a.rep_id, g.n,
           'depth.act|' || a.customer_no || '|' || g.n as key
    from depth_accounts a
    cross join lateral generate_series(1,
      case when a.bill_to_no is null
           then least(45, greatest(2, round(exp(nl_seed.gauss(ln(7) + 0.55 * a.z, 0.6, 'depth.acts|' || a.customer_no)))))::int
           when nl_seed.chance(0.25, 'depth.branch.acts|' || a.customer_no)
           then nl_seed.ri(1, 3, 'depth.branch.acts.n|' || a.customer_no)
           else 0 end) as g(n)
  ),
  drawn as (
    select p.*,
           nl_seed.u(p.key || '|kind') as kind_u,
           nl_seed.u(p.key || '|outcome') as outcome_u,
           nl_seed.ri(1, 14, p.key || '|topic') as topic,
           -- More of it recent than old.
           v_set.today - (1 + floor(364 * power(nl_seed.u(p.key || '|age'), 1.5))::int) as raw_day,
           nl_seed.u(p.key || '|author') as author_u
    from planned p
  ),
  dated as (
    select d.*,
           -- Weekends move back to Friday.
           d.raw_day - greatest(extract(isodow from d.raw_day)::int - 5, 0) as on_day
    from drawn d
  )
  select d.customer_no,
         cm.id,
         who.id,
         k.kind,
         k.call_outcome,
         format(
           case
             when k.kind = 'call' and k.call_outcome = 'voicemail'
               then 'Left a voicemail for %3$s about ' || t.short_form || '.'
             when k.kind = 'call' and k.call_outcome = 'no_answer'
               then 'Called %3$s about ' || t.short_form || '. No answer; will try again tomorrow.'
             when k.kind = 'call' and k.call_outcome = 'callback'
               then '%3$s asked for a call back later today about ' || t.short_form || '.'
             when k.kind = 'call'
               then nl_seed.pick(array['', 'Spoke with %3$s. ', 'Good call with %3$s. '], d.key || '|open')
                    || t.long_form
                    || nl_seed.pick(array['', '', ' Will follow up by email.', ' Next step is on the list.'], d.key || '|close')
             when k.kind = 'email' then t.email_form
             when k.kind = 'meeting'
               then nl_seed.pick(array['Visited the shop. ', 'Stopped in at the counter. ',
                                       'Lunch meeting with %3$s. ', 'Walked the yard with %3$s. '], d.key || '|visit')
                    || t.long_form
             else nl_seed.pick(array['', 'Heads up: ', 'For the team: '], d.key || '|lead') || t.note_form
           end,
           coalesce(part.item_no, 'the usual parts'),
           greatest(2, coalesce(nl_seed.typical_qty(part.item_no, d.key || '|qty'), 4)
                       * nl_seed.ri(1, 4, d.key || '|qtymult')),
           coalesce(split_part(who.full_name, ' ', 1), 'the buyer'),
           nl_seed.pick(array['36', '48', '60', '72', '84', '96', '108', '120'], d.key || '|len'),
           case part.family
             when 'elbow' then 'elbows'
             when 'stack' then 'stacks'
             when 'pipe' then 'straight pipe'
             when 'muffler' then 'mufflers'
             when 'clamp' then 'clamps'
             when 'flex' then 'flex pipe'
             when 'shield' then 'heat shields'
             when 'bracket' then 'rain caps and brackets'
             when 'kit' then 'stack kits'
             else 'exhaust parts'
           end,
           nl_seed.ri(2, 8, d.key || '|weeks'),
           nl_seed.ri(6, 60, d.key || '|trucks')),
         case when k.kind = 'meeting' or d.author_u < 0.8 then d.rep_id
              when d.author_u < 0.9 then (array[10, 11])[1 + floor(nl_seed.u(d.key || '|inside') * 2)::int]
              when d.author_u < 0.96 then 14
              else 1 end,
         'seed',
         k.at,
         k.at
  from dated d
  join templates t on t.topic = d.topic
  left join depth_parts dp on dp.customer_no = d.customer_no
  cross join lateral (
    select dp.items[1 + floor(nl_seed.u(d.key || '|part') * least(cardinality(dp.items), 4))::int] as item_no,
           dp.families[1 + floor(nl_seed.u(d.key || '|part') * least(cardinality(dp.families), 4))::int] as family
  ) part
  cross join lateral (
    select case when d.kind_u < 0.45 then 'call'
                when d.kind_u < 0.75 then 'email'
                when d.kind_u < 0.85 then 'meeting'
                else 'note' end as kind,
           case when d.kind_u >= 0.45 then null
                when d.outcome_u < 0.55 then 'reached'
                when d.outcome_u < 0.80 then 'voicemail'
                when d.outcome_u < 0.90 then 'no_answer'
                else 'callback' end as call_outcome,
           ((d.on_day + time '07:30' + make_interval(mins => nl_seed.ri(0, 600, d.key || '|min')))
             at time zone 'America/Chicago') as at
  ) k
  -- Who it was with: someone who was at the account on that day.
  left join lateral (
    select ct.id, ct.full_name
    from nl.contacts ct
    where ct.customer_no = d.customer_no
      and (ct.left_on is null or ct.left_on > d.on_day)
      and (d.topic <> 12 or ct.title in ('Accounts Payable', 'Office Manager', 'Owner', 'General Manager'))
    order by nl_seed.u(d.key || '|who|' || ct.id)
    limit 1
  ) who on true
  -- About a third of what happens during a commitment's window is about it.
  left join lateral (
    select c.id
    from nl.commitments c
    where c.customer_no = d.customer_no
      and d.on_day between c.starts_on and c.ends_on
      and nl_seed.chance(0.35, d.key || '|commit')
    order by c.id
    limit 1
  ) cm on true
  order by d.customer_no, d.n;

  -- The base world's calls, emails and visits draw from one shared list of
  -- sentences, so an email could read like a visit. Give each kind its own
  -- wording and name who it was with. Keyed on the account and the moment,
  -- not the row id, so the result does not depend on insert order.
  update nl.activities act
     set body = nl_seed.pick(
           case
             when act.kind = 'email' then array[
               'Sent the updated price sheet.',
               'Emailed a request for their Q4 forecast.',
               'Sent the new catalog as a PDF.',
               'Confirmed the ship date on the open order by email.']
             when act.kind = 'meeting' then array[
               'Stopped by with the new catalog.',
               'Went over open backorders at their counter.',
               'Visited to walk through the Q4 forecast.']
             when act.call_outcome = 'voicemail' then array[
               'Left a message about the chrome lead time.',
               'Left a voicemail about the open backorders.']
             when act.call_outcome = 'no_answer' then array[
               'No answer on the main line; called about the open backorders.',
               'Called about the Q4 forecast. No answer.']
             when act.call_outcome = 'callback' then array[
               'Asked for a call back after lunch about the open order.',
               'Asked to be called back tomorrow about the price sheet.']
             else array[
               'Went over open backorders.',
               'Asked for the Q4 forecast.',
               'Confirmed the ship date on the open order.']
           end,
           'depth.base|' || act.customer_no || '|' || extract(epoch from act.occurred_at)::bigint),
         contact_id = (
           select ct.id
           from nl.contacts ct
           where ct.customer_no = act.customer_no and ct.left_on is null
           order by ct.is_primary desc, ct.id
           limit 1)
   where act.via = 'seed'
     and act.kind <> 'note'
     and act.contact_id is null;

  -- -------------------------------------------------------------------------
  -- Next steps with due dates
  -- -------------------------------------------------------------------------

  -- Added over the last seven months. Old ones are nearly all done; recent
  -- ones mostly open, and some of those are overdue.
  insert into nl.next_steps (customer_no, title, due_on, owner_id, created_by, created_at, completed_at, completed_by)
  select a.customer_no,
         format(nl_seed.pick(array[
                  'Send the quote for %1$s to %2$s',
                  'Ship a sample of %1$s',
                  'Call %2$s about the fleet refresh',
                  'Confirm stack lengths with %2$s',
                  'Get a freight quote for the split shipment',
                  'Check lead time on %1$s with production',
                  'Get the open order in before the price increase',
                  'Ask accounts payable to clear the past-due invoices',
                  'Send the trade show catalog to %2$s',
                  'Remind %2$s to reorder %1$s',
                  'Confirm the backorder ship date for %1$s',
                  'Send the return authorization for %1$s'], s.key || '|title'),
                coalesce(dp.items[1 + floor(nl_seed.u(s.key || '|part') * least(cardinality(dp.items), 3))::int],
                         'the usual parts'),
                coalesce(split_part(who.full_name, ' ', 1), 'the buyer')),
         s.created_on + nl_seed.ri(2, 21, s.key || '|due'),
         a.rep_id,
         a.rep_id,
         (s.created_on + time '09:15') at time zone 'America/Chicago',
         case when s.done
              then (s.created_on + nl_seed.ri(0, least(s.age - 1, 25), s.key || '|took') + time '16:00')
                   at time zone 'America/Chicago' end,
         case when s.done then a.rep_id end
  from depth_accounts a
  left join depth_parts dp on dp.customer_no = a.customer_no
  cross join lateral generate_series(1,
    case when a.bill_to_no is null and nl_seed.chance(0.75, 'depth.steps|' || a.customer_no)
         then nl_seed.ri(1, 3, 'depth.steps.n|' || a.customer_no) else 0 end) as g(n)
  cross join lateral (
    select 'depth.step|' || a.customer_no || '|' || g.n as key,
           x.age,
           v_set.today - x.age as created_on,
           nl_seed.chance(case when x.age > 30 then 0.92 when x.age > 10 then 0.6 else 0.2 end,
                          'depth.step|' || a.customer_no || '|' || g.n || '|done') as done
    from (select nl_seed.ri(1, 200, 'depth.step|' || a.customer_no || '|' || g.n || '|age') as age) x
  ) s
  left join lateral (
    select ct.full_name
    from nl.contacts ct
    where ct.customer_no = a.customer_no and ct.left_on is null
    order by ct.is_primary desc, ct.id
    limit 1
  ) who on true
  order by a.customer_no, g.n;

  drop table if exists pg_temp.depth_accounts;
  drop table if exists pg_temp.depth_parts;
end $$;
