-- The raw material the context engine has to make sense of, and the context
-- it makes out of it.
--
-- The mess is the point. An operator's knowledge is not in one clean table,
-- so this seeds it the way it actually arrives:
--
--   * a LEGACY CRM EXPORT from 2024 that nobody has cleaned: the same account
--     spelled three ways, a phone number typed into the name field, two
--     different payment terms for one account, freight terms buried in a
--     free-text note, and a buyer who has since left;
--   * two years of ARCHIVED MAIL with facts worth mining in it: a freight
--     agreement, a certificate requirement, a preferred carrier, a buyer's
--     replacement, a customer's own part number for one of ours, a promise
--     about a price hold, a supplier's lead time;
--   * an ATTACHMENT-BORNE fact: a printed purchase order that states the
--     packaging and marking a customer will hold us to;
--   * HAND ENTRIES that contradict the ERP, so the world has a real conflict
--     in it and the conflicts screen is never empty by accident;
--   * PLAYBOOKS, the durable half of context, which is authored rather than
--     extracted.
--
-- Then the promotion rule runs over all of it and the bundles are compiled,
-- so a fresh world already has facts, conflicts, stale facts and gaps.
--
-- Everything is keyed randomness (nl_seed.u, nl_seed.ri, nl_seed.pick), so
-- the same day gives the same mess. The fact-bearing documents are a fixed
-- cast, because tests and screens depend on them; the routine archived mail
-- around them scales, so the volume is believable at every size.
--
-- The claims here are written straight into nl.claims rather than through
-- nl.record_claim, because the seed runs as the schema's owner and wants one
-- statement per group rather than one function call per claim. Every snippet
-- is a literal substring of the body it is quoted from, which is the rule
-- nl.record_claim enforces for everybody else.
create or replace function nl_seed.extra_93_context() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today    date := (select today from nl_seed.settings);
  v_scale    double precision := (select scale from nl_seed.settings);
  v_filler   int;
  v_doc      bigint;
  v_doc_b    bigint;
  v_cust     record;
  v_other    record;
  v_item     record;
  v_vendor   record;
  v_n        int;
  v_i        int;
  v_entry    bigint;
  v_body     text;
  v_subject  text;
  v_from     text;
  v_at       timestamptz;
  v_row      int := 0;
  v_po       text;
begin
  -- -------------------------------------------------------------------------
  -- 1. The sources, and how far each one is trusted
  -- -------------------------------------------------------------------------
  -- The tiers are the whole of what the promotion rule knows about a source,
  -- so they are worth arguing about once and then trusting. The ERP's own
  -- export is 5. A purchase order the customer printed and sent is 4: it is
  -- their own words on their own paperwork. Mail is 3. A person typing what
  -- they know is 2. A CRM export from 2024 is 1.
  insert into nl.sources (key, kind, name, trust_tier, refresh_cadence, authoritative_for, last_seen_at)
  values
    ('erp_customer_master', 'erp_export', 'ERP customer master export', 5,
     'every weekday morning',
     'Who an account is, its price group, and whether it ships on its own carrier account.',
     v_today::timestamptz),
    ('erp_open_orders', 'erp_export', 'ERP open sales lines export', 5,
     'every weekday morning',
     'What is on order and not yet shipped. Nothing about terms.',
     v_today::timestamptz),
    ('customer_purchase_orders', 'attachment', 'Purchase orders customers send in', 4,
     'with the mail they arrive on',
     'Packaging, marking and the terms a customer will hold us to, in their own words on their own paperwork.',
     (v_today - 40)::timestamptz),
    ('order_desk_inbox', 'inbox', 'Order desk inbox', 3,
     'as mail arrives',
     'What a customer or a supplier said in writing, on the date they said it.',
     v_today::timestamptz),
    ('mail_archive', 'inbox', 'Archived mail, 2024 onward', 3,
     'no longer refreshed',
     'Correspondence history. Good for what was agreed; it says nothing about what is true today.',
     (v_today - 3)::timestamptz),
    ('crm_activity', 'manual', 'Call and note log', 2,
     'as the team logs calls',
     'What was said on a call, in the words of whoever made it.',
     v_today::timestamptz),
    ('hand_entry', 'manual', 'Typed by a person', 3,
     'when somebody types one',
     'What a rep knows and no system holds. Level with a customer''s own email: a rep on the phone heard it too.',
     v_today::timestamptz),
    ('legacy_crm_2024', 'crm_export', 'Legacy CRM export, March 2024', 1,
     'once, in March 2024',
     'Nothing on its own. A starting point for names and old terms, and it is known to be dirty.',
     '2024-03-14'::timestamptz)
  on conflict (key) do nothing;

  -- The extractors. Two recognizer versions on purpose: one of them is the
  -- one a test revokes, which is why a version is on every claim.
  insert into nl.extractors (name, version, kind, note) values
    ('recognizer', '1', 'recognizer',
     'The deterministic patterns in app/src/lib/context/recognize.ts.'),
    ('legacy_import', '1', 'adapter',
     'Reads the 2024 CRM export''s own columns. Not a guess: the columns are labelled.'),
    ('po_reader', '1', 'adapter',
     'Reads a printed purchase order''s terms block.'),
    ('prose_model', '1', 'model',
     'Stage two: prose with no shape. Every claim carries the verbatim span, which is checked.'),
    ('person', '1', 'person', 'Somebody typed it.')
  on conflict (name, version) do nothing;

  -- -------------------------------------------------------------------------
  -- 2. The cast: accounts with enough history to have context worth holding
  -- -------------------------------------------------------------------------
  create temporary table ctx_account on commit drop as
  select c.customer_no, c.name, c.city, c.state, c.email_domain, c.ships_own_carrier,
         ct.id as contact_id, ct.full_name as contact_name, ct.title as contact_title,
         ct.email as contact_email,
         row_number() over (order by nl_seed.u('ctx.account|' || c.customer_no)) as pick
  from nl.customers c
  join nl.contacts ct
    on ct.customer_no = c.customer_no and ct.is_primary and ct.email is not null
  where not c.blocked and not c.closed and c.email_domain is not null
    and exists (select 1 from nl.invoice_lines il
                where il.customer_no = c.customer_no and il.posted_on > v_today - 730);

  select count(*) into v_n from ctx_account;
  -- A world too small to hold a conversation gets no invented context rather
  -- than invented context about nobody.
  if v_n < 6 then
    return;
  end if;

  -- The part each of those accounts buys most, for the cross-reference facts.
  create temporary table ctx_part on commit drop as
  select a.customer_no, il.item_no, i.description, i.family,
         row_number() over (partition by a.customer_no
                            order by sum(il.quantity) desc, il.item_no) as pick
  from ctx_account a
  join nl.invoice_lines il on il.customer_no = a.customer_no
  join nl.items i on i.item_no = il.item_no
  where not i.blocked and il.quantity > 0 and il.posted_on > v_today - 730
  group by a.customer_no, il.item_no, i.description, i.family;

  -- -------------------------------------------------------------------------
  -- 3. The legacy CRM export, dirty on purpose
  -- -------------------------------------------------------------------------
  -- One jsonb row per line as it arrived, plus the row rendered as text,
  -- which is what a recognizer reads and what a snippet is checked against.
  -- Nothing is cleaned in place: the duplicates and the phone number in the
  -- name field stay visible, and claims are made from the rows.
  for v_cust in select * from ctx_account where pick <= 14 order by pick loop
    v_row := v_row + 1;

    -- The ordinary row: the account, its buyer, and terms in the terms field.
    v_body := format(
      'ACCT,%s,%s,%s %s,%s,%s,Net %s,%s',
      v_cust.customer_no, v_cust.name, v_cust.city, v_cust.state,
      v_cust.contact_name, coalesce(v_cust.contact_email, ''),
      nl_seed.pick(array['30', '45', '60'], 'ctx.terms|' || v_cust.customer_no),
      case when nl_seed.chance(0.5, 'ctx.fr|' || v_cust.customer_no)
           then 'freight collect' else 'freight prepaid and add' end);
    insert into nl.legacy_crm_rows (export_name, row_no, raw, raw_text)
    values ('crm-export-2024-03-14.csv', v_row,
            jsonb_build_object('record', 'ACCT', 'acct_no', v_cust.customer_no,
                               'acct_name', v_cust.name,
                               'city_state', v_cust.city || ' ' || v_cust.state,
                               'contact', v_cust.contact_name,
                               'contact_email', coalesce(v_cust.contact_email, ''),
                               'terms', 'Net ' || nl_seed.pick(array['30', '45', '60'],
                                          'ctx.terms|' || v_cust.customer_no),
                               'notes', v_body),
            v_body);

    -- Every fourth account gets a DUPLICATE row under a different spelling
    -- and no account number, which is exactly the shape entity resolution
    -- exists for.
    if v_row % 4 = 1 then
      v_row := v_row + 1;
      v_body := format('ACCT,,%s,%s %s,,,Net 30,duplicate of an account we cannot match on number',
                       upper(replace(replace(v_cust.name, ' Truck Parts', ' TRUCK PTS'), '&', 'AND')),
                       v_cust.city, v_cust.state);
      insert into nl.legacy_crm_rows (export_name, row_no, raw, raw_text)
      values ('crm-export-2024-03-14.csv', v_row,
              jsonb_build_object('record', 'ACCT', 'acct_no', '',
                                 'acct_name', upper(replace(replace(v_cust.name, ' Truck Parts', ' TRUCK PTS'), '&', 'AND')),
                                 'city_state', v_cust.city || ' ' || v_cust.state,
                                 'terms', 'Net 30'),
              v_body);
    end if;

    -- Every fifth account gets a SECOND terms row that disagrees with the
    -- first, from the same export. Two payment terms for one account, which
    -- is what a real dirty export looks like.
    if v_row % 5 = 2 then
      v_row := v_row + 1;
      v_body := format('TERMS,%s,%s,Net %s,superseded?,keyed by hand 2024', v_cust.customer_no,
                       v_cust.name,
                       nl_seed.pick(array['15', '20', '90'], 'ctx.terms2|' || v_cust.customer_no));
      insert into nl.legacy_crm_rows (export_name, row_no, raw, raw_text)
      values ('crm-export-2024-03-14.csv', v_row,
              jsonb_build_object('record', 'TERMS', 'acct_no', v_cust.customer_no,
                                 'terms', 'Net ' || nl_seed.pick(array['15', '20', '90'],
                                            'ctx.terms2|' || v_cust.customer_no)),
              v_body);
    end if;

    -- Every seventh account has a PHONE NUMBER in the name field, which a
    -- name matcher must not treat as a company.
    if v_row % 7 = 3 then
      v_row := v_row + 1;
      v_body := format('ACCT,%s,555-01%s,%s %s,,,Net 30,name field holds a phone number',
                       v_cust.customer_no, lpad((10 + (v_row % 80))::text, 2, '0'),
                       v_cust.city, v_cust.state);
      insert into nl.legacy_crm_rows (export_name, row_no, raw, raw_text)
      values ('crm-export-2024-03-14.csv', v_row,
              jsonb_build_object('record', 'ACCT', 'acct_no', v_cust.customer_no,
                                 'acct_name', '555-01' || lpad((10 + (v_row % 80))::text, 2, '0'),
                                 'terms', 'Net 30'),
              v_body);
    end if;
  end loop;

  -- Register each legacy row as a source document, and make the claim the
  -- legacy adapter would make from its labelled terms column. Trust tier 1,
  -- asserted in March 2024, so it loses to anything newer or better and shows
  -- up as the thing that made a fact stale.
  for v_cust in
    select r.id, r.row_no, r.raw, r.raw_text
    from nl.legacy_crm_rows r
    where r.export_name = 'crm-export-2024-03-14.csv'
      and r.raw ->> 'acct_no' <> ''
      and r.raw ->> 'terms' like 'Net %'
    order by r.row_no
  loop
    v_doc := nl_seed.ctx_document('legacy_crm_2024',
      'legacy-row-' || v_cust.row_no,
      format('CRM export row %s', v_cust.row_no),
      '2024-03-14 09:00+00'::timestamptz, 'text/csv', 'legacy_crm_rows', v_cust.id::text);

    perform nl_seed.ctx_claim(
      'customer', v_cust.raw ->> 'acct_no', v_cust.raw ->> 'acct_no',
      'payment_terms_days',
      null, replace(v_cust.raw ->> 'terms', 'Net ', '')::numeric, null, null, null, 'days',
      replace(v_cust.raw ->> 'terms', 'Net ', '') || ' days',
      null, null, null, null, null,
      '2024-03-14'::date, '2024-03-14'::date, null,
      v_doc, 'legacy_import', '1',
      format('row %s, terms column', v_cust.row_no),
      v_cust.raw ->> 'terms',
      0.95, 1.0, 0.9);
  end loop;

  -- The freight terms sitting in the free-text notes column, which is where
  -- they actually were. Read by the recognizer, not by the adapter, because
  -- nobody labelled that column.
  for v_cust in
    select r.id, r.row_no, r.raw, r.raw_text
    from nl.legacy_crm_rows r
    where r.export_name = 'crm-export-2024-03-14.csv'
      and r.raw ->> 'acct_no' <> ''
      and r.raw_text like '%freight %'
    order by r.row_no
  loop
    v_doc := (select d.id from nl.source_documents d
              where d.source_key = 'legacy_crm_2024'
                and d.external_ref = 'legacy-row-' || v_cust.row_no);
    if v_doc is null then
      continue;
    end if;
    perform nl_seed.ctx_claim(
      'customer', v_cust.raw ->> 'acct_no', v_cust.raw ->> 'acct_no',
      'freight_terms',
      case when v_cust.raw_text like '%collect%' then 'collect' else 'prepaid_and_add' end,
      null, null, null, null, '',
      case when v_cust.raw_text like '%collect%' then 'collect' else 'prepaid and add' end,
      null, null, null, null, null,
      '2024-03-14'::date, '2024-03-14'::date, null,
      v_doc, 'recognizer', '1',
      format('row %s, notes column', v_cust.row_no),
      case when v_cust.raw_text like '%collect%' then 'freight collect' else 'freight prepaid and add' end,
      0.95, 0.9, 0.88);
  end loop;

  -- -------------------------------------------------------------------------
  -- 4. Two years of archived mail
  -- -------------------------------------------------------------------------
  -- Ten fact-bearing letters, one per account, each holding one thing worth
  -- mining. They are a fixed cast because the screens and the tests depend on
  -- them. Every snippet quoted below is a literal line of the body.

  -- (a) A freight agreement, eleven months ago. Newer than the legacy export
  --     and from a source we trust more, so it wins outright.
  select * into v_cust from ctx_account where pick = 1;
  v_subject := 'Freight on our stocking orders';
  v_body := format(
E'Hi,\n\nWe talked this through with your office last week and I want it in writing so nobody has to ask again.\nFrom now on please ship freight collect on our stocking orders.\nOur terms stay Net 45 from the invoice date.\n\nThanks,\n%s\n%s\n%s\n%s, %s',
    v_cust.contact_name, v_cust.contact_title, v_cust.name, v_cust.city, v_cust.state);
  v_at := (v_today - 334)::timestamptz + interval '9 hours 12 minutes';
  v_doc := nl_seed.ctx_mail(v_cust.contact_email, v_cust.contact_name, v_subject, v_body, v_at,
                            v_cust.customer_no, null, 'orders');
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'freight_terms',
    'collect', null, null, null, null, '', 'collect',
    null, null, null, null, null,
    (v_today - 334)::date, (v_today - 334)::date, null,
    v_doc, 'recognizer', '1', 'line 5',
    'From now on please ship freight collect on our stocking orders.',
    0.98, 0.95, 0.9);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'payment_terms_days',
    null, 45, null, null, null, 'days', '45 days',
    null, null, null, null, null,
    (v_today - 334)::date, (v_today - 334)::date, null,
    v_doc, 'recognizer', '1', 'line 6',
    'Our terms stay Net 45 from the invoice date.',
    0.98, 0.95, 0.95);

  -- (b) A certificate requirement, two years back, still in force. Old
  --     enough to be stale under its own horizon in some worlds, which is
  --     exactly the case the coverage screen is for.
  select * into v_cust from ctx_account where pick = 2;
  v_subject := 'Paperwork we need with every shipment';
  v_body := format(
E'Good afternoon,\n\nOur quality department has tightened up. Every shipment now needs a certificate of conformance in the box.\nWithout it our receiving team will not book the parts in, and that helps nobody.\n\nRegards,\n%s\n%s\n%s',
    v_cust.contact_name, v_cust.contact_title, v_cust.name);
  v_at := (v_today - 688)::timestamptz + interval '14 hours 41 minutes';
  v_doc := nl_seed.ctx_mail(v_cust.contact_email, v_cust.contact_name, v_subject, v_body, v_at,
                            v_cust.customer_no, null, 'orders');
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'certificate_required',
    'certificate_of_conformance', null, null, null, null, '', 'certificate of conformance',
    null, null, null, null, null,
    (v_today - 688)::date, (v_today - 688)::date, null,
    v_doc, 'recognizer', '1', 'line 4',
    'Every shipment now needs a certificate of conformance in the box.',
    0.97, 0.95, 0.92);

  -- (c) A preferred carrier, and a customer's own part number for one of
  --     ours. The part number is scoped to the part, because it has to be.
  select * into v_cust from ctx_account where pick = 3;
  select * into v_item from ctx_part where customer_no = v_cust.customer_no and pick = 1;
  v_subject := 'Routing, and our own number for one of yours';
  v_body := format(
E'Morning,\n\nTwo housekeeping things.\n\nPlease route it via Cordell Freight Lines on anything over a pallet. Our dock has an account with them.\nAlso, your %s shows up as XPT-4471 in our system, so put that on the packing list and our receiving\nteam will stop calling you about it.\n\nThanks,\n%s\n%s\n%s',
    v_item.item_no, v_cust.contact_name, v_cust.contact_title, v_cust.name);
  v_at := (v_today - 210)::timestamptz + interval '8 hours 3 minutes';
  v_doc := nl_seed.ctx_mail(v_cust.contact_email, v_cust.contact_name, v_subject, v_body, v_at,
                            v_cust.customer_no, null, 'orders');
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'preferred_carrier',
    'Cordell Freight Lines', null, null, null, null, '', 'Cordell Freight Lines',
    null, null, null, null, null,
    (v_today - 210)::date, (v_today - 210)::date, null,
    v_doc, 'recognizer', '1', 'line 6',
    'Please route it via Cordell Freight Lines on anything over a pallet.',
    0.98, 0.9, 0.85);
  if v_item.item_no is not null then
    perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'customer_part_no',
      'XPT-4471', null, null, null, null, '', 'XPT-4471',
      null, null, v_item.item_no, null, null,
      (v_today - 210)::date, (v_today - 210)::date, null,
      v_doc, 'recognizer', '1', 'line 7',
      format('Also, your %s shows up as XPT-4471 in our system, so put that on the packing list and our receiving', v_item.item_no),
      0.98, 0.92, 0.9);
  end if;

  -- (d) The buyer left and somebody else took over. Two facts out of one
  --     letter, one of them about a person.
  select * into v_cust from ctx_account where pick = 4;
  v_subject := 'Change of buyer here';
  v_body := format(
E'Hello,\n\n%s has left us. Dana Whitfield is now taking over purchasing for the whole branch.\nPlease copy dana.whitfield@%s on anything to do with orders from here on.\n\nRegards,\nFront office\n%s',
    v_cust.contact_name, v_cust.email_domain, v_cust.name);
  v_at := (v_today - 96)::timestamptz + interval '11 hours 5 minutes';
  v_doc := nl_seed.ctx_mail('frontoffice@' || v_cust.email_domain, 'Front office', v_subject, v_body,
                            v_at, v_cust.customer_no, null, 'orders');
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'primary_buyer_name',
    'Dana Whitfield', null, null, null, null, '', 'Dana Whitfield',
    null, null, null, null, null,
    (v_today - 96)::date, (v_today - 96)::date, null,
    v_doc, 'recognizer', '1', 'line 3',
    format('%s has left us. Dana Whitfield is now taking over purchasing for the whole branch.', v_cust.contact_name),
    0.96, 0.85, 0.8);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'primary_buyer_email',
    'dana.whitfield@' || v_cust.email_domain, null, null, null, null, '',
    'dana.whitfield@' || v_cust.email_domain,
    null, null, null, null, null,
    (v_today - 96)::date, (v_today - 96)::date, null,
    v_doc, 'recognizer', '1', 'line 4',
    format('Please copy dana.whitfield@%s on anything to do with orders from here on.', v_cust.email_domain),
    0.96, 0.9, 0.85);
  if v_cust.contact_id is not null then
    perform nl_seed.ctx_claim('contact', v_cust.contact_id::text, v_cust.contact_name,
      'contact_left_company',
      null, null, null, true, null, '', 'yes',
      null, null, null, null, null,
      (v_today - 96)::date, (v_today - 96)::date, null,
      v_doc, 'recognizer', '1', 'line 3',
      format('%s has left us.', v_cust.contact_name),
      0.9, 0.88, 0.9);
  end if;

  -- (e) A promise about a price hold, with a date in it that has to be read
  --     as a date and not as a number.
  select * into v_cust from ctx_account where pick = 5;
  v_subject := 'Confirming what we agreed on pricing';
  v_body := format(
E'Hi,\n\nThank you for the call. Confirming what we agreed: you are holding the pricing through December 31.\nWe will place the first release against it next month.\n\n%s\n%s\n%s',
    v_cust.contact_name, v_cust.contact_title, v_cust.name);
  v_at := (v_today - 58)::timestamptz + interval '15 hours 22 minutes';
  v_doc := nl_seed.ctx_mail(v_cust.contact_email, v_cust.contact_name, v_subject, v_body, v_at,
                            v_cust.customer_no, null, 'orders');
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'price_hold_until',
    null, null, (date_trunc('year', v_today) + interval '1 year - 1 day')::date, null, null, '',
    to_char((date_trunc('year', v_today) + interval '1 year - 1 day')::date, 'YYYY-MM-DD'),
    null, null, null, null, null,
    (v_today - 58)::date, (v_today - 58)::date,
    (date_trunc('year', v_today) + interval '1 year - 1 day')::date,
    v_doc, 'prose_model', '1', 'line 3',
    'Confirming what we agreed: you are holding the pricing through December 31.',
    0.97, 0.85, 0.8);

  -- (f) A purchase order requirement and a packaging line, in an old letter
  --     whose freight terms have since been overtaken.
  select * into v_cust from ctx_account where pick = 6;
  v_subject := 'How to ship to our yard';
  v_body := format(
E'Hello,\n\nA few standing instructions for our yard.\n\nWe always need our purchase order number on the paperwork before receiving will take a delivery.\nPlease pack stacks in twos with cardboard between them; loose in a crate comes in scratched every time.\nFreight prepaid and add is fine with us.\n\n%s\n%s\n%s',
    v_cust.contact_name, v_cust.contact_title, v_cust.name);
  v_at := (v_today - 505)::timestamptz + interval '10 hours 18 minutes';
  v_doc := nl_seed.ctx_mail(v_cust.contact_email, v_cust.contact_name, v_subject, v_body, v_at,
                            v_cust.customer_no, null, 'orders');
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'purchase_order_required',
    null, null, null, true, null, '', 'yes',
    null, null, null, null, null,
    (v_today - 505)::date, (v_today - 505)::date, null,
    v_doc, 'recognizer', '1', 'line 5',
    'We always need our purchase order number on the paperwork before receiving will take a delivery.',
    0.97, 0.9, 0.85);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'packaging_requirement',
    'pack stacks in twos with cardboard between them', null, null, null, null, '',
    'pack stacks in twos with cardboard between them',
    null, null, null, null, null,
    (v_today - 505)::date, (v_today - 505)::date, null,
    v_doc, 'recognizer', '1', 'line 6',
    'Please pack stacks in twos with cardboard between them; loose in a crate comes in scratched every time.',
    0.97, 0.85, 0.78);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'freight_terms',
    'prepaid_and_add', null, null, null, null, '', 'prepaid and add',
    null, null, null, null, null,
    (v_today - 505)::date, (v_today - 505)::date, null,
    v_doc, 'recognizer', '1', 'line 7',
    'Freight prepaid and add is fine with us.',
    0.97, 0.95, 0.9);

  -- -------------------------------------------------------------------------
  -- 5. An attachment-borne fact: the customer's own printed purchase order
  -- -------------------------------------------------------------------------
  -- The page text is held in nl.source_document_pages, which is what a PDF
  -- reader produces. The bytes are not invented and not stored: what is
  -- stored is what was read, which is the honest thing to keep.
  select * into v_cust from ctx_account where pick = 7;
  select * into v_item from ctx_part where customer_no = v_cust.customer_no and pick = 1;
  v_po := format('PO-%s', nl_seed.ri(480000, 489999, 'ctx.po|' || v_cust.customer_no));
  v_subject := format('%s attached', v_po);
  v_body := format(
E'Hello,\n\n%s attached. The terms block on page 2 is the one our receiving team goes by, so please read it.\n\n%s\n%s\n%s',
    v_po, v_cust.contact_name, v_cust.contact_title, v_cust.name);
  v_at := (v_today - 42)::timestamptz + interval '13 hours 7 minutes';
  v_doc_b := nl_seed.ctx_mail(v_cust.contact_email, v_cust.contact_name, v_subject, v_body, v_at,
                              v_cust.customer_no, null, 'orders');

  v_doc := nl_seed.ctx_document('customer_purchase_orders', v_po,
    format('%s from %s (attachment)', v_po, v_cust.name),
    v_at, 'application/pdf', 'mail_archive',
    (select d.ref_id from nl.source_documents d where d.id = v_doc_b));
  insert into nl.source_document_pages (source_document_id, page_no, label, text)
  values
    (v_doc, 1, 'page 1', format(
E'%s\nPURCHASE ORDER\n%s\n%s, %s\n\nShip to: receiving dock\nBuyer: %s\n\nLine 1  %s  qty 24\n',
      v_cust.name, v_po, v_cust.city, v_cust.state, v_cust.contact_name,
      coalesce(v_item.item_no, 'see attached list'))),
    (v_doc, 2, 'page 2', format(
E'%s  TERMS AND CONDITIONS\n\n1. Payment terms are Net 60 from the date of invoice.\n2. Goods must be palletised and banded, no loose cartons.\n3. Every carton must be marked with our purchase order number and the part number.\n4. A certificate of conformance is required with every shipment.\n5. Freight collect on our carrier account unless agreed in writing.\n',
      v_po))
  on conflict (source_document_id, page_no) do nothing;

  -- Four facts off the terms block. Tier 4, so they beat mail and the legacy
  -- export and lose to the ERP.
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'payment_terms_days',
    null, 60, null, null, null, 'days', '60 days',
    null, null, null, null, null,
    (v_today - 42)::date, (v_today - 42)::date, null,
    v_doc, 'po_reader', '1', 'page 2, line 3',
    '1. Payment terms are Net 60 from the date of invoice.',
    0.99, 0.98, 0.97);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'packaging_requirement',
    'palletised and banded, no loose cartons', null, null, null, null, '',
    'palletised and banded, no loose cartons',
    null, null, null, null, null,
    (v_today - 42)::date, (v_today - 42)::date, null,
    v_doc, 'po_reader', '1', 'page 2, line 4',
    '2. Goods must be palletised and banded, no loose cartons.',
    0.99, 0.95, 0.94);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'marking_requirement',
    'marked with the purchase order number and the part number', null, null, null, null, '',
    'marked with the purchase order number and the part number',
    null, null, null, null, null,
    (v_today - 42)::date, (v_today - 42)::date, null,
    v_doc, 'po_reader', '1', 'page 2, line 5',
    '3. Every carton must be marked with our purchase order number and the part number.',
    0.99, 0.95, 0.94);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'certificate_required',
    'certificate_of_conformance', null, null, null, null, '', 'certificate of conformance',
    null, null, null, null, null,
    (v_today - 42)::date, (v_today - 42)::date, null,
    v_doc, 'po_reader', '1', 'page 2, line 6',
    '4. A certificate of conformance is required with every shipment.',
    0.99, 0.97, 0.96);

  -- -------------------------------------------------------------------------
  -- 6. Hand entries, including one that contradicts the ERP
  -- -------------------------------------------------------------------------
  -- Account 7's purchase order says freight collect on their own carrier.
  -- A rep then types that we are paying the freight. The ERP knows whether
  -- the account is on its own carrier account, so the cross-check catches it
  -- and the claim becomes a data-quality item rather than a fact. That is
  -- the "hand entries that contradict the ERP" case, caught rather than
  -- promoted.
  insert into nl.context_entries (subject_kind, subject_id, body, author_id, entered_at)
  values ('customer', v_cust.customer_no,
          format('Told them on the phone we pay the freight on the next two releases. %s is fine with it.',
                 v_cust.contact_name),
          2, (v_today - 9)::timestamptz + interval '16 hours')
  returning id into v_entry;
  v_doc := nl_seed.ctx_document('hand_entry', 'entry-' || v_entry,
    format('Hand entry about %s', v_cust.name),
    (v_today - 9)::timestamptz + interval '16 hours', 'text/plain', 'context_entries', v_entry::text);
  perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'freight_payer',
    'northline', null, null, null, null, '', 'northline',
    null, null, null, null, null,
    (v_today - 9)::date, (v_today - 9)::date, null,
    v_doc, 'person', '1', 'line 1',
    'Told them on the phone we pay the freight on the next two releases.',
    0.99, 0.9, 0.7);

  -- And one hand entry that disagrees with an old letter by enough to need a
  -- person: a rep says Net 30 where the legacy export says something else.
  -- Both are tier-adjacent, so trust does not settle it.
  select * into v_other from ctx_account where pick = 8;
  insert into nl.context_entries (subject_kind, subject_id, body, author_id, entered_at)
  values ('customer', v_other.customer_no,
          'Their controller told me on the phone their terms are Net 30, whatever the old system says.',
          3, (v_today - 21)::timestamptz + interval '10 hours 30 minutes')
  returning id into v_entry;
  v_doc := nl_seed.ctx_document('hand_entry', 'entry-' || v_entry,
    format('Hand entry about %s', v_other.name),
    (v_today - 21)::timestamptz + interval '10 hours 30 minutes', 'text/plain',
    'context_entries', v_entry::text);
  perform nl_seed.ctx_claim('customer', v_other.customer_no, v_other.name, 'payment_terms_days',
    null, 30, null, null, null, 'days', '30 days',
    null, null, null, null, null,
    (v_today - 21)::date, (v_today - 21)::date, null,
    v_doc, 'person', '1', 'line 1',
    'Their controller told me on the phone their terms are Net 30, whatever the old system says.',
    0.99, 0.95, 0.85);
  -- The rival, from archived mail on the same day, at the same trust tier as
  -- a hand entry is adjacent to. A person has to choose.
  v_subject := 'Our terms';
  v_body := format(
E'Hello,\n\nFor the record, our standing terms with you are Net 90 and have been for years.\nPlease do not change them without talking to me first.\n\n%s\n%s\n%s',
    v_other.contact_name, v_other.contact_title, v_other.name);
  v_at := (v_today - 20)::timestamptz + interval '9 hours 40 minutes';
  v_doc := nl_seed.ctx_mail(v_other.contact_email, v_other.contact_name, v_subject, v_body, v_at,
                            v_other.customer_no, null, 'orders');
  perform nl_seed.ctx_claim('customer', v_other.customer_no, v_other.name, 'payment_terms_days',
    null, 90, null, null, null, 'days', '90 days',
    null, null, null, null, null,
    (v_today - 20)::date, (v_today - 20)::date, null,
    v_doc, 'recognizer', '1', 'line 3',
    'For the record, our standing terms with you are Net 90 and have been for years.',
    0.98, 0.95, 0.95);

  -- -------------------------------------------------------------------------
  -- 6b. Two things we could not accept, kept with their snippets
  -- -------------------------------------------------------------------------
  -- Nothing is dropped silently. A value that parses and is not believable is
  -- a data-quality item; a line nobody could land on an attribute is an
  -- unparsed item. Both keep their words, and both are on the second tab of
  -- the conflicts screen.
  insert into nl.context_entries (subject_kind, subject_id, body, author_id, entered_at)
  values ('customer', v_other.customer_no,
          E'Their buyer says the mill behind this line is quoting about 400 days now.\nThey also said something about a "blanket release against the annual", which I did not follow.',
          3, (v_today - 6)::timestamptz + interval '15 hours 10 minutes')
  returning id into v_entry;
  v_doc := nl_seed.ctx_document('hand_entry', 'entry-' || v_entry,
    format('Hand entry about %s', v_other.name),
    (v_today - 6)::timestamptz + interval '15 hours 10 minutes', 'text/plain',
    'context_entries', v_entry::text);

  insert into nl.context_review_items
    (kind, source_document_id, subject_kind, subject_id, subject_raw, proposed_attribute,
     locator, snippet, reason, extractor, extractor_version)
  values
    ('failed_validation', v_doc, 'customer', v_other.customer_no, v_other.name,
     'vendor_lead_time_days', 'line 1',
     'Their buyer says the mill behind this line is quoting about 400 days now.',
     '400 above 200 is not believable.', 'recognizer', '1'),
    ('unparsed', v_doc, 'customer', v_other.customer_no, v_other.name, null, 'line 2',
     'They also said something about a "blanket release against the annual", which I did not follow.',
     'Could not tell what this means: no attribute in the dictionary covers a blanket release.',
     'prose_model', '1')
  on conflict (source_document_id, locator, kind, snippet) do nothing;

  -- -------------------------------------------------------------------------
  -- 7. A supplier's lead time, from the procurement side
  -- -------------------------------------------------------------------------
  select v.vendor_no, v.name, v.city, v.state into v_vendor
  from nl.vendors v
  where exists (select 1 from nl.items i where i.vendor_no = v.vendor_no)
  order by nl_seed.u('ctx.vendor|' || v.vendor_no)
  limit 1;

  if v_vendor.vendor_no is not null then
    v_subject := 'Lead times from our end';
    v_body := format(
E'Hello,\n\nOur lead time is running 3 to 4 weeks at the moment, and that is honest rather than optimistic.\nOur minimum order is $2,500 and we cannot ship under it.\n\nShipping office\n%s\n%s, %s',
      v_vendor.name, v_vendor.city, v_vendor.state);
    v_at := (v_today - 74)::timestamptz + interval '8 hours 55 minutes';
    v_doc := nl_seed.ctx_mail('shipping@' || nl_seed.slug(v_vendor.name) || '.example',
                              'Shipping office', v_subject, v_body, v_at, null,
                              v_vendor.vendor_no, 'procurement');
    perform nl_seed.ctx_claim('vendor', v_vendor.vendor_no, v_vendor.name, 'vendor_lead_time_days',
      null, null, null, null, '{"low": 21, "high": 28}'::jsonb, 'days', '21 to 28 days',
      null, null, null, null, v_vendor.vendor_no,
      (v_today - 74)::date, (v_today - 74)::date, null,
      v_doc, 'recognizer', '1', 'line 3',
      'Our lead time is running 3 to 4 weeks at the moment, and that is honest rather than optimistic.',
      0.98, 0.92, 0.9);
    perform nl_seed.ctx_claim('vendor', v_vendor.vendor_no, v_vendor.name,
      'vendor_minimum_order_value',
      null, 2500, null, null, null, 'USD', '$2,500.00',
      null, null, null, null, v_vendor.vendor_no,
      (v_today - 74)::date, (v_today - 74)::date, null,
      v_doc, 'recognizer', '1', 'line 4',
      'Our minimum order is $2,500 and we cannot ship under it.',
      0.98, 0.92, 0.92);

    -- An older, slower lead time from the same supplier, at the same trust
    -- tier. It loses on recency, which is the second rung of the rule.
    v_subject := 'Delivery dates';
    v_body := format(
E'Hello,\n\nLead time here is about eight weeks while the mill catches up.\n\nShipping office\n%s',
      v_vendor.name);
    v_at := (v_today - 430)::timestamptz + interval '9 hours 30 minutes';
    v_doc := nl_seed.ctx_mail('shipping@' || nl_seed.slug(v_vendor.name) || '.example',
                              'Shipping office', v_subject, v_body, v_at, null,
                              v_vendor.vendor_no, 'procurement');
    perform nl_seed.ctx_claim('vendor', v_vendor.vendor_no, v_vendor.name, 'vendor_lead_time_days',
      null, null, null, null, '{"low": 56, "high": 56}'::jsonb, 'days', '56 days',
      null, null, null, null, v_vendor.vendor_no,
      (v_today - 430)::date, (v_today - 430)::date, null,
      v_doc, 'recognizer', '1', 'line 3',
      'Lead time here is about eight weeks while the mill catches up.',
      0.98, 0.92, 0.88);
  end if;

  -- -------------------------------------------------------------------------
  -- 8. A claim nobody can attach to an account yet
  -- -------------------------------------------------------------------------
  -- Mail from an address on nobody's file, naming a company by a spelling
  -- that is not ours. The value parses, the attribute is in the dictionary,
  -- and the SUBJECT does not resolve, so the claim is unresolved: work for a
  -- person, not a fact and not a failure.
  select * into v_other from ctx_account where pick = 9;
  v_subject := 'Terms for our new account';
  v_body := format(
E'Hello,\n\nWe are opening an account with you. Our standard terms with suppliers are Net 45.\nPlease ship freight collect.\n\nPurchasing\n%s of Bellwether\n', upper(nl_seed.slug(v_other.name)));
  v_at := (v_today - 12)::timestamptz + interval '12 hours 1 minute';
  v_doc := nl_seed.ctx_mail('purchasing@bellwetherpartsgroup.example', 'Purchasing', v_subject,
                            v_body, v_at, null, null, 'orders');
  perform nl_seed.ctx_claim('customer', null,
    'Bellwether Parts Group', 'payment_terms_days',
    null, 45, null, null, null, 'days', '45 days',
    null, null, null, null, null,
    (v_today - 12)::date, (v_today - 12)::date, null,
    v_doc, 'recognizer', '1', 'line 3',
    'Our standard terms with suppliers are Net 45.',
    0.2, 0.95, 0.95);
  insert into nl.entity_candidates (raw_kind, raw_value, target_kind, target_id, score, evidence,
                                    source_document_id)
  values ('email_domain', 'bellwetherpartsgroup.example', 'customer', v_other.customer_no, 0.31,
          jsonb_build_object('rule', 'name_slug',
                             'detail', 'The domain is not on file. The name is unlike anything in the book.'),
          v_doc)
  on conflict (raw_kind, raw_value, target_kind, target_id) do nothing;

  -- -------------------------------------------------------------------------
  -- 9. Routine archived mail, so the volume is believable
  -- -------------------------------------------------------------------------
  -- No facts worth mining in these, which is honest: most mail is like that.
  -- They exist so the exploration tool has a haystack, and they scale.
  v_filler := greatest(55, round(100 * v_scale)::int);
  v_i := 0;
  while v_i < v_filler loop
    v_i := v_i + 1;
    select * into v_cust from ctx_account where pick = 1 + (v_i % v_n);
    select * into v_item from ctx_part
    where customer_no = v_cust.customer_no and pick = 1 + (v_i % 2);
    v_subject := nl_seed.pick(
      array['Quick question', 'Following up', 'Order update', 'Thanks', 'Delivery yesterday',
            'Counter question', 'Checking in'],
      'ctx.filler.subject|' || v_i::text);
    v_body := format(
E'Hi,\n\n%s\n\n%s\n%s\n%s',
      nl_seed.pick(array[
        'Thanks for getting that on the truck so quickly, the shop was waiting on it.',
        format('Did the %s go out yesterday? The driver did not leave a slip.', coalesce(v_item.item_no, 'order')),
        'No action needed, just closing the loop on our last conversation.',
        'Our counter staff asked me to say thank you for the catalogue.',
        format('Can you confirm you still carry %s? A customer asked.', coalesce(v_item.item_no, 'that line')),
        'Everything arrived and everything was right. Rare and appreciated.'],
        'ctx.filler.body|' || v_i::text),
      v_cust.contact_name, v_cust.contact_title, v_cust.name);
    v_at := (v_today - nl_seed.ri(20, 700, 'ctx.filler.when|' || v_i::text))::timestamptz
            + (interval '1 minute' * nl_seed.ri(420, 1020, 'ctx.filler.min|' || v_i::text));
    perform nl_seed.ctx_mail(v_cust.contact_email, v_cust.contact_name, v_subject, v_body, v_at,
                             v_cust.customer_no, null, 'orders');
  end loop;

  -- -------------------------------------------------------------------------
  -- 10. The ERP adapter: register the customer master and make its claims
  -- -------------------------------------------------------------------------
  -- The highest-trust source, and it is authoritative for exactly one thing
  -- in this dictionary: who pays the freight, because the ERP knows whether
  -- an account ships on its own carrier account. Registering it makes the
  -- "a low-trust source loses to a high-trust one even when newer" case real
  -- rather than a test fixture.
  for v_cust in select * from ctx_account where ships_own_carrier order by pick limit 6 loop
    v_doc := nl_seed.ctx_document('erp_customer_master',
      'customer-' || v_cust.customer_no,
      format('Customer master row for %s', v_cust.name),
      v_today::timestamptz, 'text/csv', 'customers', v_cust.customer_no);
    -- No snippet check applies here: nl.source_document_text has no branch
    -- for the customer master, because a CSV column is not prose. The
    -- locator is the column name, which is the honest citation for a row.
    perform nl_seed.ctx_claim('customer', v_cust.customer_no, v_cust.name, 'freight_payer',
      'third_party', null, null, null, null, '', 'third party',
      null, null, null, null, null,
      v_today, v_today, null,
      v_doc, 'legacy_import', '1', 'column Ships Own Carrier',
      'Ships Own Carrier = Yes',
      1.0, 1.0, 1.0);
  end loop;

  -- -------------------------------------------------------------------------
  -- 11. Playbooks: the durable half of context
  -- -------------------------------------------------------------------------
  -- Authored, reviewed, versioned, and not extracted from anything. An agent
  -- needs this as much as it needs a customer's freight terms, and it does
  -- not decay the way a fact does.
  insert into nl.playbooks (key, title, body, subject_kind, surfaces, disclosure, version,
                            author_id, reviewed_at)
  values
    ('how_we_quote', 'How we quote',
E'A quote holds for 30 days from the day it is written, and it says so on its face.\n\nPrices come from `nl.price_for`, in this order: an agreement in force, then the last price the account actually paid inside a year, then their price group discount off list, then list. A quantity break stacks on the group discount and never cuts under an agreed price.\n\nA price under the margin floor is flagged and still quotable. The floor is a warning to a person, not a veto by a machine.\n\nFreight is quoted at the published tariff unless the account has its own carrier account, in which case the quote says freight collect and carries no freight line.',
     null, '{quoting,replying_external,internal_review}', 'customer', 2, 1, v_today - 120),
    ('certificates_explained', 'Certificates, and what each one means',
E'A **certificate of conformance** is our own statement that what we shipped matches what was ordered. We can produce one for any shipment on request, same day.\n\nA **mill test report** is the steel mill''s chemistry and mechanical results for the heat the material came from. We can only supply one where we still hold the mill paperwork for that heat, which in practice means purchased tube and not fabricated assemblies.\n\nIf an account asks for a mill test report on a fabricated part, say what we can supply rather than promising the paperwork and finding out later.',
     null, '{quoting,replying_external,shipping_paperwork,internal_review}', 'customer', 1, 1,
     v_today - 210),
    ('freight_words', 'What the freight words mean on our paperwork',
E'**Prepaid**: we pay the carrier and absorb it.\n\n**Prepaid and add**: we pay the carrier and the amount appears as a line on the invoice.\n\n**Collect**: the carrier bills the customer. Nothing appears on our invoice.\n\n**Third party**: the customer''s own carrier account is billed directly, usually because they have a rate we cannot match. Nothing appears on our invoice and we do not choose the carrier.\n\nAn account flagged as shipping on its own carrier account in the ERP is third party, whatever anybody has written down since.',
     'customer', '{quoting,replying_external,shipping_paperwork,internal_review}', 'customer', 3,
     6, v_today - 45),
    ('allocation_house_rules', 'How we allocate short stock',
E'When stock does not cover the open lines for a part, it goes out in ship-date order, earliest first. A line that is already late does not jump the queue: it is already in front.\n\nA partial shipment is offered rather than assumed. Telling somebody that eight of twelve can go now beats sending eight and letting them find out.\n\nNothing is promised past the date the supply forecast projects. If the forecast has no date, the lead time is the date, and the reply says which it is.',
     null, '{promising_date,buying,internal_review}', 'internal', 1, 5, v_today - 75),
    ('buying_from_suppliers', 'Buying: what we hold to',
E'A purchase order is raised against a demand we can name: an open sales line, a commitment inside its window, or a reorder point that the coverage view says is breached.\n\nA supplier''s stated lead time is what we plan to, not what we promise to. A promise to a customer takes the projected date, which carries the forecast''s own slip.\n\nWhere a supplier has a minimum order, we consolidate rather than pay to break it, unless a customer line is already late.',
     'vendor', '{buying,internal_review}', 'internal', 1, 5, v_today - 60)
  on conflict (key) do nothing;

  -- -------------------------------------------------------------------------
  -- 12. Run the rules, then compile
  -- -------------------------------------------------------------------------
  -- Promotion first, so the facts exist; then the bundles, so the read path
  -- has something to serve. A fresh world therefore has facts, conflicts,
  -- stale facts and gaps in it before anybody presses anything.
  --
  -- nl.promote_claims and nl.compile_context_bundles both require an active
  -- user, so the seed runs them as the first administrator.
  perform nl_seed.ctx_promote_and_compile();
end $$;

-- ---------------------------------------------------------------------------
-- The small helpers the builder above uses
-- ---------------------------------------------------------------------------

-- Register one source document. Returns its id.
create or replace function nl_seed.ctx_document(
  p_source_key   text,
  p_external_ref text,
  p_title        text,
  p_received_at  timestamptz,
  p_media_type   text,
  p_ref_table    text,
  p_ref_id       text
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  insert into nl.source_documents
    (source_key, external_ref, title, received_at, media_type, sha256, ref_table, ref_id)
  values (p_source_key, left(p_external_ref, 200), left(coalesce(p_title, ''), 300), p_received_at,
          p_media_type,
          pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            p_source_key || '|' || p_external_ref, 'UTF8')), 'hex'),
          coalesce(p_ref_table, ''), coalesce(p_ref_id, ''))
  on conflict (source_key, external_ref) do update set title = excluded.title
  returning id into v_id;
  return v_id;
end $$;

-- Store one archived mail and register it as a source document in one step,
-- because the two always happen together.
create or replace function nl_seed.ctx_mail(
  p_from       text,
  p_from_name  text,
  p_subject    text,
  p_body       text,
  p_at         timestamptz,
  p_customer   text,
  p_vendor     text,
  p_mailbox    text
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_mail bigint;
  v_hash text;
begin
  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    coalesce(p_from, '') || '|' || coalesce(p_subject, '') || '|' ||
    pg_catalog.regexp_replace(coalesce(p_body, ''), '\s+', ' ', 'g') || '|' ||
    pg_catalog.to_char(p_at, 'YYYY-MM-DD HH24:MI'), 'UTF8')), 'hex');

  insert into nl.mail_archive
    (mailbox_key, direction, from_address, from_name, to_address, subject, body_text,
     received_at, customer_no, vendor_no, sha256)
  values (p_mailbox, 'in', p_from, coalesce(p_from_name, ''),
          case p_mailbox when 'orders' then 'order-desk@agentmail.to'
                         else 'procurement-desk@agentmail.to' end,
          p_subject, p_body, p_at, p_customer, p_vendor, v_hash)
  returning id into v_mail;

  return nl_seed.ctx_document(
    'mail_archive',
    'archive-' || v_mail::text,
    left(p_subject, 300), p_at, 'text/plain', 'mail_archive', v_mail::text);
end $$;

-- One claim, written straight in. The seed runs as the schema's owner, so it
-- does not go through nl.record_claim; every snippet it passes is still a
-- literal substring of the document it names, which is the same rule.
create or replace function nl_seed.ctx_claim(
  p_subject_kind text,
  p_subject_id   text,
  p_subject_raw  text,
  p_attribute    text,
  p_value_text   text,
  p_value_number numeric,
  p_value_date   date,
  p_value_bool   boolean,
  p_value_json   jsonb,
  p_unit         text,
  p_display      text,
  p_scope_customer text,
  p_scope_ship_to  text,
  p_scope_item     text,
  p_scope_family   text,
  p_scope_vendor   text,
  p_asserted_at  date,
  p_valid_from   date,
  p_valid_to     date,
  p_document_id  bigint,
  p_extractor    text,
  p_version      text,
  p_locator      text,
  p_snippet      text,
  p_subject_conf numeric,
  p_attr_conf    numeric,
  p_value_conf   numeric
) returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_id bigint;
begin
  if p_document_id is null then
    return null;
  end if;
  insert into nl.claims
    (subject_kind, subject_id, subject_raw, attribute,
     value_text, value_number, value_date, value_bool, value_json, unit, value_display,
     scope_customer_no, scope_ship_to_no, scope_item_no, scope_item_family, scope_vendor_no,
     asserted_at, valid_from, valid_to,
     source_document_id, extractor, extractor_version, locator, snippet,
     subject_confidence, attribute_confidence, value_confidence, status)
  values
    (p_subject_kind, p_subject_id, left(coalesce(p_subject_raw, ''), 200), p_attribute,
     p_value_text, p_value_number, p_value_date, p_value_bool, p_value_json,
     coalesce(p_unit, ''), left(p_display, 200),
     p_scope_customer, p_scope_ship_to, p_scope_item, p_scope_family, p_scope_vendor,
     p_asserted_at, p_valid_from, p_valid_to,
     p_document_id, p_extractor, p_version, left(p_locator, 200), left(p_snippet, 1000),
     p_subject_conf, p_attr_conf, p_value_conf,
     case when p_subject_id is null then 'unresolved' else 'valid' end)
  on conflict (source_document_id, attribute, locator, scope_key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Promote everything promotable and compile every bundle, as the first
-- administrator, because both functions require an active user.
create or replace function nl_seed.ctx_promote_and_compile() returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_admin   int;
  v_subject record;
  v_result  jsonb;
begin
  select id into v_admin from nl.users where role = 'admin' and active order by id limit 1;
  if v_admin is null then
    select id into v_admin from nl.users where active order by id limit 1;
  end if;
  perform pg_catalog.set_config('nl.user_id', v_admin::text, true);

  v_result := nl.promote_claims(null, null, null, 'seed-context-promote-' || nl.today()::text);

  -- Compile every subject that has a fact or a claim about it. Compiling the
  -- whole book would be minutes of work for bundles nobody will read.
  for v_subject in
    select distinct subject_kind, subject_id from nl.facts where status = 'current'
    union
    select distinct subject_kind, subject_id from nl.claims where subject_id is not null
  loop
    perform nl.compile_context_bundles(v_subject.subject_kind, v_subject.subject_id);
  end loop;

  return v_result;
end $$;
