-- 0012 The nightly job (Supabase only: pg_cron).
--
-- The public demo runs on an invented world dated relative to today, and
-- visitors change it during the day. Every night at 00:10 Chicago time
-- (05:10 UTC while daylight saving is on) the job:
--   1. rebuilds the world for the new day (nl.reset, nl.build),
--   2. answers "pushed" where there is evidence (nl.answer_pushed_windows),
--   3. checks the stored delivered figures against a fresh count and
--      repairs any drift (nl.repair_delivery; zero is expected).
-- The rebuild takes about a minute and a half and holds its locks until it
-- commits, so pages wait during that minute. Nobody should be looking at
-- 00:10.
--
-- Files named *.supabase.sql are skipped by PGlite and the tests; the local
-- database rebuilds itself when the date changes (app/src/lib/server/db/pglite.ts).

create extension if not exists pg_cron;

create function nl.nightly() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_built    jsonb;
  v_answered jsonb;
  v_repaired jsonb;
begin
  perform nl.reset();
  v_built := nl.build('full');
  v_answered := nl.answer_pushed_windows();
  v_repaired := nl.repair_delivery();
  return jsonb_build_object(
    'built', v_built -> 'commitments',
    'invoice_lines', v_built -> 'invoice_lines',
    'answered', v_answered,
    'repaired', v_repaired);
end $$;

revoke execute on function nl.nightly() from public;

-- cron.schedule replaces a job with the same name, so this is safe to rerun.
select cron.schedule(
  'northline-nightly',
  '10 5 * * *',
  $$set statement_timeout = '10min'; select nl.nightly();$$
);
