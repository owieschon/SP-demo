-- 0001 Foundation: the schema, the two roles every request runs as, the
-- people who use the app, and the audit trail every write leaves behind.
--
-- Everything the app owns lives in schema nl. Supabase's Data API only
-- exposes the public schema, and nothing here is granted to its anon or
-- authenticated roles, so none of this is reachable over REST. The app talks
-- to Postgres directly and runs each request inside a transaction as one of
-- two login-less roles:
--
--   nl_app       the signed-in user. The server starts every transaction with
--                  set local role nl_app;
--                  select set_config('nl.user_id', '<id>', true);
--                and row-level security policies read that setting.
--   nl_readonly  the assistant's read-only SQL tool: SELECT on business
--                tables only, no grant at all on tables about people.
--
-- Neither role owns a table, so neither can bypass row-level security.

create schema if not exists nl;

-- Roles belong to the whole server, not one database, so only create them
-- when they are missing.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nl_app') then
    create role nl_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'nl_readonly') then
    create role nl_readonly nologin;
  end if;
end $$;

-- The app connects as postgres and switches to these roles per transaction,
-- which needs membership.
grant nl_app, nl_readonly to postgres;

revoke all on schema nl from public;
grant usage on schema nl to nl_app, nl_readonly;

-- Postgres lets everyone execute a new function by default. In this schema
-- nobody may: each migration grants EXECUTE on exactly what nl_app calls.
alter default privileges in schema nl revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Clock helpers
-- ---------------------------------------------------------------------------

-- "Today" for the business, in the company's time zone. Tests pin it with
--   set nl.today = '2026-09-17';
-- so anything that depends on the date gives the same answer every run.
create function nl.today() returns date
language sql stable
as $$
  select coalesce(
    nullif(current_setting('nl.today', true), '')::date,
    (now() at time zone 'America/Chicago')::date)
$$;

-- Row versions for optimistic locking. JavaScript dates keep milliseconds
-- and Postgres keeps microseconds, so a version the browser sends back must
-- be stored at millisecond precision or it would never match again.
create function nl.now_ms() returns timestamptz
language sql volatile
as $$ select date_trunc('milliseconds', clock_timestamp()) $$;

-- Trigger: every update moves updated_at forward, by at least a millisecond,
-- so two updates inside the same millisecond still get different versions.
create function nl.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := greatest(nl.now_ms(), old.updated_at + interval '1 millisecond');
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

create table nl.users (
  id         int primary key,
  email      text not null unique,
  full_name  text not null,
  title      text not null default '',
  role       text not null check (role in ('account_manager', 'operations', 'admin')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table nl.users is 'People who use the app. Ids are fixed so a nightly rebuild keeps sessions valid.';

-- The signed-in user for this transaction, or null when nobody is.
create function nl.current_user_id() returns int
language sql stable
as $$ select nullif(current_setting('nl.user_id', true), '')::int $$;

create function nl.is_admin() returns boolean
language sql stable
as $$
  select exists (
    select 1 from nl.users
    where id = nl.current_user_id() and role = 'admin' and active)
$$;

-- Every write function starts here: no active user, no write.
create function nl.require_active_user() returns nl.users
language plpgsql stable
as $$
declare
  v_user nl.users;
begin
  select * into v_user from nl.users where id = nl.current_user_id();
  if not found or not v_user.active then
    raise exception 'No active user is signed in for this request.'
      using errcode = 'NL401';
  end if;
  return v_user;
end $$;

alter table nl.users enable row level security;
-- Names and roles are shown all over the app.
create policy users_read on nl.users for select to nl_app using (true);
grant select on nl.users to nl_app;
-- nl_readonly gets nothing on this table, on purpose.

-- ---------------------------------------------------------------------------
-- Audit log: one row per write, whoever or whatever made it
-- ---------------------------------------------------------------------------

create table nl.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   int references nl.users (id),
  via        text not null check (via in ('ui', 'assistant', 'nightly', 'import', 'seed')),
  action     text not null,
  entity     text not null,
  entity_id  text not null,
  request_id text,
  detail     jsonb not null default '{}'
);

create index audit_log_entity_idx on nl.audit_log (entity, entity_id, at desc);
create index audit_log_actor_idx on nl.audit_log (actor_id, at desc);

alter table nl.audit_log enable row level security;
-- A user can read the whole trail (it is how the team sees who changed what)
-- and can only ever add rows in their own name. Nobody edits or deletes.
create policy audit_read on nl.audit_log for select to nl_app using (true);
create policy audit_write on nl.audit_log for insert to nl_app
  with check (actor_id = (select nl.current_user_id()));
grant select, insert on nl.audit_log to nl_app;

-- ---------------------------------------------------------------------------
-- Request ids: a retried write returns its first result instead of running twice
-- ---------------------------------------------------------------------------

create table nl.request_log (
  request_id text primary key,
  actor_id   int references nl.users (id),
  action     text not null,
  result     jsonb,
  created_at timestamptz not null default now()
);

create index request_log_actor_idx on nl.request_log (actor_id);

alter table nl.request_log enable row level security;
create policy request_log_own on nl.request_log for all to nl_app
  using (actor_id = (select nl.current_user_id()))
  with check (actor_id = (select nl.current_user_id()));
grant select, insert, update on nl.request_log to nl_app;

-- Claim a request id before doing any work.
--   returns null      first time: go ahead, then call nl.finish_request
--   returns a result  this request already ran: hand that result back
-- Two copies of the same request racing each other are safe: the second
-- insert waits on the unique index until the first commits, then finds its
-- result. If the first one fails, its claim rolls back with it.
create function nl.claim_request(p_request_id text, p_action text) returns jsonb
language plpgsql
as $$
declare
  v_prior nl.request_log;
begin
  if p_request_id is null or length(p_request_id) < 8 or length(p_request_id) > 100 then
    raise exception 'Every write needs a request id of 8 to 100 characters.'
      using errcode = 'NL422';
  end if;

  insert into nl.request_log (request_id, actor_id, action)
  values (p_request_id, nl.current_user_id(), p_action)
  on conflict (request_id) do nothing;
  if found then
    return null;
  end if;

  -- Row-level security hides other users' rows, so a request id that
  -- belongs to someone else looks the same as one used for another action.
  select * into v_prior from nl.request_log where request_id = p_request_id;
  if not found or v_prior.action <> p_action then
    raise exception 'Request id % was already used for a different write.', p_request_id
      using errcode = 'NL409';
  end if;
  return coalesce(v_prior.result, '{}'::jsonb) || jsonb_build_object('replayed', true);
end $$;

create function nl.finish_request(p_request_id text, p_result jsonb) returns void
language sql
as $$
  update nl.request_log set result = p_result where request_id = p_request_id;
$$;

grant execute on function
  nl.today(), nl.now_ms(), nl.current_user_id(), nl.is_admin(),
  nl.require_active_user(), nl.claim_request(text, text), nl.finish_request(text, jsonb)
to nl_app;
