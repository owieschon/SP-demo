-- 0044 One dial for an outside agent, instead of two permission systems.
--
-- THE PROBLEM THIS REMOVES. Migration 0024 gave /api/mcp its own permission
-- system: a token carried the scopes 'read' and 'propose', and every gated
-- tool was exposed only as propose_<name>. So a person driving this app from
-- their coding agent was strictly weaker than the same person in a browser,
-- and nothing in the database needed that. Two systems decided the same
-- question and the smaller one always won.
--
-- THE ONE DIAL. A token already acts as one named person, so what it MAY do
-- is what that person may do. The only thing left to decide is how far it
-- goes without asking, and this app already has a vocabulary for exactly
-- that: the autonomy ladder in migration 0028. So the token gets a rung on
-- that ladder and nothing else:
--
--   suggest      a gated tool stays propose_<name>. A person approves it in
--                the app. This is what every token does today.
--   auto_review  the tool acts for real, the run is recorded, and a person
--                has an undo window.
--   auto         the tool acts, audited, with no queue step.
--
-- AND IT IS AN AUTHORITY GRANT, NOT A NEW TABLE. Migration 0031 already made
-- an agent a principal in nl.users and already made 'agent_autonomy' an
-- AMOUNT authority whose amount is the rung, 0 to 3, with this comment on
-- nl.authority_grants: "Raising a person's ceiling and raising an agent's
-- autonomy are the same row and the same write." A token is a principal like
-- any other, so this migration gives each token its own agent-kind row in
-- nl.users and its level is an nl.grant_authority call against that row. No
-- second table, no second write, no second audit trail.
--
-- WHY nl.mcp_tokens CARRIES A PRINCIPAL AND NOT A LEVEL. A level column here
-- would be a copy of the grant, and a copy goes stale the first time somebody
-- dates a grant forward. So the token stores the id of the principal that
-- holds the level, and the level is resolved on read. That is the same rule
-- this schema follows everywhere else: a reference stores an id, never a copy.
--
-- WHAT IS STILL ENFORCED AT EVERY RUNG. Nothing here relaxes a check:
--   * row-level security, because the token still runs as its person;
--   * nl.may_approve for 'approve_agent_proposal', at the value at risk,
--     which reads the person's grant, its effective dates AND the policy
--     engine's cap through nl.authority_limit_override;
--   * the pause switch, nl.agent_paused('mcp'), at every rung including
--     suggest;
--   * the harness's own re-check inside nl.record_agent_action;
--   * the gated tool's own SQL function, which is the same function the page
--     and the in-app approval call.
--
-- SCOPES ARE GONE. nl.mcp_tokens.scopes is dropped. It was not the safety
-- mechanism (the propose_ shape was), it duplicated the question the level
-- now answers, and keeping it would have left two dials again.
--
-- Depends on 0024 (tokens), 0028 (the ladder, the pause, agent_actions),
-- 0031 (principals and authority grants) and 0034 (the policy engine).
-- See docs/mcp.md.

-- ---------------------------------------------------------------------------
-- 1. approve_agent_proposal becomes an amount authority
-- ---------------------------------------------------------------------------

-- "Run what the agent proposed" was a yes or no, which was enough while the
-- only way to run one was a person clicking approve. Once a token can act on
-- its own the interesting question is not whether but HOW MUCH, so this
-- authority gains a ceiling: the value a person lets an agent act on for them
-- without looking.
--
-- Nothing existing changes. Every grant of it in force has limit_amount null,
-- and null on an amount authority already means "no ceiling" in
-- nl.authority_limit, so today's answers are identical. The constraint
-- authority_limit_shape calls this function, and replacing a function does not
-- revalidate rows that are already there; it only widens what a new row may
-- say.
create or replace function nl.authority_is_amount(p_authority text) returns boolean
language sql immutable
set search_path = ''
as $$
  select p_authority in (
    'approve_quote', 'release_purchase_order', 'accept_price_increase',
    -- New in 0044: the value a person lets an agent act on for them.
    'approve_agent_proposal',
    'agent_autonomy')
$$;

-- ---------------------------------------------------------------------------
-- 2. A note on the seam migration 0031 left, and why this is not it
-- ---------------------------------------------------------------------------

-- 0031 left nl.authority_limit_override as a seam for the policy engine and
-- feature-detected nl.resolve_policy to fill it. That seam cannot work as
-- written, and it is worth saying why rather than quietly leaving it:
--
--   * 0031 runs before 0034, so on a fresh build the detection fails and the
--     override stays the null stub. It has never carried anything;
--   * more fundamentally, it looks a policy up by the AUTHORITY's own name,
--     and nl.policy_types.key must be dotted
--     (check key ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'). A bare name like
--     'approve_agent_proposal' can never be a policy type, so the lookup
--     could never match even with the function replaced.
--
-- Fixing that means changing a function every nl.may_approve call in the app
-- goes through, and is not this migration's business. What IS this
-- migration's business is that the policy engine's cap binds on the MCP path,
-- and there is already a policy type that says exactly the right thing:
-- 'agents.approval_threshold', "The value up to which an agent may act
-- without a person". nl.mcp_may_act below consults it.
--
-- Its built-in default is 0 and its own note in 0034 reads "nothing yet". So
-- a 0 that came from the built-in default means unwired, not zero dollars,
-- and the only way to tell is that nl.resolve_policy answers with
-- policy_id null when nothing matched. That is the test used below, which is
-- why nothing changes until somebody actually sets a policy.

-- ---------------------------------------------------------------------------
-- 3. Two more kinds of MCP work, so the ladder has a rung to stand on
-- ---------------------------------------------------------------------------

-- The ladder's grain is (agent, work_kind), and nl.record_agent_action checks
-- that the level it is handed is the level that kind of work is set to. So
-- each rung an outside agent can act at is its own kind of work, named for
-- the rung. That is not a trick: the two rungs really are different work,
-- because one of them leaves an undo window open and the other does not, and
-- each row carries the parameter its own rung needs (the constraints on
-- nl.agent_autonomy allow an undo window only at auto_review and a sample
-- only at auto).
insert into nl.agent_work_kinds (agent, work_kind, label, reviewer, description) values
  ('mcp', 'act_with_review', 'Change made with an undo window', 'the person the token acts as',
   'An outside agent made a change for real. It is done, it is recorded, and there is a window to take it back.'),
  ('mcp', 'act', 'Change made outright', 'nobody, a sampled share afterwards',
   'An outside agent made a change for real with no queue step. Audited, and bounded by the person''s authority.')
on conflict (agent, work_kind) do nothing;

insert into nl.agent_autonomy (agent, work_kind, level, undo_window_minutes, sample_rate, note) values
  ('mcp', 'act_with_review', 'auto_review', 60, 0,
   'A token raised to act-with-review changes records for real. Sixty minutes to undo.'),
  ('mcp', 'act', 'auto', 0, 0.050,
   'A token raised to act changes records outright. One in twenty is reviewed afterwards.')
on conflict (agent, work_kind) do nothing;

-- ---------------------------------------------------------------------------
-- 4. A token's principal
-- ---------------------------------------------------------------------------

-- nl.users.id has no default, because ids are fixed so a nightly rebuild keeps
-- sessions valid. People are single digits and the two seeded desk agents are
-- 101 and 102, so token principals get their own band well clear of both.
create sequence nl.mcp_principal_ids as int start with 9001 minvalue 9001;

comment on sequence nl.mcp_principal_ids is
  'Ids for the agent-kind nl.users row each MCP token acts through. Its own band, clear of people and of the desk agents (migration 0044).';

alter table nl.mcp_tokens
  -- The agent principal whose 'agent_autonomy' grant IS this token's rung on
  -- the ladder. Null on a token minted before this migration, which reads as
  -- the lowest rung: migrate on read, never with a mass update.
  add column principal_id int unique references nl.users (id);

comment on column nl.mcp_tokens.principal_id is
  'The agent-kind principal holding this token''s autonomy grant. Null reads as suggest (migration 0044).';

-- Scopes are gone. They answered the same question the level answers, and the
-- smaller answer always won.
alter table nl.mcp_tokens drop column scopes;

-- Make, or find, the principal a token's level lives on.
--
-- security definer because nl_app has select and a two-column update on
-- nl.users and nothing else: creating a principal is not something a page may
-- do by hand. The gate is the same one minting a token has, an admin, checked
-- here rather than assumed from the caller.
create function nl.ensure_mcp_principal(p_token_id bigint) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token nl.mcp_tokens;
  v_id    int;
begin
  if not nl.is_admin() then
    raise exception 'Only an admin can give an MCP token a principal.' using errcode = 'NL403';
  end if;

  select * into v_token from nl.mcp_tokens where id = p_token_id for update;
  if not found then
    raise exception 'MCP token % does not exist.', coalesce(p_token_id, 0) using errcode = 'NL404';
  end if;
  if v_token.principal_id is not null then
    return v_token.principal_id;
  end if;

  v_id := nextval('nl.mcp_principal_ids');

  -- An agent principal, not a person: kind 'agent' keeps it off the sign-in
  -- picker and out of /people, and nl.grant_authority refuses an autonomy
  -- grant to anything that is not one. The email is synthetic and unique
  -- because nl.users.email is unique and nothing ever sends to it.
  insert into nl.users (id, email, full_name, title, role, active, kind, responsibility)
  values (v_id,
          'mcp-token-' || v_id || '@northline.example',
          'Coding agent: ' || v_token.label,
          'Coding agent',
          'agent', true, 'agent',
          'Acts as ' || (select u.full_name from nl.users u where u.id = v_token.user_id)
            || ' over MCP, as far as its autonomy grant allows.');

  update nl.mcp_tokens set principal_id = v_id where id = p_token_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Reading a token's rung
-- ---------------------------------------------------------------------------

-- The grant's number against the ladder's name. The grant counts from 0
-- because a ceiling in nl.authority_grants is a number like every other
-- ceiling; the ladder uses names because code branches on them. This is the
-- SQL side of the conversion $lib/harness/levels.ts documents.
--
-- 0 is 'shadow' on the ladder, which for a token would mean drafting for
-- nobody: there is no draft to keep and nothing to read, so it reads as the
-- floor instead. A token with no grant at all reads as the floor too, which
-- is why an existing token keeps behaving exactly as it did.
create function nl.mcp_level_floor() returns text
language sql immutable
set search_path = ''
as $$ select 'suggest'::text $$;

create function nl.mcp_token_level(p_token_id bigint) returns text
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select case nl.authority_limit(t.principal_id, 'agent_autonomy')
              when 1 then 'suggest'
              when 2 then 'auto_review'
              when 3 then 'auto'
              -- 0, or a grant with no ceiling, or no grant in force today.
              else nl.mcp_level_floor()
            end
     from nl.mcp_tokens t
     where t.id = p_token_id
       and t.principal_id is not null
       and nl.has_authority(t.principal_id, 'agent_autonomy')),
    nl.mcp_level_floor())
$$;

comment on function nl.mcp_token_level(bigint) is
  'The rung this token stands on, read from its principal''s agent_autonomy grant. suggest when it has none (migration 0044).';

-- Which kind of MCP work a rung is. One function so the server, the recorder
-- and the board cannot disagree about it.
create function nl.mcp_work_kind(p_level text) returns text
language sql immutable
set search_path = ''
as $$
  select case p_level
    when 'auto_review' then 'act_with_review'
    when 'auto' then 'act'
    else 'propose'
  end
$$;

-- Everything the endpoint needs before it decides what a tool call does, in
-- one answer, read through the same ladder every other agent uses.
create function nl.mcp_token_autonomy(p_token_id bigint) returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
           'token_id', p_token_id,
           'level', lvl.level,
           'work_kind', nl.mcp_work_kind(lvl.level),
           -- The ladder's own answer for that kind of work: the undo window,
           -- the sample rate and the pause all come from nl.agent_autonomy_for
           -- rather than from anything this migration invented.
           'ladder', nl.agent_autonomy_for('mcp', nl.mcp_work_kind(lvl.level)),
           'paused', (nl.agent_paused('mcp') ->> 'paused')::boolean,
           'pause', nl.agent_paused('mcp'),
           -- A pause stops a token acting at any rung. At suggest it stops it
           -- proposing too: a queue nobody is working is not a safe place to
           -- pile work up while the brake is on.
           'may_act', lvl.level in ('auto_review', 'auto')
                      and not (nl.agent_paused('mcp') ->> 'paused')::boolean,
           'undo_window_minutes',
             coalesce((nl.agent_autonomy_for('mcp', nl.mcp_work_kind(lvl.level))
                       ->> 'undo_window_minutes')::int, 0))
  from (select nl.mcp_token_level(p_token_id) as level) lvl
$$;

comment on function nl.mcp_token_autonomy(bigint) is
  'What this token may do right now: its rung, the ladder row behind it, and the pause (migration 0044).';

-- ---------------------------------------------------------------------------
-- 6. The value at risk, and whether this person may let an agent act on it
-- ---------------------------------------------------------------------------

-- What a tool call is worth, so a ceiling has something to bite on. A
-- commitment tool is worth the commitment; the rest move no money, so they
-- are worth nothing and any grant clears them. Kept as one function because
-- "what is this worth" must have one answer wherever it is asked.
create function nl.mcp_action_amount(p_tool text, p_input jsonb) returns numeric
language sql stable
set search_path = ''
as $$
  select case
    when p_tool in ('record_outcome', 'set_confidence') then
      coalesce((select c.committed_value
                from nl.commitments c
                where c.id = (p_input ->> 'commitment_id')::bigint), 0)
    else 0
  end
$$;

-- Which account a tool call is about, so the policy engine can answer for that
-- account rather than only for the company. A commitment tool names it through
-- its commitment; the additive tools name it outright; the rest are not about
-- one account at all, and an empty answer means the company default wins.
create function nl.mcp_action_customer(p_tool text, p_input jsonb) returns text
language sql stable
set search_path = ''
as $$
  select case
    when p_tool in ('record_outcome', 'set_confidence') then
      coalesce((select c.customer_no
                from nl.commitments c
                where c.id = (p_input ->> 'commitment_id')::bigint), '')
    when p_tool in ('add_note', 'add_next_step') then coalesce(p_input ->> 'customer_no', '')
    else ''
  end
$$;

-- The policy engine's own cap for this call, or null when nobody has set one.
--
-- 'agents.approval_threshold' is the policy type 0034 wrote for exactly this
-- question. Its built-in default is 0 and its note says "nothing yet", so a
-- built-in answer is read as "unwired" rather than as "zero dollars"; the
-- difference is policy_id, which nl.policy_answer sets to null when nothing
-- matched. Once a policy row exists at any scope, the number is real and it
-- binds, at that account or company wide, exactly as every other policy does.
create function nl.mcp_policy_cap(p_tool text, p_input jsonb) returns numeric
language sql stable
set search_path = ''
as $$
  select case
    when answer.a -> 'policy_id' is null or answer.a ->> 'policy_id' is null then null
    else (answer.a ->> 'value')::numeric
  end
  from (select nl.resolve_policy(
                 'agents.approval_threshold',
                 jsonb_build_object(
                   'customer_no', nl.mcp_action_customer(p_tool, p_input),
                   'on_date', nl.today()::text)) as a) answer
$$;

-- May this person let an agent act for them, on this, without approving it?
--
-- Two questions, both asked of something that already existed:
--
--   1. the PERSON's authority. 'approve_agent_proposal' is the authority
--      migration 0031 defines as "run what the assistant proposed", and
--      running a gated tool from a coding agent is exactly that.
--      nl.may_approve reads the grant and its effective dates in one call;
--   2. the COMPANY's cap, from the policy engine, which can be set per
--      account. Null when nobody has set one, which is where this database
--      stands today.
--
-- The answer names whichever one refused, with its number, because "refused"
-- without the figure is not something anybody can act on. It is never
-- downgraded to a proposal: a token asked to act and could not, and saying so
-- is the honest answer.
create function nl.mcp_may_act(p_user_id int, p_tool text, p_input jsonb) returns jsonb
language sql stable
set search_path = ''
as $$
  with asked as (
    select nl.mcp_action_amount(p_tool, p_input) as amount,
           nl.mcp_policy_cap(p_tool, p_input)    as policy_cap
  ),
  judged as (
    select a.amount,
           a.policy_cap,
           nl.has_authority(p_user_id, 'approve_agent_proposal') as holds,
           nl.authority_limit(p_user_id, 'approve_agent_proposal') as ceiling,
           nl.may_approve(p_user_id, 'approve_agent_proposal', a.amount) as person_ok,
           (a.policy_cap is null or a.amount <= a.policy_cap) as policy_ok,
           (select u.full_name from nl.users u where u.id = p_user_id) as who
    from asked a
  )
  select jsonb_build_object(
           'allowed', j.person_ok and j.policy_ok,
           'authority', 'approve_agent_proposal',
           'amount', j.amount,
           'holds', j.holds,
           -- Null means "no ceiling" here as it does everywhere else in
           -- nl.authority_grants, and also means "no grant"; 'holds' tells
           -- the two apart.
           'ceiling', case when j.holds then j.ceiling end,
           'policy_cap', j.policy_cap,
           'reason', case
             when j.person_ok and j.policy_ok then ''
             when not j.holds then
               j.who || ' does not hold approve_agent_proposal, so a token acting as them cannot'
                     || ' make this change. Grant it on /people, or approve the change yourself.'
             when not j.person_ok then
               j.who || ' may let an agent act up to '
                     || to_char(j.ceiling, 'FM999,999,999.00')
                     || ', and this is worth ' || to_char(j.amount, 'FM999,999,999.00')
                     || '. Raise the ceiling on /people or approve it yourself.'
             else
               'The company lets an agent act up to '
                     || to_char(j.policy_cap, 'FM999,999,999.00')
                     || ' (agents.approval_threshold), and this is worth '
                     || to_char(j.amount, 'FM999,999,999.00')
                     || '. Change the policy on /policies or approve it yourself.'
           end)
  from judged j
$$;

comment on function nl.mcp_may_act(int, text, jsonb) is
  'May a token acting as this person make this change without asking? Names the ceiling or the cap when not (migration 0044).';

-- ---------------------------------------------------------------------------
-- 7. Minting, authenticating, and moving the dial
-- ---------------------------------------------------------------------------

-- Minting loses the scopes argument and gains a principal at the lowest rung,
-- so a freshly minted token behaves exactly as every token behaves today:
-- everything becomes a proposal.
drop function nl.mint_mcp_token(text, int, text[], text, text);

create function nl.mint_mcp_token(
  p_label        text,
  p_user_id      int,
  p_token_sha256 text,
  p_request_id   text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay    jsonb;
  v_actor     nl.users;
  v_label     text := btrim(coalesce(p_label, ''));
  v_target    nl.users;
  v_id        bigint;
  v_principal int;
  v_result    jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'mint_mcp_token');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if not nl.is_admin() then
    raise exception 'Only an admin can mint an MCP token.' using errcode = 'NL403';
  end if;
  if length(v_label) < 1 or length(v_label) > 60 then
    raise exception 'A token needs a label of 1 to 60 characters, so it can be recognised later.'
      using errcode = 'NL422';
  end if;
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'A token is stored as its SHA-256, which is 64 lowercase hex characters.'
      using errcode = 'NL422';
  end if;

  select * into v_target from nl.users where id = p_user_id and active;
  if not found then
    raise exception 'There is no active user %, so a token cannot act as them.', coalesce(p_user_id, 0)
      using errcode = 'NL404';
  end if;
  if v_target.kind <> 'person' then
    raise exception 'A token acts as a person, not as another agent.' using errcode = 'NL422';
  end if;

  insert into nl.mcp_tokens (label, token_sha256, user_id, created_by)
  values (left(v_label, 60), p_token_sha256, p_user_id, v_actor.id)
  returning id into v_id;

  -- Its principal, and its rung: 1 is 'suggest', the floor, so a new token
  -- proposes and writes nothing until somebody raises it on /agents.
  v_principal := nl.ensure_mcp_principal(v_id);
  perform nl.grant_authority(
    v_principal, 'agent_autonomy', 1, null, null,
    'Minted at suggest: it proposes, a person approves.',
    p_request_id || ':autonomy', 'ui');

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'mint_mcp_token', 'mcp_token', v_id::text, p_request_id,
          jsonb_build_object('label', left(v_label, 60), 'acts_as', p_user_id,
                             'principal_id', v_principal, 'level', 'suggest'));

  v_result := jsonb_build_object('token_id', v_id, 'label', left(v_label, 60),
                                 'acts_as', p_user_id,
                                 'principal_id', v_principal,
                                 'level', 'suggest');
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Authentication gains the rung and loses the scopes. It still says nothing
-- about which tokens exist: a wrong token, a made-up token and a revoked one
-- all come back the same way.
create or replace function nl.authenticate_mcp_token(p_token_sha256 text) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_token  nl.mcp_tokens;
  v_active boolean;
begin
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then
    return null;
  end if;

  select * into v_token from nl.mcp_tokens where token_sha256 = p_token_sha256;
  if not found then
    return null;
  end if;

  select u.active into v_active from nl.users u where u.id = v_token.user_id;

  -- A revoked token is still recorded as having been tried, which is how a
  -- leaked token shows up in the list after it was turned off.
  update nl.mcp_tokens set last_used_at = now() where id = v_token.id;

  return jsonb_build_object(
    'token_id', v_token.id,
    'label', v_token.label,
    'user_id', v_token.user_id,
    'principal_id', v_token.principal_id,
    -- The one dial, read through the ladder. Everything the endpoint decides
    -- about this call comes from here.
    'autonomy', nl.mcp_token_autonomy(v_token.id),
    -- Handed back so the app can compare the hashes in constant time.
    'token_sha256', v_token.token_sha256,
    'revoked', v_token.revoked_at is not null,
    'user_active', coalesce(v_active, false));
end $$;

-- Move a token's dial. This is nl.grant_authority and nothing else: the same
-- call, the same table, the same audit row and the same gate as raising a
-- person's approval ceiling. There is deliberately no mcp-shaped write here.
--
-- It claims no request id of its own on purpose. nl.grant_authority claims
-- p_request_id, so a second send of the form replays that one grant instead
-- of writing a second row, and a wrapper claiming the same id first would
-- simply lock itself out.
create function nl.set_mcp_token_autonomy(
  p_token_id   bigint,
  p_level      text,
  p_starts_on  date,
  p_note       text,
  p_request_id text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_token     nl.mcp_tokens;
  v_principal int;
  v_grant     int;
  v_before    text;
  v_result    jsonb;
begin
  if p_level is null or p_level not in ('suggest', 'auto_review', 'auto') then
    raise exception 'A token''s level is suggest, auto_review or auto, not %.',
      coalesce(p_level, 'empty') using errcode = 'NL422';
  end if;

  select * into v_token from nl.mcp_tokens where id = p_token_id;
  if not found then
    raise exception 'MCP token % does not exist.', coalesce(p_token_id, 0) using errcode = 'NL404';
  end if;
  if v_token.revoked_at is not null then
    raise exception 'MCP token % is revoked, so its level does not mean anything.', p_token_id
      using errcode = 'NL422';
  end if;

  v_before := nl.mcp_token_level(p_token_id);

  -- A token minted before this migration has no principal yet. Making one on
  -- the way past is the migrate-on-read rule: nothing was rewritten in bulk,
  -- and the row grows the first time somebody needs it to.
  --
  -- One consequence, written down rather than discovered later: creating a
  -- principal needs an admin, and raising a level needs change_policy, so
  -- somebody holding change_policy but not admin can raise any token minted
  -- since 0044 and not one minted before it. Every token this app mints from
  -- now on has its principal already, so this only ever bites on a token that
  -- predates the migration, and the fix is for an admin to move it once.
  v_principal := nl.ensure_mcp_principal(p_token_id);

  v_grant := case p_level when 'suggest' then 1 when 'auto_review' then 2 else 3 end;

  -- Every gate lives in here: nl.require_role_authority, the 0 to 3 range,
  -- the refusal to grant autonomy to anything that is not an agent, the
  -- effective dating and the audit row.
  perform nl.grant_authority(
    v_principal, 'agent_autonomy', v_grant, p_starts_on, null,
    left(coalesce(p_note, ''), 300), p_request_id, 'ui');

  v_result := jsonb_build_object(
    'token_id', p_token_id,
    'principal_id', v_principal,
    'from_level', v_before,
    'level', nl.mcp_token_level(p_token_id),
    'requested', p_level,
    'starts_on', coalesce(p_starts_on, nl.today()));
  return v_result;
end $$;

comment on function nl.set_mcp_token_autonomy(bigint, text, date, text, text) is
  'Raise or lower a token''s rung. Calls nl.grant_authority, the same write as raising a person''s limit (migration 0044).';

-- ---------------------------------------------------------------------------
-- 8. Access
-- ---------------------------------------------------------------------------

-- principal_id is written only inside nl.ensure_mcp_principal, which is
-- security definer, so nl_app's update grant is deliberately NOT widened to
-- cover it. The existing grant of update (last_used_at, revoked_at) stands.

grant execute on function
  nl.mint_mcp_token(text, int, text, text),
  nl.ensure_mcp_principal(bigint),
  nl.mcp_level_floor(),
  nl.mcp_token_level(bigint),
  nl.mcp_work_kind(text),
  nl.mcp_token_autonomy(bigint),
  nl.mcp_action_amount(text, jsonb),
  nl.mcp_action_customer(text, jsonb),
  nl.mcp_policy_cap(text, jsonb),
  nl.mcp_may_act(int, text, jsonb),
  nl.set_mcp_token_autonomy(bigint, text, date, text, text)
to nl_app;
