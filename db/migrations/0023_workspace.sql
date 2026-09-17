-- 0023 The agent workspace: one queue over everything an agent has put in
-- front of a person, and the workspace's own record of what was decided.
--
-- The rules that shape this migration:
--   * The queue OWNS NO APPROVAL LOGIC. It is a view that collects the rows
--     already waiting in each feature's own table, in one shape. Deciding one
--     still goes through that feature's own write function, which is where the
--     request id, the role rules, the row version, the audit row and the
--     "input comes from the stored record" guarantee live.
--   * The queue is built from the tables that EXIST. Four features feed it and
--     they are being built on different branches: RFQ drafts (0011) and
--     assistant proposals (0017) are here, mail drafts (0021) and purchase
--     requests (0022) are not. A view cannot name a table that does not exist,
--     not even inside `where exists`, because Postgres resolves the name when
--     the view is created. So the view text is assembled by a function from
--     the sources present, and nl.rebuild_agent_queue() is run again once a
--     later migration adds one. See docs/workspace.md.
--   * Row-level security still decides who sees what. The view is
--     security_invoker, so each source's own policies apply: an RFQ draft is
--     its creator's (or an admin's), an assistant proposal is its creator's.
--   * nl.queue_decisions is the workspace's own history, so "what did we
--     decide about this" survives a source row being rebuilt by the nightly
--     job. It never replaces the audit log; it sits beside it.
--
-- Depends on 0001 (users, audit log, request ids), 0002 (customers, vendors),
-- 0003 (commitments), 0011 (RFQ drafts) and 0017 (assistant proposals).

-- ---------------------------------------------------------------------------
-- The workspace's own record of decisions
-- ---------------------------------------------------------------------------

create table nl.queue_decisions (
  id         bigint generated always as identity (start with 6001) primary key,
  source     text not null check (source in ('rfq', 'assistant', 'mail', 'purchase')),
  source_id  bigint not null check (source_id > 0),
  -- edited_approved means a person corrected the proposal first, through the
  -- source's own revise function, and then approved what they had corrected.
  decision   text not null check (decision in ('approved', 'edited_approved', 'rejected')),
  decided_by int not null references nl.users (id),
  decided_at timestamptz not null default now(),
  note       text not null default '',
  -- The request id the SOURCE's write ran under, not this row's own. It is
  -- what ties a decision here to the audit row the source wrote, and what
  -- makes recording the same decision twice write once.
  request_id text not null check (length(request_id) between 8 and 100),
  unique (source, source_id, request_id)
);

comment on table nl.queue_decisions is
  'What a person decided in the agent workspace. Append only. The write itself belongs to the source feature; this is the workspace''s own history (migration 0023).';

create index queue_decisions_recent_idx on nl.queue_decisions (decided_at desc, id desc);
create index queue_decisions_source_idx on nl.queue_decisions (source, source_id);
create index queue_decisions_by_idx on nl.queue_decisions (decided_by, decided_at desc);

-- Record one decision. There is no row version to lock here: this is an
-- insert, and the row the decision is ABOUT was locked by the source's own
-- write function a moment earlier. Recording the same decision twice (the
-- same source write, retried) writes once and says so.
create function nl.record_queue_decision(
  p_source            text,
  p_source_id         bigint,
  p_decision          text,
  p_note              text,
  p_source_request_id text,
  p_request_id        text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_id     bigint;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_queue_decision');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_source is null or p_source not in ('rfq', 'assistant', 'mail', 'purchase') then
    raise exception 'The workspace does not know a source called %.', coalesce(p_source, 'empty')
      using errcode = 'NL422';
  end if;
  if p_source_id is null or p_source_id <= 0 then
    raise exception 'A decision names the record it is about.' using errcode = 'NL422';
  end if;
  if p_decision is null or p_decision not in ('approved', 'edited_approved', 'rejected') then
    raise exception 'A decision is approved, edited_approved or rejected, not %.',
      coalesce(p_decision, 'empty') using errcode = 'NL422';
  end if;
  if p_source_request_id is null or length(p_source_request_id) < 8 or length(p_source_request_id) > 100 then
    raise exception 'A decision names the request id its write ran under.' using errcode = 'NL422';
  end if;

  insert into nl.queue_decisions (source, source_id, decision, decided_by, note, request_id)
  values (p_source, p_source_id, p_decision, v_actor.id, left(coalesce(p_note, ''), 500), p_source_request_id)
  on conflict (source, source_id, request_id) do nothing
  returning id, decided_at into v_id, v_at;

  -- Already recorded: hand back the row that is there and write nothing more,
  -- not even an audit row, because nothing changed.
  if v_id is null then
    select d.id, d.decided_at into v_id, v_at
    from nl.queue_decisions d
    where d.source = p_source and d.source_id = p_source_id and d.request_id = p_source_request_id;
    v_result := jsonb_build_object('decision_id', v_id, 'decided_at', v_at, 'recorded', false);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'queue_decision', 'queue_decision', v_id::text, p_request_id,
          jsonb_build_object('source', p_source,
                             'source_id', p_source_id,
                             'decision', p_decision,
                             'source_request_id', p_source_request_id,
                             'note', left(coalesce(p_note, ''), 500)));

  v_result := jsonb_build_object('decision_id', v_id, 'decided_at', v_at, 'recorded', true);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Building the queue from the sources that exist
-- ---------------------------------------------------------------------------

-- The first of these tables that exists in schema nl, or null. Mail drafts
-- and purchase requests are built elsewhere, so their exact table name is a
-- reasonable guess rather than something this migration can rely on.
create function nl.agent_queue_table(p_candidates text[]) returns text
language sql stable
set search_path = ''
as $$
  select c.name
  from unnest(p_candidates) with ordinality as c(name, ord)
  where pg_catalog.to_regclass('nl.' || pg_catalog.quote_ident(c.name)) is not null
  order by c.ord
  limit 1
$$;

create function nl.agent_queue_has_column(p_table text, p_column text) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.pg_attribute a
    where a.attrelid = pg_catalog.to_regclass('nl.' || pg_catalog.quote_ident(p_table))
      and a.attname = p_column
      and a.attnum > 0
      and not a.attisdropped)
$$;

-- A piece of SQL for one column of a table this migration did not create:
-- "d"."subject" when that column is there, or the fallback expression when it
-- is not. This is what lets the queue take what a later table happens to
-- offer without failing on what it does not.
create function nl.agent_queue_column(
  p_table    text,
  p_column   text,
  p_alias    text,
  p_fallback text
) returns text
language sql stable
set search_path = ''
as $$
  select case
    when nl.agent_queue_has_column(p_table, p_column)
      then pg_catalog.quote_ident(p_alias) || '.' || pg_catalog.quote_ident(p_column)
    else p_fallback
  end
$$;

-- One SELECT in the queue's shape for one source, or null when that source is
-- not in this database. Every branch casts every column, so the union has one
-- type per column no matter which branches are in it.
--
-- The shape, once:
--   source, source_id, summary, subject_kind, subject_no, subject_name,
--   value, created_by_id, created_by, created_via, created_at, row_version,
--   reviewer_id, status
create function nl.agent_queue_fragment(p_source text) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_table    text;
  v_ref      text;   -- nl.customers or nl.vendors
  v_ref_key  text;   -- customer_no or vendor_no
  v_kind     text;   -- 'account' or 'vendor'
  v_key      text;   -- SQL for the source row's own reference column
  v_summary  text;
  v_value    text;
  v_author   text;
  v_reviewer text;
begin
  if p_source = 'rfq' then
    if pg_catalog.to_regclass('nl.rfq_drafts') is null then
      return null;
    end if;
    -- An open RFQ draft is waiting for a person. needs_review counts the
    -- fields the validator could not settle, and nl.approve_rfq_draft refuses
    -- while any of them is open, so the queue shows that as its own status.
    return $frag$
      select 'rfq'::text                                            as source,
             d.id::bigint                                           as source_id,
             ('Turn emailed request R-' || d.id || ' into a quote for '
               || coalesce(c.name, 'a customer that is not settled yet'))::text as summary,
             (case when c.customer_no is not null then 'account' end)::text     as subject_kind,
             c.customer_no::text                                    as subject_no,
             c.name::text                                           as subject_name,
             (d.validation #>> '{totals,subtotal}')::numeric(12, 2) as value,
             d.created_by::int                                      as created_by_id,
             u.full_name::text                                      as created_by,
             (case when d.extractor = 'claude' then 'assistant' else 'person' end)::text as created_via,
             d.created_at                                           as created_at,
             d.updated_at                                           as row_version,
             d.created_by::int                                      as reviewer_id,
             (case when d.needs_review > 0 then 'needs_review' else 'waiting' end)::text as status
      from nl.rfq_drafts d
      join nl.users u on u.id = d.created_by
      left join nl.customers c on c.customer_no = d.customer_no
      where d.status = 'draft'
    $frag$;

  elsif p_source = 'assistant' then
    if pg_catalog.to_regclass('nl.assistant_proposals') is null then
      return null;
    end if;
    -- A draft proposal is waiting. One that was approved and then failed is
    -- waiting too, for another attempt, and shows as 'retry'.
    --
    -- Most proposals are about a commitment, so the account comes from the
    -- first option's commitment_id when it has one. The regexp test keeps a
    -- cast from ever failing on an option that has something else there.
    return $frag$
      select 'assistant'::text                     as source,
             p.id::bigint                          as source_id,
             p.summary::text                       as summary,
             (case when cu.customer_no is not null then 'account' end)::text as subject_kind,
             cu.customer_no::text                  as subject_no,
             cu.name::text                         as subject_name,
             null::numeric(12, 2)                  as value,
             p.created_by::int                     as created_by_id,
             u.full_name::text                     as created_by,
             'assistant'::text                     as created_via,
             p.created_at                          as created_at,
             p.updated_at                          as row_version,
             p.created_by::int                     as reviewer_id,
             (case when p.status = 'approved' then 'retry' else 'waiting' end)::text as status
      from nl.assistant_proposals p
      join nl.users u on u.id = p.created_by
      left join lateral (
        select cm.customer_no, cs.name
        from nl.commitments cm
        join nl.customers cs on cs.customer_no = cm.customer_no
        where cm.id = (case
                         when (p.options -> 0 -> 'input' ->> 'commitment_id') ~ '^[0-9]+$'
                           then (p.options -> 0 -> 'input' ->> 'commitment_id')::bigint
                       end)
      ) cu on true
      where p.status = 'draft'
         or (p.status = 'approved' and p.error is not null)
    $frag$;

  elsif p_source in ('mail', 'purchase') then
    -- Neither of these tables exists on this branch. What follows is built
    -- from whatever columns the table turns out to have, so the queue picks
    -- it up when migration 0021 or 0022 is applied and
    -- nl.rebuild_agent_queue() is run again.
    if p_source = 'mail' then
      v_table   := nl.agent_queue_table(array['mail_drafts']);
      v_ref     := 'nl.customers';
      v_ref_key := 'customer_no';
      v_kind    := 'account';
    else
      v_table   := nl.agent_queue_table(array['purchase_requests', 'purchase_request_drafts']);
      v_ref     := 'nl.vendors';
      v_ref_key := 'vendor_no';
      v_kind    := 'vendor';
    end if;
    if v_table is null then
      return null;
    end if;
    -- The four columns the queue cannot do without. Without them this source
    -- stays out, and nl.agent_queue_sources() reports it as absent.
    if not (nl.agent_queue_has_column(v_table, 'id')
            and nl.agent_queue_has_column(v_table, 'status')
            and nl.agent_queue_has_column(v_table, 'created_at')
            and nl.agent_queue_has_column(v_table, 'updated_at')) then
      return null;
    end if;

    v_key := nl.agent_queue_column(v_table, v_ref_key, 'd', 'null::text');
    -- A one-line summary: the row's own subject or summary line if it has one.
    v_summary := case
      when nl.agent_queue_has_column(v_table, 'summary') then 'd.summary'
      when nl.agent_queue_has_column(v_table, 'subject') then 'd.subject'
      else format('%L', case when p_source = 'mail' then 'Mail draft waiting to be sent'
                             else 'Purchase request waiting for a person' end)
    end;
    v_value := case
      when nl.agent_queue_has_column(v_table, 'value') then 'd.value'
      when nl.agent_queue_has_column(v_table, 'total') then 'd.total'
      when nl.agent_queue_has_column(v_table, 'total_value') then 'd.total_value'
      else 'null'
    end;
    v_author   := nl.agent_queue_column(v_table, 'created_by', 'd', 'null');
    v_reviewer := nl.agent_queue_column(v_table, 'reviewer_id', 'd', 'null');

    return format($frag$
      select %1$L::text                                as source,
             d.id::bigint                              as source_id,
             (%2$s)::text                              as summary,
             (case when r.%3$I is not null then %4$L end)::text as subject_kind,
             r.%3$I::text                              as subject_no,
             r.name::text                              as subject_name,
             (%5$s)::numeric(12, 2)                    as value,
             (%6$s)::int                               as created_by_id,
             coalesce(u.full_name, %7$L)::text         as created_by,
             'agent'::text                             as created_via,
             d.created_at                              as created_at,
             d.updated_at                              as row_version,
             (%8$s)::int                               as reviewer_id,
             'waiting'::text                           as status
      from nl.%9$I d
      left join nl.users u on u.id = (%6$s)
      left join %10$s r on r.%3$I = (%11$s)
      where d.status in ('draft', 'waiting', 'pending', 'proposed')
    $frag$,
      p_source, v_summary, v_ref_key, v_kind, v_value, v_author,
      case when p_source = 'mail' then 'the order desk agent' else 'the procurement agent' end,
      v_reviewer, v_table, v_ref, v_key);
  end if;

  return null;
end $$;

-- Which sources are part of the queue as it stands. The page shows this so a
-- person is told that mail drafts are not in this database, rather than
-- wondering where they went.
create function nl.agent_queue_sources() returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_object_agg(s.name, nl.agent_queue_fragment(s.name) is not null)
  from unnest(array['rfq', 'assistant', 'mail', 'purchase']) as s(name)
$$;

-- Build (or rebuild) nl.agent_queue from the sources present. Run this again
-- after any migration that adds one. Only the owner of the schema can: it is
-- deliberately not granted to nl_app.
create function nl.rebuild_agent_queue() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_parts text[] := '{}';
  v_name  text;
  v_sql   text;
begin
  foreach v_name in array array['rfq', 'assistant', 'mail', 'purchase']
  loop
    v_sql := nl.agent_queue_fragment(v_name);
    if v_sql is not null then
      v_parts := v_parts || v_sql;
    end if;
  end loop;

  if cardinality(v_parts) = 0 then
    raise exception 'The workspace queue has no sources at all, which cannot be right.'
      using errcode = 'NL422';
  end if;

  -- security_invoker: each source's own row-level security decides who sees
  -- which rows, exactly as it does on that feature's own page.
  execute format(
    'create or replace view nl.agent_queue with (security_invoker = true) as %s',
    array_to_string(v_parts, ' union all '));
  -- create or replace keeps grants, but say it anyway so a rebuild after a
  -- drop is still usable.
  execute 'grant select on nl.agent_queue to nl_app';

  return nl.agent_queue_sources();
end $$;

select nl.rebuild_agent_queue();

comment on view nl.agent_queue is
  'Everything an agent has put in front of a person, in one shape, from the sources this database has. Rebuild it with nl.rebuild_agent_queue() after adding one (migration 0023).';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.queue_decisions enable row level security;

-- The workspace's history is the team's, like the audit log: everyone reads
-- it, everyone may only ever add a row in their own name, and nobody edits or
-- deletes one.
create policy queue_decisions_read on nl.queue_decisions for select to nl_app using (true);
create policy queue_decisions_insert on nl.queue_decisions for insert to nl_app
  with check (decided_by = (select nl.current_user_id()));

grant select, insert on nl.queue_decisions to nl_app;
grant select on nl.agent_queue to nl_app;
-- nl_readonly gets nothing here: a decision names the person who made it.

grant execute on function
  nl.record_queue_decision(text, bigint, text, text, text, text),
  nl.agent_queue_table(text[]),
  nl.agent_queue_has_column(text, text),
  nl.agent_queue_column(text, text, text, text),
  nl.agent_queue_fragment(text),
  nl.agent_queue_sources()
to nl_app;
-- nl.rebuild_agent_queue() is not granted: it is DDL, for the schema's owner.
