-- 0033 Certification, qualification and traceability: the paperwork that
-- decides whether a part may ship.
--
-- In plenty of this trade the paperwork is the product. A part with no
-- certificate cannot ship, whatever is on the shelf. "What heat was this
-- made from" is an ordinary question, asked years after the invoice, and the
-- answer has to be a document with a number on it rather than a memory.
--
-- What this migration adds:
--
--   nl.certificate_types      the kinds of paper: certificate of conformance,
--                             mill certificate or material test report,
--                             first article inspection report, weld
--                             procedure qualification, calibration
--                             certificate, restricted substance declaration,
--                             country of melt statement
--   nl.documents              one row per document, with its number, who
--                             issued it, when, when it expires, and a
--                             SHA-256 of the file. The bytes are optional
--                             and usually absent, the same way
--                             nl.rfq_attachments keeps them but nothing
--                             requires them.
--   nl.lots                   a received or produced quantity with a heat
--                             number, a mill, a country of melt, a vendor
--                             lot number and the receipt it came in on
--   nl.lot_documents          the certificates that belong to a lot
--   nl.item_documents         the certificates that belong to a part rather
--                             than to any one lot (a first article report, a
--                             weld procedure)
--   nl.lot_consumption        which child lots went into which parent lot,
--                             and how much. This is the genealogy.
--   nl.shipment_line_lots     which lot each shipped line came out of, which
--                             is what connects the genealogy to a customer
--   nl.part_qualifications    a customer has approved this part from this
--                             source
--   nl.supplier_qualifications  the approved source list, per part
--   nl.operator_qualifications  a welder qualified to a procedure, with an
--                             expiry
--   nl.gauges, nl.calibrations  equipment with a calibration due date
--   nl.document_requirements  what a customer, an order or a part requires
--                             in the package, what it adds to the price and
--                             how many days it adds to the promise
--
-- WHY PAPERWORK HANGS OFF A LOT AND NOT OFF A PART. A mill certificate is
-- about a particular pour of steel on a particular day, not about the part
-- number it later became. Two lots of the same part number can come from
-- different mills in different countries, one of them acceptable to a
-- customer and one not. Put the certificate on the part and that distinction
-- is gone, and with it the ability to answer the only question that matters
-- in a recall: which customers got metal from this heat. So certificates
-- attach to lots, and the few that really are about the part rather than the
-- material (a first article report, a weld procedure qualification) attach
-- to the part through nl.item_documents, which is a different table on
-- purpose.
--
-- THE GUARDRAIL. nl.shipments already moves through picking, packed,
-- awaiting carrier and shipped (migration 0019). A trigger here refuses the
-- last step when the document package the shipment owes is incomplete, and
-- the refusal names exactly what is missing. It is a trigger rather than a
-- change to nl.advance_shipment() so that the warehouse code keeps its one
-- owner, and so that nothing can get around it by writing the table
-- directly.

-- ---------------------------------------------------------------------------
-- Certificate kinds and documents
-- ---------------------------------------------------------------------------

create table nl.certificate_types (
  code              text primary key check (code ~ '^[A-Z]{3,6}$'),
  name              text not null,
  description       text not null default '',
  -- What the certificate is about, which decides how a requirement for it is
  -- satisfied: material by a lot's paperwork, part and process by the part's,
  -- equipment by a current calibration, shipment by the package we issue.
  applies_to        text not null check (applies_to in ('material', 'part', 'process', 'equipment', 'shipment')),
  typically_expires boolean not null default false,
  sort              int not null default 0
);

comment on table nl.certificate_types is
  'The kinds of certificate this business issues or collects. applies_to decides how a requirement for one is satisfied.';

create table nl.documents (
  id           bigint generated always as identity (start with 8001) primary key,
  kind         text not null references nl.certificate_types (code),
  -- The number on the paper, which is how anybody refers to it.
  reference_no text not null check (length(reference_no) between 2 and 60),
  issued_by    text not null default '',        -- the mill, the lab, the plater, or us
  issued_on    date not null,
  expires_on   date,
  file_name    text not null default '',
  media_type   text not null default '',
  byte_size    int check (byte_size >= 0),
  -- The hash is of the file as received, so a document can be shown to be
  -- the same one years later.
  sha256       text check (sha256 ~ '^[0-9a-f]{64}$'),
  -- Where the file lives. A reference is enough; the bytes are optional.
  storage_ref  text not null default '',
  bytes        bytea,
  note         text not null default '',
  created_at   timestamptz not null default now(),
  constraint documents_window check (expires_on is null or expires_on >= issued_on)
);

comment on column nl.documents.bytes is
  'The file itself, when we hold it. Usually null: a reference and a hash are enough to prove which document is meant.';

create index documents_kind_idx on nl.documents (kind, issued_on desc);
create index documents_reference_idx on nl.documents (lower(reference_no) text_pattern_ops);
create index documents_expiry_idx on nl.documents (expires_on) where expires_on is not null;

-- Everything except the bytes, for lists and panels, so a page that lists
-- fifty certificates never drags a file through the connection.
create view nl.document_list with (security_invoker = true) as
select
  d.id, d.kind, t.name as kind_name, t.applies_to, d.reference_no, d.issued_by, d.issued_on,
  d.expires_on, d.file_name, d.media_type, d.byte_size, d.sha256, d.storage_ref, d.note, d.created_at,
  (d.bytes is not null) as has_file,
  (d.expires_on is not null and d.expires_on < (select nl.today())) as expired,
  case when d.expires_on is not null then d.expires_on - (select nl.today()) end as days_to_expiry
from nl.documents d
join nl.certificate_types t on t.code = d.kind;

-- ---------------------------------------------------------------------------
-- Lots
-- ---------------------------------------------------------------------------

create table nl.lots (
  lot_no            text primary key check (lot_no ~ '^[A-Z0-9][A-Z0-9.-]{3,29}$'),
  item_no           text not null references nl.items (item_no) on delete cascade,
  -- The mill's own identifiers. A heat is one pour of steel; everything
  -- traceable about material starts here.
  heat_no           text not null default '',
  mill              text not null default '',
  country_of_melt   text not null default '',
  vendor_no         text references nl.vendors (vendor_no),
  vendor_lot_no     text not null default '',
  -- Where it came from: a purchase receipt, or a production order for a lot
  -- we made ourselves.
  received_on       date not null,
  receipt_reference text not null default '',
  production_order  text,
  location_code     text references nl.locations (code),
  quantity_received numeric(14, 4) not null check (quantity_received > 0),
  -- What is left of it. A lot that has been fully consumed keeps its row
  -- forever: the genealogy is the point, not the balance.
  quantity_remaining numeric(14, 4) not null check (quantity_remaining >= 0),
  status            text not null default 'available'
                      check (status in ('quarantine', 'available', 'consumed', 'rejected', 'expired')),
  note              text not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default nl.now_ms(),
  constraint lots_remaining_within_received check (quantity_remaining <= quantity_received)
);

comment on table nl.lots is
  'A received or produced quantity with its own identity and its own paperwork. A lot of tube with no mill certificate is a real state this table can hold and the shipment gate will refuse.';

create index lots_item_idx on nl.lots (item_no, received_on desc);
create index lots_heat_idx on nl.lots (heat_no) where heat_no <> '';
create index lots_vendor_idx on nl.lots (vendor_no);
create index lots_status_idx on nl.lots (status, item_no);
create index lots_production_order_idx on nl.lots (production_order) where production_order is not null;

create trigger lots_touch before update on nl.lots
  for each row execute function nl.touch_updated_at();

create table nl.lot_documents (
  lot_no      text not null references nl.lots (lot_no) on delete cascade,
  document_id bigint not null references nl.documents (id) on delete cascade,
  primary key (lot_no, document_id)
);

create index lot_documents_document_idx on nl.lot_documents (document_id);

-- A certificate about the part rather than about any one lot: a first
-- article inspection report, a weld procedure qualification, a restricted
-- substance declaration. A different table from nl.lot_documents on purpose:
-- confusing the two is how a business ends up claiming material provenance
-- it cannot show.
create table nl.item_documents (
  item_no     text not null references nl.items (item_no) on delete cascade,
  document_id bigint not null references nl.documents (id) on delete cascade,
  -- The customer this piece of paper was produced for, when it was produced
  -- for one. Null means it covers the part for everybody.
  customer_no text references nl.customers (customer_no) on delete cascade,
  primary key (item_no, document_id)
);

create index item_documents_document_idx on nl.item_documents (document_id);
create index item_documents_customer_idx on nl.item_documents (customer_no);

-- ---------------------------------------------------------------------------
-- Genealogy
-- ---------------------------------------------------------------------------

-- Which child lot went into which parent lot, and how much of it. Every
-- backward and forward trace walks this table and nothing else.
create table nl.lot_consumption (
  id               bigint generated always as identity (start with 9001) primary key,
  child_lot        text not null references nl.lots (lot_no) on delete cascade,
  parent_lot       text references nl.lots (lot_no) on delete cascade,
  -- The order the material was issued to. A row with an order and no parent
  -- lot is material issued to a job that has not been received into a lot
  -- yet, and a forward trace stops there and says so.
  production_order text,
  consumed_on      date not null,
  quantity         numeric(14, 4) not null check (quantity > 0),
  note             text not null default '',
  constraint lot_consumption_not_itself check (child_lot <> coalesce(parent_lot, '')),
  constraint lot_consumption_goes_somewhere check (parent_lot is not null or production_order is not null)
);

comment on table nl.lot_consumption is
  'The genealogy: which lots went into which. A lot consumed into two parents has two rows and is counted once in each, never twice in either.';

-- The forward trace walks up by child and the backward trace walks down by
-- parent, so there is an index for each direction, each carrying the
-- quantity so the walk never visits the table.
create index lot_consumption_child_idx on nl.lot_consumption (child_lot) include (parent_lot, quantity);
create index lot_consumption_parent_idx on nl.lot_consumption (parent_lot) include (child_lot, quantity);
create index lot_consumption_order_idx on nl.lot_consumption (production_order) where production_order is not null;

-- Which lot each shipped line came out of. This is the join that turns a
-- genealogy into a list of customers, which is the only thing anybody wants
-- from it in a recall.
create table nl.shipment_line_lots (
  shipment_no text not null,
  line_no     int not null,
  lot_no      text not null references nl.lots (lot_no),
  quantity    numeric(14, 4) not null check (quantity > 0),
  primary key (shipment_no, line_no, lot_no),
  foreign key (shipment_no, line_no) references nl.shipment_lines (shipment_no, line_no) on delete cascade
);

create index shipment_line_lots_lot_idx on nl.shipment_line_lots (lot_no);

/*
 * Backward: from a lot, every lot underneath it, at any depth, with the
 * certificates each one carries. This is the answer to "what was this made
 * from, and where is the paperwork".
 *
 * The same planner care as the other recursive walks here (docs/sql.md): a
 * declared row estimate so the planner does not invent one, a pinned search
 * path so it cannot inline the function and throw that estimate away, and a
 * path guard so a loop in the data stops instead of spinning. A lot consumed
 * into two parents appears once per path it took, and the quantities are
 * multiplied down the path, so nothing is double counted when the rows are
 * added up per lot.
 */
create function nl.lot_trace_back(p_lot_no text)
returns table (
  depth            int,
  lot_no           text,
  parent_lot       text,
  item_no          text,
  description      text,
  heat_no          text,
  mill             text,
  country_of_melt  text,
  vendor_no        text,
  received_on      date,
  quantity_used    numeric,
  certificates     jsonb,
  path             text[]
)
language sql stable rows 20
set search_path = ''
as $$
  with recursive down (depth, lot_no, parent_lot, quantity, path) as (
    select 0, l.lot_no, null::text, l.quantity_received, array[l.lot_no]
    from nl.lots l
    where l.lot_no = p_lot_no
    union all
    select
      d.depth + 1,
      c.child_lot,
      c.parent_lot,
      c.quantity,
      d.path || c.child_lot
    from down d
    join nl.lot_consumption c on c.parent_lot = d.lot_no
    where d.depth < 24 and not c.child_lot = any (d.path)
  )
  select
    d.depth,
    d.lot_no,
    d.parent_lot,
    l.item_no,
    i.description,
    l.heat_no,
    l.mill,
    l.country_of_melt,
    l.vendor_no,
    l.received_on,
    round(d.quantity, 4),
    coalesce(c.certs, '[]'::jsonb),
    d.path
  from down d
  join nl.lots l on l.lot_no = d.lot_no
  join nl.items i on i.item_no = l.item_no
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'kind', dc.kind, 'reference_no', dc.reference_no, 'issued_by', dc.issued_by,
             'issued_on', dc.issued_on, 'expires_on', dc.expires_on,
             'expired', dc.expires_on is not null and dc.expires_on < nl.today())
           order by dc.kind) as certs
    from nl.lot_documents ld
    join nl.documents dc on dc.id = ld.document_id
    where ld.lot_no = d.lot_no
  ) c on true
$$;

-- ---------------------------------------------------------------------------
-- Qualification: permission rather than paperwork
-- ---------------------------------------------------------------------------

-- A customer has approved this part, from this source. Approval is not the
-- same thing as a certificate: a part can have every certificate and still
-- not be approved from a second vendor, and quoting it from that vendor is a
-- commercial decision somebody should make on purpose.
create table nl.part_qualifications (
  id                  bigint generated always as identity (start with 4001) primary key,
  customer_no         text not null references nl.customers (customer_no) on delete cascade,
  item_no             text not null references nl.items (item_no) on delete cascade,
  -- The source the approval covers. Both null means the part is approved
  -- however it is made.
  source_vendor_no    text references nl.vendors (vendor_no),
  source_work_center  text references nl.work_centers (code),
  first_article_status text not null default 'not required'
                        check (first_article_status in ('not required', 'submitted', 'approved', 'rejected')),
  approved_on         date,
  expires_on          date,
  -- What would make this approval need doing again.
  requalify_trigger   text not null default 'none'
                        check (requalify_trigger in ('none', 'design change', 'new source', 'audit lapsed', 'periodic')),
  document_id         bigint references nl.documents (id),
  note                text not null default '',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default nl.now_ms(),
  constraint part_qualifications_window check (expires_on is null or approved_on is null
                                               or expires_on >= approved_on)
);

create unique index part_qualifications_one_idx
  on nl.part_qualifications (customer_no, item_no,
                             coalesce(source_vendor_no, ''), coalesce(source_work_center, ''));
create index part_qualifications_item_idx on nl.part_qualifications (item_no);
create index part_qualifications_document_idx on nl.part_qualifications (document_id);

create trigger part_qualifications_touch before update on nl.part_qualifications
  for each row execute function nl.touch_updated_at();

-- The approved source list: which vendor may supply which part, audited
-- when, rated how, expiring when. A null item_no approves the vendor for
-- everything it supplies.
create table nl.supplier_qualifications (
  id             bigint generated always as identity (start with 4501) primary key,
  vendor_no      text not null references nl.vendors (vendor_no) on delete cascade,
  item_no        text references nl.items (item_no) on delete cascade,
  scope          text not null default '',
  audited_on     date,
  expires_on     date,
  quality_rating numeric(4, 1) check (quality_rating >= 0 and quality_rating <= 100),
  status         text not null default 'approved'
                   check (status in ('approved', 'conditional', 'suspended', 'not approved')),
  document_id    bigint references nl.documents (id),
  note           text not null default '',
  updated_at     timestamptz not null default nl.now_ms()
);

create unique index supplier_qualifications_one_idx
  on nl.supplier_qualifications (vendor_no, coalesce(item_no, ''));
create index supplier_qualifications_item_idx on nl.supplier_qualifications (item_no);
create index supplier_qualifications_expiry_idx on nl.supplier_qualifications (expires_on);
create index supplier_qualifications_document_idx on nl.supplier_qualifications (document_id);

create trigger supplier_qualifications_touch before update on nl.supplier_qualifications
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- People and equipment
-- ---------------------------------------------------------------------------

-- A welder is qualified to a procedure, and the qualification lapses. An
-- operation that needs one can therefore be unsatisfied today even though
-- the cell is free, which is a real reason a job does not run.
create table nl.operator_qualifications (
  id            bigint generated always as identity (start with 4801) primary key,
  user_id       int not null references nl.users (id) on delete cascade,
  process_code  text not null check (length(process_code) between 2 and 20),
  process_name  text not null default '',
  work_center   text references nl.work_centers (code),
  qualified_on  date not null,
  expires_on    date,
  document_id   bigint references nl.documents (id),
  note          text not null default '',
  unique (user_id, process_code)
);

create index operator_qualifications_process_idx on nl.operator_qualifications (process_code);
create index operator_qualifications_document_idx on nl.operator_qualifications (document_id);

create table nl.gauges (
  code         text primary key check (code ~ '^[A-Z][A-Z0-9-]{2,19}$'),
  name         text not null,
  work_center  text references nl.work_centers (code),
  asset_no     text references nl.capital_assets (asset_no),
  interval_days int not null default 365 check (interval_days between 1 and 3650),
  active       boolean not null default true
);

create index gauges_wc_idx on nl.gauges (work_center);
create index gauges_asset_idx on nl.gauges (asset_no);

create table nl.calibrations (
  id            bigint generated always as identity (start with 5501) primary key,
  gauge_code    text references nl.gauges (code) on delete cascade,
  machine_code  text references nl.machines (code) on delete cascade,
  calibrated_on date not null,
  due_on        date not null,
  calibrated_by text not null default '',
  result        text not null default 'pass' check (result in ('pass', 'pass with adjustment', 'fail')),
  document_id   bigint references nl.documents (id),
  note          text not null default '',
  constraint calibrations_one_thing check ((gauge_code is null) <> (machine_code is null)),
  constraint calibrations_due_after check (due_on >= calibrated_on)
);

create index calibrations_gauge_idx on nl.calibrations (gauge_code, calibrated_on desc);
create index calibrations_machine_idx on nl.calibrations (machine_code, calibrated_on desc);
create index calibrations_due_idx on nl.calibrations (due_on);
create index calibrations_document_idx on nl.calibrations (document_id);

-- What a routing operation needs before it may run.
alter table nl.routing_operations
  add column requires_process_qual text,     -- a process code from nl.operator_qualifications
  add column requires_gauge        text references nl.gauges (code);

comment on column nl.routing_operations.requires_process_qual is
  'The process a person must be qualified to before running this step. Checked by nl.operation_readiness.';

-- Whether each operation could actually run today: is there a qualified
-- person for the process it needs, and is the gauge it needs in
-- calibration. A cell being free is not the same as a job being able to run.
create view nl.operation_readiness with (security_invoker = true) as
select
  o.id,
  o.item_no,
  o.seq,
  o.work_center,
  o.description,
  o.requires_process_qual,
  o.requires_gauge,
  q.qualified_people,
  q.next_qualification_expiry,
  c.gauge_due_on,
  (o.requires_process_qual is null or coalesce(q.qualified_people, 0) > 0) as people_ready,
  (o.requires_gauge is null or (c.gauge_due_on is not null and c.gauge_due_on >= (select nl.today()))) as gauge_ready,
  ((o.requires_process_qual is null or coalesce(q.qualified_people, 0) > 0)
   and (o.requires_gauge is null or (c.gauge_due_on is not null and c.gauge_due_on >= (select nl.today())))) as ready,
  case
    when o.requires_process_qual is not null and coalesce(q.qualified_people, 0) = 0
      then 'Nobody is currently qualified to ' || o.requires_process_qual
    when o.requires_gauge is not null and (c.gauge_due_on is null or c.gauge_due_on < (select nl.today()))
      then 'Gauge ' || o.requires_gauge || ' is out of calibration'
    else ''
  end as blocked_reason
from nl.routing_operations o
left join lateral (
  select
    count(*)::int as qualified_people,
    min(oq.expires_on) as next_qualification_expiry
  from nl.operator_qualifications oq
  join nl.users u on u.id = oq.user_id and u.active
  where oq.process_code = o.requires_process_qual
    and (oq.expires_on is null or oq.expires_on >= (select nl.today()))
) q on true
left join lateral (
  select max(cal.due_on) as gauge_due_on
  from nl.calibrations cal
  where cal.gauge_code = o.requires_gauge and cal.result <> 'fail'
) c on true;

-- ---------------------------------------------------------------------------
-- Requirements, and the package a shipment owes
-- ---------------------------------------------------------------------------

-- What has to be in the envelope. A requirement can come from the customer
-- (this account always wants a mill certificate), from one order (this job
-- needs a first article), or from the part itself (this alloy always ships
-- with a country of melt statement).
--
-- A requirement costs money and time, which is why price_adder and
-- lead_days_adder are here rather than being pretended away: a certified
-- package is a real line on a quote.
create table nl.document_requirements (
  id                bigint generated always as identity (start with 6501) primary key,
  scope             text not null check (scope in ('customer', 'order', 'item')),
  customer_no       text references nl.customers (customer_no) on delete cascade,
  item_no           text references nl.items (item_no) on delete cascade,
  document_no       text,                        -- the order, for an order requirement
  certificate_type  text not null references nl.certificate_types (code),
  inspection_level  text not null default ''
                      check (inspection_level in ('', 'standard', 'source', 'first article', 'dimensional', '100 percent')),
  domestic_melt_required boolean not null default false,
  packaging_note    text not null default '',
  marking_note      text not null default '',
  price_adder       numeric(12, 2) not null default 0 check (price_adder >= 0),
  lead_days_adder   int not null default 0 check (lead_days_adder >= 0),
  active            boolean not null default true,
  note              text not null default '',
  created_at        timestamptz not null default now(),
  -- The scope decides which key has to be filled in, and which must not be.
  constraint document_requirements_scope_keys check (
    case scope
      when 'customer' then customer_no is not null and document_no is null
      when 'order'    then document_no is not null
      when 'item'     then item_no is not null and customer_no is null and document_no is null
    end)
);

create index document_requirements_customer_idx on nl.document_requirements (customer_no) where active;
create index document_requirements_item_idx on nl.document_requirements (item_no) where active;
create index document_requirements_order_idx on nl.document_requirements (document_no) where active;

/*
 * What a shipment owes and has not got. One row per line and certificate
 * type that is required and unsatisfied, with the reason in plain English so
 * the refusal message can use it directly.
 *
 * How a requirement is satisfied depends on what the certificate is about:
 *
 *   material   a lot on that line, OR any lot underneath it in the
 *              genealogy, has the certificate, unexpired. A finished elbow
 *              does not have a mill certificate of its own and never will:
 *              the certificate belongs to the heat of tube three levels
 *              down, and this is what finds it. A line with no lot at all
 *              fails, which is the point: shipping material you cannot
 *              trace is the thing this prevents.
 *   part
 *   process    the part has the certificate (nl.item_documents), either for
 *              everybody or for this customer
 *   equipment  the gauge or machine the part's routing needs is in
 *              calibration
 *   shipment   the certificate is attached to the shipment itself
 *
 * A domestic melt requirement is checked against the lot's country of melt,
 * not against a piece of paper, because that is where the fact lives.
 */
create table nl.shipment_documents (
  shipment_no text not null references nl.shipments (shipment_no) on delete cascade,
  document_id bigint not null references nl.documents (id) on delete cascade,
  primary key (shipment_no, document_id)
);

create index shipment_documents_document_idx on nl.shipment_documents (document_id);

create function nl.shipment_document_gaps(p_shipment_no text)
returns table (
  line_no          int,
  item_no          text,
  certificate_type text,
  certificate_name text,
  applies_to       text,
  reason           text
)
language sql stable rows 4
set search_path = ''
as $$
  with ship as (
    select s.shipment_no, s.customer_no
    from nl.shipments s
    where s.shipment_no = p_shipment_no
  ),
  -- Every requirement that reaches any line of this shipment.
  needed as (
    select distinct l.line_no, l.item_no, r.certificate_type, r.domestic_melt_required
    from ship sh
    join nl.shipment_lines l on l.shipment_no = sh.shipment_no
    join nl.document_requirements r
      on r.active
     and (
       (r.scope = 'customer' and r.customer_no = sh.customer_no
        and (r.item_no is null or r.item_no = l.item_no))
       or (r.scope = 'item' and r.item_no = l.item_no)
       or (r.scope = 'order' and r.document_no = l.document_no
           and (r.item_no is null or r.item_no = l.item_no))
     )
  )
  select
    n.line_no,
    n.item_no,
    n.certificate_type,
    t.name,
    t.applies_to,
    case
      when t.applies_to = 'material' and not exists (
             select 1 from nl.shipment_line_lots sl where sl.shipment_no = p_shipment_no and sl.line_no = n.line_no)
        then 'no lot is recorded against this line, so its material cannot be traced'
      when t.applies_to = 'material' and n.domestic_melt_required and exists (
             select 1
             from nl.shipment_line_lots sl
             cross join lateral nl.lot_trace_back(sl.lot_no) tr
             where sl.shipment_no = p_shipment_no and sl.line_no = n.line_no
               and tr.country_of_melt <> '' and tr.country_of_melt <> 'US')
        then 'material under this line was melted outside the United States'
      when t.applies_to = 'material'
        then 'no unexpired ' || t.name || ' on the lot shipped or on anything under it'
      when t.applies_to in ('part', 'process')
        then 'no unexpired ' || t.name || ' on file for this part'
      when t.applies_to = 'equipment'
        then 'the equipment this part needs is out of calibration'
      else 'the ' || t.name || ' has not been attached to this shipment'
    end
  from needed n
  join nl.certificate_types t on t.code = n.certificate_type
  where
    case t.applies_to
      -- Material: the certificate is on the lot shipped or on any lot
      -- underneath it, unexpired, and nothing underneath it was melted
      -- somewhere the requirement rules out.
      when 'material' then not exists (
        select 1
        from nl.shipment_line_lots sl
        cross join lateral nl.lot_trace_back(sl.lot_no) tr
        join nl.lot_documents ld on ld.lot_no = tr.lot_no
        join nl.documents d on d.id = ld.document_id
        where sl.shipment_no = p_shipment_no
          and sl.line_no = n.line_no
          and d.kind = n.certificate_type
          and (d.expires_on is null or d.expires_on >= nl.today()))
      or (n.domestic_melt_required and exists (
        select 1
        from nl.shipment_line_lots sl
        cross join lateral nl.lot_trace_back(sl.lot_no) tr
        where sl.shipment_no = p_shipment_no
          and sl.line_no = n.line_no
          and tr.country_of_melt <> '' and tr.country_of_melt <> 'US'))
      when 'equipment' then not exists (
        select 1
        from nl.routing_operations ro
        join nl.calibrations cal on cal.gauge_code = ro.requires_gauge
        where ro.item_no = n.item_no
          and ro.requires_gauge is not null
          and cal.result <> 'fail'
          and cal.due_on >= nl.today())
        -- Only a part whose routing actually names a gauge can fail this.
        and exists (select 1 from nl.routing_operations ro2
                     where ro2.item_no = n.item_no and ro2.requires_gauge is not null)
      when 'shipment' then not exists (
        select 1
        from nl.shipment_documents sd
        join nl.documents d on d.id = sd.document_id
        where sd.shipment_no = p_shipment_no
          and d.kind = n.certificate_type
          and (d.expires_on is null or d.expires_on >= nl.today()))
      -- Part and process: on file for the part, for everybody or for this
      -- customer.
      else not exists (
        select 1
        from nl.item_documents idoc
        join nl.documents d on d.id = idoc.document_id
        where idoc.item_no = n.item_no
          and d.kind = n.certificate_type
          and (d.expires_on is null or d.expires_on >= nl.today())
          and (idoc.customer_no is null
               or idoc.customer_no = (select customer_no from ship)))
    end
$$;

-- One row per shipment saying whether its package is complete, for a list.
create view nl.shipment_package with (security_invoker = true) as
select
  s.shipment_no,
  s.customer_no,
  s.status,
  s.promised_on,
  coalesce(g.gaps, 0)::int as gaps,
  coalesce(g.summary, '')  as missing,
  coalesce(g.gaps, 0) = 0  as complete
from nl.shipments s
left join lateral (
  select count(*)::int as gaps,
         string_agg(distinct x.certificate_type, ', ' order by x.certificate_type) as summary
  from nl.shipment_document_gaps(s.shipment_no) x
) g on true;

/*
 * The gate. A shipment cannot reach 'shipped' while it still owes paperwork,
 * and the refusal names every missing piece.
 *
 * A trigger rather than a change to nl.advance_shipment() (migration 0019):
 * the warehouse writes keep their one owner, and a write that goes around
 * the function is stopped too. NL422 is the same SQLSTATE the warehouse
 * writes raise, so the app turns it into the same kind of message.
 */
create function nl.shipment_paperwork_gate() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_missing text;
  v_count   int;
begin
  if new.status <> 'shipped' or old.status = 'shipped' then
    return new;
  end if;

  select count(*), string_agg(g.certificate_name || ' on line ' || g.line_no
                              || ' (' || g.item_no || '): ' || g.reason, '; ' order by g.line_no)
    into v_count, v_missing
  from nl.shipment_document_gaps(new.shipment_no) g;

  if coalesce(v_count, 0) > 0 then
    raise exception 'Shipment % cannot ship until its document package is complete. Missing: %.',
      new.shipment_no, v_missing
      using errcode = 'NL422';
  end if;

  return new;
end $$;

create trigger shipments_paperwork_gate
  before update of status on nl.shipments
  for each row execute function nl.shipment_paperwork_gate();

-- ---------------------------------------------------------------------------
-- The traces
-- ---------------------------------------------------------------------------


/*
 * Forward: from a raw lot, every lot made from it, at any depth, and every
 * shipment and customer that received one. This is the recall question, and
 * it is the one worth having.
 *
 * The walk goes up nl.lot_consumption by child_lot, which the include index
 * answers without touching the table, then joins the lots it reaches to the
 * shipped lines. A customer that received two different descendants of the
 * same heat appears once per lot, and nl.lot_recall_customers below rolls
 * that into one row per account, which is what somebody would actually pick
 * up a phone with.
 */
create function nl.lot_trace_forward(p_lot_no text)
returns table (
  depth            int,
  lot_no           text,
  child_lot        text,
  item_no          text,
  description      text,
  quantity         numeric,
  status           text,
  shipment_no      text,
  shipped_at       timestamptz,
  customer_no      text,
  customer_name    text,
  shipped_quantity numeric,
  path             text[]
)
language sql stable rows 20
set search_path = ''
as $$
  with recursive up (depth, lot_no, child_lot, quantity, path) as (
    select 0, l.lot_no, null::text, l.quantity_received, array[l.lot_no]
    from nl.lots l
    where l.lot_no = p_lot_no
    union all
    select
      u.depth + 1,
      c.parent_lot,
      c.child_lot,
      c.quantity,
      u.path || c.parent_lot
    from up u
    join nl.lot_consumption c on c.child_lot = u.lot_no
    where c.parent_lot is not null
      and u.depth < 24
      and not c.parent_lot = any (u.path)
  )
  select
    u.depth,
    u.lot_no,
    u.child_lot,
    l.item_no,
    i.description,
    round(u.quantity, 4),
    l.status,
    sl.shipment_no,
    sh.shipped_at,
    sh.customer_no,
    cu.name,
    round(sl.quantity, 4),
    u.path
  from up u
  join nl.lots l on l.lot_no = u.lot_no
  join nl.items i on i.item_no = l.item_no
  left join nl.shipment_line_lots sl on sl.lot_no = u.lot_no
  left join nl.shipments sh on sh.shipment_no = sl.shipment_no
  left join nl.customers cu on cu.customer_no = sh.customer_no
$$;

-- Who to call: one row per account that received anything descended from
-- this lot, with what they got and when it went.
create function nl.lot_recall_customers(p_lot_no text)
returns table (
  customer_no   text,
  customer_name text,
  owner_id      int,
  shipments     int,
  parts         int,
  quantity      numeric,
  first_shipped timestamptz,
  last_shipped  timestamptz,
  item_numbers  text[]
)
language sql stable rows 10
set search_path = ''
as $$
  select
    t.customer_no,
    t.customer_name,
    cu.owner_id,
    count(distinct t.shipment_no)::int,
    count(distinct t.item_no)::int,
    round(sum(t.shipped_quantity), 4),
    min(t.shipped_at),
    max(t.shipped_at),
    array_agg(distinct t.item_no order by t.item_no)
  from nl.lot_trace_forward(p_lot_no) t
  join nl.customers cu on cu.customer_no = t.customer_no
  where t.shipment_no is not null
  group by t.customer_no, t.customer_name, cu.owner_id
$$;

-- Backward from a shipment: every lot behind every line of it, with the
-- certificates. This is what gets emailed when a customer asks for the
-- paperwork on an order they received last year.
create function nl.shipment_trace(p_shipment_no text)
returns table (
  line_no      int,
  item_no      text,
  description  text,
  depth        int,
  lot_no       text,
  heat_no      text,
  mill         text,
  country_of_melt text,
  received_on  date,
  certificates jsonb
)
language sql stable rows 30
set search_path = ''
as $$
  select
    sl.line_no,
    t.item_no,
    t.description,
    t.depth,
    t.lot_no,
    t.heat_no,
    t.mill,
    t.country_of_melt,
    t.received_on,
    t.certificates
  from nl.shipment_line_lots sl
  cross join lateral nl.lot_trace_back(sl.lot_no) t
  where sl.shipment_no = p_shipment_no
$$;

-- ---------------------------------------------------------------------------
-- Flags a quote should carry
-- ---------------------------------------------------------------------------

/*
 * Whether this account has approved this part, and whether the source is on
 * the approved list. Nothing here blocks anything: quoting an unqualified
 * source is a commercial decision, sometimes the right one, and a system
 * that refuses it just gets worked around. What it must not be is silent.
 */
create function nl.part_qualification_flags(p_customer_no text, p_item_no text)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'customer_no', p_customer_no,
    'item_no', p_item_no,
    'today', nl.today(),
    'customer_approved', q.id is not null and q.status = 'current',
    'customer_qualification', case when q.id is not null then jsonb_build_object(
        'first_article_status', q.first_article_status,
        'approved_on', q.approved_on,
        'expires_on', q.expires_on,
        'status', q.status,
        'requalify_trigger', q.requalify_trigger) end,
    'supplier_qualification', case when s.id is not null then jsonb_build_object(
        'vendor_no', s.vendor_no,
        'status', s.status,
        'audited_on', s.audited_on,
        'expires_on', s.expires_on,
        'quality_rating', s.quality_rating,
        'expired', s.expires_on is not null and s.expires_on < nl.today()) end,
    'requirements', coalesce(r.reqs, '[]'::jsonb),
    'requirement_price_adder', coalesce(r.price_adder, 0),
    'requirement_lead_days', coalesce(r.lead_days, 0),
    'flags', coalesce(f.flags, '[]'::jsonb))
  from (select 1) one
  left join lateral (
    select pq.id, pq.first_article_status, pq.approved_on, pq.expires_on, pq.requalify_trigger,
           case
             when pq.first_article_status = 'rejected' then 'rejected'
             when pq.expires_on is not null and pq.expires_on < nl.today() then 'expired'
             when pq.first_article_status = 'submitted' then 'submitted'
             when pq.approved_on is null then 'not approved'
             else 'current'
           end as status
    from nl.part_qualifications pq
    where pq.customer_no = p_customer_no and pq.item_no = p_item_no
    order by pq.approved_on desc nulls last, pq.id desc
    limit 1
  ) q on true
  left join lateral (
    select sq.id, sq.vendor_no, sq.status, sq.audited_on, sq.expires_on, sq.quality_rating
    from nl.items i
    join nl.supplier_qualifications sq
      on sq.vendor_no = i.vendor_no and (sq.item_no is null or sq.item_no = i.item_no)
    where i.item_no = p_item_no
    order by (sq.item_no is not null) desc, sq.id
    limit 1
  ) s on true
  left join lateral (
    select
      jsonb_agg(jsonb_build_object(
        'scope', dr.scope, 'certificate_type', dr.certificate_type,
        'inspection_level', nullif(dr.inspection_level, ''),
        'domestic_melt_required', dr.domestic_melt_required,
        'price_adder', dr.price_adder, 'lead_days_adder', dr.lead_days_adder,
        'packaging_note', nullif(dr.packaging_note, ''),
        'marking_note', nullif(dr.marking_note, ''))
        order by dr.certificate_type) as reqs,
      sum(dr.price_adder) as price_adder,
      max(dr.lead_days_adder) as lead_days
    from nl.document_requirements dr
    where dr.active
      and ((dr.scope = 'customer' and dr.customer_no = p_customer_no
            and (dr.item_no is null or dr.item_no = p_item_no))
        or (dr.scope = 'item' and dr.item_no = p_item_no))
  ) r on true
  left join lateral (
    -- One short list a quote can print without working anything out.
    select jsonb_agg(x.flag order by x.flag) as flags
    from (
      select 'The customer has not approved this part' as flag
      where q.id is null
      union all
      select 'The customer approval expired on ' || q.expires_on
      where q.id is not null and q.expires_on is not null and q.expires_on < nl.today()
      union all
      select 'A first article is still outstanding'
      where q.first_article_status = 'submitted'
      union all
      select 'The supplier qualification expired on ' || s.expires_on
      where s.id is not null and s.expires_on is not null and s.expires_on < nl.today()
      union all
      select 'The supplier is ' || s.status
      where s.id is not null and s.status <> 'approved'
      union all
      select 'The part has no approved supplier on file'
      where s.id is null and exists (select 1 from nl.items i
                                      where i.item_no = p_item_no and i.vendor_no is not null)
    ) x
  ) f on true
$$;

-- Lots whose remaining quantity does not agree with what has been consumed
-- out of them and shipped. Always empty; the seed and the tests say so.
create function nl.lot_balance_drift()
returns table (lot_no text, received numeric, consumed numeric, shipped numeric, remaining numeric, expected numeric)
language sql stable
set search_path = ''
as $$
  select
    l.lot_no,
    l.quantity_received,
    coalesce(c.used, 0),
    coalesce(s.shipped, 0),
    l.quantity_remaining,
    l.quantity_received - coalesce(c.used, 0) - coalesce(s.shipped, 0)
  from nl.lots l
  left join lateral (
    select sum(x.quantity) as used from nl.lot_consumption x where x.child_lot = l.lot_no
  ) c on true
  left join lateral (
    select sum(x.quantity) as shipped from nl.shipment_line_lots x where x.lot_no = l.lot_no
  ) s on true
  where l.quantity_remaining
        is distinct from (l.quantity_received - coalesce(c.used, 0) - coalesce(s.shipped, 0))
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.certificate_types enable row level security;
alter table nl.documents enable row level security;
alter table nl.lots enable row level security;
alter table nl.lot_documents enable row level security;
alter table nl.item_documents enable row level security;
alter table nl.lot_consumption enable row level security;
alter table nl.shipment_line_lots enable row level security;
alter table nl.shipment_documents enable row level security;
alter table nl.part_qualifications enable row level security;
alter table nl.supplier_qualifications enable row level security;
alter table nl.operator_qualifications enable row level security;
alter table nl.gauges enable row level security;
alter table nl.calibrations enable row level security;
alter table nl.document_requirements enable row level security;

create policy certificate_types_read on nl.certificate_types for select to nl_app, nl_readonly using (true);
create policy documents_read on nl.documents for select to nl_app, nl_readonly using (true);
create policy lots_read on nl.lots for select to nl_app, nl_readonly using (true);
create policy lot_documents_read on nl.lot_documents for select to nl_app, nl_readonly using (true);
create policy item_documents_read on nl.item_documents for select to nl_app, nl_readonly using (true);
create policy lot_consumption_read on nl.lot_consumption for select to nl_app, nl_readonly using (true);
create policy shipment_line_lots_read on nl.shipment_line_lots for select to nl_app using (true);
create policy shipment_documents_read on nl.shipment_documents for select to nl_app using (true);
create policy part_qualifications_read on nl.part_qualifications for select to nl_app, nl_readonly using (true);
create policy supplier_qualifications_read on nl.supplier_qualifications for select to nl_app, nl_readonly using (true);
create policy document_requirements_read on nl.document_requirements for select to nl_app, nl_readonly using (true);
create policy gauges_read on nl.gauges for select to nl_app, nl_readonly using (true);
create policy calibrations_read on nl.calibrations for select to nl_app, nl_readonly using (true);
-- An operator qualification names a person, so the read-only role the
-- assistant's SQL tool uses gets nothing on it, the same rule 0019 follows
-- for the stock ledger and the counts.
create policy operator_qualifications_read on nl.operator_qualifications for select to nl_app using (true);

-- Attaching a certificate is a warehouse and quality act, so the same people
-- who run the warehouse may do it. Nothing is deleted: a document that
-- should not have been attached is superseded, never removed.
create policy documents_insert on nl.documents for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy lot_documents_insert on nl.lot_documents for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy item_documents_insert on nl.item_documents for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy shipment_documents_insert on nl.shipment_documents for insert to nl_app
  with check ((select nl.can_run_imports()));
create policy lots_change on nl.lots for update to nl_app
  using ((select nl.can_run_imports())) with check ((select nl.can_run_imports()));

grant select on nl.certificate_types, nl.documents, nl.lots, nl.lot_documents, nl.item_documents,
  nl.lot_consumption, nl.shipment_line_lots, nl.shipment_documents, nl.part_qualifications,
  nl.supplier_qualifications, nl.operator_qualifications, nl.gauges, nl.calibrations,
  nl.document_requirements
to nl_app;

grant insert on nl.documents, nl.lot_documents, nl.item_documents, nl.shipment_documents to nl_app;
grant update (quantity_remaining, status, note, updated_at) on nl.lots to nl_app;

grant select on nl.certificate_types, nl.documents, nl.lots, nl.lot_documents, nl.item_documents,
  nl.lot_consumption, nl.part_qualifications, nl.supplier_qualifications, nl.gauges,
  nl.calibrations, nl.document_requirements
to nl_readonly;

grant select on nl.document_list, nl.operation_readiness, nl.shipment_package to nl_app;
grant select on nl.document_list, nl.operation_readiness to nl_readonly;

grant execute on function
  nl.shipment_document_gaps(text),
  nl.lot_trace_back(text),
  nl.lot_trace_forward(text),
  nl.lot_recall_customers(text),
  nl.shipment_trace(text),
  nl.part_qualification_flags(text, text),
  nl.lot_balance_drift()
to nl_app;

-- The traces hold no people except the customer's own name, which the
-- read-only role already sees on nl.customers. nl.lot_recall_customers and
-- nl.shipment_trace read shipments, which name the person who packed them,
-- so they stay off the read-only role.
grant execute on function
  nl.lot_trace_back(text),
  nl.part_qualification_flags(text, text),
  nl.lot_balance_drift()
to nl_readonly;

revoke execute on function nl.shipment_paperwork_gate() from public;
