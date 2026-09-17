-- 0021 The order desk agent: mailboxes, the mail that arrives in them, the
-- runs the agent makes, and the outbox queue a person approves.
--
-- The rules that shape this migration:
--   * Mail is data, never instruction. A message is stored exactly as it
--     arrived and nothing in it can reach a write function.
--   * The agent reads the whole book but only ever WRITES a draft reply into
--     a queue. It cannot send. Only nl.mark_mail_sent moves a draft to
--     'sent', and only after the send call has come back with a provider id.
--   * A draft is approved by the mailbox's reviewer or an admin, nobody else.
--     Approving with a changed subject or body stores the change and marks
--     the draft edited, so the queue shows what a person rewrote.
--   * The same message is never worked twice: a SHA-256 of its normalized
--     content is unique, so a re-poll, a webhook and a retry all land on the
--     row that already exists.
--   * Every run is one row with its lookups, rounds, tokens and error, so
--     "why did it say that" has an answer that does not depend on a log file.
--   * Every function here is security definer, and no role is granted INSERT,
--     UPDATE or DELETE on any of these tables. There is no way to change a
--     message, a draft or a run except through a function that checks the
--     rules first, which is what makes "only nl.mark_mail_sent can say sent"
--     a fact about the schema rather than a habit of the code above it. Each
--     one therefore does its own permission check (nl.require_active_user,
--     and nl.may_review_mailbox where a decision is being made).
--
-- Quantity breaks live here too. nl.price_for (migration 0018) answers "what
-- does this account pay for this part"; the order desk also has to answer
-- "what does it pay for twelve of them", which is a different question with a
-- published answer, so it gets a table and one function on top of 0018
-- instead of arithmetic in the app.
--
-- Depends on 0001 to 0019. Nothing here is granted to nl_readonly: every one
-- of these tables names a person.

-- ---------------------------------------------------------------------------
-- Caps
-- ---------------------------------------------------------------------------

-- The most agent runs one mailbox makes in one day. A wedged poll loop, or a
-- mail loop between two robots, stops here instead of running all night.
create function nl.mail_daily_cap() returns int
language sql immutable
set search_path = ''
as $$ select 60 $$;

-- The most lookups one run may make. The run records every one of them.
create function nl.mail_lookup_cap() returns int
language sql immutable
set search_path = ''
as $$ select 8 $$;

-- ---------------------------------------------------------------------------
-- Mailboxes
-- ---------------------------------------------------------------------------

create table nl.mailboxes (
  id            int primary key,
  address       text not null unique,
  kind          text not null check (kind in ('orders', 'procurement')),
  label         text not null,
  -- One sentence the drafts sign off with, and the page shows.
  purpose       text not null default '',
  -- Who approves what this desk drafts. An admin may approve as well.
  reviewer_id   int not null references nl.users (id),
  -- The intents this desk handles. Anything else becomes 'other'.
  intents       text[] not null default '{}',
  -- The furthest a draft from this desk may go. Checked in code
  -- (app/src/lib/server/desk/policy.ts) against every fact a draft cites.
  disclosure    text not null check (disclosure in ('customer', 'vendor', 'internal')),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default nl.now_ms()
);

comment on table nl.mailboxes is
  'The desks the agent answers for: an address, who reviews its drafts, and how far what it writes may go (migration 0021).';

create index mailboxes_reviewer_idx on nl.mailboxes (reviewer_id);

create trigger mailboxes_touch before update on nl.mailboxes
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Mail that arrived
-- ---------------------------------------------------------------------------

create table nl.mail_messages (
  id                bigint generated always as identity (start with 5001) primary key,
  mailbox_id        int not null references nl.mailboxes (id),
  -- Only inbound mail is stored here. What we send lives on the draft that
  -- was approved, which is the thing a person actually signed off.
  direction         text not null default 'in' check (direction = 'in'),
  -- What the mail provider calls this message and its thread. Null in the
  -- scripted demo, where the messages never went through a provider.
  provider_message_id text,
  provider_thread_id  text,
  from_address      text not null,
  from_name         text not null default '',
  to_addresses      text[] not null default '{}',
  cc_addresses      text[] not null default '{}',
  subject           text not null default '',
  body_text         text not null,
  -- The same body with quoted history and signature blocks taken off, which
  -- is what the classifier and the extractor read.
  body_stripped     text not null default '',
  received_at       timestamptz not null,
  -- SHA-256 of the normalized content (see nl.mail_content_key). Unique, so
  -- the same message can never be worked twice however it arrives.
  content_sha256    text not null unique check (content_sha256 ~ '^[0-9a-f]{64}$'),
  -- Who the agent decided it is from. A customer, or a vendor on the
  -- procurement desk, or neither.
  customer_no       text references nl.customers (customer_no),
  vendor_no         text references nl.vendors (vendor_no),
  contact_id        bigint references nl.contacts (id),
  match_reason      text not null default '',
  intent            text check (intent in ('rfq', 'purchase_order', 'price_question',
                                           'stock_question', 'order_status', 'other')),
  intent_confidence numeric(4, 3) check (intent_confidence between 0 and 1),
  status            text not null default 'new'
                      check (status in ('new', 'working', 'drafted', 'needs_person', 'ignored')),
  -- One or two sentences from the agent: what this message asks for.
  summary           text not null default '',
  -- The RFQ draft this message became, when the request was for a quote, so
  -- approving the quote and approving the reply are one flow.
  rfq_draft_id      bigint references nl.rfq_drafts (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default nl.now_ms(),
  constraint mail_messages_matched_one_side check (customer_no is null or vendor_no is null)
);

comment on table nl.mail_messages is
  'Inbound mail, stored as it arrived. The body is data: nothing in it reaches a write (migration 0021).';

create index mail_messages_mailbox_idx on nl.mail_messages (mailbox_id, received_at desc);
create index mail_messages_status_idx on nl.mail_messages (status, received_at desc);
create index mail_messages_customer_idx on nl.mail_messages (customer_no);
create index mail_messages_vendor_idx on nl.mail_messages (vendor_no);
create index mail_messages_contact_idx on nl.mail_messages (contact_id);
create index mail_messages_thread_idx on nl.mail_messages (provider_thread_id);
create index mail_messages_rfq_draft_idx on nl.mail_messages (rfq_draft_id);

create trigger mail_messages_touch before update on nl.mail_messages
  for each row execute function nl.touch_updated_at();

-- Attachments. The documents work (migration 0020) owns parsed attachments;
-- when its table is there, document_attachment_id points at the parsed copy.
-- Until then the bytes are kept here, which is all the order desk needs to
-- show a person what came in. No foreign key: the other table may not exist.
create table nl.mail_attachments (
  id                     bigint generated always as identity primary key,
  message_id             bigint not null references nl.mail_messages (id) on delete cascade,
  provider_attachment_id text,
  file_name              text not null,
  media_type             text not null default 'application/octet-stream',
  size_bytes             int not null check (size_bytes >= 0),
  bytes                  bytea,
  document_attachment_id bigint,
  created_at             timestamptz not null default now()
);

create index mail_attachments_message_idx on nl.mail_attachments (message_id);

-- ---------------------------------------------------------------------------
-- The outbox: what the agent drafted, waiting for a person
-- ---------------------------------------------------------------------------

create table nl.mail_drafts (
  id                  bigint generated always as identity (start with 6001) primary key,
  mailbox_id          int not null references nl.mailboxes (id),
  in_reply_to_id      bigint references nl.mail_messages (id) on delete set null,
  provider_thread_id  text,
  to_addresses        text[] not null check (cardinality(to_addresses) between 1 and 10),
  cc_addresses        text[] not null default '{}',
  subject             text not null check (length(subject) between 1 and 300),
  body                text not null check (length(body) between 1 and 20000),
  intent              text not null check (intent in ('rfq', 'purchase_order', 'price_question',
                                                      'stock_question', 'order_status', 'other')),
  -- Every fact the body rests on, with the ids it came from:
  -- [{"kind": "own_price", "subject": "10012", "ids": {...}, "text": "..."}]
  -- The disclosure check runs over exactly this list before the row is written.
  facts               jsonb not null default '[]'
                        check (jsonb_typeof(facts) = 'array'),
  -- [{"kind": "quote_pdf", "name": "Quote 448123.pdf", "quote_id": 448123}]
  attachments         jsonb not null default '[]'
                        check (jsonb_typeof(attachments) = 'array'),
  -- Why the agent could not finish, when it could not: a policy refusal, a
  -- fact it could not verify, or a question only a person can answer.
  blocked_reason      text not null default '',
  status              text not null default 'draft'
                        check (status in ('draft', 'approved', 'sent', 'failed', 'rejected')),
  -- True when the reviewer changed the subject or the body before approving.
  edited              boolean not null default false,
  reviewed_by         int references nl.users (id),
  reviewed_at         timestamptz,
  reject_reason       text not null default '',
  -- The provider's id for what actually went out, and what it said if it did not.
  provider_message_id text,
  sent_at             timestamptz,
  send_attempts       int not null default 0 check (send_attempts >= 0),
  error               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default nl.now_ms(),
  -- A reviewed draft names who reviewed it and when.
  constraint mail_drafts_review_recorded check (
    (status = 'draft' and reviewed_by is null and reviewed_at is null)
    or (status <> 'draft' and reviewed_by is not null and reviewed_at is not null)),
  -- Only a sent draft carries a provider id and a sent time, and it must
  -- carry both. This is the constraint that makes "nothing is sent until you
  -- approve" a property of the schema and not of the code above it.
  constraint mail_drafts_sent_is_recorded check (
    (status = 'sent' and provider_message_id is not null and sent_at is not null)
    or (status <> 'sent' and sent_at is null))
);

comment on table nl.mail_drafts is
  'The review queue. The agent writes rows here and can do nothing else; a person approves, and only then is anything sent (migration 0021).';

create index mail_drafts_mailbox_status_idx on nl.mail_drafts (mailbox_id, status, created_at desc);
create index mail_drafts_reply_idx on nl.mail_drafts (in_reply_to_id);
create index mail_drafts_reviewed_by_idx on nl.mail_drafts (reviewed_by);

create trigger mail_drafts_touch before update on nl.mail_drafts
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Runs: one row per message the agent worked
-- ---------------------------------------------------------------------------

create table nl.mail_runs (
  id           bigint generated always as identity primary key,
  mailbox_id   int not null references nl.mailboxes (id),
  message_id   bigint not null references nl.mail_messages (id) on delete cascade,
  -- Which model decided the intent: the scripted demo classifier, or the real one.
  mode         text not null check (mode in ('mock', 'live')),
  model        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  -- Every lookup the run made, in order:
  -- [{"name": "price_for", "input": {...}, "rows": 1, "ms": 4}]
  lookups      jsonb not null default '[]' check (jsonb_typeof(lookups) = 'array'),
  lookup_count int not null default 0 check (lookup_count >= 0),
  rounds       int not null default 0 check (rounds >= 0),
  input_tokens  int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  outcome      text not null default 'running'
                 check (outcome in ('running', 'drafted', 'needs_person', 'ignored', 'failed')),
  draft_id     bigint references nl.mail_drafts (id) on delete set null,
  error        text
);

comment on table nl.mail_runs is
  'One agent run per message: what it looked up, how many rounds, what it cost and what came out (migration 0021).';

create index mail_runs_message_idx on nl.mail_runs (message_id, id desc);
create index mail_runs_mailbox_idx on nl.mail_runs (mailbox_id, started_at desc);
create index mail_runs_draft_idx on nl.mail_runs (draft_id);

-- Runs per mailbox per day, so the cap survives a restart.
create table nl.mail_counters (
  on_day     date not null,
  mailbox_id int not null references nl.mailboxes (id),
  runs       int not null default 0 check (runs >= 0),
  primary key (on_day, mailbox_id)
);

-- ---------------------------------------------------------------------------
-- Quantity breaks
-- ---------------------------------------------------------------------------

-- A published break: buy min_quantity or more of a part and take extra off
-- the price the account would otherwise pay. It stacks on the tier discount,
-- which is how this trade quotes: "12 or more is $x each".
create table nl.quantity_breaks (
  item_no        text not null references nl.items (item_no) on delete cascade,
  min_quantity   int not null check (min_quantity > 1),
  extra_discount numeric(5, 4) not null check (extra_discount > 0 and extra_discount < 0.5),
  note           text not null default '',
  primary key (item_no, min_quantity)
);

comment on table nl.quantity_breaks is
  'Published quantity breaks. They stack on the price group discount and never override an agreed price (migration 0021).';

-- The price this account pays for this many of this part, and which rule and
-- which break said so. Everything nl.price_for returns, plus:
--
--   quantity        what was asked for
--   break_quantity  the break that applied, null when none did
--   break_discount  how much extra it took off
--   unit_price      the price after the break (= price when none applied)
--   extended        quantity x unit_price
--   next_quantity   the next break up, null when there is none
--   next_price      what each would cost at that quantity
--
-- An agreed price is the agreed price: a break never cuts under it, because
-- the agreement is the thing both sides signed. Breaks apply to the tier
-- price, to last paid and to list.
--
-- below_floor stays a flag, not a veto, exactly as in nl.price_for: a screen
-- says the price is a bad idea, a person decides.
create function nl.desk_price_for(
  p_customer_no text,
  p_item_no     text,
  p_quantity    int,
  p_on_date     date
)
returns table (
  customer_no    text,
  item_no        text,
  on_date        date,
  quantity       int,
  price          numeric,
  rule           text,
  detail         text,
  break_quantity int,
  break_discount numeric,
  break_note     text,
  unit_price     numeric,
  extended       numeric,
  next_quantity  int,
  next_price     numeric,
  list_price     numeric,
  discount       numeric,
  unit_cost      numeric,
  floor_price    numeric,
  margin_pct     numeric,
  below_floor    boolean
)
language sql stable
set search_path = ''
as $$
  with asked as (
    select greatest(coalesce(p_quantity, 1), 1) as quantity
  ),
  base as (
    select * from nl.price_for(p_customer_no, p_item_no, p_on_date)
  ),
  -- The deepest break this quantity reaches. Never applied to an agreement.
  applied as (
    select qb.min_quantity, qb.extra_discount, qb.note
    from nl.quantity_breaks qb, asked a, base b
    where qb.item_no = b.item_no
      and b.rule <> 'agreement'
      and qb.min_quantity <= a.quantity
    order by qb.extra_discount desc
    limit 1
  ),
  -- The next break up, so a reply can say what buying more would cost.
  upcoming as (
    select qb.min_quantity, qb.extra_discount
    from nl.quantity_breaks qb, asked a, base b
    where qb.item_no = b.item_no
      and b.rule <> 'agreement'
      and qb.min_quantity > a.quantity
    order by qb.min_quantity
    limit 1
  )
  select
    b.customer_no,
    b.item_no,
    b.on_date,
    a.quantity,
    b.price,
    b.rule,
    b.detail,
    ap.min_quantity,
    ap.extra_discount,
    coalesce(ap.note, ''),
    p.unit_price,
    round(a.quantity * p.unit_price, 2) as extended,
    up.min_quantity,
    case when up.extra_discount is not null
         then round(b.price * (1 - up.extra_discount), 2) end as next_price,
    b.list_price,
    b.discount,
    b.unit_cost,
    b.floor_price,
    case when p.unit_price > 0 then round((p.unit_price - b.unit_cost) / p.unit_price, 4) end,
    p.unit_price < b.floor_price
  from base b
  cross join asked a
  left join applied ap on true
  left join upcoming up on true
  cross join lateral (
    select round(b.price * (1 - coalesce(ap.extra_discount, 0)), 2) as unit_price
  ) p
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- The identity of a message: sender, subject and body, normalized. Two copies
-- of the same mail hash the same however the provider numbered them, so a
-- re-poll after a webhook has already delivered it writes nothing.
create function nl.mail_content_key(
  p_mailbox_id  int,
  p_from        text,
  p_subject     text,
  p_body        text,
  p_received_at timestamptz
) returns text
language sql immutable
set search_path = ''
as $$
  select encode(
    sha256(convert_to(
      p_mailbox_id::text || e'\n'
      || lower(btrim(coalesce(p_from, ''))) || e'\n'
      || lower(btrim(coalesce(p_subject, ''))) || e'\n'
      || btrim(regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g')) || e'\n'
      || to_char(coalesce(p_received_at, '2000-01-01'::timestamptz) at time zone 'UTC',
                 'YYYY-MM-DD"T"HH24:MI'),
      'UTF8')),
    'hex')
$$;

-- Store one inbound message. Idempotent on the content key: a message that is
-- already here comes back with duplicate = true and nothing is written, so a
-- poll, a webhook and a retry can all deliver the same mail.
--
-- Security definer: no role has INSERT on nl.mail_messages, so a poll can only
-- get mail in through this function, which decides the shape of the row.
create function nl.record_mail_message(
  p_mailbox_id  int,
  p_provider_message_id text,
  p_provider_thread_id  text,
  p_from        text,
  p_from_name   text,
  p_to          text[],
  p_cc          text[],
  p_subject     text,
  p_body        text,
  p_body_stripped text,
  p_received_at timestamptz,
  p_attachments jsonb,
  p_request_id  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_mailbox nl.mailboxes;
  v_key     text;
  v_id      bigint;
  v_att     jsonb;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_mail_message');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_mailbox from nl.mailboxes where id = p_mailbox_id;
  if not found then
    raise exception 'Mailbox % does not exist.', coalesce(p_mailbox_id::text, 'empty') using errcode = 'NL404';
  end if;
  if not v_mailbox.active then
    raise exception 'Mailbox % is switched off.', v_mailbox.address using errcode = 'NL422';
  end if;
  if p_from is null or btrim(p_from) = '' then
    raise exception 'A message needs a sender.' using errcode = 'NL422';
  end if;
  if p_body is null or length(p_body) = 0 or length(p_body) > 100000 then
    raise exception 'A message body is 1 to 100,000 characters.' using errcode = 'NL422';
  end if;
  if p_attachments is not null and jsonb_typeof(p_attachments) is distinct from 'array' then
    raise exception 'Attachments are a JSON array.' using errcode = 'NL422';
  end if;

  v_key := nl.mail_content_key(p_mailbox_id, p_from, p_subject, p_body, p_received_at);

  select id into v_id from nl.mail_messages where content_sha256 = v_key;
  if found then
    v_result := jsonb_build_object('message_id', v_id, 'duplicate', true);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  insert into nl.mail_messages (
    mailbox_id, provider_message_id, provider_thread_id, from_address, from_name,
    to_addresses, cc_addresses, subject, body_text, body_stripped, received_at, content_sha256)
  values (
    p_mailbox_id, p_provider_message_id, p_provider_thread_id,
    lower(btrim(p_from)), left(coalesce(p_from_name, ''), 200),
    coalesce(p_to, array[v_mailbox.address]), coalesce(p_cc, '{}'),
    left(coalesce(p_subject, ''), 300), p_body,
    coalesce(nullif(btrim(coalesce(p_body_stripped, '')), ''), p_body),
    coalesce(p_received_at, now()), v_key)
  returning id into v_id;

  for v_att in select value from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb))
  loop
    insert into nl.mail_attachments (message_id, provider_attachment_id, file_name, media_type,
                                     size_bytes, bytes, document_attachment_id)
    values (v_id,
            v_att ->> 'provider_attachment_id',
            left(coalesce(v_att ->> 'file_name', 'attachment'), 200),
            coalesce(v_att ->> 'media_type', 'application/octet-stream'),
            greatest(coalesce((v_att ->> 'size_bytes')::int, 0), 0),
            case when v_att ? 'base64' then decode(v_att ->> 'base64', 'base64') end,
            (v_att ->> 'document_attachment_id')::bigint);
  end loop;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'record_mail_message', 'mail_message', v_id::text, p_request_id,
          jsonb_build_object('mailbox', v_mailbox.address, 'from', lower(btrim(p_from)),
                             'subject', left(coalesce(p_subject, ''), 300),
                             'attachments', jsonb_array_length(coalesce(p_attachments, '[]'::jsonb))));

  v_result := jsonb_build_object('message_id', v_id, 'duplicate', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Start a run on a message, and claim one of the mailbox's runs for today.
-- Raises NL429 when the day is used up, so a wedged loop stops here.
create function nl.start_mail_run(
  p_message_id bigint,
  p_mode       text,
  p_model      text,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_message nl.mail_messages;
  v_runs    int;
  v_cap     int := nl.mail_daily_cap();
  v_id      bigint;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'start_mail_run');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_mode is null or p_mode not in ('mock', 'live') then
    raise exception 'A run is in mock or live mode, not %.', coalesce(p_mode, 'empty') using errcode = 'NL422';
  end if;

  select * into v_message from nl.mail_messages where id = p_message_id for update;
  if not found then
    raise exception 'Message % does not exist.', coalesce(p_message_id::text, 'empty') using errcode = 'NL404';
  end if;

  -- The insert locks this mailbox's counter row for the rest of the
  -- transaction, so two polls at once cannot both slip past the cap.
  insert into nl.mail_counters (on_day, mailbox_id, runs)
  values (nl.today(), v_message.mailbox_id, 1)
  on conflict (on_day, mailbox_id) do update set runs = nl.mail_counters.runs + 1
  returning runs into v_runs;

  if v_runs > v_cap then
    raise exception 'This desk has worked % messages today, which is its daily limit. It resets tomorrow.', v_cap
      using errcode = 'NL429';
  end if;

  insert into nl.mail_runs (mailbox_id, message_id, mode, model)
  values (v_message.mailbox_id, p_message_id, p_mode, p_model)
  returning id into v_id;

  update nl.mail_messages set status = 'working' where id = p_message_id and status = 'new';

  v_result := jsonb_build_object('run_id', v_id, 'runs_today', v_runs, 'cap', v_cap);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Close a run and write everything it decided onto the message in the same
-- transaction: who it is from, what it is, and what the agent made of it.
create function nl.finish_mail_run(
  p_run_id        bigint,
  p_outcome       text,
  p_intent        text,
  p_confidence    numeric,
  p_summary       text,
  p_customer_no   text,
  p_vendor_no     text,
  p_contact_id    bigint,
  p_match_reason  text,
  p_message_status text,
  p_lookups       jsonb,
  p_rounds        int,
  p_input_tokens  int,
  p_output_tokens int,
  p_draft_id      bigint,
  p_rfq_draft_id  bigint,
  p_error         text,
  p_request_id    text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_run    nl.mail_runs;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'finish_mail_run');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_run from nl.mail_runs where id = p_run_id for update;
  if not found then
    raise exception 'Run % does not exist.', coalesce(p_run_id::text, 'empty') using errcode = 'NL404';
  end if;
  if v_run.finished_at is not null then
    raise exception 'Run % has already finished.', p_run_id using errcode = 'NL422';
  end if;
  if p_outcome is null or p_outcome not in ('drafted', 'needs_person', 'ignored', 'failed') then
    raise exception 'A run ends drafted, needs_person, ignored or failed, not %.',
      coalesce(p_outcome, 'empty') using errcode = 'NL422';
  end if;
  if p_message_status is null
     or p_message_status not in ('new', 'working', 'drafted', 'needs_person', 'ignored') then
    raise exception 'Unknown message status %.', coalesce(p_message_status, 'empty') using errcode = 'NL422';
  end if;
  if p_lookups is not null and jsonb_typeof(p_lookups) is distinct from 'array' then
    raise exception 'Lookups are a JSON array.' using errcode = 'NL422';
  end if;
  if p_customer_no is not null and p_vendor_no is not null then
    raise exception 'A message is from a customer or a vendor, not both.' using errcode = 'NL422';
  end if;
  -- A contact must really belong to the account the run matched.
  if p_contact_id is not null and not exists (
    select 1 from nl.contacts ct
    where ct.id = p_contact_id and ct.customer_no = p_customer_no) then
    raise exception 'Contact % is not at account %.', p_contact_id,
      coalesce(p_customer_no, 'none') using errcode = 'NL422';
  end if;

  update nl.mail_runs
     set finished_at   = now(),
         outcome       = p_outcome,
         lookups       = coalesce(p_lookups, '[]'::jsonb),
         lookup_count  = jsonb_array_length(coalesce(p_lookups, '[]'::jsonb)),
         rounds        = greatest(coalesce(p_rounds, 0), 0),
         input_tokens  = greatest(coalesce(p_input_tokens, 0), 0),
         output_tokens = greatest(coalesce(p_output_tokens, 0), 0),
         draft_id      = p_draft_id,
         error         = left(p_error, 1000)
   where id = p_run_id;

  update nl.mail_messages
     set status            = p_message_status,
         intent            = p_intent,
         intent_confidence = p_confidence,
         summary           = left(coalesce(p_summary, ''), 1000),
         customer_no       = p_customer_no,
         vendor_no         = p_vendor_no,
         contact_id        = p_contact_id,
         match_reason      = left(coalesce(p_match_reason, ''), 500),
         rfq_draft_id      = coalesce(p_rfq_draft_id, rfq_draft_id)
   where id = v_run.message_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'finish_mail_run', 'mail_run', p_run_id::text, p_request_id,
          jsonb_build_object('message_id', v_run.message_id, 'outcome', p_outcome, 'intent', p_intent,
                             'confidence', p_confidence, 'draft_id', p_draft_id,
                             'lookups', jsonb_array_length(coalesce(p_lookups, '[]'::jsonb)),
                             'customer_no', p_customer_no, 'vendor_no', p_vendor_no));

  v_result := jsonb_build_object('run_id', p_run_id, 'outcome', p_outcome, 'message_id', v_run.message_id);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- The agent's one write: put a reply in the queue. It cannot approve it and
-- it cannot send it. Security definer, because nothing is granted INSERT on
-- nl.mail_drafts: a draft exists only if this function agreed to make it.
--
-- A blocked draft (status 'draft' with a blocked_reason) is still queued: a
-- person needs to see what the agent could not answer and why.
create function nl.queue_mail_draft(
  p_mailbox_id     int,
  p_in_reply_to_id bigint,
  p_to             text[],
  p_cc             text[],
  p_subject        text,
  p_body           text,
  p_intent         text,
  p_facts          jsonb,
  p_attachments    jsonb,
  p_blocked_reason text,
  p_request_id     text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_mailbox nl.mailboxes;
  v_message nl.mail_messages;
  v_thread  text;
  v_id      bigint;
  v_at      timestamptz;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'queue_mail_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_mailbox from nl.mailboxes where id = p_mailbox_id;
  if not found then
    raise exception 'Mailbox % does not exist.', coalesce(p_mailbox_id::text, 'empty') using errcode = 'NL404';
  end if;
  if not v_mailbox.active then
    raise exception 'Mailbox % is switched off.', v_mailbox.address using errcode = 'NL422';
  end if;

  if p_in_reply_to_id is not null then
    select * into v_message from nl.mail_messages where id = p_in_reply_to_id;
    if not found then
      raise exception 'Message % does not exist.', p_in_reply_to_id using errcode = 'NL404';
    end if;
    if v_message.mailbox_id <> p_mailbox_id then
      raise exception 'Message % did not arrive at %.', p_in_reply_to_id, v_mailbox.address
        using errcode = 'NL422';
    end if;
    v_thread := v_message.provider_thread_id;
  end if;

  if p_to is null or cardinality(p_to) = 0 or cardinality(p_to) > 10 then
    raise exception 'A reply goes to 1 to 10 addresses.' using errcode = 'NL422';
  end if;
  if exists (select 1 from unnest(p_to) a where a is null or btrim(a) = '' or position('@' in a) = 0) then
    raise exception 'Every recipient needs an email address.' using errcode = 'NL422';
  end if;
  if p_subject is null or btrim(p_subject) = '' or length(p_subject) > 300 then
    raise exception 'A reply needs a subject of 1 to 300 characters.' using errcode = 'NL422';
  end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 20000 then
    raise exception 'A reply needs a body of 1 to 20,000 characters.' using errcode = 'NL422';
  end if;
  if p_intent is null or p_intent not in ('rfq', 'purchase_order', 'price_question',
                                          'stock_question', 'order_status', 'other') then
    raise exception 'Unknown intent %.', coalesce(p_intent, 'empty') using errcode = 'NL422';
  end if;
  if p_facts is not null and jsonb_typeof(p_facts) is distinct from 'array' then
    raise exception 'The facts a draft cites are a JSON array.' using errcode = 'NL422';
  end if;
  if p_attachments is not null and jsonb_typeof(p_attachments) is distinct from 'array' then
    raise exception 'Attachments are a JSON array.' using errcode = 'NL422';
  end if;
  -- Every fact must name its kind, or the disclosure check above this has
  -- nothing to check.
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_facts, '[]'::jsonb)) f
    where jsonb_typeof(f.value) is distinct from 'object' or coalesce(f.value ->> 'kind', '') = '') then
    raise exception 'Every fact a draft cites names its kind.' using errcode = 'NL422';
  end if;

  insert into nl.mail_drafts (mailbox_id, in_reply_to_id, provider_thread_id, to_addresses, cc_addresses,
                              subject, body, intent, facts, attachments, blocked_reason)
  values (p_mailbox_id, p_in_reply_to_id, v_thread,
          (select array_agg(lower(btrim(a))) from unnest(p_to) a),
          coalesce((select array_agg(lower(btrim(a))) from unnest(p_cc) a), '{}'),
          btrim(p_subject), p_body, p_intent,
          coalesce(p_facts, '[]'::jsonb), coalesce(p_attachments, '[]'::jsonb),
          left(coalesce(p_blocked_reason, ''), 500))
  returning id, updated_at into v_id, v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'queue_mail_draft', 'mail_draft', v_id::text, p_request_id,
          jsonb_build_object('mailbox', v_mailbox.address, 'in_reply_to', p_in_reply_to_id,
                             'intent', p_intent, 'to', p_to,
                             'facts', jsonb_array_length(coalesce(p_facts, '[]'::jsonb)),
                             'blocked_reason', left(coalesce(p_blocked_reason, ''), 500)));

  v_result := jsonb_build_object('draft_id', v_id, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- May this person decide about this mailbox's queue? Its reviewer, or an admin.
create function nl.may_review_mailbox(p_mailbox_id int) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1 from nl.mailboxes m
    where m.id = p_mailbox_id
      and (m.reviewer_id = nl.current_user_id() or nl.is_admin()))
$$;

-- A person says yes. They may also rewrite the subject and the body first,
-- which is stored and marks the draft edited. Nothing is sent here: the send
-- happens after this returns, and nl.mark_mail_sent records it.
create function nl.approve_mail_draft(
  p_draft_id            bigint,
  p_subject             text,
  p_body                text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_draft   nl.mail_drafts;
  v_subject text;
  v_body    text;
  v_edited  boolean;
  v_at      timestamptz;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'approve_mail_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_draft from nl.mail_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'Draft M-% does not exist.', coalesce(p_draft_id::text, 'empty') using errcode = 'NL404';
  end if;
  if not nl.may_review_mailbox(v_draft.mailbox_id) then
    raise exception 'Only this desk''s reviewer or an admin can approve draft M-%.', p_draft_id
      using errcode = 'NL403';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'Draft M-% is already %; it cannot be approved again.', p_draft_id, v_draft.status
      using errcode = 'NL422';
  end if;
  if v_draft.blocked_reason <> '' then
    raise exception 'Draft M-% is held: %. Rewrite it before approving.', p_draft_id, v_draft.blocked_reason
      using errcode = 'NL422';
  end if;
  if v_draft.updated_at <> p_expected_updated_at then
    raise exception 'Draft M-% changed since it was loaded. Reload it and decide again.', p_draft_id
      using errcode = 'NL409';
  end if;

  -- An empty field means "keep what the agent wrote".
  v_subject := coalesce(nullif(btrim(coalesce(p_subject, '')), ''), v_draft.subject);
  v_body    := coalesce(nullif(btrim(coalesce(p_body, '')), ''), v_draft.body);
  if length(v_subject) > 300 then
    raise exception 'A subject is at most 300 characters.' using errcode = 'NL422';
  end if;
  if length(v_body) > 20000 then
    raise exception 'A reply is at most 20,000 characters.' using errcode = 'NL422';
  end if;
  v_edited := v_subject <> v_draft.subject or v_body <> v_draft.body;

  update nl.mail_drafts
     set status      = 'approved',
         subject     = v_subject,
         body        = v_body,
         edited      = v_edited,
         reviewed_by = v_actor.id,
         reviewed_at = now(),
         error       = null
   where id = p_draft_id
  returning updated_at into v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'approve_mail_draft', 'mail_draft', p_draft_id::text, p_request_id,
          jsonb_build_object('edited', v_edited, 'to', v_draft.to_addresses,
                             'intent', v_draft.intent, 'subject', v_subject));

  v_result := jsonb_build_object('draft_id', p_draft_id, 'status', 'approved',
                                 'edited', v_edited, 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- A person says no. Final: a rejected draft never comes back.
create function nl.reject_mail_draft(
  p_draft_id            bigint,
  p_reason              text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_draft  nl.mail_drafts;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'reject_mail_draft');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_draft from nl.mail_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'Draft M-% does not exist.', coalesce(p_draft_id::text, 'empty') using errcode = 'NL404';
  end if;
  if not nl.may_review_mailbox(v_draft.mailbox_id) then
    raise exception 'Only this desk''s reviewer or an admin can reject draft M-%.', p_draft_id
      using errcode = 'NL403';
  end if;
  if v_draft.status not in ('draft', 'failed') then
    raise exception 'Draft M-% is already %.', p_draft_id, v_draft.status using errcode = 'NL422';
  end if;
  if v_draft.updated_at <> p_expected_updated_at then
    raise exception 'Draft M-% changed since it was loaded. Reload it and decide again.', p_draft_id
      using errcode = 'NL409';
  end if;

  update nl.mail_drafts
     set status        = 'rejected',
         reviewed_by   = v_actor.id,
         reviewed_at   = now(),
         reject_reason = left(coalesce(p_reason, ''), 500)
   where id = p_draft_id
  returning updated_at into v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'reject_mail_draft', 'mail_draft', p_draft_id::text, p_request_id,
          jsonb_build_object('reason', left(coalesce(p_reason, ''), 500)));

  v_result := jsonb_build_object('draft_id', p_draft_id, 'status', 'rejected', 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- The send came back with a provider id. This is the only way a draft reaches
-- 'sent', and it can only happen to a draft a person approved.
--
-- Idempotent through the request id, which the send derives from the approval:
-- approving twice, or a retry after a timeout, records one send.
create function nl.mark_mail_sent(
  p_draft_id            bigint,
  p_provider_message_id text,
  p_request_id          text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_draft  nl.mail_drafts;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'mark_mail_sent');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_draft from nl.mail_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'Draft M-% does not exist.', coalesce(p_draft_id::text, 'empty') using errcode = 'NL404';
  end if;
  if not nl.may_review_mailbox(v_draft.mailbox_id) then
    raise exception 'Only this desk''s reviewer or an admin can send draft M-%.', p_draft_id
      using errcode = 'NL403';
  end if;
  if v_draft.status = 'sent' then
    v_result := jsonb_build_object('draft_id', p_draft_id, 'status', 'sent',
                                   'provider_message_id', v_draft.provider_message_id,
                                   'updated_at', v_draft.updated_at, 'already_sent', true);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;
  if v_draft.status <> 'approved' then
    raise exception 'Draft M-% is %; only an approved draft can be sent.', p_draft_id, v_draft.status
      using errcode = 'NL422';
  end if;
  if p_provider_message_id is null or btrim(p_provider_message_id) = '' then
    raise exception 'A sent reply carries the id the mail provider gave it.' using errcode = 'NL422';
  end if;

  update nl.mail_drafts
     set status              = 'sent',
         provider_message_id = left(btrim(p_provider_message_id), 200),
         sent_at             = now(),
         send_attempts       = send_attempts + 1,
         error               = null
   where id = p_draft_id
  returning updated_at into v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'mark_mail_sent', 'mail_draft', p_draft_id::text, p_request_id,
          jsonb_build_object('to', v_draft.to_addresses, 'subject', v_draft.subject,
                             'provider_message_id', left(btrim(p_provider_message_id), 200)));

  v_result := jsonb_build_object('draft_id', p_draft_id, 'status', 'sent',
                                 'provider_message_id', left(btrim(p_provider_message_id), 200),
                                 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- The send failed. A transient failure (the provider could not be reached)
-- leaves the draft approved with the message on it, so it can be tried again.
-- A permanent refusal (the provider rejected the address or the content) sets
-- 'failed', which takes it out of the send path until a person looks at it.
create function nl.mark_mail_failed(
  p_draft_id   bigint,
  p_error      text,
  p_permanent  boolean,
  p_request_id text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_draft  nl.mail_drafts;
  v_status text;
  v_at     timestamptz;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'mark_mail_failed');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  select * into v_draft from nl.mail_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'Draft M-% does not exist.', coalesce(p_draft_id::text, 'empty') using errcode = 'NL404';
  end if;
  if not nl.may_review_mailbox(v_draft.mailbox_id) then
    raise exception 'Only this desk''s reviewer or an admin can record a failure on draft M-%.', p_draft_id
      using errcode = 'NL403';
  end if;
  if v_draft.status <> 'approved' then
    raise exception 'Draft M-% is %; only an approved draft was being sent.', p_draft_id, v_draft.status
      using errcode = 'NL422';
  end if;
  if p_error is null or btrim(p_error) = '' then
    raise exception 'Say what went wrong.' using errcode = 'NL422';
  end if;

  v_status := case when coalesce(p_permanent, false) then 'failed' else 'approved' end;

  update nl.mail_drafts
     set status        = v_status,
         error         = left(btrim(p_error), 1000),
         send_attempts = send_attempts + 1
   where id = p_draft_id
  returning updated_at into v_at;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'mark_mail_failed', 'mail_draft', p_draft_id::text, p_request_id,
          jsonb_build_object('error', left(btrim(p_error), 1000), 'permanent', coalesce(p_permanent, false),
                             'status', v_status));

  v_result := jsonb_build_object('draft_id', p_draft_id, 'status', v_status,
                                 'error', left(btrim(p_error), 1000), 'updated_at', v_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- What the desk page counts
-- ---------------------------------------------------------------------------

create view nl.mail_desk_counts with (security_invoker = true) as
select
  m.id as mailbox_id,
  m.address,
  m.label,
  m.kind,
  m.reviewer_id,
  m.disclosure,
  m.active,
  count(msg.id) filter (where msg.status in ('new', 'working'))::int as waiting,
  count(msg.id) filter (where msg.status = 'needs_person')::int      as needs_person,
  count(msg.id)::int                                                 as messages,
  (select count(*) from nl.mail_drafts d
   where d.mailbox_id = m.id and d.status = 'draft')::int            as queued,
  (select count(*) from nl.mail_drafts d
   where d.mailbox_id = m.id and d.status = 'approved')::int         as approved,
  (select count(*) from nl.mail_drafts d
   where d.mailbox_id = m.id and d.status = 'sent')::int             as sent,
  coalesce((select c.runs from nl.mail_counters c
            where c.mailbox_id = m.id and c.on_day = nl.today()), 0) as runs_today,
  nl.mail_daily_cap()                                                as runs_cap
from nl.mailboxes m
left join nl.mail_messages msg on msg.mailbox_id = m.id
group by m.id, m.address, m.label, m.kind, m.reviewer_id, m.disclosure, m.active;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.mailboxes enable row level security;
alter table nl.mail_messages enable row level security;
alter table nl.mail_attachments enable row level security;
alter table nl.mail_drafts enable row level security;
alter table nl.mail_runs enable row level security;
alter table nl.mail_counters enable row level security;
alter table nl.quantity_breaks enable row level security;

-- Mail to the order desk is the company's correspondence, not one person's
-- private mail, so the whole team reads it. Nobody writes any of it directly:
-- there is no insert, update or delete policy on these tables at all, and the
-- functions above are security definer, so a write has to go through one.
create policy mailboxes_read on nl.mailboxes for select to nl_app using (true);
create policy mail_messages_read on nl.mail_messages for select to nl_app using (true);
create policy mail_attachments_read on nl.mail_attachments for select to nl_app using (true);
create policy mail_drafts_read on nl.mail_drafts for select to nl_app using (true);
create policy mail_runs_read on nl.mail_runs for select to nl_app using (true);
create policy mail_counters_read on nl.mail_counters for select to nl_app using (true);

-- Quantity breaks are published prices, not people, so the read-only role the
-- assistant uses may read them.
create policy quantity_breaks_read on nl.quantity_breaks
  for select to nl_app, nl_readonly using (true);

grant select on nl.mailboxes, nl.mail_messages, nl.mail_attachments, nl.mail_drafts,
  nl.mail_runs, nl.mail_counters, nl.mail_desk_counts to nl_app;
grant select on nl.quantity_breaks to nl_app, nl_readonly;

-- nl_readonly gets nothing on the five mail tables: every one of them names a
-- person, an address or what they wrote.

grant execute on function
  nl.mail_daily_cap(),
  nl.mail_lookup_cap(),
  nl.mail_content_key(int, text, text, text, timestamptz),
  nl.may_review_mailbox(int),
  nl.record_mail_message(int, text, text, text, text, text[], text[], text, text, text, timestamptz, jsonb, text),
  nl.start_mail_run(bigint, text, text, text),
  nl.finish_mail_run(bigint, text, text, numeric, text, text, text, bigint, text, text, jsonb, int, int, int, bigint, bigint, text, text),
  nl.queue_mail_draft(int, bigint, text[], text[], text, text, text, jsonb, jsonb, text, text),
  nl.approve_mail_draft(bigint, text, text, timestamptz, text),
  nl.reject_mail_draft(bigint, text, timestamptz, text),
  nl.mark_mail_sent(bigint, text, text),
  nl.mark_mail_failed(bigint, text, boolean, text)
to nl_app;

grant execute on function nl.desk_price_for(text, text, int, date) to nl_app, nl_readonly;
