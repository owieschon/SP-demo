-- 0025 Settings and the admin console: where the API keys live, and the one
-- passcode that stands between a visitor and them.
--
-- The problem this migration exists to solve. The deployed app is public and
-- signing in needs no password: anyone can pick any person from the list,
-- including the admin. So "is this user an admin" cannot protect a page that
-- holds keys. Instead the instance is CLAIMED once, by whoever gets there
-- first, with a passcode. Only a hash of that passcode is stored. From then
-- on, changing a setting needs the passcode.
--
-- Three deliberate choices, each of which is easy to get wrong:
--
--   1. The tables live in schema nl_config, not nl. nl.reset() truncates
--      every table in schemas nl and nl_seed, and the nightly job calls it,
--      so a key or a passcode kept in nl would be wiped every night. Nothing
--      in nl_config has a foreign key to nl.users either: TRUNCATE ... CASCADE
--      on nl.users would take the referencing rows with it, which is the same
--      accident by another route. updated_by is a plain integer and the name
--      is resolved at render time.
--
--   2. No role can read the tables. nl_app is granted nothing on nl_config's
--      tables, and nl_readonly (the assistant's SQL tool) is granted nothing
--      at all, not even on the view. Everything goes through the functions
--      below, which are SECURITY DEFINER, and through the view nl.settings,
--      which is the only readable projection and never shows a secret. Every
--      other view in this project sets security_invoker = true; this one
--      deliberately does not, which is what lets it read the base table on
--      the caller's behalf.
--
--   3. A secret arrives already encrypted. The app encrypts with AES-256-GCM
--      under a key derived from the server's session secret, and stores the
--      result as base64 text, so the plaintext and the encryption key never
--      travel to the database at all. See app/src/lib/server/settings/crypto.ts
--      and docs/settings.md, which also says what happens when the session
--      secret is rotated: the stored secrets become unreadable and have to be
--      pasted again.
--
-- Depends on 0001 (users, audit log, request ids, nl.now_ms).

create schema if not exists nl_config;
revoke all on schema nl_config from public;
grant usage on schema nl_config to nl_app;
-- Same rule as schema nl: a new function is executable by nobody until it is
-- granted (see 0001).
alter default privileges in schema nl_config revoke execute on functions from public;

-- ---------------------------------------------------------------------------
-- Which settings exist, and which of them are secret
-- ---------------------------------------------------------------------------

-- The fixed list. A key that is not in it cannot be stored: the check
-- constraint on nl_config.settings calls this. The app reads the same list
-- from here in a test, so the two cannot drift apart.
create function nl.setting_keys() returns text[]
language sql immutable
set search_path = ''
as $$
  select array[
    'anthropic_api_key',
    'anthropic_model',
    'live_ai_passphrase',
    'assistant_daily_per_user',
    'assistant_daily_total',
    'agentmail_api_key',
    'mail_inbox_orders',
    'mail_inbox_procurement',
    'mail_allowlist',
    'cron_secret'
  ]
$$;

-- A secret is never shown again after it is saved: the page gets only whether
-- it is set, its last four characters and when it changed.
create function nl.setting_is_secret(p_key text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_key in ('anthropic_api_key', 'live_ai_passphrase', 'agentmail_api_key', 'cron_secret')
$$;

-- ---------------------------------------------------------------------------
-- The settings themselves
-- ---------------------------------------------------------------------------

create table nl_config.settings (
  key        text primary key,
  -- The value of a setting that is not secret (a model name, a cap, an
  -- address). Null on a secret row.
  value      text,
  -- A secret, encrypted by the app before it got here, base64. Null on a row
  -- that is not secret.
  secret     text,
  is_secret  boolean not null,
  -- The last four characters of the plaintext, for "sk-ant-...4f2a" on screen.
  last4      text not null default '',
  -- nl.users.id, without a foreign key on purpose (see the header).
  updated_by int,
  updated_at timestamptz not null default nl.now_ms(),
  created_at timestamptz not null default now(),
  constraint settings_key_known check (key = any (nl.setting_keys())),
  constraint settings_secret_flag check (is_secret = nl.setting_is_secret(key)),
  constraint settings_last4_short check (length(last4) <= 4),
  -- A row is one shape or the other, never a mix, and never both empty.
  constraint settings_shape check (
    (is_secret and value is null and secret is not null and length(secret) between 1 and 8000)
    or (not is_secret and secret is null and last4 = '' and value is not null and length(value) <= 4000))
);

comment on table nl_config.settings is
  'API keys, model choices and caps set from /settings. Read it through the view nl.settings; secrets arrive already encrypted (migration 0025).';

create trigger settings_touch before update on nl_config.settings
  for each row execute function nl.touch_updated_at();

-- The only readable projection, and the only thing nl_app is granted. It
-- cannot show a secret: the column is not in it.
--
-- No security_invoker = true here, unlike every other view in this project.
-- That means the view runs with its owner's privileges, so it can read
-- nl_config.settings although the caller cannot. It is safe because the view
-- hides the secret column outright.
create view nl.settings as
select
  s.key,
  s.is_secret,
  -- Is there anything stored for this key at all?
  (s.value is not null or s.secret is not null) as is_set,
  case when s.is_secret then null else s.value end as value,
  s.last4,
  s.updated_by,
  s.updated_at
from nl_config.settings s;

comment on view nl.settings is
  'Settings without their secrets: key, whether it is set, its last four characters and when it changed (migration 0025).';

-- What the server itself needs: the same rows, with the encrypted secret.
-- The ciphertext is useless without the session secret the app holds, which
-- is why handing it to the app is not the same as exposing the key. Only
-- nl_app may call this; nl_readonly may not.
create function nl.settings_with_secrets()
returns table (key text, is_secret boolean, value text, secret text, last4 text, updated_at timestamptz)
language sql stable security definer
set search_path = ''
as $$
  select s.key, s.is_secret, s.value, s.secret, s.last4, s.updated_at
  from nl_config.settings s
$$;

-- ---------------------------------------------------------------------------
-- Who owns this instance
-- ---------------------------------------------------------------------------

-- One row, ever. `only_row` is a primary key that can only hold true, which
-- is the simplest way Postgres will refuse a second row.
create table nl_config.admin_lock (
  only_row      boolean primary key default true check (only_row),
  -- How the hash was derived, so a future migration can tell old rows apart.
  algo          text not null check (algo in ('scrypt')),
  salt          text not null check (length(salt) between 16 and 128),
  passcode_hash text not null check (length(passcode_hash) between 32 and 256),
  claimed_by    int not null,
  claimed_at    timestamptz not null default now(),
  updated_by    int not null,
  updated_at    timestamptz not null default nl.now_ms()
);

comment on table nl_config.admin_lock is
  'The admin passcode, as a salted scrypt hash. One row: whoever claimed this instance (migration 0025).';

create trigger admin_lock_touch before update on nl_config.admin_lock
  for each row execute function nl.touch_updated_at();

-- Every attempt at the passcode, right or wrong. This is the rate limit's
-- memory, so it has to be in the database: a restarted server must not forget
-- that someone has been guessing.
create table nl_config.admin_attempts (
  id         bigint generated always as identity primary key,
  user_id    int not null,
  at         timestamptz not null default now(),
  ok         boolean not null,
  request_id text
);

create index admin_attempts_recent_idx on nl_config.admin_attempts (user_id, at desc);

comment on table nl_config.admin_attempts is
  'Passcode attempts, for the rate limit and for the record (migration 0025).';

-- Five wrong answers in fifteen minutes, per person, then a pause.
create function nl.admin_attempt_limit() returns int
language sql immutable
set search_path = ''
as $$ select 5 $$;

create function nl.admin_attempt_window() returns interval
language sql immutable
set search_path = ''
as $$ select interval '15 minutes' $$;

-- Wrong answers from this person inside the window.
create function nl_config.failed_attempts(p_user_id int) returns int
language sql stable
set search_path = ''
as $$
  select count(*)::int
  from nl_config.admin_attempts a
  where a.user_id = p_user_id
    and not a.ok
    and a.at > now() - nl.admin_attempt_window()
$$;

-- When the oldest of those wrong answers leaves the window, which is when
-- guessing may start again.
create function nl_config.locked_until(p_user_id int) returns timestamptz
language sql stable
set search_path = ''
as $$
  select min(a.at) + nl.admin_attempt_window()
  from nl_config.admin_attempts a
  where a.user_id = p_user_id
    and not a.ok
    and a.at > now() - nl.admin_attempt_window()
$$;

-- Compare two strings without leaking, through how long it takes, how much of
-- them matched. The loop always runs to the end of the longer string instead
-- of stopping at the first difference, which is what timingSafeEqual does in
-- Node. Both sides here are hex digests of the same fixed length.
create function nl.constant_time_equal(p_a text, p_b text) returns boolean
language plpgsql immutable
set search_path = ''
as $$
declare
  v_a    text := coalesce(p_a, '');
  v_b    text := coalesce(p_b, '');
  v_len  int  := greatest(length(v_a), length(v_b));
  v_diff int  := 0;
begin
  -- Different lengths can never be equal. Lengths are not secret here: both
  -- sides are digests of a fixed size.
  if length(v_a) <> length(v_b) then
    v_diff := 1;
  end if;
  for i in 1 .. v_len loop
    if substr(v_a, i, 1) is distinct from substr(v_b, i, 1) then
      v_diff := v_diff + 1;
    end if;
  end loop;
  return v_diff = 0;
end $$;

-- ---------------------------------------------------------------------------
-- Claiming the instance, and the passcode
-- ---------------------------------------------------------------------------

-- What the page needs before it can ask for the passcode: has anyone claimed
-- this instance, and if so what salt should the typed passcode be hashed
-- with. The hash itself never leaves the database.
create function nl.admin_lock_state() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select coalesce(
    (select jsonb_build_object(
       'claimed', true,
       'algo', l.algo,
       'salt', l.salt,
       'claimed_by', l.claimed_by,
       'claimed_at', l.claimed_at,
       'updated_at', l.updated_at)
     from nl_config.admin_lock l),
    jsonb_build_object('claimed', false))
$$;

-- Set the first passcode. Whoever is signed in when this runs owns the
-- instance. It can only ever happen once: a second call is refused, not
-- merged, so a visitor cannot take over a claimed instance.
--
-- The passcode itself is not a parameter. The app hashes it with scrypt and
-- sends the hash and the salt, which is also why this function cannot check
-- how long the passcode was; the app does that (MIN_PASSCODE_LENGTH).
create function nl.claim_instance(
  p_algo       text,
  p_salt       text,
  p_hash       text,
  p_request_id text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'claim_instance');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if exists (select 1 from nl_config.admin_lock) then
    raise exception 'This instance has already been claimed. Use the passcode you set, or change it from Settings.'
      using errcode = 'NL409';
  end if;
  if p_algo is distinct from 'scrypt' then
    raise exception 'A passcode hash has to come from scrypt.' using errcode = 'NL422';
  end if;
  if p_salt is null or length(p_salt) not between 16 and 128
     or p_hash is null or length(p_hash) not between 32 and 256 then
    raise exception 'The passcode hash or its salt is the wrong size.' using errcode = 'NL422';
  end if;

  insert into nl_config.admin_lock (algo, salt, passcode_hash, claimed_by, updated_by)
  values (p_algo, p_salt, p_hash, v_actor.id, v_actor.id)
  returning updated_at into v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'claim_instance', 'instance', 'northline', p_request_id,
          jsonb_build_object('algo', p_algo));

  v_result := jsonb_build_object('claimed', true, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Is this the passcode? Records the attempt either way, which is what makes
-- the rate limit and the record true.
--
-- A wrong answer is not an exception: it returns ok = false, so the attempt
-- row and the audit row commit. Only a structural problem raises (nobody
-- signed in, nothing claimed yet, a reused request id).
create function nl.check_admin_passcode(p_hash text, p_request_id text) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_replay   jsonb;
  v_actor    nl.users;
  v_lock     nl_config.admin_lock;
  v_failed   int;
  v_until    timestamptz;
  v_ok       boolean;
  v_result   jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'check_admin_passcode');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  select * into v_lock from nl_config.admin_lock;
  if not found then
    raise exception 'Nobody has claimed this instance yet. Set a passcode first.' using errcode = 'NL422';
  end if;

  v_failed := nl_config.failed_attempts(v_actor.id);
  if v_failed >= nl.admin_attempt_limit() then
    -- Locked. The attempt is not counted, or the lock would never end, but it
    -- is still on the record.
    v_until := nl_config.locked_until(v_actor.id);
    insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
    values (v_actor.id, 'ui', 'admin_passcode_locked', 'instance', 'northline', p_request_id,
            jsonb_build_object('failed', v_failed, 'until', v_until));
    v_result := jsonb_build_object(
      'ok', false, 'locked', true, 'attempts_left', 0,
      'minutes', greatest(1, ceil(extract(epoch from (v_until - now())) / 60)::int));
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  v_ok := nl.constant_time_equal(p_hash, v_lock.passcode_hash);

  insert into nl_config.admin_attempts (user_id, ok, request_id)
  values (v_actor.id, v_ok, p_request_id);

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui',
          case when v_ok then 'admin_passcode_ok' else 'admin_passcode_failed' end,
          'instance', 'northline', p_request_id,
          jsonb_build_object('failed_before', v_failed));

  v_result := jsonb_build_object(
    'ok', v_ok, 'locked', false,
    'attempts_left', case when v_ok then nl.admin_attempt_limit()
                          else nl.admin_attempt_limit() - v_failed - 1 end);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Change the passcode. Only someone who knows the old one can: the old hash
-- is compared here, in the database, not trusted from the app. A wrong old
-- passcode counts against the same rate limit as a wrong unlock.
create function nl.change_admin_passcode(
  p_old_hash            text,
  p_algo                text,
  p_new_salt            text,
  p_new_hash            text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_lock   nl_config.admin_lock;
  v_failed int;
  v_until  timestamptz;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'change_admin_passcode');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  select * into v_lock from nl_config.admin_lock;
  if not found then
    raise exception 'Nobody has claimed this instance yet. Set a passcode first.' using errcode = 'NL422';
  end if;

  v_failed := nl_config.failed_attempts(v_actor.id);
  if v_failed >= nl.admin_attempt_limit() then
    v_until := nl_config.locked_until(v_actor.id);
    insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
    values (v_actor.id, 'ui', 'admin_passcode_locked', 'instance', 'northline', p_request_id,
            jsonb_build_object('failed', v_failed, 'until', v_until, 'while', 'change'));
    v_result := jsonb_build_object(
      'ok', false, 'locked', true, 'attempts_left', 0,
      'minutes', greatest(1, ceil(extract(epoch from (v_until - now())) / 60)::int));
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  if not nl.constant_time_equal(p_old_hash, v_lock.passcode_hash) then
    insert into nl_config.admin_attempts (user_id, ok, request_id)
    values (v_actor.id, false, p_request_id);
    insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
    values (v_actor.id, 'ui', 'admin_passcode_failed', 'instance', 'northline', p_request_id,
            jsonb_build_object('failed_before', v_failed, 'while', 'change'));
    v_result := jsonb_build_object(
      'ok', false, 'locked', false,
      'attempts_left', nl.admin_attempt_limit() - v_failed - 1);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  if p_algo is distinct from 'scrypt' then
    raise exception 'A passcode hash has to come from scrypt.' using errcode = 'NL422';
  end if;
  if p_new_salt is null or length(p_new_salt) not between 16 and 128
     or p_new_hash is null or length(p_new_hash) not between 32 and 256 then
    raise exception 'The passcode hash or its salt is the wrong size.' using errcode = 'NL422';
  end if;
  -- "Is the new passcode the same as the old one" cannot be answered here:
  -- every change gets a fresh salt, so the same phrase hashes to a different
  -- value. The app compares the new phrase under the OLD salt and refuses it
  -- (server/settings/admin.ts, changePasscode).

  update nl_config.admin_lock
     set algo = p_algo, salt = p_new_salt, passcode_hash = p_new_hash, updated_by = v_actor.id
   where only_row
     and updated_at = p_expected_updated_at
  returning updated_at into v_at;
  if not found then
    raise exception 'The passcode changed since this page was loaded. Reload and try again.' using errcode = 'NL409';
  end if;

  insert into nl_config.admin_attempts (user_id, ok, request_id)
  values (v_actor.id, true, p_request_id);

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'change_admin_passcode', 'instance', 'northline', p_request_id, '{}');

  v_result := jsonb_build_object('ok', true, 'locked', false, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Writing a setting
-- ---------------------------------------------------------------------------

-- The rules each key's value has to obey. Raises NL422 with a message a
-- person can act on. Secrets are not checked here: the database never sees
-- their plaintext.
create function nl_config.check_setting(p_key text, p_value text) returns text
language plpgsql immutable
set search_path = ''
as $$
declare
  v_value text := btrim(coalesce(p_value, ''));
begin
  if p_key = 'anthropic_model' then
    if v_value = '' or length(v_value) > 80 or v_value !~ '^[a-z0-9][a-z0-9.\-]*$' then
      raise exception 'A model name is lower-case letters, digits, dots and dashes, up to 80 characters.'
        using errcode = 'NL422';
    end if;
  elsif p_key in ('assistant_daily_per_user', 'assistant_daily_total') then
    if v_value !~ '^\d{1,6}$' then
      raise exception 'A daily cap is a whole number of calls, 0 or more.' using errcode = 'NL422';
    end if;
    -- No leading zeros on screen.
    v_value := (v_value::int)::text;
  elsif p_key in ('mail_inbox_orders', 'mail_inbox_procurement') then
    v_value := lower(v_value);
    if v_value !~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$' or length(v_value) > 200 then
      raise exception 'An inbox is one email address.' using errcode = 'NL422';
    end if;
  elsif p_key = 'mail_allowlist' then
    -- One address per line or separated by commas. Stored as a comma
    -- separated list in lower case so the app can split it on a comma.
    select string_agg(a, ',') into v_value
    from (
      select distinct lower(btrim(part)) as a
      from regexp_split_to_table(v_value, '[,;\n\r]+') as part
      where btrim(part) <> ''
      order by 1
    ) parts;
    v_value := coalesce(v_value, '');
    if v_value = '' then
      raise exception 'The allowed recipients list needs at least one address, or clear it instead.'
        using errcode = 'NL422';
    end if;
    if length(v_value) > 4000 then
      raise exception 'That allowed recipients list is too long.' using errcode = 'NL422';
    end if;
    if exists (
      select 1 from regexp_split_to_table(v_value, ',') as a
      where a !~ '^[^@\s,]+@[^@\s,]+\.[^@\s,]+$') then
      raise exception 'Every allowed recipient has to be an email address.' using errcode = 'NL422';
    end if;
  end if;
  return v_value;
end $$;

-- Store one setting. A secret arrives already encrypted, with the last four
-- characters of its plaintext for the screen; anything else arrives as text.
--
-- Optimistic locking works the way it does everywhere else, with one extra
-- case: p_expected_updated_at is null for "there is no row for this key yet".
-- If a row has appeared in the meantime that is a conflict, not an overwrite.
create function nl.set_setting(
  p_key                 text,
  p_value               text,
  p_secret              text,
  p_last4               text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_replay    jsonb;
  v_actor     nl.users;
  v_secret    boolean;
  v_before    nl_config.settings;
  v_had_row   boolean;
  v_value     text;
  v_last4     text;
  v_at        timestamptz;
  v_result    jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_setting');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  -- Settings belong to whoever claimed the instance. Before that there is
  -- nobody to belong to.
  if not exists (select 1 from nl_config.admin_lock) then
    raise exception 'Claim this instance with a passcode before changing any setting.' using errcode = 'NL403';
  end if;
  if p_key is null or not (p_key = any (nl.setting_keys())) then
    raise exception '% is not a setting this app has.', coalesce(p_key, 'null') using errcode = 'NL422';
  end if;

  v_secret := nl.setting_is_secret(p_key);
  if v_secret then
    if p_secret is null or p_secret = '' or p_value is not null then
      raise exception 'That setting is a secret and has to arrive encrypted.' using errcode = 'NL422';
    end if;
    if length(p_secret) > 8000 then
      raise exception 'That secret is too long.' using errcode = 'NL422';
    end if;
    v_last4 := right(coalesce(p_last4, ''), 4);
    v_value := null;
  else
    if p_secret is not null then
      raise exception 'That setting is not a secret, so it is stored as plain text.' using errcode = 'NL422';
    end if;
    v_value := nl_config.check_setting(p_key, p_value);
    v_last4 := '';
  end if;

  select * into v_before from nl_config.settings where key = p_key;
  v_had_row := found;

  if v_had_row and p_expected_updated_at is null then
    raise exception 'Someone set % while this page was open. Reload and try again.', p_key using errcode = 'NL409';
  end if;
  if not v_had_row and p_expected_updated_at is not null then
    raise exception '% was cleared while this page was open. Reload and try again.', p_key using errcode = 'NL409';
  end if;

  if v_had_row then
    update nl_config.settings
       set value = v_value,
           secret = case when v_secret then p_secret else null end,
           last4 = v_last4,
           updated_by = v_actor.id
     where key = p_key
       and updated_at = p_expected_updated_at
    returning updated_at into v_at;
    if not found then
      raise exception '% changed since this page was loaded. Reload and try again.', p_key using errcode = 'NL409';
    end if;
  else
    insert into nl_config.settings (key, value, secret, is_secret, last4, updated_by)
    values (p_key, v_value, case when v_secret then p_secret else null end, v_secret, v_last4, v_actor.id)
    returning updated_at into v_at;
  end if;

  -- The audit trail records that a secret changed and its last four
  -- characters, never the secret. A value that is not secret is recorded in
  -- full, before and after, because that is the point of the trail.
  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'set_setting', 'setting', p_key, p_request_id,
          jsonb_build_object(
            'is_secret', v_secret,
            'last4', v_last4,
            'was_set', v_had_row,
            'before', case when v_secret then null else to_jsonb(v_before.value) end,
            'after', case when v_secret then null else to_jsonb(v_value) end));

  v_result := jsonb_build_object('key', p_key, 'is_set', true, 'last4', v_last4, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Remove one setting, so the app falls back to its environment variable (or
-- to nothing at all).
create function nl.clear_setting(
  p_key                 text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_before nl_config.settings;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'clear_setting');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if not exists (select 1 from nl_config.admin_lock) then
    raise exception 'Claim this instance with a passcode before changing any setting.' using errcode = 'NL403';
  end if;

  select * into v_before from nl_config.settings where key = p_key;
  if not found then
    raise exception 'Nothing is stored for %.', coalesce(p_key, 'null') using errcode = 'NL404';
  end if;

  delete from nl_config.settings
   where key = p_key
     and updated_at = p_expected_updated_at;
  if not found then
    raise exception '% changed since this page was loaded. Reload and try again.', p_key using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'clear_setting', 'setting', p_key, p_request_id,
          jsonb_build_object(
            'is_secret', v_before.is_secret,
            'last4', v_before.last4,
            'before', case when v_before.is_secret then null else to_jsonb(v_before.value) end));

  v_result := jsonb_build_object('key', p_key, 'is_set', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Health: what the Settings page reports, without any secret in it
-- ---------------------------------------------------------------------------

-- Row counts of the tables the world is made of. SECURITY DEFINER so the
-- figure is the whole table rather than what row-level security lets the
-- caller see, and it returns nothing but counts.
create function nl.diagnostic_counts() returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'users', (select count(*) from nl.users),
    'customers', (select count(*) from nl.customers),
    'contacts', (select count(*) from nl.contacts),
    'items', (select count(*) from nl.items),
    'commitments', (select count(*) from nl.commitments),
    'invoices', (select count(*) from nl.invoices),
    'invoice_lines', (select count(*) from nl.invoice_lines),
    'audit_log', (select count(*) from nl.audit_log))
$$;

-- How much room the database is using. Needs a privilege nl_app does not
-- have, hence SECURITY DEFINER.
create function nl.diagnostic_db_size() returns bigint
language sql stable security definer
set search_path = ''
as $$ select pg_database_size(current_database()) $$;

-- The last nightly run. On Supabase that is pg_cron's own record; everywhere
-- else (PGlite, local development) pg_cron does not exist, so the newest
-- audit row the nightly job left is the best there is.
create function nl.diagnostic_last_nightly() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_row jsonb;
begin
  if to_regclass('cron.job_run_details') is not null then
    -- No user input goes into this statement; it is dynamic only because the
    -- table does not exist on every database this app runs on.
    execute $q$
      select jsonb_build_object(
               'source', 'cron',
               'at', d.start_time,
               'finished_at', d.end_time,
               'status', d.status,
               'detail', left(coalesce(d.return_message, ''), 500))
      from cron.job_run_details d
      join cron.job j on j.jobid = d.jobid
      where j.jobname = 'northline-nightly'
      order by d.start_time desc
      limit 1
    $q$ into v_row;
    if v_row is not null then
      return v_row;
    end if;
  end if;

  select jsonb_build_object(
           'source', 'audit',
           'at', a.at,
           'status', 'recorded',
           'detail', a.action || ' on ' || a.entity)
    into v_row
  from nl.audit_log a
  where a.via = 'nightly'
  order by a.at desc
  limit 1;

  return coalesce(v_row, jsonb_build_object('source', 'none'));
end $$;

-- The three checks that prove the stored figures still agree with the rows
-- they were counted from. Each should be zero.
--
-- nl.delivery_drift() and nl.warehouse_drift() are revoked from everyone
-- (migrations 0008 and 0019): they belong to the nightly job. This function
-- is SECURITY DEFINER so the Settings page can see their count without
-- anybody being granted the checks themselves, and it returns counts only.
create function nl.diagnostic_drift() returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_delivery  int;
  v_warehouse int := null;
  v_cost      int;
  v_days      int := 90;
begin
  select count(*) into v_delivery from nl.delivery_drift();

  -- The warehouse arrived later than the rest of the app, so a database
  -- without migration 0019 simply has no answer for this one.
  if to_regprocedure('nl.warehouse_drift()') is not null then
    execute 'select count(*) from nl.warehouse_drift()' into v_warehouse;
  end if;

  -- Ledger lines whose stored cost disagrees with the cost timeline for the
  -- day they were posted. db/seed.d/55 puts those in step, and margin history
  -- reads the figure on the line, so a restamp that went wrong would quietly
  -- change the margin of a closed month. Only the last ninety days are
  -- checked, which keeps the query quick on the full world; the page says so.
  select count(*) into v_cost
  from nl.invoice_lines il
  join nl.item_cost_timeline t
    on t.item_no = il.item_no
   and il.posted_on >= t.effective_from
   and (t.effective_to is null or il.posted_on <= t.effective_to)
  where il.posted_on >= nl.today() - v_days
    and il.unit_cost is distinct from t.unit_cost;

  return jsonb_build_object(
    'delivery', v_delivery,
    'warehouse', v_warehouse,
    'cost', v_cost,
    'cost_days', v_days);
end $$;

-- ---------------------------------------------------------------------------
-- Grants. nl_readonly, the role the assistant's SQL tool runs as, gets
-- nothing here: not the tables, not the view, not one function.
-- ---------------------------------------------------------------------------

grant select on nl.settings to nl_app;

-- The helpers the functions below use on their own (nl.constant_time_equal,
-- nl.admin_attempt_limit, nl.admin_attempt_window, nl_config.failed_attempts,
-- nl_config.locked_until, nl_config.check_setting) are granted to nobody:
-- SECURITY DEFINER means they run as the owner, so the caller needs no right
-- to them.
grant execute on function
  nl.setting_keys(),
  nl.setting_is_secret(text),
  nl.settings_with_secrets(),
  nl.admin_lock_state(),
  nl.claim_instance(text, text, text, text),
  nl.check_admin_passcode(text, text),
  nl.change_admin_passcode(text, text, text, text, timestamptz, text),
  nl.set_setting(text, text, text, text, timestamptz, text),
  nl.clear_setting(text, timestamptz, text),
  nl.diagnostic_counts(),
  nl.diagnostic_db_size(),
  nl.diagnostic_last_nightly(),
  nl.diagnostic_drift()
to nl_app;

-- Row-level security on all three tables with no policy at all: even if a
-- grant were added to one of them by mistake, nl_app would still read
-- nothing. The functions above reach the rows because they run as the owner.
alter table nl_config.settings enable row level security;
alter table nl_config.admin_lock enable row level security;
alter table nl_config.admin_attempts enable row level security;
