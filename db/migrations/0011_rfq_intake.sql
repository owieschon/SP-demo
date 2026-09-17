-- 0011 RFQ intake: a customer's emailed request for parts becomes a draft,
-- code checks the draft against the book, and a person approves it into a
-- quote and a quoted commitment.
--
-- The rules that shape this migration:
--   * The AI (or the rules extractor) only proposes. It never writes a quote.
--   * Validation is deterministic code. The app stores its result with the
--     draft; this migration re-checks the facts that decide what gets
--     written (items, customer, prices) at approval time.
--   * Nothing is created until a person approves. Approval takes the draft id,
--     its row version and a request id, nothing else: the lines, prices and
--     customer come from the stored draft and the catalog, never from the
--     request.
--   * A draft is private to the person who made it (and admins).
--
-- Depends on 0001 to 0009 only.

-- ---------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------

create table nl.rfq_drafts (
  id             bigint generated always as identity (start with 7001) primary key,
  created_by     int not null references nl.users (id),
  -- The email as pasted or uploaded, and what it was called (a file name or a sample).
  source_text    text not null check (length(source_text) between 1 and 100000),
  source_name    text not null default '',
  extractor      text not null check (extractor in ('rules', 'claude')),
  model          text,
  -- What the extractor proposed, untouched.
  draft          jsonb not null,
  -- What a person changed on top of it (chosen item, quantity, customer, date).
  overrides      jsonb not null default '{}',
  -- The latest validation of draft + overrides, written by the app's validator.
  validation     jsonb not null,
  -- How many fields still need a person. Copied out of validation for the list.
  needs_review   int not null default 0 check (needs_review >= 0),
  customer_no    text references nl.customers (customer_no),
  -- Token usage of the extraction call, when it was a live model call.
  usage          jsonb,
  status         text not null default 'draft' check (status in ('draft', 'approved', 'rejected')),
  decided_by     int references nl.users (id),
  decided_at     timestamptz,
  reject_reason  text not null default '',
  quote_id       bigint references nl.quotes (id) on delete set null,
  commitment_id  bigint references nl.commitments (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default nl.now_ms(),
  -- A decided draft names who decided and when; an open one names nobody.
  constraint rfq_drafts_decision_recorded check (
    (status = 'draft' and decided_by is null and decided_at is null)
    or (status <> 'draft' and decided_by is not null and decided_at is not null))
);

comment on table nl.rfq_drafts is
  'Emailed requests for quote, as extracted and validated. Nothing is created from one until a person approves it (migration 0011).';

create index rfq_drafts_created_by_idx on nl.rfq_drafts (created_by, created_at desc);
create index rfq_drafts_customer_idx on nl.rfq_drafts (customer_no);
create index rfq_drafts_decided_by_idx on nl.rfq_drafts (decided_by);
create index rfq_drafts_quote_idx on nl.rfq_drafts (quote_id);
create index rfq_drafts_commitment_idx on nl.rfq_drafts (commitment_id);

create trigger rfq_drafts_touch before update on nl.rfq_drafts
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Store a freshly extracted and validated draft.
create function nl.save_rfq_draft(
  p_source_text text,
  p_source_name text,
  p_extractor   text,
  p_model       text,
  p_draft       jsonb,
  p_validation  jsonb,
  p_usage       jsonb,
  p_request_id  text
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
  v_replay := nl.claim_request(p_request_id, 'save_rfq_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_source_text is null or length(trim(p_source_text)) = 0 then
    raise exception 'Paste or upload an email first.' using errcode = 'NL422';
  end if;
  if length(p_source_text) > 100000 then
    raise exception 'That email is longer than 100,000 characters.' using errcode = 'NL422';
  end if;
  if p_extractor is null or p_extractor not in ('rules', 'claude') then
    raise exception 'Unknown extractor %.', coalesce(p_extractor, 'empty') using errcode = 'NL422';
  end if;
  if jsonb_typeof(p_draft) is distinct from 'object' or jsonb_typeof(p_validation) is distinct from 'object' then
    raise exception 'A draft and its validation are JSON objects.' using errcode = 'NL422';
  end if;

  insert into nl.rfq_drafts (created_by, source_text, source_name, extractor, model, draft,
                             validation, needs_review, customer_no, usage)
  values (v_actor.id, p_source_text, left(coalesce(p_source_name, ''), 200), p_extractor, p_model, p_draft,
          p_validation, coalesce((p_validation ->> 'needs_review')::int, 0),
          p_validation #>> '{customer,customer_no}', p_usage)
  returning id, updated_at into v_id, v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'save_rfq_draft', 'rfq_draft', v_id::text, p_request_id,
          jsonb_build_object(
            'extractor', p_extractor,
            'model', p_model,
            'source_name', coalesce(p_source_name, ''),
            'lines', jsonb_array_length(coalesce(p_draft -> 'lines', '[]'::jsonb)),
            'needs_review', coalesce((p_validation ->> 'needs_review')::int, 0)));

  v_result := jsonb_build_object('draft_id', v_id, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- A person fixed something; the app re-validated draft + overrides and sends
-- both. Only an open draft of the caller's (or any, for an admin) changes.
create function nl.revise_rfq_draft(
  p_draft_id            bigint,
  p_overrides           jsonb,
  p_validation          jsonb,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_draft  nl.rfq_drafts;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'revise_rfq_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if jsonb_typeof(p_overrides) is distinct from 'object' or jsonb_typeof(p_validation) is distinct from 'object' then
    raise exception 'Changes and their validation are JSON objects.' using errcode = 'NL422';
  end if;

  -- Row-level security hides other people's drafts, so "not found" covers
  -- both a wrong id and someone else's draft.
  select * into v_draft from nl.rfq_drafts where id = p_draft_id;
  if not found then
    raise exception 'Draft R-% does not exist.', p_draft_id using errcode = 'NL404';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'Draft R-% is already %; it cannot change.', p_draft_id, v_draft.status
      using errcode = 'NL422';
  end if;

  update nl.rfq_drafts
     set overrides    = p_overrides,
         validation   = p_validation,
         needs_review = coalesce((p_validation ->> 'needs_review')::int, 0),
         customer_no  = p_validation #>> '{customer,customer_no}'
   where id = p_draft_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_at;
  if not found then
    raise exception 'Draft R-% changed since it was loaded. Reload it and try again.', p_draft_id
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'revise_rfq_draft', 'rfq_draft', p_draft_id::text, p_request_id,
          jsonb_build_object(
            'from', v_draft.overrides,
            'to', p_overrides,
            'needs_review', coalesce((p_validation ->> 'needs_review')::int, 0)));

  v_result := jsonb_build_object('draft_id', p_draft_id, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- A person says no. Final: a rejected draft never comes back.
create function nl.reject_rfq_draft(
  p_draft_id            bigint,
  p_reason              text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_draft  nl.rfq_drafts;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'reject_rfq_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_draft from nl.rfq_drafts where id = p_draft_id;
  if not found then
    raise exception 'Draft R-% does not exist.', p_draft_id using errcode = 'NL404';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'Draft R-% is already %.', p_draft_id, v_draft.status using errcode = 'NL422';
  end if;

  update nl.rfq_drafts
     set status        = 'rejected',
         decided_by    = v_actor.id,
         decided_at    = now(),
         reject_reason = left(coalesce(p_reason, ''), 500)
   where id = p_draft_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_at;
  if not found then
    raise exception 'Draft R-% changed since it was loaded. Reload it and decide again.', p_draft_id
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'reject_rfq_draft', 'rfq_draft', p_draft_id::text, p_request_id,
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)));

  v_result := jsonb_build_object('draft_id', p_draft_id, 'status', 'rejected', 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- A person says yes. In one transaction:
--   a quote (source 'rfq', valid 30 days) with the draft's lines at today's
--   prices for the customer, and a commitment in "quoted" status (owned by
--   the approver, window today to the needed-by date or 90 days, value = the
--   quote total, confidence 50) that the quote is linked to.
-- Everything written comes from the stored draft and the catalog. Prices are
-- worked out again here from list price and the customer's price group; if
-- they no longer match what the person was shown, nothing is written.
create function nl.approve_rfq_draft(
  p_draft_id            bigint,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay        jsonb;
  v_actor         nl.users;
  v_draft         nl.rfq_drafts;
  v_validation    jsonb;
  v_customer      nl.customers;
  v_discount      numeric;
  v_contact_id    bigint;
  v_needed_by     date;
  v_today         date := nl.today();
  v_line          jsonb;
  v_item          nl.items;
  v_qty           int;
  v_price         numeric(12, 2);
  v_shown         numeric(12, 2);
  v_total         numeric(12, 2) := 0;
  v_items         text[] := '{}';
  v_qtys          int[] := '{}';
  v_prices        numeric(12, 2)[] := '{}';
  v_quote_id      bigint;
  v_commitment_id bigint;
  v_at            timestamptz;
  v_result        jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'approve_rfq_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  -- Lock the draft row so two approvals cannot interleave.
  select * into v_draft from nl.rfq_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'Draft R-% does not exist.', p_draft_id using errcode = 'NL404';
  end if;
  -- The select policy already limits this to the creator or an admin; the
  -- check here makes the rule explicit.
  if v_draft.created_by <> v_actor.id and v_actor.role <> 'admin' then
    raise exception 'Only the person who made draft R-% or an admin can approve it.', p_draft_id
      using errcode = 'NL403';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'Draft R-% is already %; it cannot be approved.', p_draft_id, v_draft.status
      using errcode = 'NL422';
  end if;
  if v_draft.updated_at <> p_expected_updated_at then
    raise exception 'Draft R-% changed since it was loaded. Reload it and decide again.', p_draft_id
      using errcode = 'NL409';
  end if;

  v_validation := v_draft.validation;

  -- Field rule: nothing may still need a person. Checked on the counter and
  -- on every status in the stored validation.
  if v_draft.needs_review > 0
     or coalesce((v_validation ->> 'needs_review')::int, 1) > 0
     or jsonb_path_exists(v_validation, 'lax $.** ? (@.status == "needs_review")') then
    raise exception 'Draft R-% still has fields that need review.', p_draft_id using errcode = 'NL422';
  end if;

  -- The customer: must exist, be open, and not be blocked.
  select * into v_customer from nl.customers where customer_no = v_validation #>> '{customer,customer_no}';
  if not found then
    raise exception 'Draft R-% has no customer.', p_draft_id using errcode = 'NL422';
  end if;
  if v_customer.blocked or v_customer.closed then
    raise exception 'Customer % is blocked or closed.', v_customer.customer_no using errcode = 'NL422';
  end if;
  select discount into v_discount from nl.price_groups where code = v_customer.price_group;

  -- The buyer, only if the contact really belongs to this customer.
  select id into v_contact_id
  from nl.contacts
  where id = (v_validation #>> '{customer,contact_id}')::bigint
    and customer_no = v_customer.customer_no;

  v_needed_by := (v_validation #>> '{needed_by,date}')::date;
  if v_needed_by is not null and v_needed_by < v_today then
    raise exception 'The needed-by date % has passed.', v_needed_by using errcode = 'NL422';
  end if;

  -- First pass: check every line against the catalog and price it. Nothing
  -- is written until every line has passed.
  for v_line in
    select value from jsonb_array_elements(coalesce(v_validation -> 'lines', '[]'::jsonb))
  loop
    -- A line a person removed is not quoted.
    continue when coalesce((v_line ->> 'removed')::boolean, false);

    select * into v_item from nl.items where item_no = v_line ->> 'item_no';
    if not found then
      raise exception 'Item % is not in the catalog.', coalesce(v_line ->> 'item_no', '(none)')
        using errcode = 'NL422';
    end if;
    if v_item.blocked then
      raise exception 'Item % is blocked.', v_item.item_no using errcode = 'NL422';
    end if;

    v_qty := (v_line ->> 'quantity')::int;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Item % needs a quantity above zero.', v_item.item_no using errcode = 'NL422';
    end if;

    -- Today's price for this customer, and the price the person was shown.
    v_price := round(v_item.list_price * (1 - coalesce(v_discount, 0)), 2);
    v_shown := (v_line ->> 'unit_price')::numeric;
    if v_shown is distinct from v_price then
      raise exception 'The price of % changed from % to % since the draft was checked. Reload it and decide again.',
        v_item.item_no, v_shown, v_price
        using errcode = 'NL409';
    end if;

    v_items  := v_items || v_item.item_no;
    v_qtys   := v_qtys || v_qty;
    v_prices := v_prices || v_price;
    v_total  := v_total + v_qty * v_price;
  end loop;

  if cardinality(v_items) = 0 then
    raise exception 'Draft R-% has no lines to quote.', p_draft_id using errcode = 'NL422';
  end if;
  if v_total <= 0 then
    raise exception 'The quote for draft R-% totals nothing.', p_draft_id using errcode = 'NL422';
  end if;

  -- Second pass: write. The commitment comes first so the quote can be
  -- created already linked to it.
  insert into nl.commitments (title, customer_no, buyer_contact_id, owner_id, committed_value,
                              starts_on, ends_on, confidence, notes, created_by)
  values (
    format('Emailed request R-%s', p_draft_id),
    v_customer.customer_no,
    v_contact_id,
    v_actor.id,
    v_total,
    v_today,
    coalesce(v_needed_by, v_today + 90),
    50,
    format('Created from emailed request R-%s.', p_draft_id),
    v_actor.id)
  returning id into v_commitment_id;

  insert into nl.quotes (customer_no, contact_id, commitment_id, quoted_on, valid_until, source, created_by)
  values (v_customer.customer_no, v_contact_id, v_commitment_id, v_today, v_today + 30, 'rfq', v_actor.id)
  returning id into v_quote_id;

  insert into nl.quote_lines (quote_id, line_no, item_no, quantity, unit_price)
  select v_quote_id, l.line_no, l.item_no, l.quantity, l.unit_price
  from unnest(v_items, v_qtys, v_prices) with ordinality as l(item_no, quantity, unit_price, line_no);

  -- One scope row per part, with the total quantity asked for.
  insert into nl.commitment_items (commitment_id, item_no, quantity)
  select v_commitment_id, l.item_no, sum(l.quantity)
  from unnest(v_items, v_qtys) as l(item_no, quantity)
  group by l.item_no;

  update nl.rfq_drafts
     set status        = 'approved',
         decided_by    = v_actor.id,
         decided_at    = now(),
         quote_id      = v_quote_id,
         commitment_id = v_commitment_id
   where id = p_draft_id
  returning updated_at into v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'approve_rfq_draft', 'rfq_draft', p_draft_id::text, p_request_id,
          jsonb_build_object(
            'quote_id', v_quote_id,
            'commitment_id', v_commitment_id,
            'customer_no', v_customer.customer_no,
            'lines', cardinality(v_items),
            'total', v_total,
            'needed_by', v_needed_by));

  v_result := jsonb_build_object(
    'draft_id', p_draft_id,
    'status', 'approved',
    'quote_id', v_quote_id,
    'commitment_id', v_commitment_id,
    'total', v_total,
    'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.rfq_drafts enable row level security;

-- A draft holds a customer's email, so only its creator (and admins) see it.
create policy rfq_drafts_read on nl.rfq_drafts for select to nl_app
  using (created_by = (select nl.current_user_id()) or (select nl.is_admin()));
create policy rfq_drafts_insert on nl.rfq_drafts for insert to nl_app
  with check (created_by = (select nl.current_user_id()) and status = 'draft');
create policy rfq_drafts_update on nl.rfq_drafts for update to nl_app
  using (created_by = (select nl.current_user_id()) or (select nl.is_admin()))
  with check (created_by = (select nl.current_user_id()) or (select nl.is_admin()));

grant select, insert on nl.rfq_drafts to nl_app;
grant update (overrides, validation, needs_review, customer_no, status, decided_by, decided_at,
              reject_reason, quote_id, commitment_id, updated_at) on nl.rfq_drafts to nl_app;
-- nl_readonly gets nothing here: drafts are customers' emails.

grant execute on function
  nl.save_rfq_draft(text, text, text, text, jsonb, jsonb, jsonb, text),
  nl.revise_rfq_draft(bigint, jsonb, jsonb, timestamptz, text),
  nl.reject_rfq_draft(bigint, text, timestamptz, text),
  nl.approve_rfq_draft(bigint, timestamptz, text)
to nl_app;
