-- 96 The paperwork: certificate kinds, mill certificates on heats of steel,
-- a genealogy three and four levels deep, qualified welders, calibrated
-- gauges, approved sources, and a shipment that cannot go out because its
-- package is short one document.
--
-- Migration 0037 added the tables. This file fills them on top of the plant
-- that db/seed.d/95_manufacturing.sql built, and it has one job beyond
-- looking plausible: make every question a defence or aerospace distributor
-- asks answerable on the seeded world.
--
--   what heat is this part made from        nl.lot_trace_back
--   who got parts from this heat            nl.lot_recall_customers
--   where is the certificate                nl.lot_documents
--   may we ship it                          nl.shipment_document_gaps
--
-- HOW THE GENEALOGY IS BUILT. Backwards from the shipments, the same way
-- db/seed.d/60_warehouse.sql builds the stock ledger backwards from today's
-- on-hand figure, and for the same reason: the shipments already exist and
-- are read by the warehouse pages, so the lots have to fit them rather than
-- the other way round.
--
--   1. Every part that can be a leaf (bought, with no parts list) gets one
--      to three received lots, with a heat number, a mill and a country of
--      melt.
--   2. Every shipment line gets a lot of the part it shipped.
--   3. Then three passes down the bill of materials: a lot of a made child
--      is created for each parent lot that needs one, and a lot of a bought
--      child is consumed out of a received lot. Each pass writes the
--      consumption rows, which are the genealogy.
--   4. A final pass sets every lot's received and remaining quantities from
--      what was actually consumed and shipped out of it, so
--      nl.lot_balance_drift() is empty by construction and no lot can have a
--      negative balance.
--
-- THE BLOCKED SHIPMENT. One shipment is deliberately short a mill
-- certificate: the customer requires one, the tube lot under the part it is
-- shipping has none, and nl.shipment_paperwork_gate() will refuse to let it
-- go. It is the most important row in this file, because a system that only
-- ever says yes has not been shown to say no.

-- ---------------------------------------------------------------------------
-- The generator's own bookkeeping. The app never reads these.
-- ---------------------------------------------------------------------------

-- Lots waiting to have their children worked out, one pass at a time.
create table if not exists nl_seed.trace_todo (
  lot_no   text primary key,
  item_no  text not null,
  quantity numeric(14, 4) not null,
  lvl      int not null
);

create or replace function nl_seed.extra_96_traceability() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today   date := (select today from nl_seed.settings);
  v_scale   double precision := (select scale from nl_seed.settings);
  v_next    bigint := 1;
  v_lvl     int;
  v_made    int;
  v_target  text;          -- the shipment that will be refused
  v_users   int[];
  v_mills   text[] := array['Lakeshore Steel', 'Cascade Tube Works', 'Ironline Mill',
                            'Meridian Metals', 'Borealis Steel', 'Kettle Falls Rolling'];
begin
  -- -------------------------------------------------------------------------
  -- 1. The kinds of paper
  -- -------------------------------------------------------------------------
  insert into nl.certificate_types (code, name, description, applies_to, typically_expires, sort) values
    ('COC', 'Certificate of conformance',
     'Our statement that what shipped matches what was ordered, signed and numbered.', 'shipment', false, 1),
    ('MTR', 'Material test report',
     'The mill certificate for a heat of steel: chemistry, mechanical properties, the pour it came from.',
     'material', false, 2),
    ('COO', 'Country of origin and melt statement',
     'Where the material was melted and where the part was made.', 'material', false, 3),
    ('FAI', 'First article inspection report',
     'The dimensional report on the first piece off a new part, approved before production runs.',
     'part', false, 4),
    ('WPQ', 'Weld procedure qualification',
     'The qualified procedure a weld was made to, and the record qualifying it.', 'process', true, 5),
    ('CAL', 'Calibration certificate',
     'A gauge or machine measured against a standard, with a date it is next due.', 'equipment', true, 6),
    ('RSD', 'Restricted substance declaration',
     'A declaration that the part is free of the substances a customer prohibits.', 'part', true, 7)
  on conflict (code) do nothing;

  -- -------------------------------------------------------------------------
  -- 2. Gauges, calibrations, and the operations that need them
  -- -------------------------------------------------------------------------
  insert into nl.gauges (code, name, work_center, asset_no, interval_days) values
    ('GA-CAL-01', 'Digital calipers, cell one',  'CUT CELL',    null,     365),
    ('GA-CAL-02', 'Digital calipers, cell two',  'BEND CELL',   null,     365),
    ('GA-BORE-01','Bore gauge set 3 to 8 inch',  'FORM CELL',   null,     365),
    ('GA-PROT-01','Digital protractor',          'BEND CELL',   null,     180),
    ('GA-ARM-01', 'Measuring arm, inspection',   'INSPECT',     'CA-011', 365),
    ('GA-THK-01', 'Coating thickness gauge',     'POLISH CELL', null,     180)
  on conflict (code) do nothing;

  -- Most are in calibration. The protractor is a fortnight overdue, which is
  -- a real state a shop floor is in more often than it admits.
  insert into nl.documents (kind, reference_no, issued_by, issued_on, expires_on, storage_ref, note)
  select
    'CAL',
    'CAL-' || g.code || '-' || to_char(v_today - g.age, 'YYYYMMDD'),
    'Northline metrology lab',
    v_today - g.age,
    v_today - g.age + g.interval_days,
    'certs/calibration/' || lower(replace(g.code, '-', '_')) || '.pdf',
    ''
  from (
    select g.code, g.interval_days,
           case when g.code = 'GA-PROT-01' then g.interval_days + 14
                else nl_seed.ri(20, 200, 'trace.cal.age|' || g.code) end as age
    from nl.gauges g
  ) g
  on conflict do nothing;

  insert into nl.calibrations (gauge_code, calibrated_on, due_on, calibrated_by, result, document_id, note)
  select
    g.code,
    d.issued_on,
    d.expires_on,
    'Northline metrology lab',
    case when nl_seed.chance(0.12, 'trace.cal.result|' || g.code) then 'pass with adjustment' else 'pass' end,
    d.id,
    case when d.expires_on < v_today then 'Overdue: pulled from service until it is recalibrated' else '' end
  from nl.gauges g
  join nl.documents d
    on d.kind = 'CAL' and d.reference_no like 'CAL-' || g.code || '-%'
  on conflict do nothing;

  -- Which steps need a qualified person and a calibrated gauge. Welding
  -- needs a procedure; inspection needs the arm.
  update nl.routing_operations
     set requires_process_qual = case when work_center = 'WELD CELL' then 'GMAW-AL' end,
         requires_gauge = case when work_center = 'WELD CELL' then 'GA-CAL-02' end
   where work_center = 'WELD CELL';

  update nl.routing_operations
     set requires_process_qual = 'DIM-INSP',
         requires_gauge = 'GA-ARM-01'
   where work_center = 'INSPECT' and is_inspection;

  -- The large bender's angle has to be set against a protractor, and that
  -- protractor is a fortnight out of calibration. So those operations are
  -- not satisfied today even though the cell is standing free, which is
  -- exactly the state nl.operation_readiness exists to show.
  update nl.routing_operations
     set requires_gauge = 'GA-PROT-01'
   where work_center = 'BEND CELL' and machine = 'BEND-LG';

  -- The people. Operations and admins run the floor in this world, so they
  -- are the ones who hold the qualifications.
  select array_agg(id order by id) into v_users
  from nl.users where active and role in ('operations', 'admin');

  if v_users is not null and cardinality(v_users) > 0 then
    insert into nl.documents (kind, reference_no, issued_by, issued_on, expires_on, storage_ref)
    select
      'WPQ',
      'WPQ-' || p.process || '-' || u.id,
      'Northline weld engineering',
      v_today - nl_seed.ri(200, 900, 'trace.wpq.on|' || p.process || u.id),
      v_today - nl_seed.ri(200, 900, 'trace.wpq.on|' || p.process || u.id) + 1095,
      'certs/weld/' || lower(p.process) || '_' || u.id || '.pdf'
    from unnest(v_users) as u(id)
    cross join (values ('GMAW-AL'), ('GMAW-SS'), ('DIM-INSP')) as p(process)
    where nl_seed.chance(0.6, 'trace.qual|' || p.process || '|' || u.id)
    on conflict do nothing;

    insert into nl.operator_qualifications
      (user_id, process_code, process_name, work_center, qualified_on, expires_on, document_id, note)
    select
      u.id,
      p.process,
      p.label,
      p.cell,
      d.issued_on,
      d.expires_on,
      d.id,
      ''
    from unnest(v_users) as u(id)
    cross join (values ('GMAW-AL', 'Gas metal arc, aluminized', 'WELD CELL'),
                       ('GMAW-SS', 'Gas metal arc, stainless', 'WELD CELL'),
                       ('DIM-INSP', 'Dimensional inspection', 'INSPECT')) as p(process, label, cell)
    join nl.documents d on d.kind = 'WPQ' and d.reference_no = 'WPQ-' || p.process || '-' || u.id
    on conflict (user_id, process_code) do nothing;
  end if;

  -- -------------------------------------------------------------------------
  -- 3. Approved sources
  -- -------------------------------------------------------------------------
  insert into nl.documents (kind, reference_no, issued_by, issued_on, expires_on, storage_ref, note)
  select
    'RSD',
    'RSD-' || v.vendor_no || '-' || extract(year from v_today - a.age)::text,
    v.name,
    v_today - a.age,
    v_today - a.age + 730,
    'certs/vendor/' || lower(v.vendor_no) || '_rsd.pdf',
    ''
  from nl.vendors v
  cross join lateral (select nl_seed.ri(30, 900, 'trace.rsd.age|' || v.vendor_no) as age) a
  where exists (select 1 from nl.items i where i.vendor_no = v.vendor_no)
    and nl_seed.chance(0.55, 'trace.rsd|' || v.vendor_no)
  on conflict do nothing;

  -- Most vendors are approved; a few are conditional, one or two suspended,
  -- and some audits have lapsed. A lapsed audit is the interesting case: it
  -- flags a quote without blocking it.
  insert into nl.supplier_qualifications
    (vendor_no, item_no, scope, audited_on, expires_on, quality_rating, status, document_id, note)
  select
    v.vendor_no,
    null,
    case when nl_seed.chance(0.3, 'trace.sq.scope|' || v.vendor_no)
         then 'Tube and sheet, aluminized and stainless'
         else 'All supplied parts' end,
    v_today - a.age,
    v_today - a.age + 730,
    round((72 + nl_seed.u('trace.sq.rating|' || v.vendor_no) * 27)::numeric, 1),
    case
      when nl_seed.chance(0.04, 'trace.sq.status|' || v.vendor_no) then 'suspended'
      when nl_seed.chance(0.14, 'trace.sq.status2|' || v.vendor_no) then 'conditional'
      else 'approved'
    end,
    (select d.id from nl.documents d
      where d.kind = 'RSD' and d.reference_no like 'RSD-' || v.vendor_no || '-%' limit 1),
    ''
  from nl.vendors v
  cross join lateral (
    -- About one audit in six has lapsed.
    select case when nl_seed.chance(0.17, 'trace.sq.lapsed|' || v.vendor_no)
                then nl_seed.ri(740, 1100, 'trace.sq.age|' || v.vendor_no)
                else nl_seed.ri(20, 700, 'trace.sq.age|' || v.vendor_no) end as age
  ) a
  where exists (select 1 from nl.items i where i.vendor_no = v.vendor_no)
  on conflict do nothing;

  -- -------------------------------------------------------------------------
  -- 4. Customer part approvals, with first articles
  -- -------------------------------------------------------------------------
  -- The accounts that buy the most, on the parts they buy most, which is
  -- where a real approved parts list comes from.
  insert into nl.documents (kind, reference_no, issued_by, issued_on, expires_on, storage_ref, note)
  select
    'FAI',
    'FAI-' || t.item_no || '-' || t.customer_no,
    'Northline quality',
    t.approved_on,
    null,
    'certs/fai/' || lower(replace(t.item_no, '/', '_')) || '_' || t.customer_no || '.pdf',
    ''
  from (
    select
      b.customer_no,
      b.item_no,
      v_today - nl_seed.ri(120, 1400, 'trace.fai.on|' || b.customer_no || '|' || b.item_no) as approved_on
    from (
      select
        il.customer_no,
        il.item_no,
        sum(il.amount) as revenue,
        row_number() over (partition by il.customer_no order by sum(il.amount) desc, il.item_no) as rank
      from nl.invoice_lines il
      join nl.items i on i.item_no = il.item_no
      where il.quantity > 0 and i.kind = 'finished good'
      group by il.customer_no, il.item_no
    ) b
    where b.rank <= greatest(2, round(6 * v_scale * 8))
      and b.revenue > 0
      and nl_seed.chance(0.45, 'trace.fai|' || b.customer_no || '|' || b.item_no)
  ) t
  on conflict do nothing;

  insert into nl.part_qualifications
    (customer_no, item_no, source_vendor_no, source_work_center, first_article_status,
     approved_on, expires_on, requalify_trigger, document_id, note)
  select
    q.customer_no,
    q.item_no,
    null,
    null,
    q.status,
    case when q.status in ('approved', 'rejected') then q.approved_on end,
    case when q.status = 'approved' and q.expiring then q.approved_on + 730 end,
    case
      when q.status = 'submitted' then 'new source'
      when q.expiring then 'periodic'
      else 'design change'
    end,
    d.id,
    ''
  from (
    select
      f.customer_no,
      f.item_no,
      d2.issued_on as approved_on,
      case
        when nl_seed.chance(0.08, 'trace.pq.status|' || f.customer_no || '|' || f.item_no) then 'submitted'
        when nl_seed.chance(0.03, 'trace.pq.status2|' || f.customer_no || '|' || f.item_no) then 'rejected'
        else 'approved'
      end as status,
      nl_seed.chance(0.35, 'trace.pq.expiring|' || f.customer_no || '|' || f.item_no) as expiring
    from (
      select
        split_part(d.reference_no, '-', 2) as item_part,
        d.reference_no,
        d.issued_on,
        d.id
      from nl.documents d
      where d.kind = 'FAI'
    ) fai
    cross join lateral (
      -- The reference carries the part and the account, and part numbers
      -- contain dashes, so the account is the last field and the part is
      -- everything between the first dash and it.
      select
        substring(fai.reference_no from 5 for
                  length(fai.reference_no) - 4 - length(split_part(fai.reference_no, '-', -1)) - 1) as item_no,
        split_part(fai.reference_no, '-', -1) as customer_no
    ) f
    join nl.documents d2 on d2.id = fai.id
    where exists (select 1 from nl.items i where i.item_no = f.item_no)
      and exists (select 1 from nl.customers c where c.customer_no = f.customer_no)
  ) q
  join nl.documents d
    on d.kind = 'FAI' and d.reference_no = 'FAI-' || q.item_no || '-' || q.customer_no
  on conflict do nothing;

  -- A weld procedure and a restricted substance declaration on the parts
  -- that need them, at the part level rather than the lot level, because
  -- they are about the part and not about any one heat.
  insert into nl.item_documents (item_no, document_id, customer_no)
  select distinct pq.item_no, d.id, null
  from nl.part_qualifications pq
  join nl.routing_operations r on r.item_no = pq.item_no and r.work_center = 'WELD CELL'
  cross join lateral (
    select d2.id from nl.documents d2
    where d2.kind = 'WPQ' and d2.expires_on >= v_today
    order by d2.expires_on desc, d2.id
    limit 1
  ) d
  on conflict (item_no, document_id) do nothing;

  insert into nl.item_documents (item_no, document_id, customer_no)
  select distinct i.item_no, d.id, null
  from nl.items i
  join nl.documents d
    on d.kind = 'RSD' and d.reference_no like 'RSD-' || i.vendor_no || '-%'
  where i.vendor_no is not null and d.expires_on >= v_today
  on conflict (item_no, document_id) do nothing;

  -- -------------------------------------------------------------------------
  -- 5. Received lots, with heats and mills
  --
  -- Anything that can be the bottom of a tree gets lots: the material master
  -- this plant buys, and any bought part that turns up on a shipment or in
  -- somebody's parts list.
  -- -------------------------------------------------------------------------
  delete from nl_seed.trace_todo;

  insert into nl.lots
    (lot_no, item_no, heat_no, mill, country_of_melt, vendor_no, vendor_lot_no,
     received_on, receipt_reference, production_order, location_code,
     quantity_received, quantity_remaining, status, note)
  select
    'RL-' || lpad((v_next + s.n)::text, 6, '0'),
    s.item_no,
    -- A heat number, a mill and a country of melt are facts about metal. A
    -- carton or a box of abrasive discs has a vendor lot number and nothing
    -- else, which is why those columns are empty rather than invented.
    case when i.kind = 'raw material' then
      upper(substr(md5('heat|' || s.item_no || '|' || s.k), 1, 2))
      || nl_seed.ri(10000, 99999, 'trace.heat|' || s.item_no || s.k)::text
    else '' end,
    case when i.kind in ('raw material', 'component')
         then v_mills[1 + nl_seed.ri(0, cardinality(v_mills) - 1, 'trace.mill|' || s.item_no || s.k)]
         else '' end,
    -- Mostly melted in the United States, and the rest is exactly why a
    -- domestic melt requirement exists.
    case when i.kind in ('raw material', 'component')
         then (array['US', 'US', 'US', 'US', 'US', 'US', 'US', 'CA', 'MX', 'KR', 'TW'])
                [1 + nl_seed.ri(0, 10, 'trace.melt|' || s.item_no || s.k)]
         else '' end,
    i.vendor_no,
    'V' || nl_seed.ri(100000, 999999, 'trace.vlot|' || s.item_no || s.k)::text,
    v_today - nl_seed.ri(5, 240, 'trace.recv|' || s.item_no || s.k),
    'PR' || nl_seed.ri(100000, 999999, 'trace.receipt|' || s.item_no || s.k)::text,
    null,
    'MAIN',
    -- Provisional: pass 8 sets these from what was actually used.
    greatest(10, coalesce(st.on_hand, 100))::numeric,
    greatest(10, coalesce(st.on_hand, 100))::numeric,
    'available',
    ''
  from (
    select
      x.item_no,
      k.k,
      row_number() over (order by x.item_no, k.k) as n
    from (
      -- Every part that can be a leaf: no parts list of its own.
      select distinct i.item_no
      from nl.items i
      where not exists (select 1 from nl.bom_lines b
                         where b.parent_item = i.item_no and not b.is_substitute)
        and (
          exists (select 1 from nl_seed.mfg_material m where m.item_no = i.item_no)
          or exists (select 1 from nl.bom_lines b2 where b2.child_item = i.item_no)
          or exists (select 1 from nl.shipment_lines sl where sl.item_no = i.item_no)
        )
    ) x
    -- One to three lots each: a part is rarely all one heat.
    cross join lateral (
      select generate_series(1, 1 + nl_seed.ri(0, 2, 'trace.lots|' || x.item_no)) as k
    ) k
  ) s
  join nl.items i on i.item_no = s.item_no
  left join nl.stock st on st.item_no = s.item_no
  on conflict (lot_no) do nothing;

  select coalesce(max(substr(lot_no, 4)::bigint), 0) + 1 into v_next from nl.lots where lot_no like 'RL-%';

  -- Mill certificates on most of them, and a country of melt statement on
  -- the ones that were not melted here (which is when anybody asks).
  insert into nl.documents (kind, reference_no, issued_by, issued_on, expires_on, storage_ref, note)
  select
    'MTR',
    'MTR-' || l.heat_no || '-' || l.lot_no,
    l.mill,
    l.received_on - nl_seed.ri(2, 20, 'trace.mtr.on|' || l.lot_no),
    null,
    'certs/mtr/' || lower(l.lot_no) || '.pdf',
    'Heat ' || l.heat_no || ', melted in ' || l.country_of_melt
  from nl.lots l
  where l.lot_no like 'RL-%'
    -- Only metal has a mill certificate.
    and l.heat_no <> ''
    -- About one lot in eight came in without its certificate, which is the
    -- state the shipment gate exists to catch.
    and not nl_seed.chance(0.12, 'trace.mtr.missing|' || l.lot_no)
  on conflict do nothing;

  insert into nl.lot_documents (lot_no, document_id)
  select l.lot_no, d.id
  from nl.lots l
  join nl.documents d on d.kind = 'MTR' and d.reference_no = 'MTR-' || l.heat_no || '-' || l.lot_no
  on conflict (lot_no, document_id) do nothing;

  insert into nl.documents (kind, reference_no, issued_by, issued_on, expires_on, storage_ref, note)
  select
    'COO',
    'COO-' || l.lot_no,
    l.mill,
    l.received_on,
    null,
    'certs/coo/' || lower(l.lot_no) || '.pdf',
    'Melted and poured in ' || l.country_of_melt
  from nl.lots l
  where l.lot_no like 'RL-%'
    and l.country_of_melt <> ''
    and nl_seed.chance(0.55, 'trace.coo|' || l.lot_no)
  on conflict do nothing;

  insert into nl.lot_documents (lot_no, document_id)
  select l.lot_no, d.id
  from nl.lots l
  join nl.documents d on d.kind = 'COO' and d.reference_no = 'COO-' || l.lot_no
  on conflict (lot_no, document_id) do nothing;

  -- -------------------------------------------------------------------------
  -- 6. Shipments from last spring, so the genealogy has depth to walk
  --
  -- The genealogy hangs off shipments, because a shipment is what connects a
  -- heat of steel to a customer. The shipments the warehouse seed builds are
  -- the ones on the dock this week, and what happens to be on them is
  -- whatever the open orders asked for: often a rain cap or a clamp, which
  -- is one level deep and traces nowhere interesting.
  --
  -- So a handful of shipments from five months ago are added here, carrying
  -- the deepest parts in the catalogue (a kit, which holds a muffler, which
  -- holds a phantom shell, which is rolled from sheet). They are dated well
  -- outside the ninety days the stock ledger covers, so they change none of
  -- the warehouse's own figures, and they give the forward trace somewhere
  -- to arrive: a real customer who received metal from a real heat.
  -- -------------------------------------------------------------------------
  insert into nl.shipments
    (shipment_no, customer_no, location_code, carrier, status, promised_on,
     packed_by, packed_at, shipped_at, tracking, note, created_at)
  select
    'SHH-' || lpad(d.n::text, 3, '0'),
    d.customer_no,
    'MAIN',
    'LTL',
    'shipped',
    v_today - 152,
    coalesce(v_users[1], 1),
    (v_today - 151)::timestamptz,
    (v_today - 150)::timestamptz,
    '1Z' || nl_seed.ri(100000000, 999999999, 'trace.hist.track|' || d.item_no)::text,
    'Shipped last spring, kept for the material trace',
    (v_today - 155)::timestamptz
  from (
    select
      c.item_no,
      c.customer_no,
      row_number() over (order by c.levels desc, c.item_no) as n
    from (
      select
        r.item_no,
        r.levels,
        -- Somebody who has actually bought it, so the recall names a real
        -- account with a real history rather than an arbitrary one.
        coalesce(
          (select il.customer_no
           from nl.invoice_lines il
           where il.item_no = r.item_no and il.quantity > 0
           order by il.posted_on desc, il.invoice_no
           limit 1),
          (select cu.customer_no from nl.customers cu
            where not cu.blocked and not cu.closed order by cu.customer_no limit 1)) as customer_no
      from nl.item_cost_rolled r
      join nl.items i on i.item_no = r.item_no
      where r.levels >= 2 and not i.blocked
      order by r.levels desc, r.item_no
      limit greatest(3, round(10 * v_scale * 10)::int)
    ) c
  ) d
  where d.customer_no is not null
  on conflict (shipment_no) do nothing;

  insert into nl.shipment_lines (shipment_no, line_no, document_no, order_line_no, item_no, quantity, bin)
  select
    s.shipment_no,
    1,
    '',
    null,
    d.item_no,
    1 + nl_seed.ri(1, 5, 'trace.hist.qty|' || d.item_no),
    ''
  from (
    select
      c.item_no,
      'SHH-' || lpad(row_number() over (order by c.levels desc, c.item_no)::text, 3, '0') as shipment_no
    from (
      select r.item_no, r.levels
      from nl.item_cost_rolled r
      join nl.items i on i.item_no = r.item_no
      where r.levels >= 2 and not i.blocked
      order by r.levels desc, r.item_no
      limit greatest(3, round(10 * v_scale * 10)::int)
    ) c
  ) d
  join nl.shipments s on s.shipment_no = d.shipment_no
  on conflict (shipment_no, line_no) do nothing;

  -- -------------------------------------------------------------------------
  -- 7. A lot for every shipment line, and then the tree under it
  -- -------------------------------------------------------------------------
  select coalesce(max(substr(lot_no, 4)::bigint), 0) + 1 into v_next from nl.lots;

  insert into nl.lots
    (lot_no, item_no, heat_no, mill, country_of_melt, vendor_no, vendor_lot_no,
     received_on, receipt_reference, production_order, location_code,
     quantity_received, quantity_remaining, status, note)
  select
    'FL-' || lpad((v_next + s.n)::text, 6, '0'),
    s.item_no, '', '', '', null, '',
    coalesce((sh.shipped_at at time zone 'America/Chicago')::date, v_today),
    s.shipment_no,
    -- A made part comes off a production order; a bought one off a receipt.
    case when exists (select 1 from nl.bom_lines b
                       where b.parent_item = s.item_no and not b.is_substitute)
         then 'PO' || nl_seed.ri(100000, 999999, 'trace.prod|' || s.shipment_no || s.line_no)::text end,
    sh.location_code,
    s.quantity::numeric,
    0,
    'consumed',
    'Built or picked for ' || s.shipment_no
  from (
    select sl.shipment_no, sl.line_no, sl.item_no, sl.quantity,
           row_number() over (order by sl.shipment_no, sl.line_no) as n
    from nl.shipment_lines sl
  ) s
  join nl.shipments sh on sh.shipment_no = s.shipment_no
  on conflict (lot_no) do nothing;

  insert into nl.shipment_line_lots (shipment_no, line_no, lot_no, quantity)
  select sl.shipment_no, sl.line_no, l.lot_no, sl.quantity
  from nl.shipment_lines sl
  join nl.lots l
    on l.receipt_reference = sl.shipment_no and l.item_no = sl.item_no and l.lot_no like 'FL-%'
  on conflict (shipment_no, line_no, lot_no) do nothing;

  insert into nl_seed.trace_todo (lot_no, item_no, quantity, lvl)
  select l.lot_no, l.item_no, l.quantity_received, 0
  from nl.lots l
  where l.lot_no like 'FL-%'
  on conflict (lot_no) do nothing;

  -- Three passes down the tree. Each pass creates a lot for every made
  -- child, and consumes a received lot for every bought child.
  for v_lvl in 0 .. 2 loop
    select coalesce(max(substr(lot_no, 4)::bigint), 0) + 1 into v_next from nl.lots;

    drop table if exists pg_temp.trace_kids;
    create temporary table trace_kids on commit drop as
    select
      t.lot_no as parent_lot,
      b.child_item,
      round(t.quantity * b.quantity_per * (1 + b.scrap_pct), 4) as quantity,
      exists (select 1 from nl.bom_lines b2
               where b2.parent_item = b.child_item and not b2.is_substitute) as child_is_made,
      'ML-' || lpad((v_next + row_number() over (order by t.lot_no, b.line_no))::text, 6, '0') as new_lot
    from nl_seed.trace_todo t
    join nl.bom_lines b on b.parent_item = t.item_no and not b.is_substitute
    where t.lvl = v_lvl;

    exit when not exists (select 1 from pg_temp.trace_kids);

    -- A made child becomes a lot of its own.
    insert into nl.lots
      (lot_no, item_no, heat_no, mill, country_of_melt, vendor_no, vendor_lot_no,
       received_on, receipt_reference, production_order, location_code,
       quantity_received, quantity_remaining, status, note)
    select
      k.new_lot, k.child_item, '', '', '', null, '',
      v_today - nl_seed.ri(3, 120, 'trace.made.on|' || k.new_lot),
      '',
      'PO' || nl_seed.ri(100000, 999999, 'trace.made.order|' || k.new_lot)::text,
      'MAIN',
      k.quantity, 0, 'consumed',
      'Made for ' || k.parent_lot
    from pg_temp.trace_kids k
    where k.child_is_made
    on conflict (lot_no) do nothing;

    insert into nl.lot_consumption (child_lot, parent_lot, production_order, consumed_on, quantity, note)
    select
      k.new_lot, k.parent_lot, null,
      v_today - nl_seed.ri(1, 100, 'trace.cons.on|' || k.new_lot),
      k.quantity, ''
    from pg_temp.trace_kids k
    where k.child_is_made
    on conflict do nothing;

    insert into nl_seed.trace_todo (lot_no, item_no, quantity, lvl)
    select k.new_lot, k.child_item, k.quantity, v_lvl + 1
    from pg_temp.trace_kids k
    where k.child_is_made
    on conflict (lot_no) do nothing;

    -- A bought child is consumed out of a received lot: the one with the
    -- most left, so a part with three heats spreads across them.
    insert into nl.lot_consumption (child_lot, parent_lot, production_order, consumed_on, quantity, note)
    select
      pick.lot_no, k.parent_lot, null,
      v_today - nl_seed.ri(1, 100, 'trace.cons.buy|' || k.parent_lot || k.child_item),
      k.quantity, ''
    from pg_temp.trace_kids k
    cross join lateral (
      select l.lot_no
      from nl.lots l
      where l.item_no = k.child_item and l.lot_no like 'RL-%'
      order by nl_seed.u('trace.pick|' || k.parent_lot || '|' || l.lot_no), l.lot_no
      limit 1
    ) pick
    where not k.child_is_made
    on conflict do nothing;

    get diagnostics v_made = row_count;
  end loop;

  -- -------------------------------------------------------------------------
  -- 8. The requirements, and the one shipment that cannot go
  -- -------------------------------------------------------------------------
  -- The shipment that will be refused: the first one still on the dock,
  -- taken in shipment number order so it is the same one every build.
  select s.shipment_no into v_target
  from nl.shipments s
  where s.status = 'awaiting carrier'
    and exists (select 1 from nl.shipment_lines l where l.shipment_no = s.shipment_no)
  order by s.shipment_no
  limit 1;

  -- If nothing is awaiting a carrier, anything still on the dock will do.
  if v_target is null then
    select s.shipment_no into v_target
    from nl.shipments s
    where s.status <> 'shipped'
      and exists (select 1 from nl.shipment_lines l where l.shipment_no = s.shipment_no)
    order by s.shipment_no
    limit 1;
  end if;

  -- Accounts that want paperwork with every order. The target's account is
  -- one of them, and so are a handful of others, picked in a fixed order.
  insert into nl.document_requirements
    (scope, customer_no, item_no, document_no, certificate_type, inspection_level,
     domestic_melt_required, packaging_note, marking_note, price_adder, lead_days_adder, note)
  select
    'customer', c.customer_no, null, null, r.cert, r.level, r.melt, r.pack, r.mark, r.adder, r.days, r.note
  from (
    select s.customer_no
    from nl.shipments s
    where s.shipment_no = v_target
    union
    select x.customer_no from (
      select c2.customer_no
      from nl.customers c2
      where exists (select 1 from nl.shipments s2 where s2.customer_no = c2.customer_no)
      order by c2.customer_no
      limit 6
    ) x
  ) c
  cross join (values
    ('MTR', 'standard', false, '', 'Heat number on every piece', 0.00, 0,
     'This account will not take material without the mill certificate'),
    ('COC', '', false, 'Boxed and labelled to the account standard', '', 12.50, 1,
     'A signed certificate of conformance with every shipment')
  ) as r(cert, level, melt, pack, mark, adder, days, note)
  where c.customer_no is not null
  on conflict do nothing;

  -- One account insists on domestic melt, which is the requirement that
  -- bites on a lot from an overseas mill rather than on a missing document.
  insert into nl.document_requirements
    (scope, customer_no, item_no, document_no, certificate_type, inspection_level,
     domestic_melt_required, packaging_note, marking_note, price_adder, lead_days_adder, note)
  select
    'customer', c.customer_no, null, null, 'COO', '', true, '', 'Country of melt on the packing list',
    18.00, 2, 'Domestic melt only, stated on the certificate'
  from (
    select c2.customer_no
    from nl.customers c2
    where exists (select 1 from nl.shipments s2 where s2.customer_no = c2.customer_no)
      and c2.customer_no <> coalesce((select s.customer_no from nl.shipments s where s.shipment_no = v_target), '')
    order by c2.customer_no desc
    limit 1
  ) c
  on conflict do nothing;

  -- A part that always ships with a first article on file, whoever buys it:
  -- the proprietary parts, which are made to one account's drawing.
  insert into nl.document_requirements
    (scope, customer_no, item_no, document_no, certificate_type, inspection_level,
     domestic_melt_required, packaging_note, marking_note, price_adder, lead_days_adder, note)
  select
    'item', null, i.item_no, null, 'FAI', 'first article', false, '', '', 145.00, 5,
    'Made to a drawing, so the dimensional report goes with it'
  from nl.items i
  where i.proprietary
  on conflict do nothing;

  -- The certificates of conformance we issue. Every shipment that has
  -- already gone has one; every shipment still on the dock has one too,
  -- except the target, which is short its mill certificate and not its
  -- certificate of conformance, so the refusal names exactly one thing.
  insert into nl.documents (kind, reference_no, issued_by, issued_on, expires_on, storage_ref, note)
  select
    'COC',
    'COC-' || s.shipment_no,
    'Northline Exhaust Co.',
    coalesce((s.shipped_at at time zone 'America/Chicago')::date, v_today),
    null,
    'certs/coc/' || lower(s.shipment_no) || '.pdf',
    ''
  from nl.shipments s
  where exists (select 1 from nl.shipment_lines l where l.shipment_no = s.shipment_no)
  on conflict do nothing;

  insert into nl.shipment_documents (shipment_no, document_id)
  select s.shipment_no, d.id
  from nl.shipments s
  join nl.documents d on d.kind = 'COC' and d.reference_no = 'COC-' || s.shipment_no
  on conflict (shipment_no, document_id) do nothing;

  -- And now the point of the whole file: take the mill certificates off the
  -- material under the target shipment, so it owes one and cannot go.
  if v_target is not null then
    delete from nl.lot_documents ld
    where ld.document_id in (
      select d.id
      from nl.shipment_line_lots sl
      cross join lateral nl.lot_trace_back(sl.lot_no) t
      join nl.lot_documents ld2 on ld2.lot_no = t.lot_no
      join nl.documents d on d.id = ld2.document_id
      where sl.shipment_no = v_target and d.kind = 'MTR'
    );
  end if;

  -- -------------------------------------------------------------------------
  -- 9. Balance every lot against what was actually taken out of it
  --
  -- Received is at least what was consumed and shipped out of it, and
  -- remaining is the difference. So nl.lot_balance_drift() is empty by
  -- construction and no lot can hold a negative quantity, whatever the draws
  -- above did.
  -- -------------------------------------------------------------------------
  update nl.lots l
     set quantity_received = greatest(l.quantity_received, b.used + b.shipped, 1),
         quantity_remaining = greatest(l.quantity_received, b.used + b.shipped, 1) - b.used - b.shipped,
         status = case
           when greatest(l.quantity_received, b.used + b.shipped, 1) - b.used - b.shipped <= 0 then 'consumed'
           when l.status = 'quarantine' then 'quarantine'
           else 'available'
         end
    from (
      select
        l2.lot_no,
        coalesce((select sum(c.quantity) from nl.lot_consumption c where c.child_lot = l2.lot_no), 0) as used,
        coalesce((select sum(s.quantity) from nl.shipment_line_lots s where s.lot_no = l2.lot_no), 0) as shipped
      from nl.lots l2
    ) b
   where b.lot_no = l.lot_no;

  -- A few lots sit in quarantine waiting for their paperwork, which is a
  -- real state and the reason the status column exists.
  update nl.lots
     set status = 'quarantine',
         note = 'Held: no mill certificate on file'
   where lot_no like 'RL-%'
     and quantity_remaining > 0
     and heat_no <> ''
     and not exists (select 1 from nl.lot_documents ld
                      join nl.documents d on d.id = ld.document_id
                     where ld.lot_no = lots.lot_no and d.kind = 'MTR')
     and nl_seed.chance(0.5, 'trace.quarantine|' || lot_no);
end $$;
