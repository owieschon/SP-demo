-- 0040 The nightly job wakes the procurement desk (Supabase only: pg_cron).
--
-- 0012 rebuilds the world every night. What it rebuilds is the record of what
-- happened: customers, parts, the ledger, stock. What it does NOT rebuild is
-- the work an agent had noticed, because signals and purchase requests are not
-- history, they are what the desk made of the history. So every morning the
-- procurement desk opened onto an empty page on a world that plainly had short
-- parts in it, which reads as a broken feature rather than a quiet day.
--
-- The fix is not to seed signals. Seeding them would be a lie: the point of
-- the desk is that it derives its own work from the world. The fix is to let
-- the desk do exactly that once, right after the rebuild, which is also what
-- would happen on a real morning.
--
-- Drafting the purchase requests is deliberately limited to the vendors with
-- the most short parts. A queue holding one request per vendor in the book is
-- not a review queue, it is a wall, and the honest demonstration is a person
-- looking at a handful of decisions rather than scrolling past hundreds.

create or replace function nl.nightly() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_built    jsonb;
  v_answered jsonb;
  v_repaired jsonb;
  v_swept    jsonb;
  v_drafted  int := 0;
  v_request  text := 'nightly-' || to_char(now(), 'YYYYMMDDHH24MISS');
  v_actor    int;
  v_vendor   text;
begin
  perform nl.reset();
  v_built := nl.build('full');
  v_answered := nl.answer_pushed_windows();
  v_repaired := nl.repair_delivery();

  -- The desk writes in someone's name, like every other write in this
  -- database. The nightly job has no session, so it borrows the operations
  -- user the seed always creates, and the audit row says 'automation'.
  select id into v_actor from nl.users
   where active and role = 'operations' order by id limit 1;

  if v_actor is null then
    -- Nothing to do rather than an exception: a world without that user is a
    -- world nobody is demonstrating.
    return jsonb_build_object(
      'built', v_built -> 'commitments',
      'invoice_lines', v_built -> 'invoice_lines',
      'answered', v_answered,
      'repaired', v_repaired,
      'desks', 'skipped: no operations user');
  end if;

  perform set_config('nl.user_id', v_actor::text, true);

  v_swept := nl.sweep_procurement_signals(v_request || '-sweep', 'automation');

  for v_vendor in
    select vendor_no from nl.procurement_signals
     where vendor_no is not null and signal = 'below_reorder_point'
     group by vendor_no
     order by count(*) desc, vendor_no
     limit 5
  loop
    v_drafted := v_drafted + coalesce(
      (nl.draft_purchase_requests(v_vendor, v_request || '-' || v_vendor, 'automation') ->> 'drafted')::int,
      0);
  end loop;

  return jsonb_build_object(
    'built', v_built -> 'commitments',
    'invoice_lines', v_built -> 'invoice_lines',
    'answered', v_answered,
    'repaired', v_repaired,
    'signals', v_swept -> 'raised',
    'requests_drafted', v_drafted);
end $$;

revoke execute on function nl.nightly() from public;
