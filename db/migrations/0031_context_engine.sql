-- 0027 The context engine: how scattered raw material becomes trustworthy
-- context an agent can act on, with its provenance still attached.
--
-- The problem this solves. An operator's knowledge is not in one table. It is
-- in an ERP export, a legacy CRM dump nobody has cleaned since 2024, two
-- years of mail, an attachment somebody printed to PDF, and a note a rep
-- typed while on the phone. An agent that guesses at that is worse than
-- useless. An agent that re-derives it on every call is slow and expensive.
--
-- So the pipeline here has five steps, and each one is a table you can query:
--
--   1. SOURCES         what we read from, and how far we trust it (1 to 5).
--   2. SOURCE DOCUMENTS one row per thing we read, pointing BACK at the row it
--                      really lives in. No bytes are copied.
--   3. CLAIMS          "this source says this attribute of this subject is
--                      this value", with the locator and the verbatim snippet.
--                      Several claims may disagree. A claim is not a fact.
--   4. FACTS           the one current answer, chosen by a written rule or by
--                      a person, carrying the claims that support it.
--   5. BUNDLES         facts plus durable know-how plus policy, COMPILED per
--                      subject and purpose, content-hashed and versioned. An
--                      agent reads a bundle; it does not assemble context.
--
-- Three ideas do most of the work:
--
--   * The DICTIONARY carries the meaning, not the extractor. nl.context_attributes
--     says an attribute's type, unit, allowed values, freshness horizon, how
--     far it may be disclosed, and WHICH SURFACES may consume it. That last
--     column is the answer to "how should this context be applied": a
--     packaging requirement reaches a quote and the shipping paperwork and
--     never touches a price, because the dictionary says so.
--   * A parse is THREE separately scored parts: the subject (entity
--     resolution), the attribute (a dictionary lookup) and the value (typed
--     and normalized). Missing any one leaves the claim unresolved. It never
--     half-promotes.
--   * SCOPE is part of the parse. Every claim carries (customer, ship-to,
--     part, part family, vendor) where null means "all", and on read the most
--     specific scope wins. That is the same precedence shape nl.price_for
--     already uses, deliberately, rather than a second machinery.
--
-- Depends on 0001 (users, audit, request ids), 0002 (customers, contacts,
-- items, vendors, invoices), 0003 (activities), 0010 (ERP snapshots),
-- 0011 (RFQ drafts), 0018 (customer prices), 0020 (RFQ attachments),
-- 0021 (mail). Everything it reads outside its own tables is feature-detected
-- or left-joined, so it applies to a database that is missing a branch.
--
-- See docs/context-engine.md.

-- ---------------------------------------------------------------------------
-- 0. Settings: read the policy engine when it is here, our defaults when not
-- ---------------------------------------------------------------------------

create table nl.context_defaults (
  key   text primary key,
  value jsonb not null,
  note  text not null default ''
);

comment on table nl.context_defaults is
  'The context engine''s own thresholds and horizons, used when the policy engine is not in this database (migration 0027).';

insert into nl.context_defaults (key, value, note) values
  ('promotion.min_confidence', '0.5',
   'A claim below this confidence never promotes, however much we trust its source.'),
  ('promotion.trust_gap_min', '1',
   'How many trust tiers a winner must beat a disagreeing rival by to settle it without a person.'),
  ('promotion.conflict_threshold', '0.34',
   'How far two values may disagree (relative, 0 to 1) before a tie on trust goes to a person instead of promoting.'),
  ('read.min_confidence', '0.6',
   'The bar a fact must clear to appear in a compiled bundle.'),
  ('freshness.default_days', '365',
   'The freshness horizon for an attribute whose dictionary entry does not set one.');

-- One setting, from the policy engine if it is here and answers, otherwise
-- ours. Feature detection rather than a hard dependency: the policy engine is
-- being built on another branch and this has to work either way.
create function nl.context_setting(p_key text) returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_value jsonb;
begin
  if pg_catalog.to_regprocedure('nl.resolve_policy(text)') is not null then
    begin
      execute 'select nl.resolve_policy($1)' into v_value using p_key;
      if v_value is not null then
        return v_value;
      end if;
    exception when others then
      -- A policy engine that raises on a key it does not know is not an
      -- error here: fall through to our own default.
      null;
    end;
  end if;
  select d.value into v_value from nl.context_defaults d where d.key = p_key;
  return v_value;
end $$;

create function nl.context_number(p_key text) returns numeric
language sql stable
set search_path = ''
as $$ select (nl.context_setting(p_key) #>> '{}')::numeric $$;

-- ---------------------------------------------------------------------------
-- 1. Surfaces: the work a fact can be applied to
-- ---------------------------------------------------------------------------

-- A surface is a piece of work an agent does. The dictionary lists, per
-- attribute, which surfaces may consume it, and whether the surface leaves
-- the building. Those two together are the disclosure rule: an attribute
-- marked internal never reaches an external surface even when it is listed
-- there, because being RELEVANT to quoting and being SAYABLE to a customer
-- are different questions. A credit note is the case that makes it obvious.
create table nl.context_surfaces (
  key      text primary key,
  label    text not null,
  -- True when what is assembled for this surface can end up in front of
  -- somebody outside the company.
  external boolean not null,
  note     text not null default ''
);

insert into nl.context_surfaces (key, label, external, note) values
  ('internal_review',    'Internal review',    false, 'A person or an agent looking at what we know. Nothing leaves.'),
  ('buying',             'Buying',             false, 'Replenishment and purchase decisions.'),
  ('quoting',            'Quoting',            true,  'A price and terms that go out on a quote.'),
  ('promising_date',     'Promising a date',   true,  'A ship or delivery date we commit to.'),
  ('replying_external',  'Replying outside',   true,  'A reply written to a customer or a supplier.'),
  ('shipping_paperwork', 'Shipping paperwork', true,  'Labels, packing lists, certificates that travel with the goods.');

-- ---------------------------------------------------------------------------
-- 2. The data dictionary: where an attribute's MEANING lives
-- ---------------------------------------------------------------------------

-- The policy engine (branch policy-engine) may bring a dictionary of its own
-- under this name. If it is already here, leave it alone and use it; the
-- columns below are the ones the context engine reads, so the two merge by
-- having the same shape rather than by one importing the other.
do $$
begin
  if pg_catalog.to_regclass('nl.context_attributes') is null then
    create table nl.context_attributes (
      key            text primary key,
      label          text not null,
      -- What the attribute is about: customer, contact, vendor or item.
      subject_kind   text not null check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
      value_type     text not null check (value_type in
                       ('text', 'integer', 'number', 'money', 'date', 'bool', 'enum', 'range_days')),
      unit           text not null default '',
      -- Only for value_type = 'enum'. A value outside this list is refused.
      allowed_values text[] not null default '{}',
      -- Plausibility, not type: a 400 day lead time parses and is still wrong.
      min_number     numeric,
      max_number     numeric,
      -- How long a value of this kind stays believable before it has to be
      -- verified again. Null falls back to freshness.default_days.
      freshness_days int check (freshness_days is null or freshness_days > 0),
      -- How far it may travel. 'internal' never leaves the building.
      disclosure     text not null default 'internal'
                       check (disclosure in ('internal', 'customer', 'public')),
      -- The surfaces allowed to consume it. This is the "how should the
      -- context be applied" column.
      surfaces       text[] not null default '{}',
      -- True when a claim about this attribute must name a part as well as
      -- the subject (a customer's own part number for one of ours).
      needs_item     boolean not null default false,
      -- A cheap cross-check against a high-trust source, by name. The
      -- promotion rule knows the handful of names; anything else is ignored.
      cross_check    text not null default '',
      note           text not null default '',
      active         boolean not null default true
    );

    comment on table nl.context_attributes is
      'The data dictionary. An extraction that does not land on a row here is not a claim (migration 0027).';

    -- The dictionary itself. Reference data, not part of the invented world,
    -- so it lives in the migration: a claim cannot be written before this
    -- exists. Read the surfaces column as "which work may use this".
    --
    -- Note two pairs that look alike and are not:
    --   * packaging_requirement and marking_requirement reach quoting and the
    --     shipping paperwork and NEVER the price. That is the dictionary's
    --     decision, not an extractor's.
    --   * credit_status_note is relevant to quoting and is marked internal, so
    --     a person pricing a quote sees it and a customer never does. Being
    --     relevant to a surface and being sayable on it are different
    --     questions, and this is the row that proves it.
    insert into nl.context_attributes
      (key, label, subject_kind, value_type, unit, allowed_values, min_number, max_number,
       freshness_days, disclosure, surfaces, needs_item, cross_check, note)
    values
      ('payment_terms_days', 'Payment terms', 'customer', 'integer', 'days', '{}', 0, 180, 540,
       'customer', '{internal_review,quoting,replying_external}', false, '',
       'Net days from the invoice date. "Net 45" is 45.'),
      ('freight_terms', 'Freight terms', 'customer', 'enum', '', '{prepaid,collect,prepaid_and_add,third_party}',
       null, null, 540, 'customer',
       '{internal_review,quoting,replying_external,shipping_paperwork}', false, '',
       'How the freight is billed, in the words the paperwork uses.'),
      ('freight_payer', 'Who pays the freight', 'customer', 'enum', '',
       '{northline,customer,third_party}', null, null, 540, 'customer',
       '{internal_review,quoting,replying_external,shipping_paperwork}', false,
       'customer_ships_own_carrier',
       'Cross-checked against the ERP: an account on its own carrier account does not have us paying.'),
      ('preferred_carrier', 'Preferred carrier', 'customer', 'text', '', '{}', null, null, 540,
       'customer', '{internal_review,replying_external,shipping_paperwork}', false, '',
       'The carrier they ask for by name.'),
      ('certificate_required', 'Certificate required', 'customer', 'enum', '',
       '{none,certificate_of_conformance,mill_test_report,both}', null, null, 730, 'customer',
       '{internal_review,quoting,replying_external,shipping_paperwork}', false, '',
       'Paperwork that has to travel with the goods.'),
      ('packaging_requirement', 'Packaging requirement', 'customer', 'text', '', '{}', null, null,
       730, 'customer', '{internal_review,quoting,shipping_paperwork}', false, '',
       'How it must be packed. Reaches the quote and the paperwork, never the price.'),
      ('marking_requirement', 'Marking requirement', 'customer', 'text', '', '{}', null, null,
       730, 'customer', '{internal_review,quoting,shipping_paperwork}', false, '',
       'What has to be printed on the carton or the label.'),
      ('purchase_order_required', 'Purchase order required', 'customer', 'bool', '', '{}', null, null,
       730, 'customer', '{internal_review,quoting,replying_external}', false, '',
       'True when they will not accept a shipment without their own purchase order number on it.'),
      ('primary_buyer_name', 'Buyer', 'customer', 'text', '', '{}', null, null, 365, 'customer',
       '{internal_review,quoting,replying_external}', false, '',
       'Who places the orders now. Decays fast: people move.'),
      ('primary_buyer_email', 'Buyer address', 'customer', 'text', '', '{}', null, null, 365,
       'customer', '{internal_review,replying_external}', false, '',
       'Where a reply should go.'),
      ('customer_part_no', 'Their part number', 'customer', 'text', '', '{}', null, null, 730,
       'customer', '{internal_review,quoting,replying_external,shipping_paperwork}', true, '',
       'What the customer calls one of our parts. Scoped to the part, always.'),
      ('price_hold_until', 'Price held until', 'customer', 'date', '', '{}', null, null, 180,
       'customer', '{internal_review,quoting,replying_external}', false, '',
       'A date we said a price would hold to.'),
      ('credit_status_note', 'Credit note', 'customer', 'text', '', '{}', null, null, 120,
       'internal', '{internal_review,quoting}', false, '',
       'What the office knows about paying. Internal: relevant to quoting, never repeated outside.'),
      ('vendor_lead_time_days', 'Lead time', 'vendor', 'range_days', 'days', '{}', 0, 200, 180,
       'internal', '{internal_review,buying,promising_date}', false, '',
       'What the supplier says it takes now, as a range of days.'),
      ('vendor_minimum_order_value', 'Minimum order', 'vendor', 'money', 'USD', '{}', 0, 500000,
       365, 'internal', '{internal_review,buying}', false, '',
       'The order value below which they will not ship.'),
      ('item_substitute_part_no', 'Substitute part', 'item', 'text', '', '{}', null, null, 365,
       'customer', '{internal_review,quoting,replying_external}', false, '',
       'A part we may offer instead, when the customer has accepted one before.'),
      ('contact_left_company', 'No longer there', 'contact', 'bool', '', '{}', null, null, 365,
       'internal', '{internal_review}', false, '',
       'True when somebody has left. Internal: we do not tell a company who left it.')
    on conflict (key) do nothing;
  end if;
end $$;

-- Every surface an attribute names has to be a surface we have, or the
-- "which work may use this" column means nothing.
create function nl.context_attribute_surfaces_ok(p_surfaces text[]) returns boolean
language sql stable
set search_path = ''
as $$
  select not exists (
    select 1 from unnest(coalesce(p_surfaces, '{}')) s(key)
    where not exists (select 1 from nl.context_surfaces x where x.key = s.key))
$$;

-- The freshness horizon for one attribute, in days.
create function nl.context_horizon(p_attribute text) returns int
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select a.freshness_days from nl.context_attributes a where a.key = p_attribute),
    nl.context_number('freshness.default_days')::int)
$$;

-- ---------------------------------------------------------------------------
-- 3. Sources, and the documents we read from them
-- ---------------------------------------------------------------------------

create table nl.sources (
  key               text primary key,
  kind              text not null check (kind in
                      ('erp_export', 'crm_export', 'inbox', 'attachment', 'manual', 'derived')),
  name              text not null,
  -- 5 is the ERP's own export, 1 is a spreadsheet somebody last touched
  -- three years ago. The promotion rule reads nothing else about a source.
  trust_tier        int not null check (trust_tier between 1 and 5),
  -- In a person's words: 'every weekday morning', 'once, in 2024'.
  refresh_cadence   text not null default '',
  last_seen_at      timestamptz,
  -- What this source is the right answer for, and what it is not.
  authoritative_for text not null default '',
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default nl.now_ms()
);

comment on table nl.sources is
  'What the context engine reads from, and how far each one is trusted. Registered through adapters over the stores that already exist; nothing is copied (migration 0027).';

create index sources_kind_idx on nl.sources (kind, trust_tier desc);

create trigger sources_touch before update on nl.sources
  for each row execute function nl.touch_updated_at();

-- One thing we read. An ERP snapshot row, a mail message, an attachment, a
-- hand-typed note: all of them are source documents, and every one POINTS
-- BACK at the row it really lives in rather than holding a copy.
create table nl.source_documents (
  id           bigint generated always as identity (start with 70001) primary key,
  source_key   text not null references nl.sources (key) on delete cascade,
  -- The source's own name for it: a provider message id, a snapshot id and
  -- row number, a legacy row number. Unique per source, so reading the same
  -- thing twice registers one document.
  external_ref text not null check (length(external_ref) between 1 and 200),
  title        text not null default '',
  received_at  timestamptz not null,
  media_type   text not null default 'text/plain',
  -- SHA-256 of the text or bytes as the source holds them, so a document that
  -- changed under us is visible.
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- The pointer home. No foreign key: the row lives in one of several tables,
  -- and one of those tables may not exist in this database.
  ref_table    text not null default '',
  ref_id       text not null default '',
  created_at   timestamptz not null default now(),
  unique (source_key, external_ref)
);

comment on table nl.source_documents is
  'One row per thing read, pointing back at where it really lives. The bytes are never duplicated (migration 0027).';

create index source_documents_source_idx on nl.source_documents (source_key, received_at desc);
create index source_documents_ref_idx on nl.source_documents (ref_table, ref_id);
create index source_documents_sha_idx on nl.source_documents (sha256);

-- Text a reader produced for a document that is not itself text in a table: a
-- PDF's pages, a spreadsheet's sheets. A mail body and an activity note need
-- no row here, because nl.source_document_text follows the pointer instead.
create table nl.source_document_pages (
  source_document_id bigint not null references nl.source_documents (id) on delete cascade,
  page_no            int not null check (page_no > 0),
  label              text not null default '',
  text               text not null,
  primary key (source_document_id, page_no)
);

comment on table nl.source_document_pages is
  'What a reader got out of a document whose own store holds bytes, not text (migration 0027).';

-- The text of a document, whichever way it is held. This is what makes the
-- verbatim-span guard enforceable in the database rather than a promise the
-- application keeps: a claim's snippet has to appear in here.
--
-- Every branch is guarded by to_regclass, so a database without the mail
-- feature or without the ERP snapshots still answers.
create function nl.source_document_text(p_id bigint) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_doc  nl.source_documents;
  v_text text;
  v_sql  text;
begin
  select * into v_doc from nl.source_documents where id = p_id;
  if not found then
    return null;
  end if;

  -- Pages first: when a reader produced text, that text is the document.
  select string_agg(p.text, E'\n' order by p.page_no) into v_text
  from nl.source_document_pages p
  where p.source_document_id = p_id;
  if v_text is not null then
    return v_text;
  end if;

  if v_doc.ref_table = '' or v_doc.ref_id = '' then
    return null;
  end if;
  if pg_catalog.to_regclass('nl.' || pg_catalog.quote_ident(v_doc.ref_table)) is null then
    return null;
  end if;

  -- The column that holds the words, per table. A table nobody listed here
  -- has no text for us, which is honest rather than a guess.
  v_sql := case v_doc.ref_table
    when 'mail_messages'   then 'select body_text from nl.mail_messages where id = $1::bigint'
    when 'mail_archive'    then 'select subject || E''\n'' || body_text from nl.mail_archive where id = $1::bigint'
    when 'activities'      then 'select body from nl.activities where id = $1::bigint'
    when 'legacy_crm_rows' then 'select raw_text from nl.legacy_crm_rows where id = $1::bigint'
    when 'context_entries' then 'select body from nl.context_entries where id = $1::bigint'
    else null
  end;
  if v_sql is null then
    return null;
  end if;

  execute v_sql into v_text using v_doc.ref_id;
  return v_text;
end $$;

-- ---------------------------------------------------------------------------
-- 4. The two stores this feature owns outright
-- ---------------------------------------------------------------------------

-- A legacy CRM export, staged exactly as it arrived: one jsonb row per line,
-- warts and all. It is staged rather than cleaned because the mess is the
-- point: duplicate accounts spelled three ways, a phone number in the name
-- field, two payment terms for one account, freight terms buried in a note.
create table nl.legacy_crm_rows (
  id          bigint generated always as identity (start with 80001) primary key,
  export_name text not null,
  row_no      int not null check (row_no > 0),
  raw         jsonb not null,
  -- The row rendered as one line of text, which is what a recognizer reads
  -- and what a snippet is checked against.
  raw_text    text not null,
  imported_at timestamptz not null default now(),
  unique (export_name, row_no)
);

comment on table nl.legacy_crm_rows is
  'A legacy CRM export staged as it arrived. Never cleaned in place: claims are made from it and the mess stays visible (migration 0027).';

-- Two years of archived mail.
--
-- Why this is not nl.mail_messages. That table is the order desk's WORKING
-- QUEUE: the agent picks up everything in it that nobody has answered, and a
-- mail in it without an intent and a draft is an unanswered customer. An
-- archive of two years of correspondence back-filled into it would look to
-- the desk like sixty people waiting for a reply. So the archive is its own
-- store, and the context engine registers BOTH through adapters. That is the
-- point of adapters: one engine, several stores, nothing copied.
create table nl.mail_archive (
  id           bigint generated always as identity (start with 82001) primary key,
  mailbox_key  text not null check (mailbox_key in ('orders', 'procurement')),
  direction    text not null default 'in' check (direction in ('in', 'out')),
  from_address text not null,
  from_name    text not null default '',
  to_address   text not null default '',
  subject      text not null default '',
  body_text    text not null,
  received_at  timestamptz not null,
  -- The account or supplier the archive itself names, when the export did.
  -- Often null, which is why entity resolution is a step of its own.
  customer_no  text references nl.customers (customer_no) on delete set null,
  vendor_no    text references nl.vendors (vendor_no) on delete set null,
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at   timestamptz not null default now()
);

comment on table nl.mail_archive is
  'Archived correspondence, kept as raw material. Separate from nl.mail_messages, which is the order desk''s live queue (migration 0027).';

create index mail_archive_received_idx on nl.mail_archive (received_at desc);
create index mail_archive_customer_idx on nl.mail_archive (customer_no);
create index mail_archive_vendor_idx on nl.mail_archive (vendor_no);
create index mail_archive_from_idx on nl.mail_archive (lower(from_address));

-- A hand entry: somebody typed something they know, outside any other
-- feature. It is a source document like any other, at a trust tier of its
-- own, so a hand entry that contradicts the ERP is a conflict rather than an
-- overwrite.
create table nl.context_entries (
  id          bigint generated always as identity (start with 81001) primary key,
  subject_kind text not null check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
  subject_id  text not null,
  body        text not null check (length(body) between 1 and 4000),
  author_id   int not null references nl.users (id),
  entered_at  timestamptz not null default now()
);

create index context_entries_subject_idx on nl.context_entries (subject_kind, subject_id);
create index context_entries_author_idx on nl.context_entries (author_id);

-- ---------------------------------------------------------------------------
-- 5. Extractors, and revoking one
-- ---------------------------------------------------------------------------

-- Every claim records which extractor made it and at which version. That is
-- what makes "one bad extractor's output stops counting" a single statement
-- rather than a forensic exercise.
create table nl.extractors (
  name       text not null,
  version    text not null,
  kind       text not null check (kind in ('recognizer', 'model', 'adapter', 'person')),
  note       text not null default '',
  revoked_at timestamptz,
  revoked_by int references nl.users (id),
  created_at timestamptz not null default now(),
  primary key (name, version)
);

comment on table nl.extractors is
  'Who made a claim and at which version. Revoking one stops its claims counting toward promotion without deleting the record (migration 0027).';

create index extractors_revoked_by_idx on nl.extractors (revoked_by);

-- ---------------------------------------------------------------------------
-- 6. Claims: what a source says, before anybody decides it is true
-- ---------------------------------------------------------------------------

create table nl.claims (
  id            bigint generated always as identity (start with 90001) primary key,

  -- THE SUBJECT. Either resolved (subject_kind + subject_id) or not, in which
  -- case subject_raw holds what the source actually wrote and the claim waits
  -- for entity resolution.
  subject_kind  text not null check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
  subject_id    text,
  subject_raw   text not null default '',

  -- THE ATTRIBUTE. A dictionary key, enforced. An extraction that does not
  -- land on one is not a claim; it goes to nl.context_review_items.
  attribute     text not null references nl.context_attributes (key),

  -- THE VALUE, typed. Exactly the column the dictionary's value_type names is
  -- filled in; nl.record_claim refuses anything else.
  value_text    text,
  value_number  numeric(18, 4),
  value_date    date,
  value_bool    boolean,
  value_json    jsonb,
  unit          text not null default '',
  -- The value as one short canonical string, worked out once at write time so
  -- a screen and a comparison agree. nl.record_claim fills it in from the
  -- typed value when a caller leaves it out, so it is never empty.
  value_display text not null default '',
  -- The canonical value, folded for comparison. Two claims that say the same
  -- thing have the same key, which is what "corroborated" counts.
  value_key text generated always as (lower(btrim(coalesce(value_display, '')))) stored,

  -- SCOPE. Null means "all". A certificate requirement can be customer-wide,
  -- part-wide, or one combination of the two.
  scope_customer_no text,
  scope_ship_to_no  text,
  scope_item_no     text,
  scope_item_family text,
  scope_vendor_no   text,
  -- Most specific wins on read. A part beats a family, a branch beats a
  -- billing parent. Stored so an index can order by it.
  scope_specificity int generated always as (
    (case when scope_item_no     is not null then 8 else 0 end) +
    (case when scope_item_family is not null then 4 else 0 end) +
    (case when scope_ship_to_no  is not null then 2 else 0 end) +
    (case when scope_customer_no is not null then 1 else 0 end) +
    (case when scope_vendor_no   is not null then 1 else 0 end)) stored,
  scope_key text generated always as (
    coalesce(scope_customer_no, '*') || '|' || coalesce(scope_ship_to_no, '*') || '|' ||
    coalesce(scope_item_no, '*') || '|' || coalesce(scope_item_family, '*') || '|' ||
    coalesce(scope_vendor_no, '*')) stored,

  -- EFFECTIVE DATING. Four dates, because "recent" is not the same question
  -- as "true then". asserted_at is when the source says it was true;
  -- captured_at is when we read it; valid_from and valid_to are the window
  -- the value applies to, and a value past valid_to is not a fact any more.
  asserted_at   date not null,
  captured_at   timestamptz not null default now(),
  valid_from    date not null,
  valid_to      date,

  -- PROVENANCE. A claim with no citation is refused by a constraint, not by
  -- a convention.
  source_document_id bigint not null references nl.source_documents (id) on delete cascade,
  extractor          text not null,
  extractor_version  text not null,
  -- Where in the document: 'line 14', 'page 2, line 8', 'sheet Terms, row 3'.
  locator            text not null,
  -- The words themselves, verbatim, so a person can check it in one click.
  snippet            text not null,

  -- THREE CONFIDENCES, one per part of the parse. The overall confidence is
  -- the weakest of the three, because a perfectly parsed value about the
  -- wrong customer is worth nothing.
  subject_confidence   numeric(4, 3) not null check (subject_confidence between 0 and 1),
  attribute_confidence numeric(4, 3) not null check (attribute_confidence between 0 and 1),
  value_confidence     numeric(4, 3) not null check (value_confidence between 0 and 1),
  confidence numeric(4, 3) generated always as (
    least(subject_confidence, attribute_confidence, value_confidence)) stored,

  -- 'valid'      parsed, validated, eligible for promotion
  -- 'unresolved' one of the three parts is missing (usually the subject)
  -- 'invalid'    failed validation; the reason is in validation
  -- 'superseded' a later claim from the same source about the same thing
  status     text not null default 'valid'
               check (status in ('valid', 'unresolved', 'invalid', 'superseded')),
  validation jsonb not null default '[]',

  created_at timestamptz not null default now(),

  constraint claims_has_citation check (btrim(locator) <> '' and btrim(snippet) <> ''),
  constraint claims_has_a_subject_or_a_raw_one check (subject_id is not null or btrim(subject_raw) <> ''),
  constraint claims_window check (valid_to is null or valid_to >= valid_from),
  constraint claims_validation_is_an_array check (jsonb_typeof(validation) = 'array'),
  -- The same attribute read from the same place in the same document is ONE
  -- claim. Exploring the inbox again finds the same evidence and must not
  -- turn one email into five claims that then corroborate each other.
  constraint claims_one_per_place unique (source_document_id, attribute, locator, scope_key)
);

comment on table nl.claims is
  'What a source says about one attribute of one subject, with its locator and verbatim snippet. Claims disagree; facts do not (migration 0027).';

create index claims_subject_idx on nl.claims (subject_kind, subject_id, attribute)
  where status = 'valid';
create index claims_attribute_idx on nl.claims (attribute, captured_at desc);
create index claims_document_idx on nl.claims (source_document_id);
create index claims_extractor_idx on nl.claims (extractor, extractor_version);
create index claims_unresolved_idx on nl.claims (subject_kind, subject_raw) where status = 'unresolved';

-- A claim counts toward promotion only while its extractor is not revoked.
-- One view, so every reader agrees about what "counts" means.
create view nl.claim_candidates with (security_invoker = true) as
  select c.*,
         s.key       as source_key,
         s.name      as source_name,
         s.kind      as source_kind,
         s.trust_tier,
         d.received_at as document_received_at,
         d.title       as document_title,
         d.ref_table,
         d.ref_id
  from nl.claims c
  join nl.source_documents d on d.id = c.source_document_id
  join nl.sources s on s.key = d.source_key
  left join nl.extractors e on e.name = c.extractor and e.version = c.extractor_version
  where c.status = 'valid'
    and s.active
    and (e.name is null or e.revoked_at is null);

comment on view nl.claim_candidates is
  'Claims that count: valid, from an active source, from an extractor nobody revoked (migration 0027).';

-- ---------------------------------------------------------------------------
-- 7. "I could not tell what this means", and claims that failed validation
-- ---------------------------------------------------------------------------

-- Both outcomes are first class and both keep their snippet. Dropping either
-- one silently is how a context engine quietly stops covering half the book.
create table nl.context_review_items (
  id                 bigint generated always as identity (start with 91001) primary key,
  kind               text not null check (kind in ('unparsed', 'failed_validation')),
  source_document_id bigint not null references nl.source_documents (id) on delete cascade,
  subject_kind       text check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
  subject_id         text,
  subject_raw        text not null default '',
  -- What the extractor thought it might be, when it had a guess.
  proposed_attribute text references nl.context_attributes (key),
  locator            text not null,
  snippet            text not null,
  reason             text not null,
  extractor          text not null default '',
  extractor_version  text not null default '',
  status             text not null default 'open' check (status in ('open', 'dismissed', 'resolved')),
  note               text not null default '',
  decided_by         int references nl.users (id),
  decided_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default nl.now_ms(),
  constraint context_review_items_has_citation check (btrim(locator) <> '' and btrim(snippet) <> ''),
  -- The same snippet from the same document is one item, however many times
  -- an exploration runs over it.
  unique (source_document_id, locator, kind, snippet)
);

comment on table nl.context_review_items is
  'Extractions that did not land on a dictionary attribute, and claims that failed validation. Both keep their snippet (migration 0027).';

create index context_review_items_open_idx on nl.context_review_items (status, created_at desc);
create index context_review_items_subject_idx on nl.context_review_items (subject_kind, subject_id);
create index context_review_items_decided_by_idx on nl.context_review_items (decided_by);

create trigger context_review_items_touch before update on nl.context_review_items
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 8. Entity resolution as its own step
-- ---------------------------------------------------------------------------

-- A raw name, an email domain, a phone number or a part number, scored
-- against the thing it might be, with the evidence for the score. The
-- matching itself is the order desk's (app/src/lib/server/desk/tools.ts):
-- this feature imports it rather than writing a second matcher.
create table nl.entity_candidates (
  id                 bigint generated always as identity (start with 92001) primary key,
  raw_kind           text not null check (raw_kind in ('name', 'email', 'email_domain', 'phone', 'part_number')),
  raw_value          text not null check (btrim(raw_value) <> ''),
  target_kind        text not null check (target_kind in ('customer', 'contact', 'vendor', 'item')),
  target_id          text not null,
  score              numeric(4, 3) not null check (score between 0 and 1),
  -- Why: {"rule": "contact_email", "detail": "..."} in the matcher's words.
  evidence           jsonb not null default '{}',
  source_document_id bigint references nl.source_documents (id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (raw_kind, raw_value, target_kind, target_id)
);

create index entity_candidates_raw_idx on nl.entity_candidates (raw_kind, raw_value, score desc);
create index entity_candidates_target_idx on nl.entity_candidates (target_kind, target_id);

-- The decision. Accepted or rejected, by a rule or by a person, and the
-- evidence that decided it. One accepted link per raw value.
create table nl.entity_links (
  id          bigint generated always as identity (start with 93001) primary key,
  raw_kind    text not null check (raw_kind in ('name', 'email', 'email_domain', 'phone', 'part_number')),
  raw_value   text not null check (btrim(raw_value) <> ''),
  target_kind text not null check (target_kind in ('customer', 'contact', 'vendor', 'item')),
  target_id   text not null,
  decision    text not null check (decision in ('accepted', 'rejected')),
  decided_via text not null check (decided_via in ('rule', 'person')),
  decided_by  int references nl.users (id),
  decided_at  timestamptz not null default now(),
  score       numeric(4, 3) not null check (score between 0 and 1),
  evidence    jsonb not null default '{}',
  note        text not null default '',
  updated_at  timestamptz not null default nl.now_ms(),
  constraint entity_links_person_has_a_name check (decided_via <> 'person' or decided_by is not null)
);

comment on table nl.entity_links is
  'What a raw name, address, phone or part number was decided to be, by a rule or by a person (migration 0027).';

create unique index entity_links_one_accepted_idx
  on nl.entity_links (raw_kind, raw_value) where decision = 'accepted';
create index entity_links_target_idx on nl.entity_links (target_kind, target_id);
create index entity_links_decided_by_idx on nl.entity_links (decided_by);

create trigger entity_links_touch before update on nl.entity_links
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 9. Facts: the one current answer, and what it replaced
-- ---------------------------------------------------------------------------

create table nl.facts (
  id           bigint generated always as identity (start with 95001) primary key,
  subject_kind text not null check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
  subject_id   text not null,
  attribute    text not null references nl.context_attributes (key),

  value_text    text,
  value_number  numeric(18, 4),
  value_date    date,
  value_bool    boolean,
  value_json    jsonb,
  unit          text not null default '',
  value_display text not null default '',

  scope_customer_no text,
  scope_ship_to_no  text,
  scope_item_no     text,
  scope_item_family text,
  scope_vendor_no   text,
  scope_specificity int generated always as (
    (case when scope_item_no     is not null then 8 else 0 end) +
    (case when scope_item_family is not null then 4 else 0 end) +
    (case when scope_ship_to_no  is not null then 2 else 0 end) +
    (case when scope_customer_no is not null then 1 else 0 end) +
    (case when scope_vendor_no   is not null then 1 else 0 end)) stored,
  scope_key text generated always as (
    coalesce(scope_customer_no, '*') || '|' || coalesce(scope_ship_to_no, '*') || '|' ||
    coalesce(scope_item_no, '*') || '|' || coalesce(scope_item_family, '*') || '|' ||
    coalesce(scope_vendor_no, '*')) stored,

  confidence numeric(4, 3) not null check (confidence between 0 and 1),
  -- The claims that support it, and the citations a screen shows. Kept on the
  -- row so serving a fact with its provenance is one read.
  claim_ids  bigint[] not null check (cardinality(claim_ids) > 0),
  citations  jsonb not null default '[]',

  -- Who decided, and how. A person's decision is not overwritten by the rule
  -- next time it runs: nl.promote_claims leaves 'person' rows alone, and
  -- nl.resolve_context_conflict is the way one changes.
  decided_via  text not null check (decided_via in ('rule', 'person')),
  decided_rule text not null default '',
  decided_by   int references nl.users (id),
  decided_at   timestamptz not null default now(),

  asserted_at date not null,
  valid_from  date not null,
  valid_to    date,
  -- asserted_at plus the attribute's freshness horizon. Past this the fact is
  -- stale: still on the record, not served, and asking to be verified again.
  stale_after date not null,

  -- The fact this one replaced, so the chain is walkable.
  superseded_fact_id bigint references nl.facts (id) on delete set null,
  status text not null default 'current' check (status in ('current', 'superseded')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default nl.now_ms(),
  constraint facts_window check (valid_to is null or valid_to >= valid_from),
  constraint facts_person_has_a_name check (decided_via <> 'person' or decided_by is not null),
  constraint facts_citations_is_an_array check (jsonb_typeof(citations) = 'array')
);

comment on table nl.facts is
  'The current answer per subject, attribute and scope, with the claims behind it and who decided (migration 0027).';

create unique index facts_current_idx
  on nl.facts (subject_kind, subject_id, attribute, scope_key) where status = 'current';
create index facts_subject_idx on nl.facts (subject_kind, subject_id) where status = 'current';
create index facts_attribute_idx on nl.facts (attribute, status);
create index facts_stale_idx on nl.facts (stale_after) where status = 'current';
create index facts_decided_by_idx on nl.facts (decided_by);
create index facts_superseded_idx on nl.facts (superseded_fact_id);

create trigger facts_touch before update on nl.facts
  for each row execute function nl.touch_updated_at();

-- A fact with today's verdict on it: is it still inside its window, and is it
-- still fresh. Both questions are asked in one place so no caller invents its
-- own definition of stale.
create view nl.fact_state with (security_invoker = true) as
  select f.*,
         a.label       as attribute_label,
         a.value_type,
         a.disclosure,
         a.surfaces,
         (f.valid_to is not null and f.valid_to < nl.today()) as expired,
         (f.stale_after < nl.today()) as stale,
         (nl.today() - f.stale_after) as days_stale
  from nl.facts f
  join nl.context_attributes a on a.key = f.attribute
  where f.status = 'current';

comment on view nl.fact_state is
  'Current facts with today''s verdict: expired (past its window) and stale (past its freshness horizon) (migration 0027).';

-- ---------------------------------------------------------------------------
-- 10. Conflicts: what the rule would not settle
-- ---------------------------------------------------------------------------

create table nl.context_conflicts (
  id            bigint generated always as identity (start with 96001) primary key,
  subject_kind  text not null check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
  subject_id    text not null,
  attribute     text not null references nl.context_attributes (key),
  scope_key     text not null,
  -- The two claims a person is choosing between: the one the rule would have
  -- picked, and the one that stopped it.
  winner_claim_id bigint not null references nl.claims (id) on delete cascade,
  rival_claim_id  bigint not null references nl.claims (id) on delete cascade,
  -- 0 to 1. 1 means they are simply different; a number in between is how far
  -- apart two numeric values are, relative to the larger.
  disagreement  numeric(5, 4) not null check (disagreement between 0 and 1),
  reason        text not null,
  status        text not null default 'open' check (status in ('open', 'resolved', 'withdrawn')),
  resolved_claim_id bigint references nl.claims (id) on delete set null,
  resolved_by   int references nl.users (id),
  resolved_at   timestamptz,
  note          text not null default '',
  raised_at     timestamptz not null default now(),
  updated_at    timestamptz not null default nl.now_ms(),
  constraint context_conflicts_two_claims check (winner_claim_id <> rival_claim_id)
);

comment on table nl.context_conflicts is
  'Where two claims disagree by more than the threshold and trust does not settle it, so a person decides (migration 0027).';

create unique index context_conflicts_open_idx
  on nl.context_conflicts (subject_kind, subject_id, attribute, scope_key) where status = 'open';
create index context_conflicts_recent_idx on nl.context_conflicts (status, raised_at desc);
create index context_conflicts_winner_idx on nl.context_conflicts (winner_claim_id);
create index context_conflicts_rival_idx on nl.context_conflicts (rival_claim_id);
create index context_conflicts_resolved_claim_idx on nl.context_conflicts (resolved_claim_id);
create index context_conflicts_resolved_by_idx on nl.context_conflicts (resolved_by);

create trigger context_conflicts_touch before update on nl.context_conflicts
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 11. Playbooks: the durable half of context
-- ---------------------------------------------------------------------------

-- Tier one context. How we quote, what a certificate of conformance is, what
-- "collect" means on our paperwork. Authored and reviewed, not extracted, and
-- it changes about once a year. An agent needs this as much as it needs a
-- customer's freight terms, and confusing the two is how a demo either
-- invents policy or re-derives the obvious on every call.
create table nl.playbooks (
  key          text primary key,
  title        text not null,
  -- Markdown. Short enough that a whole bundle stays readable.
  body         text not null check (length(body) between 1 and 8000),
  subject_kind text check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
  scope_customer_no text,
  scope_ship_to_no  text,
  scope_item_no     text,
  scope_item_family text,
  scope_vendor_no   text,
  -- Which work this know-how belongs to. Empty means every surface.
  surfaces     text[] not null default '{}',
  disclosure   text not null default 'internal' check (disclosure in ('internal', 'customer', 'public')),
  version      int not null default 1 check (version > 0),
  author_id    int not null references nl.users (id),
  reviewed_at  date,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default nl.now_ms()
);

comment on table nl.playbooks is
  'Durable know-how: authored, reviewed, versioned, not extracted. Compiled into every bundle in its scope (migration 0027).';

create index playbooks_subject_idx on nl.playbooks (subject_kind) where active;
create index playbooks_author_idx on nl.playbooks (author_id);

create trigger playbooks_touch before update on nl.playbooks
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 12. Bundles: context is compiled, not assembled per call
-- ---------------------------------------------------------------------------

create table nl.context_bundles (
  id           bigint generated always as identity (start with 97001) primary key,
  subject_kind text not null check (subject_kind in ('customer', 'contact', 'vendor', 'item')),
  subject_id   text not null,
  purpose      text not null references nl.context_surfaces (key),
  -- Bumped only when content_hash changes. A recompile that finds nothing new
  -- moves built_at and leaves the version alone, which is what makes a
  -- recorded version worth recording.
  version      int not null check (version > 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  payload      jsonb not null,
  -- What it was built from: counts and the ids, so a rebuild can be explained.
  inputs       jsonb not null default '{}',
  built_at     timestamptz not null default now(),
  is_current   boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (subject_kind, subject_id, purpose, version)
);

comment on table nl.context_bundles is
  'Compiled context per subject and purpose: facts above the bar with their citations, the playbooks in scope, and the policy values in force. Versioned and content-hashed (migration 0027).';

create unique index context_bundles_current_idx
  on nl.context_bundles (subject_kind, subject_id, purpose) where is_current;
create index context_bundles_built_idx on nl.context_bundles (built_at desc);

-- Every agent action records the bundle version it read. That is what turns
-- "why did it say that" into a query: a reply can be explained after the
-- fact, an eval can be replayed against a frozen bundle rather than a moving
-- database, and one bad fact can be traced forward to every action that used
-- it.
create table nl.context_reads (
  id             bigint generated always as identity (start with 98001) primary key,
  bundle_id      bigint not null references nl.context_bundles (id) on delete cascade,
  bundle_version int not null,
  content_hash   text not null,
  subject_kind   text not null,
  subject_id     text not null,
  purpose        text not null,
  -- What used it: 'desk_draft', 'purchase_request', 'assistant_turn', 'mcp'.
  action         text not null check (length(action) between 1 and 60),
  -- The row that action produced, when there is one.
  entity         text not null default '',
  entity_id      text not null default '',
  actor_id       int references nl.users (id),
  via            text not null default 'agent' check (via in ('ui', 'agent', 'assistant', 'nightly', 'mcp')),
  read_at        timestamptz not null default now()
);

comment on table nl.context_reads is
  'Which compiled bundle version an agent action read. The honesty mechanism: it makes an action explainable and an eval replayable (migration 0027).';

create index context_reads_bundle_idx on nl.context_reads (bundle_id, read_at desc);
create index context_reads_entity_idx on nl.context_reads (entity, entity_id);
create index context_reads_subject_idx on nl.context_reads (subject_kind, subject_id, read_at desc);
create index context_reads_actor_idx on nl.context_reads (actor_id);

-- ---------------------------------------------------------------------------
-- 13. Which subjects matter, and where the gaps are
-- ---------------------------------------------------------------------------

-- The subjects worth covering, heaviest first. Coverage reports against this
-- and the scheduled build works through it in order, so the accounts that
-- matter are covered before the ones that do not.
create function nl.context_subjects(p_subject_kind text, p_limit int default 200)
returns table (subject_id text, name text, weight numeric)
language sql stable
set search_path = ''
as $$
  select s.subject_id, s.name, s.weight
  from (
    select c.customer_no as subject_id,
           c.name,
           coalesce((select sum(i.subtotal) from nl.invoices i
                     where i.customer_no = c.customer_no
                       and i.posted_on > nl.today() - 365), 0)::numeric as weight
    from nl.customers c
    where p_subject_kind = 'customer' and not c.closed and not c.blocked
    union all
    select v.vendor_no, v.name,
           coalesce((select count(*) from nl.items it where it.vendor_no = v.vendor_no), 0)::numeric
    from nl.vendors v
    where p_subject_kind = 'vendor'
    union all
    select it.item_no, it.description,
           coalesce((select sum(il.quantity) from nl.invoice_lines il
                     where il.item_no = it.item_no
                       and il.posted_on > nl.today() - 365), 0)::numeric
    from nl.items it
    where p_subject_kind = 'item' and not it.blocked
    union all
    select ct.id::text, ct.full_name, 1::numeric
    from nl.contacts ct
    where p_subject_kind = 'contact' and ct.left_on is null
  ) s
  order by s.weight desc, s.subject_id
  limit greatest(coalesce(p_limit, 200), 1)
$$;

-- Per subject kind and attribute: how many of the subjects that matter have a
-- fresh fact, how many have a stale one, and how many have nothing at all.
-- The missing column is the work list, and it is what sends an agent
-- exploring rather than leaving a gap to be discovered by a customer.
create function nl.context_coverage(p_limit int default 200)
returns table (
  subject_kind text,
  attribute    text,
  label        text,
  disclosure   text,
  subjects     int,
  verified     int,
  stale        int,
  missing      int,
  coverage_pct numeric
)
language sql stable
set search_path = ''
as $$
  with kinds as (
    select distinct a.subject_kind from nl.context_attributes a where a.active
  ),
  subjects as (
    select k.subject_kind, s.subject_id
    from kinds k
    cross join lateral nl.context_subjects(k.subject_kind, p_limit) s
  ),
  pairs as (
    select a.key as attribute, a.label, a.subject_kind, a.disclosure, s.subject_id
    from nl.context_attributes a
    join subjects s on s.subject_kind = a.subject_kind
    where a.active
  ),
  -- One verdict per pair: the freshest current fact for that subject and
  -- attribute at any scope. A stale fact still counts as known, just not as
  -- trusted, which is the distinction the screen shows.
  verdicts as (
    select p.subject_kind, p.attribute, p.label, p.disclosure, p.subject_id,
           (select bool_or(not f.stale and not f.expired)
            from nl.fact_state f
            where f.subject_kind = p.subject_kind
              and f.subject_id = p.subject_id
              and f.attribute = p.attribute) as fresh
    from pairs p
  )
  select v.subject_kind,
         v.attribute,
         v.label,
         v.disclosure,
         count(*)::int as subjects,
         count(*) filter (where v.fresh)::int as verified,
         count(*) filter (where v.fresh is false)::int as stale,
         count(*) filter (where v.fresh is null)::int as missing,
         round(count(*) filter (where v.fresh)::numeric * 100 / greatest(count(*), 1), 1) as coverage_pct
  from verdicts v
  group by v.subject_kind, v.attribute, v.label, v.disclosure
  order by coverage_pct, v.subject_kind, v.attribute
$$;

comment on function nl.context_coverage(int) is
  'What we know, what has gone stale and what is missing, per subject kind and attribute. The worst rows come first, because they are the work list (migration 0027).';

-- The worst offenders for one attribute: subjects that matter and have no
-- fresh fact, heaviest first.
create function nl.context_gaps(p_subject_kind text, p_attribute text, p_limit int default 20)
returns table (subject_id text, name text, weight numeric, state text, stale_days int)
language sql stable
set search_path = ''
as $$
  select s.subject_id, s.name, s.weight,
         case when f.id is null then 'missing'
              when f.expired then 'expired'
              when f.stale then 'stale'
              else 'verified' end as state,
         case when f.id is not null and f.stale then f.days_stale::int end as stale_days
  from nl.context_subjects(p_subject_kind, 500) s
  left join lateral (
    select fs.id, fs.stale, fs.expired, fs.days_stale
    from nl.fact_state fs
    where fs.subject_kind = p_subject_kind
      and fs.subject_id = s.subject_id
      and fs.attribute = p_attribute
    order by fs.scope_specificity, fs.stale_after desc
    limit 1
  ) f on true
  where f.id is null or f.stale or f.expired
  order by s.weight desc, s.subject_id
  limit greatest(coalesce(p_limit, 20), 1)
$$;

-- ---------------------------------------------------------------------------
-- 14. Writing a claim
-- ---------------------------------------------------------------------------

-- Validation, in the order the brief asks for: type, unit, domain,
-- plausibility, then the cross-check against a high-trust source. Returns an
-- array of failures, empty when it passes. A caller that gets failures writes
-- a review item instead of a claim, so nothing is dropped silently.
create function nl.check_claim_value(
  p_attribute    text,
  p_value_text   text,
  p_value_number numeric,
  p_value_date   date,
  p_value_bool   boolean,
  p_value_json   jsonb,
  p_unit         text,
  p_subject_kind text,
  p_subject_id   text,
  p_scope_item_no text
) returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_attr  nl.context_attributes;
  v_fails jsonb := '[]';
  v_low   numeric;
  v_high  numeric;
begin
  select * into v_attr from nl.context_attributes where key = p_attribute;
  if not found then
    return jsonb_build_array(jsonb_build_object('check', 'attribute',
      'detail', format('%s is not in the data dictionary.', coalesce(p_attribute, 'an empty attribute'))));
  end if;
  if not v_attr.active then
    v_fails := v_fails || jsonb_build_object('check', 'attribute', 'detail', 'That attribute is switched off.');
  end if;

  -- 1. Type. Exactly the column the dictionary names, and nothing else.
  if v_attr.value_type in ('integer', 'number', 'money') then
    if p_value_number is null then
      v_fails := v_fails || jsonb_build_object('check', 'type',
        'detail', format('%s is a %s and needs a number.', v_attr.key, v_attr.value_type));
    elsif v_attr.value_type = 'integer' and p_value_number <> trunc(p_value_number) then
      v_fails := v_fails || jsonb_build_object('check', 'type',
        'detail', format('%s is a whole number; %s is not.', v_attr.key, p_value_number));
    end if;
  elsif v_attr.value_type = 'date' then
    if p_value_date is null then
      v_fails := v_fails || jsonb_build_object('check', 'type', 'detail', format('%s needs a date.', v_attr.key));
    end if;
  elsif v_attr.value_type = 'bool' then
    if p_value_bool is null then
      v_fails := v_fails || jsonb_build_object('check', 'type', 'detail', format('%s is yes or no.', v_attr.key));
    end if;
  elsif v_attr.value_type = 'range_days' then
    if p_value_json is null or jsonb_typeof(p_value_json) <> 'object'
       or jsonb_typeof(p_value_json -> 'low') <> 'number'
       or jsonb_typeof(p_value_json -> 'high') <> 'number' then
      v_fails := v_fails || jsonb_build_object('check', 'type',
        'detail', format('%s is a range of days, as {"low": n, "high": n}.', v_attr.key));
    else
      v_low  := (p_value_json ->> 'low')::numeric;
      v_high := (p_value_json ->> 'high')::numeric;
      if v_low > v_high then
        v_fails := v_fails || jsonb_build_object('check', 'type',
          'detail', format('A range runs low to high, not %s to %s.', v_low, v_high));
      end if;
    end if;
  else
    if p_value_text is null or btrim(p_value_text) = '' then
      v_fails := v_fails || jsonb_build_object('check', 'type', 'detail', format('%s needs text.', v_attr.key));
    elsif v_attr.value_type = 'enum'
          and not (p_value_text = any (v_attr.allowed_values)) then
      v_fails := v_fails || jsonb_build_object('check', 'domain',
        'detail', format('%s is one of %s, not "%s".', v_attr.key,
                         array_to_string(v_attr.allowed_values, ', '), p_value_text));
    end if;
  end if;

  -- 2. Unit. A number with the wrong unit is a different number.
  if v_attr.unit <> '' and coalesce(p_unit, '') <> v_attr.unit then
    v_fails := v_fails || jsonb_build_object('check', 'unit',
      'detail', format('%s is measured in %s, not "%s".', v_attr.key, v_attr.unit, coalesce(p_unit, 'nothing')));
  end if;

  -- 3. Domain. Is that actually one of our customers, vendors, parts, people.
  if p_subject_id is null then
    v_fails := v_fails || jsonb_build_object('check', 'domain', 'detail', 'The subject is not resolved.');
  elsif p_subject_kind = 'customer'
        and not exists (select 1 from nl.customers c where c.customer_no = p_subject_id) then
    v_fails := v_fails || jsonb_build_object('check', 'domain',
      'detail', format('%s is not one of our accounts.', p_subject_id));
  elsif p_subject_kind = 'vendor'
        and not exists (select 1 from nl.vendors v where v.vendor_no = p_subject_id) then
    v_fails := v_fails || jsonb_build_object('check', 'domain',
      'detail', format('%s is not one of our suppliers.', p_subject_id));
  elsif p_subject_kind = 'item'
        and not exists (select 1 from nl.items i where i.item_no = p_subject_id) then
    v_fails := v_fails || jsonb_build_object('check', 'domain',
      'detail', format('%s is not one of our part numbers.', p_subject_id));
  elsif p_subject_kind = 'contact'
        and not exists (select 1 from nl.contacts ct where ct.id::text = p_subject_id) then
    v_fails := v_fails || jsonb_build_object('check', 'domain',
      'detail', 'That contact is not on file.');
  end if;

  if p_scope_item_no is not null
     and not exists (select 1 from nl.items i where i.item_no = p_scope_item_no) then
    v_fails := v_fails || jsonb_build_object('check', 'domain',
      'detail', format('%s is not one of our part numbers.', p_scope_item_no));
  end if;
  if v_attr.needs_item and p_scope_item_no is null then
    v_fails := v_fails || jsonb_build_object('check', 'domain',
      'detail', format('%s has to name the part it is about.', v_attr.key));
  end if;

  -- 4. Plausibility. It parses and it is still wrong.
  if p_value_number is not null then
    if v_attr.min_number is not null and p_value_number < v_attr.min_number then
      v_fails := v_fails || jsonb_build_object('check', 'plausibility',
        'detail', format('%s below %s is not believable.', p_value_number, v_attr.min_number));
    end if;
    if v_attr.max_number is not null and p_value_number > v_attr.max_number then
      v_fails := v_fails || jsonb_build_object('check', 'plausibility',
        'detail', format('%s above %s is not believable.', p_value_number, v_attr.max_number));
    end if;
  end if;
  if v_attr.value_type = 'range_days' and v_high is not null and v_attr.max_number is not null
     and v_high > v_attr.max_number then
    v_fails := v_fails || jsonb_build_object('check', 'plausibility',
      'detail', format('A %s day lead time is not believable.', v_high));
  end if;

  -- 5. Cross-check against the source we trust most. Only the handful of
  -- names the dictionary can carry; anything else is ignored rather than
  -- guessed at.
  if v_attr.cross_check = 'customer_ships_own_carrier' and p_subject_kind = 'customer' then
    if exists (select 1 from nl.customers c
               where c.customer_no = p_subject_id and c.ships_own_carrier)
       and p_value_text = 'northline' then
      v_fails := v_fails || jsonb_build_object('check', 'cross_check',
        'detail', 'The ERP says this account ships on its own carrier account, so we do not pay the freight.');
    end if;
  end if;

  return v_fails;
end $$;

-- One claim, or the review item it became. The three parts of the parse are
-- separate parameters with separate confidences on purpose: a well-parsed
-- value about the wrong customer must not look like a good claim.
--
-- What this refuses outright, with NL422:
--   * an attribute that is not in the dictionary;
--   * no locator or no snippet (a fact nobody can check is not a fact);
--   * a snippet that does not appear verbatim in the source document's text.
-- That last one is the anti-invention guard, and it is in the database so it
-- holds whether the claim came from a recognizer, a model, or a model that
-- had just read an email telling it what to say.
--
-- What it turns into a review item instead of a claim:
--   * a value that fails type, unit, domain, plausibility or the cross-check.
create function nl.record_claim(
  p_subject_kind        text,
  p_subject_id          text,
  p_subject_raw         text,
  p_attribute           text,
  p_value_text          text,
  p_value_number        numeric,
  p_value_date          date,
  p_value_bool          boolean,
  p_value_json          jsonb,
  p_unit                text,
  p_value_display       text,
  p_scope_customer_no   text,
  p_scope_ship_to_no    text,
  p_scope_item_no       text,
  p_scope_item_family   text,
  p_scope_vendor_no     text,
  p_asserted_at         date,
  p_valid_from          date,
  p_valid_to            date,
  p_source_document_id  bigint,
  p_extractor           text,
  p_extractor_version   text,
  p_locator             text,
  p_snippet             text,
  p_subject_confidence   numeric,
  p_attribute_confidence numeric,
  p_value_confidence     numeric,
  p_request_id          text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_text    text;
  v_fails   jsonb;
  v_status  text := 'valid';
  v_display text;
  v_id      bigint;
  v_item    bigint;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_claim');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  if p_subject_kind is null or p_subject_kind not in ('customer', 'contact', 'vendor', 'item') then
    raise exception 'A claim is about a customer, a contact, a vendor or an item, not %.',
      coalesce(p_subject_kind, 'nothing') using errcode = 'NL422';
  end if;
  if p_attribute is null
     or not exists (select 1 from nl.context_attributes a where a.key = p_attribute) then
    raise exception 'There is no attribute called % in the data dictionary. An extraction that does not land on one is not a claim.',
      coalesce(p_attribute, 'empty') using errcode = 'NL422';
  end if;
  if p_locator is null or btrim(p_locator) = '' or p_snippet is null or btrim(p_snippet) = '' then
    raise exception 'A claim needs a locator and the words it came from. A fact nobody can check is not a fact.'
      using errcode = 'NL422';
  end if;
  if not exists (select 1 from nl.source_documents d where d.id = p_source_document_id) then
    raise exception 'Source document % is not registered.', coalesce(p_source_document_id::text, 'empty')
      using errcode = 'NL404';
  end if;

  -- The verbatim-span guard. Whitespace is collapsed on both sides, because a
  -- PDF reader and a mail client disagree about spacing and nothing else.
  v_text := nl.source_document_text(p_source_document_id);
  if v_text is not null then
    if position(lower(regexp_replace(btrim(p_snippet), '\s+', ' ', 'g'))
                in lower(regexp_replace(v_text, '\s+', ' ', 'g'))) = 0 then
      raise exception 'The quoted words are not in the source document. A claim whose snippet cannot be found in what we read is thrown away.'
        using errcode = 'NL422';
    end if;
  end if;

  -- The three parts of the parse. Any one missing and the claim is
  -- unresolved: it is kept, it is visible, and it never promotes.
  v_fails := nl.check_claim_value(p_attribute, p_value_text, p_value_number, p_value_date,
                                  p_value_bool, p_value_json, p_unit,
                                  p_subject_kind, p_subject_id, p_scope_item_no);

  if p_subject_id is null then
    v_status := 'unresolved';
    -- The subject is the only missing part, so this is work for a person
    -- rather than bad data: keep it as an unresolved claim, not a failure.
    v_fails := (select coalesce(jsonb_agg(f.value), '[]')
                from jsonb_array_elements(v_fails) f
                where f.value ->> 'detail' <> 'The subject is not resolved.');
  end if;

  if jsonb_array_length(v_fails) > 0 then
    -- Not a claim. A data-quality item, with its snippet, so somebody can see
    -- exactly what we could not accept and why.
    insert into nl.context_review_items
      (kind, source_document_id, subject_kind, subject_id, subject_raw, proposed_attribute,
       locator, snippet, reason, extractor, extractor_version)
    values ('failed_validation', p_source_document_id, p_subject_kind, p_subject_id,
            left(coalesce(p_subject_raw, ''), 200), p_attribute,
            left(p_locator, 200), left(p_snippet, 1000),
            left((select string_agg(f.value ->> 'detail', ' ') from jsonb_array_elements(v_fails) f), 500),
            left(coalesce(p_extractor, ''), 60), left(coalesce(p_extractor_version, ''), 20))
    on conflict (source_document_id, locator, kind, snippet) do update
      set reason = excluded.reason, status = 'open', updated_at = nl.now_ms()
    returning id into v_item;

    v_result := jsonb_build_object('claim_id', null, 'review_item_id', v_item,
                                   'accepted', false, 'failures', v_fails);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  -- The canonical display string. A caller normally supplies it (the
  -- normalizer in app/src/lib/context/normalize.ts writes it), and this is
  -- the fallback so value_key is never empty and two claims cannot agree by
  -- both saying nothing.
  v_display := nullif(btrim(coalesce(p_value_display, '')), '');
  if v_display is null then
    v_display := coalesce(
      case when p_value_json is not null
             and jsonb_typeof(p_value_json -> 'low') = 'number'
             and jsonb_typeof(p_value_json -> 'high') = 'number'
           then format('%s to %s %s', p_value_json ->> 'low', p_value_json ->> 'high',
                       coalesce(nullif(p_unit, ''), 'days')) end,
      case when p_value_number is not null
           then btrim(format('%s %s', trim(to_char(p_value_number, 'FM999999999990.9999')),
                             coalesce(p_unit, ''))) end,
      case when p_value_date is not null then to_char(p_value_date, 'YYYY-MM-DD') end,
      case when p_value_bool is not null then case when p_value_bool then 'yes' else 'no' end end,
      nullif(btrim(coalesce(p_value_text, '')), ''),
      p_value_json::text,
      'no value');
  end if;

  insert into nl.claims
    (subject_kind, subject_id, subject_raw, attribute,
     value_text, value_number, value_date, value_bool, value_json, unit, value_display,
     scope_customer_no, scope_ship_to_no, scope_item_no, scope_item_family, scope_vendor_no,
     asserted_at, valid_from, valid_to,
     source_document_id, extractor, extractor_version, locator, snippet,
     subject_confidence, attribute_confidence, value_confidence, status, validation)
  values
    (p_subject_kind, p_subject_id, left(coalesce(p_subject_raw, ''), 200), p_attribute,
     p_value_text, p_value_number, p_value_date, p_value_bool, p_value_json,
     coalesce(p_unit, ''), left(v_display, 200),
     p_scope_customer_no, p_scope_ship_to_no, p_scope_item_no, p_scope_item_family, p_scope_vendor_no,
     coalesce(p_asserted_at, nl.today()), coalesce(p_valid_from, coalesce(p_asserted_at, nl.today())),
     p_valid_to,
     p_source_document_id, left(coalesce(p_extractor, 'unknown'), 60),
     left(coalesce(p_extractor_version, '0'), 20), left(p_locator, 200), left(p_snippet, 1000),
     coalesce(p_subject_confidence, 0.5), coalesce(p_attribute_confidence, 0.5),
     coalesce(p_value_confidence, 0.5), v_status, '[]')
  -- Reading the same evidence twice is not two claims. The value and the
  -- confidence are refreshed, because a better extractor reading the same
  -- line should be able to improve on the last one.
  on conflict (source_document_id, attribute, locator, scope_key) do update
    set value_text = excluded.value_text,
        value_number = excluded.value_number,
        value_date = excluded.value_date,
        value_bool = excluded.value_bool,
        value_json = excluded.value_json,
        value_display = excluded.value_display,
        unit = excluded.unit,
        subject_id = excluded.subject_id,
        status = excluded.status,
        subject_confidence = excluded.subject_confidence,
        attribute_confidence = excluded.attribute_confidence,
        value_confidence = excluded.value_confidence,
        extractor = excluded.extractor,
        extractor_version = excluded.extractor_version
  returning id into v_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'assistant', 'record_claim', 'claim', v_id::text, p_request_id,
          jsonb_build_object('attribute', p_attribute, 'subject_kind', p_subject_kind,
                             'subject_id', p_subject_id, 'status', v_status,
                             'source_document_id', p_source_document_id,
                             'extractor', p_extractor, 'extractor_version', p_extractor_version));

  v_result := jsonb_build_object('claim_id', v_id, 'accepted', true, 'status', v_status);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- An extraction that did not land on a dictionary attribute at all. Its own
-- outcome, its own queue, and honest about it.
create function nl.record_unparsed(
  p_source_document_id bigint,
  p_subject_kind       text,
  p_subject_id         text,
  p_subject_raw        text,
  p_proposed_attribute text,
  p_locator            text,
  p_snippet            text,
  p_reason             text,
  p_extractor          text,
  p_extractor_version  text,
  p_request_id         text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_id     bigint;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_unparsed');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if p_locator is null or btrim(p_locator) = '' or p_snippet is null or btrim(p_snippet) = '' then
    raise exception 'An unparsed item still needs its locator and its words.' using errcode = 'NL422';
  end if;
  if not exists (select 1 from nl.source_documents d where d.id = p_source_document_id) then
    raise exception 'Source document % is not registered.', coalesce(p_source_document_id::text, 'empty')
      using errcode = 'NL404';
  end if;

  insert into nl.context_review_items
    (kind, source_document_id, subject_kind, subject_id, subject_raw, proposed_attribute,
     locator, snippet, reason, extractor, extractor_version)
  values ('unparsed', p_source_document_id,
          case when p_subject_kind in ('customer', 'contact', 'vendor', 'item') then p_subject_kind end,
          p_subject_id, left(coalesce(p_subject_raw, ''), 200),
          case when exists (select 1 from nl.context_attributes a where a.key = p_proposed_attribute)
               then p_proposed_attribute end,
          left(p_locator, 200), left(p_snippet, 1000),
          left(coalesce(p_reason, 'Could not tell what this means.'), 500),
          left(coalesce(p_extractor, ''), 60), left(coalesce(p_extractor_version, ''), 20))
  on conflict (source_document_id, locator, kind, snippet) do update
    set reason = excluded.reason, updated_at = nl.now_ms()
  returning id into v_id;

  v_result := jsonb_build_object('review_item_id', v_id);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 15. Promotion: the rule, written down and configurable
-- ---------------------------------------------------------------------------

-- How far apart two claims are, as a number between 0 and 1. Two different
-- strings are simply different (1). Two numbers are as far apart as the gap
-- between them relative to the larger one, so 30 and 45 day terms disagree by
-- a third and 44 and 45 hardly at all.
create function nl.claim_disagreement(p_a nl.claims, p_b nl.claims) returns numeric
language sql immutable
set search_path = ''
as $$
  select case
    when p_a.value_number is not null and p_b.value_number is not null then
      case when greatest(abs(p_a.value_number), abs(p_b.value_number)) = 0 then 0
           else least(abs(p_a.value_number - p_b.value_number)
                      / greatest(abs(p_a.value_number), abs(p_b.value_number)), 1) end
    when p_a.value_date is not null and p_b.value_date is not null then
      case when p_a.value_date = p_b.value_date then 0 else 1 end
    when p_a.value_bool is not null and p_b.value_bool is not null then
      case when p_a.value_bool = p_b.value_bool then 0 else 1 end
    when coalesce(p_a.value_json::text, '') <> '' and coalesce(p_b.value_json::text, '') <> '' then
      case when p_a.value_json = p_b.value_json then 0 else 1 end
    else case when coalesce(lower(btrim(p_a.value_text)), '') = coalesce(lower(btrim(p_b.value_text)), '')
              then 0 else 1 end
  end::numeric(5, 4)
$$;

-- Promote the claims for one subject, attribute and scope into a fact, or
-- raise a conflict for a person. THE RULE, in order:
--
--   1. only claims that COUNT: valid, effective today, above
--      promotion.min_confidence, from an active source and an extractor
--      nobody revoked, with a citation;
--   2. the winner is the HIGHEST TRUST TIER, then the MOST RECENT assertion,
--      then the MOST CORROBORATED (the most claims agreeing with it);
--   3. if a disagreeing rival is within promotion.trust_gap_min tiers of the
--      winner AND the disagreement is above promotion.conflict_threshold,
--      NOTHING is promoted: a conflict is raised and a person decides;
--   4. a fact a PERSON decided is never overwritten by this rule. It changes
--      through nl.resolve_context_conflict and nowhere else.
--
-- Returns what it did, per group, so a caller can report counts.
create function nl.promote_claims(
  p_subject_kind text default null,
  p_subject_id   text default null,
  p_attribute    text default null,
  p_request_id   text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay    jsonb;
  v_actor     nl.users;
  v_request   text := coalesce(p_request_id, 'promote-' || pg_catalog.gen_random_uuid()::text);
  v_min_conf  numeric := nl.context_number('promotion.min_confidence');
  v_gap       numeric := nl.context_number('promotion.trust_gap_min');
  v_threshold numeric := nl.context_number('promotion.conflict_threshold');
  v_today     date := nl.today();
  v_group     record;
  v_win       nl.claims;
  v_win_id    bigint;
  v_rival     nl.claims;
  v_rival_id  bigint;
  v_rival_gap numeric;
  v_rival_tier int;
  v_win_tier  int;
  v_support   bigint[];
  v_cites     jsonb;
  v_existing  nl.facts;
  v_new_id    bigint;
  v_promoted  int := 0;
  v_raised    int := 0;
  v_unchanged int := 0;
  v_held      int := 0;
  v_result    jsonb;
begin
  v_replay := nl.claim_request(v_request, 'promote_claims');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  for v_group in
    select c.subject_kind, c.subject_id, c.attribute, c.scope_key
    from nl.claim_candidates c
    where c.subject_id is not null
      and c.confidence >= v_min_conf
      and c.valid_from <= v_today
      and (c.valid_to is null or c.valid_to >= v_today)
      and (p_subject_kind is null or c.subject_kind = p_subject_kind)
      and (p_subject_id is null or c.subject_id = p_subject_id)
      and (p_attribute is null or c.attribute = p_attribute)
    group by c.subject_kind, c.subject_id, c.attribute, c.scope_key
  loop
    -- A fact a person decided is theirs. The rule does not touch it.
    select * into v_existing from nl.facts f
    where f.subject_kind = v_group.subject_kind
      and f.subject_id = v_group.subject_id
      and f.attribute = v_group.attribute
      and f.scope_key = v_group.scope_key
      and f.status = 'current';
    if found and v_existing.decided_via = 'person' then
      v_held := v_held + 1;
      continue;
    end if;

    -- 2. The winner: highest trust tier, then most recent assertion, then
    -- most corroborated (the most other claims that say the same thing).
    -- The corroboration count is worked out in a lateral rather than a
    -- correlated subquery inside the ORDER BY, which is the same answer and
    -- a readable plan.
    select cand.id, cand.trust_tier into v_win_id, v_win_tier
    from (
      select cc.id, cc.trust_tier, cc.asserted_at, cc.confidence,
             count(*) over (partition by cc.value_key) as agreeing
      from nl.claim_candidates cc
      where cc.subject_kind = v_group.subject_kind
        and cc.subject_id = v_group.subject_id
        and cc.attribute = v_group.attribute
        and cc.scope_key = v_group.scope_key
        and cc.confidence >= v_min_conf
        and cc.valid_from <= v_today
        and (cc.valid_to is null or cc.valid_to >= v_today)
    ) cand
    order by cand.trust_tier desc, cand.asserted_at desc, cand.agreeing desc,
             cand.confidence desc, cand.id desc
    limit 1;
    if v_win_id is null then
      continue;
    end if;
    select * into v_win from nl.claims where id = v_win_id;

    -- 3. The rival that stops it: the claim that disagrees most, and among
    -- those the most trusted.
    select cc.id, cc.trust_tier, nl.claim_disagreement(v_win, cl)
      into v_rival_id, v_rival_tier, v_rival_gap
    from nl.claim_candidates cc
    join nl.claims cl on cl.id = cc.id
    where cc.subject_kind = v_group.subject_kind
      and cc.subject_id = v_group.subject_id
      and cc.attribute = v_group.attribute
      and cc.scope_key = v_group.scope_key
      and cc.confidence >= v_min_conf
      and cc.valid_from <= v_today
      and (cc.valid_to is null or cc.valid_to >= v_today)
      and cc.id <> v_win_id
      and nl.claim_disagreement(v_win, cl) > 0
    order by nl.claim_disagreement(v_win, cl) desc, cc.trust_tier desc, cc.asserted_at desc
    limit 1;

    if v_rival_id is not null
       and (v_win_tier - v_rival_tier) < v_gap
       and v_rival_gap > v_threshold then
      select * into v_rival from nl.claims where id = v_rival_id;
      -- Trust does not settle it and the values are materially apart. A
      -- person decides; nothing is promoted and nothing existing is touched.
      insert into nl.context_conflicts
        (subject_kind, subject_id, attribute, scope_key, winner_claim_id, rival_claim_id,
         disagreement, reason)
      values (v_group.subject_kind, v_group.subject_id, v_group.attribute, v_group.scope_key,
              v_win.id, v_rival.id, v_rival_gap,
              format('%s and %s disagree and neither source outranks the other by %s tier(s).',
                     v_win.value_display, v_rival.value_display, v_gap))
      on conflict (subject_kind, subject_id, attribute, scope_key) where status = 'open'
        do update set winner_claim_id = excluded.winner_claim_id,
                      rival_claim_id = excluded.rival_claim_id,
                      disagreement = excluded.disagreement,
                      reason = excluded.reason,
                      updated_at = nl.now_ms();
      v_raised := v_raised + 1;
      continue;
    end if;

    -- The claims that agree with the winner, which is what supports the fact.
    select array_agg(cc.id order by cc.id),
           jsonb_agg(jsonb_build_object(
             'claim_id', cc.id,
             'source_key', cc.source_key,
             'source_name', cc.source_name,
             'trust_tier', cc.trust_tier,
             'locator', cc.locator,
             'snippet', cc.snippet,
             'asserted_at', cc.asserted_at,
             'captured_at', cc.captured_at,
             'extractor', cc.extractor,
             'extractor_version', cc.extractor_version,
             'ref_table', cc.ref_table,
             'ref_id', cc.ref_id,
             'document_title', cc.document_title)
             order by cc.trust_tier desc, cc.asserted_at desc, cc.id)
      into v_support, v_cites
    from nl.claim_candidates cc
    where cc.subject_kind = v_group.subject_kind
      and cc.subject_id = v_group.subject_id
      and cc.attribute = v_group.attribute
      and cc.scope_key = v_group.scope_key
      and cc.confidence >= v_min_conf
      and cc.valid_from <= v_today
      and (cc.valid_to is null or cc.valid_to >= v_today)
      and cc.value_key = v_win.value_key;

    -- Nothing to do when the current fact already says this, from the same
    -- claims. A recompile that changes nothing must not churn versions.
    if v_existing.id is not null
       and v_existing.claim_ids = v_support
       and v_existing.value_display = v_win.value_display then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    if v_existing.id is not null then
      update nl.facts set status = 'superseded' where id = v_existing.id;
    end if;

    insert into nl.facts
      (subject_kind, subject_id, attribute,
       value_text, value_number, value_date, value_bool, value_json, unit, value_display,
       scope_customer_no, scope_ship_to_no, scope_item_no, scope_item_family, scope_vendor_no,
       confidence, claim_ids, citations,
       decided_via, decided_rule, asserted_at, valid_from, valid_to, stale_after,
       superseded_fact_id)
    values
      (v_win.subject_kind, v_win.subject_id, v_win.attribute,
       v_win.value_text, v_win.value_number, v_win.value_date, v_win.value_bool, v_win.value_json,
       v_win.unit, v_win.value_display,
       v_win.scope_customer_no, v_win.scope_ship_to_no, v_win.scope_item_no,
       v_win.scope_item_family, v_win.scope_vendor_no,
       v_win.confidence, v_support, coalesce(v_cites, '[]'),
       'rule',
       format('highest trust tier (%s), then most recent assertion (%s), then most corroborated (%s claim(s))',
              v_win_tier, v_win.asserted_at, cardinality(v_support)),
       v_win.asserted_at, v_win.valid_from, v_win.valid_to,
       v_win.asserted_at + nl.context_horizon(v_win.attribute),
       v_existing.id)
    returning id into v_new_id;

    -- Promoting settles any open conflict about this exact thing.
    update nl.context_conflicts
    set status = 'withdrawn', updated_at = nl.now_ms()
    where subject_kind = v_group.subject_kind and subject_id = v_group.subject_id
      and attribute = v_group.attribute and scope_key = v_group.scope_key
      and status = 'open';

    insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
    values (v_actor.id, 'assistant', 'promote_claim', 'fact', v_new_id::text, p_request_id,
            jsonb_build_object('subject_kind', v_win.subject_kind, 'subject_id', v_win.subject_id,
                               'attribute', v_win.attribute, 'value', v_win.value_display,
                               'claims', v_support, 'superseded', v_existing.id));
    v_promoted := v_promoted + 1;
  end loop;

  v_result := jsonb_build_object('promoted', v_promoted, 'conflicts_raised', v_raised,
                                 'unchanged', v_unchanged, 'held_for_a_person', v_held);
  perform nl.finish_request(v_request, v_result);
  return v_result;
end $$;

-- A person choosing between two claims. Their decision beats the rule and is
-- recorded as theirs, and nl.promote_claims will not undo it.
create function nl.resolve_context_conflict(
  p_conflict_id         bigint,
  p_claim_id            bigint,
  p_note                text,
  p_expected_updated_at timestamptz,
  p_request_id          text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay   jsonb;
  v_actor    nl.users;
  v_conflict nl.context_conflicts;
  v_claim    nl.claims;
  v_existing nl.facts;
  v_cites    jsonb;
  v_new_id   bigint;
  v_result   jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'resolve_context_conflict');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  select * into v_conflict from nl.context_conflicts where id = p_conflict_id;
  if not found then
    raise exception 'Conflict % does not exist.', coalesce(p_conflict_id::text, 'empty') using errcode = 'NL404';
  end if;
  if v_conflict.status <> 'open' then
    raise exception 'That conflict was already settled.' using errcode = 'NL409';
  end if;
  if p_expected_updated_at is not null and v_conflict.updated_at <> p_expected_updated_at then
    raise exception 'This conflict changed while you were looking at it. Reload and decide again.'
      using errcode = 'NL409';
  end if;
  if p_claim_id not in (v_conflict.winner_claim_id, v_conflict.rival_claim_id) then
    raise exception 'A conflict is settled by choosing one of its two claims.' using errcode = 'NL422';
  end if;

  select * into v_claim from nl.claims where id = p_claim_id;

  select jsonb_agg(jsonb_build_object(
           'claim_id', v_claim.id, 'source_key', s.key, 'source_name', s.name,
           'trust_tier', s.trust_tier, 'locator', v_claim.locator, 'snippet', v_claim.snippet,
           'asserted_at', v_claim.asserted_at, 'captured_at', v_claim.captured_at,
           'extractor', v_claim.extractor, 'extractor_version', v_claim.extractor_version,
           'ref_table', d.ref_table, 'ref_id', d.ref_id, 'document_title', d.title))
    into v_cites
  from nl.source_documents d join nl.sources s on s.key = d.source_key
  where d.id = v_claim.source_document_id;

  select * into v_existing from nl.facts f
  where f.subject_kind = v_claim.subject_kind and f.subject_id = v_claim.subject_id
    and f.attribute = v_claim.attribute and f.scope_key = v_claim.scope_key
    and f.status = 'current';
  if v_existing.id is not null then
    update nl.facts set status = 'superseded' where id = v_existing.id;
  end if;

  insert into nl.facts
    (subject_kind, subject_id, attribute,
     value_text, value_number, value_date, value_bool, value_json, unit, value_display,
     scope_customer_no, scope_ship_to_no, scope_item_no, scope_item_family, scope_vendor_no,
     confidence, claim_ids, citations,
     decided_via, decided_rule, decided_by, asserted_at, valid_from, valid_to, stale_after,
     superseded_fact_id)
  values
    (v_claim.subject_kind, v_claim.subject_id, v_claim.attribute,
     v_claim.value_text, v_claim.value_number, v_claim.value_date, v_claim.value_bool,
     v_claim.value_json, v_claim.unit, v_claim.value_display,
     v_claim.scope_customer_no, v_claim.scope_ship_to_no, v_claim.scope_item_no,
     v_claim.scope_item_family, v_claim.scope_vendor_no,
     v_claim.confidence, array[v_claim.id], coalesce(v_cites, '[]'),
     'person', 'a person chose between two claims', v_actor.id,
     v_claim.asserted_at, v_claim.valid_from, v_claim.valid_to,
     v_claim.asserted_at + nl.context_horizon(v_claim.attribute),
     v_existing.id)
  returning id into v_new_id;

  update nl.context_conflicts
  set status = 'resolved', resolved_claim_id = p_claim_id, resolved_by = v_actor.id,
      resolved_at = now(), note = left(coalesce(p_note, ''), 500), updated_at = nl.now_ms()
  where id = p_conflict_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'resolve_context_conflict', 'fact', v_new_id::text, p_request_id,
          jsonb_build_object('conflict_id', p_conflict_id, 'claim_id', p_claim_id,
                             'attribute', v_claim.attribute, 'subject_id', v_claim.subject_id,
                             'value', v_claim.value_display, 'note', left(coalesce(p_note, ''), 500)));

  v_result := jsonb_build_object('fact_id', v_new_id, 'conflict_id', p_conflict_id,
                                 'decided_via', 'person');
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Deciding what an unparsed or failed item was. Dismissing is a decision too,
-- and it is recorded as one.
create function nl.decide_context_review_item(
  p_item_id             bigint,
  p_decision            text,
  p_note                text,
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
  v_item   nl.context_review_items;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'decide_context_review_item');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if p_decision not in ('dismissed', 'resolved') then
    raise exception 'A review item is dismissed or resolved, not %.', coalesce(p_decision, 'empty')
      using errcode = 'NL422';
  end if;
  select * into v_item from nl.context_review_items where id = p_item_id;
  if not found then
    raise exception 'Review item % does not exist.', coalesce(p_item_id::text, 'empty') using errcode = 'NL404';
  end if;
  if v_item.status <> 'open' then
    raise exception 'That item was already decided.' using errcode = 'NL409';
  end if;
  if p_expected_updated_at is not null and v_item.updated_at <> p_expected_updated_at then
    raise exception 'This item changed while you were looking at it. Reload and decide again.'
      using errcode = 'NL409';
  end if;

  update nl.context_review_items
  set status = p_decision, note = left(coalesce(p_note, ''), 500),
      decided_by = v_actor.id, decided_at = now(), updated_at = nl.now_ms()
  where id = p_item_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'decide_context_review_item', 'context_review_item', p_item_id::text,
          p_request_id, jsonb_build_object('decision', p_decision, 'kind', v_item.kind,
                                           'note', left(coalesce(p_note, ''), 500)));

  v_result := jsonb_build_object('item_id', p_item_id, 'decision', p_decision);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 16. Entity resolution: recording a candidate and deciding it
-- ---------------------------------------------------------------------------

create function nl.record_entity_candidate(
  p_raw_kind           text,
  p_raw_value          text,
  p_target_kind        text,
  p_target_id          text,
  p_score              numeric,
  p_evidence           jsonb,
  p_source_document_id bigint,
  p_request_id         text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_id     bigint;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'record_entity_candidate');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if p_raw_kind not in ('name', 'email', 'email_domain', 'phone', 'part_number') then
    raise exception 'A raw value is a name, an email, a domain, a phone number or a part number.'
      using errcode = 'NL422';
  end if;
  if p_raw_value is null or btrim(p_raw_value) = '' then
    raise exception 'A candidate needs the raw value it was matched from.' using errcode = 'NL422';
  end if;

  insert into nl.entity_candidates
    (raw_kind, raw_value, target_kind, target_id, score, evidence, source_document_id)
  values (p_raw_kind, btrim(p_raw_value), p_target_kind, p_target_id,
          least(greatest(coalesce(p_score, 0), 0), 1), coalesce(p_evidence, '{}'), p_source_document_id)
  on conflict (raw_kind, raw_value, target_kind, target_id) do update
    set score = excluded.score, evidence = excluded.evidence
  returning id into v_id;

  v_result := jsonb_build_object('candidate_id', v_id);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Accept or reject a match. A rule may do it when the score is decisive; a
-- person does the rest, and who decided is on the row.
create function nl.decide_entity_link(
  p_raw_kind    text,
  p_raw_value   text,
  p_target_kind text,
  p_target_id   text,
  p_decision    text,
  p_via         text,
  p_score       numeric,
  p_evidence    jsonb,
  p_note        text,
  p_request_id  text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_id     bigint;
  v_claims int := 0;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'decide_entity_link');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if p_decision not in ('accepted', 'rejected') then
    raise exception 'A match is accepted or rejected, not %.', coalesce(p_decision, 'empty')
      using errcode = 'NL422';
  end if;
  if p_via not in ('rule', 'person') then
    raise exception 'A match is decided by a rule or by a person.' using errcode = 'NL422';
  end if;

  -- One accepted link per raw value: accepting a new one withdraws the old.
  if p_decision = 'accepted' then
    delete from nl.entity_links
    where raw_kind = p_raw_kind and raw_value = btrim(p_raw_value) and decision = 'accepted';
  end if;

  insert into nl.entity_links
    (raw_kind, raw_value, target_kind, target_id, decision, decided_via, decided_by,
     score, evidence, note)
  values (p_raw_kind, btrim(p_raw_value), p_target_kind, p_target_id, p_decision, p_via,
          case when p_via = 'person' then v_actor.id end,
          least(greatest(coalesce(p_score, 0), 0), 1), coalesce(p_evidence, '{}'),
          left(coalesce(p_note, ''), 500))
  returning id into v_id;

  -- An accepted link is what unresolved claims were waiting for. Fill their
  -- subject in and let them promote like any other claim.
  if p_decision = 'accepted' then
    with filled as (
      update nl.claims c
      set subject_id = p_target_id,
          status = 'valid',
          subject_confidence = least(greatest(coalesce(p_score, 0.9), 0), 1)
      where c.status = 'unresolved'
        and c.subject_kind = p_target_kind
        and lower(btrim(c.subject_raw)) = lower(btrim(p_raw_value))
      returning c.id)
    select count(*)::int into v_claims from filled;
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, case when p_via = 'person' then 'ui' else 'assistant' end,
          'decide_entity_link', 'entity_link', v_id::text, p_request_id,
          jsonb_build_object('raw_kind', p_raw_kind, 'raw_value', btrim(p_raw_value),
                             'target_kind', p_target_kind, 'target_id', p_target_id,
                             'decision', p_decision, 'claims_resolved', v_claims));

  v_result := jsonb_build_object('link_id', v_id, 'decision', p_decision, 'claims_resolved', v_claims);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 17. Reading one value, with scope precedence
-- ---------------------------------------------------------------------------

-- The value in force for a subject and an attribute, given the part and the
-- ship-to the question is about. MOST SPECIFIC SCOPE WINS, the same shape
-- nl.price_for uses: a part beats a family, a branch beats its billing
-- parent, and a subject-wide value is the fallback. A stale or expired fact
-- does not answer at all.
create function nl.context_value(
  p_subject_kind text,
  p_subject_id   text,
  p_attribute    text,
  p_item_no      text default null,
  p_ship_to_no   text default null
) returns table (
  fact_id       bigint,
  value_display text,
  value_text    text,
  value_number  numeric,
  value_date    date,
  value_bool    boolean,
  value_json    jsonb,
  unit          text,
  scope_key     text,
  specificity   int,
  confidence    numeric,
  decided_via   text,
  asserted_at   date,
  stale_after   date,
  citations     jsonb
)
language sql stable
set search_path = ''
as $$
  select f.id, f.value_display, f.value_text, f.value_number, f.value_date, f.value_bool,
         f.value_json, f.unit, f.scope_key, f.scope_specificity, f.confidence, f.decided_via,
         f.asserted_at, f.stale_after, f.citations
  from nl.fact_state f
  left join nl.items i on i.item_no = p_item_no
  where f.subject_kind = p_subject_kind
    and f.subject_id = p_subject_id
    and f.attribute = p_attribute
    and not f.stale
    and not f.expired
    -- A scope column that is set has to match the question. Null means "all".
    and (f.scope_item_no is null or f.scope_item_no = p_item_no)
    and (f.scope_item_family is null or f.scope_item_family = i.family)
    and (f.scope_ship_to_no is null or f.scope_ship_to_no = p_ship_to_no)
  order by f.scope_specificity desc, f.confidence desc, f.asserted_at desc, f.id desc
  limit 1
$$;

comment on function nl.context_value(text, text, text, text, text) is
  'The value in force, most specific scope first. A stale or expired fact does not answer (migration 0027).';

-- ---------------------------------------------------------------------------
-- 18. Compiling a bundle
-- ---------------------------------------------------------------------------

-- Which playbooks belong to a subject and a purpose. Empty surfaces means
-- every surface; a null scope column means every subject.
create function nl.playbooks_for(p_subject_kind text, p_subject_id text, p_purpose text)
returns setof nl.playbooks
language sql stable
set search_path = ''
as $$
  select p.*
  from nl.playbooks p
  left join nl.customers c on p_subject_kind = 'customer' and c.customer_no = p_subject_id
  left join nl.items i on p_subject_kind = 'item' and i.item_no = p_subject_id
  where p.active
    and (p.subject_kind is null or p.subject_kind = p_subject_kind)
    and (cardinality(p.surfaces) = 0 or p_purpose = any (p.surfaces))
    and (p.scope_customer_no is null
         or (p_subject_kind = 'customer' and p.scope_customer_no = p_subject_id)
         or p.scope_customer_no = c.bill_to_no)
    and (p.scope_vendor_no is null
         or (p_subject_kind = 'vendor' and p.scope_vendor_no = p_subject_id)
         or (p_subject_kind = 'item' and p.scope_vendor_no = i.vendor_no))
    and (p.scope_item_no is null or (p_subject_kind = 'item' and p.scope_item_no = p_subject_id))
    and (p.scope_item_family is null or (p_subject_kind = 'item' and p.scope_item_family = i.family))
  order by p.key
$$;

-- Compile one bundle: the facts above the bar with their citations, the
-- playbooks in scope, and the policy values in force. The version only moves
-- when the content hash moves, which is what makes a recorded version worth
-- recording.
--
-- The disclosure rule, in one place: a fact reaches a bundle when the
-- attribute lists this purpose as a surface AND, if the purpose is external,
-- the attribute is not internal. Being relevant to quoting and being sayable
-- to a customer are different questions.
create function nl.compile_context_bundle(
  p_subject_kind text,
  p_subject_id   text,
  p_purpose      text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_external boolean;
  v_min_conf numeric := nl.context_number('read.min_confidence');
  v_today    date := nl.today();
  v_name     text;
  v_facts    jsonb;
  v_stale    jsonb;
  v_expired  jsonb;
  v_books    jsonb;
  v_payload  jsonb;
  v_hash     text;
  v_current  nl.context_bundles;
  v_version  int;
  v_id       bigint;
  v_counts   jsonb;
begin
  select s.external into v_external from nl.context_surfaces s where s.key = p_purpose;
  if v_external is null then
    raise exception 'There is no surface called %.', coalesce(p_purpose, 'empty') using errcode = 'NL422';
  end if;

  v_name := case p_subject_kind
    when 'customer' then (select c.name from nl.customers c where c.customer_no = p_subject_id)
    when 'vendor'   then (select v.name from nl.vendors v where v.vendor_no = p_subject_id)
    when 'item'     then (select i.description from nl.items i where i.item_no = p_subject_id)
    when 'contact'  then (select ct.full_name from nl.contacts ct where ct.id::text = p_subject_id)
  end;

  -- The facts, most specific scope first per attribute, so a reader taking
  -- the first match per attribute gets the precedence for free.
  select jsonb_agg(row_to_json(x)::jsonb order by x.attribute, x.specificity desc, x.confidence desc)
    into v_facts
  from (
    select f.attribute, f.attribute_label as label, f.value_display, f.value_text, f.value_number,
           f.value_date, f.value_bool, f.value_json, f.unit, f.value_type,
           f.scope_key, f.scope_customer_no, f.scope_ship_to_no, f.scope_item_no,
           f.scope_item_family, f.scope_vendor_no, f.scope_specificity as specificity,
           f.confidence, f.decided_via, f.disclosure, f.asserted_at, f.valid_from, f.valid_to,
           f.stale_after, f.id as fact_id, f.citations
    from nl.fact_state f
    where f.subject_kind = p_subject_kind
      and f.subject_id = p_subject_id
      and f.confidence >= v_min_conf
      and not f.stale
      and not f.expired
      and p_purpose = any (f.surfaces)
      and (not v_external or f.disclosure <> 'internal')
  ) x;

  -- What has gone stale and what has expired are reported, not served. A gap
  -- an agent can see is a gap it can ask about.
  select jsonb_agg(jsonb_build_object('attribute', f.attribute, 'label', f.attribute_label,
                                      'value_display', f.value_display, 'asserted_at', f.asserted_at,
                                      'stale_after', f.stale_after, 'days_stale', f.days_stale)
                   order by f.days_stale desc)
    into v_stale
  from nl.fact_state f
  where f.subject_kind = p_subject_kind and f.subject_id = p_subject_id
    and f.stale and not f.expired and p_purpose = any (f.surfaces);

  select jsonb_agg(jsonb_build_object('attribute', f.attribute, 'label', f.attribute_label,
                                      'value_display', f.value_display, 'valid_to', f.valid_to)
                   order by f.valid_to desc)
    into v_expired
  from nl.fact_state f
  where f.subject_kind = p_subject_kind and f.subject_id = p_subject_id
    and f.expired and p_purpose = any (f.surfaces);

  select jsonb_agg(jsonb_build_object('key', p.key, 'title', p.title, 'body', p.body,
                                      'version', p.version, 'reviewed_at', p.reviewed_at)
                   order by p.key)
    into v_books
  from nl.playbooks_for(p_subject_kind, p_subject_id, p_purpose) p
  where not v_external or p.disclosure <> 'internal';

  -- The hash covers the CONTENT and nothing else. built_at and the version
  -- are deliberately outside it, or every recompile would look like a change.
  v_payload := jsonb_build_object(
    'subject', jsonb_build_object('kind', p_subject_kind, 'id', p_subject_id, 'name', v_name),
    'purpose', p_purpose,
    'external', v_external,
    'facts', coalesce(v_facts, '[]'),
    'stale', coalesce(v_stale, '[]'),
    'expired', coalesce(v_expired, '[]'),
    'playbooks', coalesce(v_books, '[]'),
    'policy', jsonb_build_object(
      'read_min_confidence', v_min_conf,
      'promotion_min_confidence', nl.context_number('promotion.min_confidence'),
      'trust_gap_min', nl.context_number('promotion.trust_gap_min'),
      'conflict_threshold', nl.context_number('promotion.conflict_threshold')));

  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(v_payload::text, 'UTF8')), 'hex');

  select * into v_current from nl.context_bundles b
  where b.subject_kind = p_subject_kind and b.subject_id = p_subject_id
    and b.purpose = p_purpose and b.is_current;

  v_counts := jsonb_build_object(
    'facts', jsonb_array_length(coalesce(v_facts, '[]')),
    'stale', jsonb_array_length(coalesce(v_stale, '[]')),
    'expired', jsonb_array_length(coalesce(v_expired, '[]')),
    'playbooks', jsonb_array_length(coalesce(v_books, '[]')),
    'compiled_on', v_today);

  -- Nothing changed: move built_at so the age is honest, keep the version.
  if v_current.id is not null and v_current.content_hash = v_hash then
    update nl.context_bundles
    set built_at = now(), inputs = v_counts
    where id = v_current.id;
    return jsonb_build_object('bundle_id', v_current.id, 'version', v_current.version,
                              'content_hash', v_hash, 'changed', false);
  end if;

  v_version := coalesce(v_current.version, 0) + 1;
  update nl.context_bundles set is_current = false
  where subject_kind = p_subject_kind and subject_id = p_subject_id
    and purpose = p_purpose and is_current;

  insert into nl.context_bundles
    (subject_kind, subject_id, purpose, version, content_hash, payload, inputs, is_current)
  values (p_subject_kind, p_subject_id, p_purpose, v_version, v_hash, v_payload, v_counts, true)
  returning id into v_id;

  return jsonb_build_object('bundle_id', v_id, 'version', v_version,
                            'content_hash', v_hash, 'changed', true);
end $$;

-- Recompile every purpose for one subject. Called after a promotion, a
-- playbook edit, a policy change or a staleness tick.
create function nl.compile_context_bundles(p_subject_kind text, p_subject_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_surface record;
  v_one     jsonb;
  v_changed int := 0;
  v_same    int := 0;
begin
  for v_surface in select key from nl.context_surfaces order by key loop
    v_one := nl.compile_context_bundle(p_subject_kind, p_subject_id, v_surface.key);
    if (v_one ->> 'changed')::boolean then
      v_changed := v_changed + 1;
    else
      v_same := v_same + 1;
    end if;
  end loop;
  return jsonb_build_object('changed', v_changed, 'unchanged', v_same);
end $$;

-- ---------------------------------------------------------------------------
-- 19. The agents' read path
-- ---------------------------------------------------------------------------

-- What an agent calls instead of assembling context itself. It SERVES the
-- compiled bundle: one index lookup and a jsonb read, so it answers in
-- single-digit milliseconds on any size of world.
--
-- Three answers are possible, and they are different things:
--   served true                the bundle is here, with its version and age
--   served true, stale true    the mill has not refreshed lately. Still
--                              served, and it says how old it is, because an
--                              agent running on the last good context and
--                              saying so beats an agent guessing
--   served false               there is nothing above the bar: either no
--                              bundle was ever compiled, or everything this
--                              purpose needs has expired. It refuses rather
--                              than handing back an empty object that reads
--                              like "we know nothing is required".
create function nl.context_for(
  p_entity_kind text,
  p_entity_id   text,
  p_purpose     text default null
) returns jsonb
language sql stable
set search_path = ''
as $$
  select case
    when b.id is null then
      jsonb_build_object(
        'served', false,
        'reason', format('No context has been compiled for %s %s for %s yet.',
                         p_entity_kind, p_entity_id, coalesce(p_purpose, 'internal_review')),
        'subject', jsonb_build_object('kind', p_entity_kind, 'id', p_entity_id),
        'purpose', coalesce(p_purpose, 'internal_review'))
    when jsonb_array_length(b.payload -> 'facts') = 0
         and jsonb_array_length(b.payload -> 'expired') > 0 then
      jsonb_build_object(
        'served', false,
        'reason', 'Everything we knew for this purpose has expired. It needs verifying before it is used.',
        'bundle_version', b.version,
        'content_hash', b.content_hash,
        'built_at', b.built_at,
        'expired', b.payload -> 'expired',
        'subject', b.payload -> 'subject',
        'purpose', b.purpose)
    else
      b.payload
      || jsonb_build_object(
           'served', true,
           'bundle_id', b.id,
           'bundle_version', b.version,
           'content_hash', b.content_hash,
           'built_at', b.built_at,
           'age_hours', round(extract(epoch from (now() - b.built_at)) / 3600.0, 1),
           -- The mill is behind. The bundle is still the last good context,
           -- and saying so is the point.
           'bundle_stale', b.built_at < now() - interval '36 hours')
  end
  from (select 1) one
  left join nl.context_bundles b
    on b.subject_kind = p_entity_kind
   and b.subject_id = p_entity_id
   and b.purpose = coalesce(p_purpose, 'internal_review')
   and b.is_current
$$;

comment on function nl.context_for(text, text, text) is
  'The compiled context bundle for one subject and purpose: facts above the bar with their citations, the playbooks in scope, the policy in force, and its version. What agents read instead of assembling context themselves (migration 0027).';

-- One exact version, so an eval replays against a frozen bundle rather than
-- a moving database.
create function nl.context_bundle_version(
  p_entity_kind text,
  p_entity_id   text,
  p_purpose     text,
  p_version     int
) returns jsonb
language sql stable
set search_path = ''
as $$
  select b.payload || jsonb_build_object('served', true, 'bundle_id', b.id,
                                         'bundle_version', b.version,
                                         'content_hash', b.content_hash, 'built_at', b.built_at,
                                         'frozen', true)
  from nl.context_bundles b
  where b.subject_kind = p_entity_kind and b.subject_id = p_entity_id
    and b.purpose = p_purpose and b.version = p_version
$$;

-- Record which bundle version an agent action read. One row, no locking: it
-- is an append-only note about something that already happened.
create function nl.record_context_read(
  p_entity_kind text,
  p_entity_id   text,
  p_purpose     text,
  p_version     int,
  p_action      text,
  p_entity      text,
  p_entity_row  text,
  p_via         text
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor  nl.users;
  v_bundle nl.context_bundles;
  v_id     bigint;
begin
  v_actor := nl.require_active_user();

  select * into v_bundle from nl.context_bundles b
  where b.subject_kind = p_entity_kind and b.subject_id = p_entity_id
    and b.purpose = p_purpose
    and ((p_version is null and b.is_current) or b.version = p_version)
  order by b.version desc
  limit 1;
  if not found then
    raise exception 'There is no bundle % for % % at %.', coalesce(p_version::text, 'current'),
      p_entity_kind, p_entity_id, p_purpose using errcode = 'NL404';
  end if;

  insert into nl.context_reads
    (bundle_id, bundle_version, content_hash, subject_kind, subject_id, purpose,
     action, entity, entity_id, actor_id, via)
  values (v_bundle.id, v_bundle.version, v_bundle.content_hash, p_entity_kind, p_entity_id,
          p_purpose, left(coalesce(p_action, 'unknown'), 60), left(coalesce(p_entity, ''), 60),
          left(coalesce(p_entity_row, ''), 60), v_actor.id,
          case when p_via in ('ui', 'agent', 'assistant', 'nightly', 'mcp') then p_via else 'agent' end)
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- 20. The scheduled context build
-- ---------------------------------------------------------------------------

-- What the existing cron pattern calls. It works through the coverage gaps
-- for the subjects that matter most, in weight order, and it does only what
-- SQL can do: promote what is now promotable, and recompile the bundles that
-- changed. The exploring itself is the application's job
-- (app/src/lib/server/context/build.ts), because reading mail bodies and
-- attachments is not SQL's work.
create function nl.context_build(p_subject_limit int default 25, p_request_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind     record;
  v_subject  record;
  v_promote  jsonb;
  v_promoted int := 0;
  v_raised   int := 0;
  v_changed  int := 0;
  v_subjects int := 0;
  v_base     text := coalesce(p_request_id, 'context-build-' || pg_catalog.gen_random_uuid()::text);
begin
  perform nl.require_active_user();

  for v_kind in select distinct a.subject_kind from nl.context_attributes a where a.active loop
    for v_subject in select * from nl.context_subjects(v_kind.subject_kind, p_subject_limit) loop
      v_subjects := v_subjects + 1;
      v_promote := nl.promote_claims(
        v_kind.subject_kind, v_subject.subject_id, null,
        left(format('%s-%s-%s', v_base, v_kind.subject_kind, v_subject.subject_id), 100));
      v_promoted := v_promoted + coalesce((v_promote ->> 'promoted')::int, 0);
      v_raised := v_raised + coalesce((v_promote ->> 'conflicts_raised')::int, 0);
      v_changed := v_changed
        + coalesce((nl.compile_context_bundles(v_kind.subject_kind, v_subject.subject_id) ->> 'changed')::int, 0);
    end loop;
  end loop;

  return jsonb_build_object('subjects', v_subjects, 'promoted', v_promoted,
                            'conflicts_raised', v_raised, 'bundles_changed', v_changed);
end $$;

-- ---------------------------------------------------------------------------
-- 21. Registering a source and a document
-- ---------------------------------------------------------------------------

create function nl.register_source(
  p_key               text,
  p_kind              text,
  p_name              text,
  p_trust_tier        int,
  p_refresh_cadence   text,
  p_authoritative_for text
) returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform nl.require_active_user();
  if p_trust_tier is null or p_trust_tier < 1 or p_trust_tier > 5 then
    raise exception 'A trust tier runs from 1 (a spreadsheet from 2023) to 5 (the ERP''s own export).'
      using errcode = 'NL422';
  end if;
  insert into nl.sources (key, kind, name, trust_tier, refresh_cadence, authoritative_for)
  values (p_key, p_kind, p_name, p_trust_tier, coalesce(p_refresh_cadence, ''),
          coalesce(p_authoritative_for, ''))
  on conflict (key) do update
    set kind = excluded.kind, name = excluded.name, trust_tier = excluded.trust_tier,
        refresh_cadence = excluded.refresh_cadence,
        authoritative_for = excluded.authoritative_for;
  return p_key;
end $$;

-- Register one thing we read. The pointer home is ref_table and ref_id;
-- nothing is copied. Registering the same document twice returns the same id.
create function nl.register_source_document(
  p_source_key   text,
  p_external_ref text,
  p_title        text,
  p_received_at  timestamptz,
  p_media_type   text,
  p_sha256       text,
  p_ref_table    text,
  p_ref_id       text
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id bigint;
begin
  perform nl.require_active_user();
  if not exists (select 1 from nl.sources s where s.key = p_source_key) then
    raise exception 'There is no source called %.', coalesce(p_source_key, 'empty') using errcode = 'NL404';
  end if;

  insert into nl.source_documents
    (source_key, external_ref, title, received_at, media_type, sha256, ref_table, ref_id)
  values (p_source_key, left(p_external_ref, 200), left(coalesce(p_title, ''), 300),
          coalesce(p_received_at, now()), coalesce(p_media_type, 'text/plain'),
          coalesce(p_sha256,
                   pg_catalog.encode(
                     pg_catalog.sha256(pg_catalog.convert_to(coalesce(p_external_ref, ''), 'UTF8')), 'hex')),
          coalesce(p_ref_table, ''), coalesce(p_ref_id, ''))
  on conflict (source_key, external_ref) do update
    set title = excluded.title, received_at = excluded.received_at,
        media_type = excluded.media_type, sha256 = excluded.sha256,
        ref_table = excluded.ref_table, ref_id = excluded.ref_id
  returning id into v_id;

  update nl.sources set last_seen_at = greatest(coalesce(last_seen_at, 'epoch'::timestamptz),
                                                coalesce(p_received_at, now()))
  where key = p_source_key;

  return v_id;
end $$;

-- A person typing what they know, outside any other feature: the hand entry
-- the brief calls for. It registers its own source document in the same
-- transaction, because an entry nothing can cite is an entry nothing can use,
-- and the adapter that would pick it up later runs on a schedule.
create function nl.add_context_entry(
  p_subject_kind text,
  p_subject_id   text,
  p_body         text,
  p_request_id   text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_id     bigint;
  v_doc    bigint;
  v_name   text;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'add_context_entry');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();

  if p_subject_kind is null or p_subject_kind not in ('customer', 'contact', 'vendor', 'item') then
    raise exception 'An entry is about a customer, a contact, a vendor or an item, not %.',
      coalesce(p_subject_kind, 'nothing') using errcode = 'NL422';
  end if;
  if p_body is null or btrim(p_body) = '' or length(p_body) > 4000 then
    raise exception 'An entry needs between 1 and 4,000 characters.' using errcode = 'NL422';
  end if;

  -- The subject has to be in the book. An entry about nobody is a note to
  -- self, and this is not the place for one.
  v_name := case p_subject_kind
    when 'customer' then (select c.name from nl.customers c where c.customer_no = p_subject_id)
    when 'vendor'   then (select v.name from nl.vendors v where v.vendor_no = p_subject_id)
    when 'item'     then (select i.description from nl.items i where i.item_no = p_subject_id)
    when 'contact'  then (select ct.full_name from nl.contacts ct where ct.id::text = p_subject_id)
  end;
  if v_name is null then
    raise exception 'There is no % called % in the book.', p_subject_kind,
      coalesce(p_subject_id, 'nothing') using errcode = 'NL404';
  end if;

  insert into nl.context_entries (subject_kind, subject_id, body, author_id)
  values (p_subject_kind, p_subject_id, btrim(p_body), v_actor.id)
  returning id into v_id;

  v_doc := nl.register_source_document(
    'hand_entry', 'entry-' || v_id::text,
    format('Hand entry about %s %s', p_subject_kind, p_subject_id),
    now(), 'text/plain', null, 'context_entries', v_id::text);

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'add_context_entry', 'context_entry', v_id::text, p_request_id,
          jsonb_build_object('subject_kind', p_subject_kind, 'subject_id', p_subject_id,
                             'source_document_id', v_doc));

  v_result := jsonb_build_object('entry_id', v_id, 'source_document_id', v_doc);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Revoke an extractor version. Its claims stay on the record and stop
-- counting toward promotion from the next build onward.
create function nl.revoke_extractor(p_name text, p_version text, p_note text, p_request_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_claims int;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'revoke_extractor');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  if not nl.is_admin() then
    raise exception 'Revoking an extractor is an administrator''s call.' using errcode = 'NL403';
  end if;

  insert into nl.extractors (name, version, kind, note, revoked_at, revoked_by)
  values (p_name, p_version, 'model', left(coalesce(p_note, ''), 500), now(), v_actor.id)
  on conflict (name, version) do update
    set revoked_at = now(), revoked_by = v_actor.id, note = left(coalesce(p_note, ''), 500);

  select count(*)::int into v_claims from nl.claims c
  where c.extractor = p_name and c.extractor_version = p_version;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'revoke_extractor', 'extractor', p_name || '@' || p_version, p_request_id,
          jsonb_build_object('claims', v_claims, 'note', left(coalesce(p_note, ''), 500)));

  v_result := jsonb_build_object('extractor', p_name, 'version', p_version, 'claims', v_claims);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 22. Access
-- ---------------------------------------------------------------------------

-- Every table here is the team's shared record: everyone signed in reads it,
-- and NOBODY is granted insert, update or delete on any of them. The only way
-- a row changes is through one of the functions above, which check the rules,
-- claim a request id and write an audit row. That makes "a claim cannot be
-- written without a citation" a property of the schema rather than a habit of
-- the code above it.
--
-- nl_readonly (the assistant's SQL role) gets nothing at all: a snippet is a
-- verbatim quote out of somebody's mail, and quite often it names a person.

alter table nl.context_defaults        enable row level security;
alter table nl.context_surfaces        enable row level security;
alter table nl.context_attributes      enable row level security;
alter table nl.sources                 enable row level security;
alter table nl.source_documents        enable row level security;
alter table nl.source_document_pages   enable row level security;
alter table nl.legacy_crm_rows         enable row level security;
alter table nl.mail_archive            enable row level security;
alter table nl.context_entries         enable row level security;
alter table nl.extractors              enable row level security;
alter table nl.claims                  enable row level security;
alter table nl.context_review_items    enable row level security;
alter table nl.entity_candidates       enable row level security;
alter table nl.entity_links            enable row level security;
alter table nl.facts                   enable row level security;
alter table nl.context_conflicts       enable row level security;
alter table nl.playbooks               enable row level security;
alter table nl.context_bundles         enable row level security;
alter table nl.context_reads           enable row level security;

create policy context_defaults_read      on nl.context_defaults      for select to nl_app using (true);
create policy context_surfaces_read      on nl.context_surfaces      for select to nl_app using (true);
create policy context_attributes_read    on nl.context_attributes    for select to nl_app using (true);
create policy sources_read               on nl.sources               for select to nl_app using (true);
create policy source_documents_read      on nl.source_documents      for select to nl_app using (true);
create policy source_document_pages_read on nl.source_document_pages for select to nl_app using (true);
create policy legacy_crm_rows_read       on nl.legacy_crm_rows       for select to nl_app using (true);
create policy mail_archive_read          on nl.mail_archive          for select to nl_app using (true);
create policy context_entries_read       on nl.context_entries       for select to nl_app using (true);
create policy extractors_read            on nl.extractors            for select to nl_app using (true);
create policy claims_read                on nl.claims                for select to nl_app using (true);
create policy context_review_items_read  on nl.context_review_items  for select to nl_app using (true);
create policy entity_candidates_read     on nl.entity_candidates     for select to nl_app using (true);
create policy entity_links_read          on nl.entity_links          for select to nl_app using (true);
create policy facts_read                 on nl.facts                 for select to nl_app using (true);
create policy context_conflicts_read     on nl.context_conflicts     for select to nl_app using (true);
create policy playbooks_read             on nl.playbooks             for select to nl_app using (true);
create policy context_bundles_read       on nl.context_bundles       for select to nl_app using (true);
create policy context_reads_read         on nl.context_reads         for select to nl_app using (true);

grant select on
  nl.context_defaults, nl.context_surfaces, nl.context_attributes, nl.sources,
  nl.source_documents, nl.source_document_pages, nl.legacy_crm_rows, nl.mail_archive,
  nl.context_entries,
  nl.extractors, nl.claims, nl.context_review_items, nl.entity_candidates, nl.entity_links,
  nl.facts, nl.context_conflicts, nl.playbooks, nl.context_bundles, nl.context_reads
to nl_app;

grant select on nl.claim_candidates, nl.fact_state to nl_app;

grant execute on function
  nl.context_setting(text),
  nl.context_number(text),
  nl.context_attribute_surfaces_ok(text[]),
  nl.context_horizon(text),
  nl.source_document_text(bigint),
  nl.context_subjects(text, int),
  nl.context_coverage(int),
  nl.context_gaps(text, text, int),
  nl.check_claim_value(text, text, numeric, date, boolean, jsonb, text, text, text, text),
  nl.record_claim(text, text, text, text, text, numeric, date, boolean, jsonb, text, text,
                  text, text, text, text, text, date, date, date, bigint, text, text, text, text,
                  numeric, numeric, numeric, text),
  nl.record_unparsed(bigint, text, text, text, text, text, text, text, text, text, text),
  nl.claim_disagreement(nl.claims, nl.claims),
  nl.promote_claims(text, text, text, text),
  nl.resolve_context_conflict(bigint, bigint, text, timestamptz, text),
  nl.decide_context_review_item(bigint, text, text, timestamptz, text),
  nl.record_entity_candidate(text, text, text, text, numeric, jsonb, bigint, text),
  nl.decide_entity_link(text, text, text, text, text, text, numeric, jsonb, text, text),
  nl.context_value(text, text, text, text, text),
  nl.playbooks_for(text, text, text),
  nl.compile_context_bundle(text, text, text),
  nl.compile_context_bundles(text, text),
  nl.context_for(text, text, text),
  nl.context_bundle_version(text, text, text, int),
  nl.record_context_read(text, text, text, int, text, text, text, text),
  nl.context_build(int, text),
  nl.register_source(text, text, text, int, text, text),
  nl.register_source_document(text, text, text, timestamptz, text, text, text, text),
  nl.add_context_entry(text, text, text, text),
  nl.revoke_extractor(text, text, text, text)
to nl_app;
