-- 0006 Pin the search path of every app function.
--
-- A function that runs with the caller's search_path can be tricked into
-- calling a look-alike object from another schema. Every name inside these
-- functions is already schema-qualified; pinning search_path to empty makes
-- that a guarantee. (pg_catalog, where the built-in functions live, is
-- always searched first regardless.)
--
-- From here on, every function in a migration is written with
--   set search_path = ''
-- in its definition. A later "create or replace" without it would drop the pin.
alter function nl.today() set search_path = '';
alter function nl.now_ms() set search_path = '';
alter function nl.touch_updated_at() set search_path = '';
alter function nl.current_user_id() set search_path = '';
alter function nl.is_admin() set search_path = '';
alter function nl.require_active_user() set search_path = '';
alter function nl.claim_request(text, text) set search_path = '';
alter function nl.finish_request(text, jsonb) set search_path = '';
alter function nl.kept_ratio() set search_path = '';
alter function nl.record_outcome(bigint, text, timestamptz, text, text, text) set search_path = '';
alter function nl.set_confidence(bigint, int, timestamptz, text, text) set search_path = '';
alter function nl.answer_pushed_windows() set search_path = '';
