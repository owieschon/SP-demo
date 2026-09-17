-- 0020 Documents: the files a customer actually sends in, and the quote
-- document that goes back out.
--
-- Two halves, one idea: a request for quote arrives as attachments, and a
-- quote leaves as a document. Neither half invents a number.
--
--   nl.rfq_attachments      the bytes of every file read into a draft, with
--                           what was read out of it (pages, sheets, rows)
--   nl.rfq_attachment_index the same rows without the bytes, for listing
--   nl.quote_document       one row per quote with its subtotal, so the web
--                           page and the PDF cannot disagree
--
-- The rules that shape this migration:
--   * A file is stored as bytes and nothing else is trusted about it. The
--     media type is fixed by the server from the kind it detected, never
--     taken from what the browser claimed, and a check constraint here holds
--     the pair together.
--   * The stored hash always describes the stored bytes: this function
--     computes the SHA-256 itself and refuses a hash that disagrees.
--   * The same file twice is recognized, not stored twice.
--   * An attachment is part of a customer's email, so it is as private as
--     the draft it belongs to: its creator, or an admin. nl_readonly (the
--     assistant's SQL role) gets nothing at all.
--
-- Depends on 0001 to 0011.

-- ---------------------------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------------------------

create table nl.rfq_attachments (
  id          bigint generated always as identity (start with 9001) primary key,
  draft_id    bigint not null references nl.rfq_drafts (id) on delete cascade,
  -- Where it sat in the upload, so a line can say "attachment 2".
  ordinal     int not null check (ordinal between 1 and 4),
  -- The name as uploaded, kept for display only. It is never used to decide
  -- what the file is, and never used to build a path.
  file_name   text not null check (length(file_name) between 1 and 200),
  -- What the server decided the file is, from its bytes and its extension.
  kind        text not null check (kind in ('txt', 'eml', 'pdf', 'xlsx', 'xls', 'csv')),
  media_type  text not null,
  byte_size   int not null check (byte_size between 1 and 10485760),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  -- What was read out of it. Null where the format has no such thing.
  page_count  int check (page_count > 0),
  sheet_count int check (sheet_count > 0),
  row_count   int check (row_count >= 0),
  -- One short line for the panel: "3 sheets, 42 rows".
  summary     text not null default '',
  bytes       bytea not null,
  created_by  int not null references nl.users (id),
  created_at  timestamptz not null default now(),
  -- The media type is the one this kind is served as, always. A file that
  -- claimed to be something else cannot get its claim stored.
  constraint rfq_attachments_media_type_matches_kind check (
    (kind, media_type) in (
      ('txt',  'text/plain'),
      ('eml',  'message/rfc822'),
      ('pdf',  'application/pdf'),
      ('xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      ('xls',  'application/vnd.ms-excel'),
      ('csv',  'text/csv'))),
  -- The same bytes are read into a draft once.
  constraint rfq_attachments_one_per_draft unique (draft_id, sha256),
  constraint rfq_attachments_one_ordinal unique (draft_id, ordinal)
);

comment on table nl.rfq_attachments is
  'The files read into an RFQ draft, bytes and all. As private as the draft (migration 0020).';
comment on column nl.rfq_attachments.bytes is
  'The file exactly as uploaded. Never select this column in a list query; read nl.rfq_attachment_index instead.';

create index rfq_attachments_draft_idx on nl.rfq_attachments (draft_id, ordinal);
-- "Have I read this file before?" across a person's own drafts.
create index rfq_attachments_sha_idx on nl.rfq_attachments (sha256);

-- Everything except the bytes. Listing a draft's attachments should never
-- pull ten megabytes through the connection to count its pages.
create view nl.rfq_attachment_index with (security_invoker = true) as
  select a.id, a.draft_id, a.ordinal, a.file_name, a.kind, a.media_type,
         a.byte_size, a.sha256, a.page_count, a.sheet_count, a.row_count,
         a.summary, a.created_by, a.created_at
  from nl.rfq_attachments a;

comment on view nl.rfq_attachment_index is
  'nl.rfq_attachments without the bytes column, for lists and panels (migration 0020).';

-- ---------------------------------------------------------------------------
-- Storing one file
-- ---------------------------------------------------------------------------

-- The bytes arrive as base64 text, because that is what both drivers send as
-- an ordinary parameter without any type guessing (see DECISIONS.md on the
-- jsonb parameters, same reason).
--
-- Returns {attachment_id, duplicate}. A file already read into this draft
-- gives duplicate = true and writes nothing.
create function nl.add_rfq_attachment(
  p_draft_id    bigint,
  p_ordinal    int,
  p_file_name   text,
  p_kind        text,
  p_media_type  text,
  p_bytes_b64   text,
  p_sha256      text,
  p_page_count  int,
  p_sheet_count int,
  p_row_count   int,
  p_summary     text,
  p_request_id  text
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay   jsonb;
  v_actor    nl.users;
  v_draft    nl.rfq_drafts;
  v_bytes    bytea;
  v_hash     text;
  v_existing bigint;
  v_held     int;
  v_id       bigint;
  v_result   jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'add_rfq_attachment');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  -- Row-level security hides other people's drafts, so "does not exist"
  -- covers both a wrong id and someone else's draft.
  select * into v_draft from nl.rfq_drafts where id = p_draft_id for update;
  if not found then
    raise exception 'Draft R-% does not exist.', p_draft_id using errcode = 'NL404';
  end if;
  if v_draft.created_by <> v_actor.id and v_actor.role <> 'admin' then
    raise exception 'Only the person who made draft R-% or an admin can add a file to it.', p_draft_id
      using errcode = 'NL403';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'Draft R-% is already %; no more files can be added.', p_draft_id, v_draft.status
      using errcode = 'NL422';
  end if;

  if p_bytes_b64 is null or length(p_bytes_b64) = 0 then
    raise exception 'The file % is empty.', coalesce(p_file_name, '(no name)') using errcode = 'NL422';
  end if;

  v_bytes := decode(p_bytes_b64, 'base64');
  if octet_length(v_bytes) > 10485760 then
    raise exception 'The file % is larger than 10 MB.', p_file_name using errcode = 'NL422';
  end if;

  -- The hash describes the stored bytes, always. Computing it here means a
  -- caller cannot store a hash that belongs to a different file.
  v_hash := encode(pg_catalog.sha256(v_bytes), 'hex');
  if p_sha256 is not null and p_sha256 <> v_hash then
    raise exception 'The checksum sent for % does not match the file.', p_file_name using errcode = 'NL422';
  end if;

  -- Already read into this draft: say so and write nothing.
  select id into v_existing from nl.rfq_attachments
  where draft_id = p_draft_id and sha256 = v_hash;
  if found then
    v_result := jsonb_build_object('attachment_id', v_existing, 'duplicate', true);
    perform nl.finish_request(p_request_id, v_result);
    return v_result;
  end if;

  select count(*)::int into v_held from nl.rfq_attachments where draft_id = p_draft_id;
  if v_held >= 4 then
    raise exception 'Draft R-% already holds four files, which is the most it can hold.', p_draft_id
      using errcode = 'NL422';
  end if;

  insert into nl.rfq_attachments (draft_id, ordinal, file_name, kind, media_type, byte_size, sha256,
                                  page_count, sheet_count, row_count, summary, bytes, created_by)
  values (p_draft_id, p_ordinal, left(p_file_name, 200), p_kind, p_media_type, octet_length(v_bytes), v_hash,
          p_page_count, p_sheet_count, p_row_count, left(coalesce(p_summary, ''), 200), v_bytes, v_actor.id)
  returning id into v_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, 'ui', 'add_rfq_attachment', 'rfq_attachment', v_id::text, p_request_id,
          jsonb_build_object(
            'draft_id', p_draft_id,
            'file_name', left(p_file_name, 200),
            'kind', p_kind,
            'byte_size', octet_length(v_bytes),
            'sha256', v_hash,
            'summary', left(coalesce(p_summary, ''), 200)));

  v_result := jsonb_build_object('attachment_id', v_id, 'duplicate', false);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- The quote as a document
-- ---------------------------------------------------------------------------

-- One row per quote, with the subtotal derived from its lines. The web page
-- and the PDF both read this, so they cannot disagree about a total.
create view nl.quote_document with (security_invoker = true) as
  select q.id,
         q.customer_no,
         cu.name as customer_name,
         cu.city as customer_city,
         cu.state as customer_state,
         cu.country as customer_country,
         cu.ships_own_carrier,
         pg.code as price_group,
         pg.label as price_group_label,
         q.contact_id,
         ct.full_name as contact_name,
         ct.title as contact_title,
         ct.email as contact_email,
         q.commitment_id,
         q.quoted_on,
         q.valid_until,
         q.source,
         q.created_by,
         u.full_name as created_by_name,
         coalesce(l.line_count, 0) as line_count,
         coalesce(l.subtotal, 0)::numeric(14, 2) as subtotal
  from nl.quotes q
  join nl.customers cu on cu.customer_no = q.customer_no
  join nl.price_groups pg on pg.code = cu.price_group
  join nl.users u on u.id = q.created_by
  left join nl.contacts ct on ct.id = q.contact_id
  left join lateral (
    select count(*)::int as line_count, sum(ql.quantity * ql.unit_price) as subtotal
    from nl.quote_lines ql
    where ql.quote_id = q.id) l on true;

comment on view nl.quote_document is
  'A quote with its subtotal, read by both the quote page and the quote PDF (migration 0020).';

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.rfq_attachments enable row level security;

-- An attachment is part of a customer's email: as private as its draft. The
-- draft's own policy would already hide the row, and saying it again here
-- keeps the rule readable where the table is.
create policy rfq_attachments_read on nl.rfq_attachments for select to nl_app
  using (exists (
    select 1 from nl.rfq_drafts d
    where d.id = draft_id
      and (d.created_by = (select nl.current_user_id()) or (select nl.is_admin()))));

create policy rfq_attachments_insert on nl.rfq_attachments for insert to nl_app
  with check (
    created_by = (select nl.current_user_id())
    and exists (
      select 1 from nl.rfq_drafts d
      where d.id = draft_id
        and d.status = 'draft'
        and (d.created_by = (select nl.current_user_id()) or (select nl.is_admin()))));

grant select, insert on nl.rfq_attachments to nl_app;
grant select on nl.rfq_attachment_index to nl_app;
-- Quotes are already readable by any signed-in user (migration 0003), and the
-- view adds nothing that was not; the assistant's read-only role may read
-- quotes too, but not the contact columns, so it is not granted here.
grant select on nl.quote_document to nl_app;
-- nl_readonly gets nothing on either: attachments are customers' files, and
-- nl.quote_document carries a named buyer's email address.

grant execute on function
  nl.add_rfq_attachment(bigint, int, text, text, text, text, text, int, int, int, text, text)
to nl_app;
