-- Catalog depth: the purchasing side of the vendor card, the people at each
-- vendor, and reorder points on the parts that are stocked.
--
-- Runs after the base world (nl_seed.finish_build() calls every
-- nl_seed.extra_NN_name() in name order). Every draw is keyed, like
-- db/seed.sql, so Supabase and PGlite build the same thing.
create or replace function nl_seed.extra_20_catalog_depth()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (select today from nl_seed.settings);
begin
  -- -------------------------------------------------------------------------
  -- Vendor cards: payment terms, freight terms, minimum order, ship-from.
  -- Most vendors ship from their own town; some from a warehouse elsewhere.
  -- -------------------------------------------------------------------------
  update nl.vendors v
     set terms = nl_seed.pick(array['Net 30', 'Net 30', 'Net 30', 'Net 30', 'Net 45', 'Net 60',
                                    '2% 10 Net 30', '2% 10 Net 30', '1% 15 Net 45', 'Net 15'],
                              'vendor.terms|' || v.vendor_no),
         freight_terms = nl_seed.pick(array['Prepaid', 'Prepaid', 'Prepaid and add', 'Prepaid and add',
                                            'FOB origin', 'Prepaid over $1,500'],
                                      'vendor.freight|' || v.vendor_no),
         min_order = (array[null, null, 100, 250, 250, 500, 500, 1000, 1500, 2500]::numeric[])
                       [nl_seed.ri(1, 10, 'vendor.min|' || v.vendor_no)],
         ships_from = case
           when nl_seed.chance(0.75, 'vendor.ships|' || v.vendor_no) or v.city = '' then
             concat_ws(', ', nullif(v.city, ''), nullif(v.state, ''))
           else nl_seed.pick(array['Toledo, OH', 'Fort Wayne, IN', 'Joliet, IL', 'Columbus, OH', 'Memphis, TN',
                                   'Dallas, TX', 'Kansas City, MO', 'Harrisburg, PA', 'Reno, NV'],
                             'vendor.ships.where|' || v.vendor_no)
         end;

  -- -------------------------------------------------------------------------
  -- Vendor contacts: one to three people at each vendor that supplies at
  -- least one active part. The first is the primary, and is the person a
  -- buyer calls about orders. Now and then a third contact has left the
  -- vendor and is kept on file as inactive.
  -- -------------------------------------------------------------------------
  insert into nl.vendor_contacts (vendor_no, full_name, title, email, phone, is_primary, active, created_at, updated_at)
  select
    x.vendor_no,
    x.full_name,
    x.title,
    lower(split_part(x.full_name, ' ', 1)) || '.' || lower(split_part(x.full_name, ' ', 2))
      || '@' || x.domain,
    '(' || nl_seed.ri(201, 989, 'vcontact.area|' || x.vendor_no) || ') 555-01'
      || lpad(nl_seed.ri(0, 99, 'vcontact.line|' || x.vendor_no || '|' || x.n)::text, 2, '0')
      || case when x.n > 1 and nl_seed.chance(0.5, 'vcontact.ext|' || x.vendor_no || '|' || x.n)
              then ' ext ' || nl_seed.ri(201, 249, 'vcontact.ext.n|' || x.vendor_no || '|' || x.n) else '' end,
    x.n = 1,
    not (x.n = 3 and nl_seed.chance(0.3, 'vcontact.gone|' || x.vendor_no)),
    x.at,
    date_trunc('milliseconds', x.at)
  from (
    select
      v.vendor_no,
      g.n,
      -- The name is drawn with the contact's position, so two people at one
      -- vendor rarely share a name; a clash picks the next draw.
      case when g.n > 1
                and nl_seed.person('vcontact|' || v.vendor_no || '|' || g.n)
                    = nl_seed.person('vcontact|' || v.vendor_no || '|1')
           then nl_seed.person('vcontact|' || v.vendor_no || '|' || g.n || '|again')
           else nl_seed.person('vcontact|' || v.vendor_no || '|' || g.n)
      end as full_name,
      case g.n
        when 1 then nl_seed.pick(array['Inside Sales', 'Inside Sales', 'Account Manager'], 'vcontact.title|' || v.vendor_no)
        when 2 then nl_seed.pick(array['Customer Service', 'Account Manager', 'Quality'], 'vcontact.title2|' || v.vendor_no)
        else nl_seed.pick(array['Accounts Receivable', 'Quality', 'Customer Service'], 'vcontact.title3|' || v.vendor_no)
      end as title,
      -- The vendor's name without its suffix, as a web domain: harborplating.example
      nl_seed.slug(regexp_replace(v.name, ' (Co\.|Inc\.|Supply|Products|Industries|Mfg|Works|Corp\.)$', ''))
        || '.example' as domain,
      ((v_today - nl_seed.ri(30, 2000, 'vcontact.since|' || v.vendor_no || '|' || g.n)) + time '09:00')
        at time zone 'America/Chicago' as at
    from nl.vendors v
    cross join lateral generate_series(1, nl_seed.ri(1, 3, 'vcontacts|' || v.vendor_no)) as g(n)
    where exists (select 1 from nl.items i where i.vendor_no = v.vendor_no and not i.blocked)
  ) x
  -- Ids in a fixed order: the primary contact of each vendor comes first.
  order by x.vendor_no, x.n;

  -- Two people with the same name at one vendor would share an email
  -- address; keep the first and drop the other (rare, after the redraw above).
  delete from nl.vendor_contacts c
  using nl.vendor_contacts d
  where d.vendor_no = c.vendor_no
    and d.email = c.email
    and d.id < c.id;

  -- -------------------------------------------------------------------------
  -- Reorder points for stocked parts, sized from how fast each one sells.
  --   weekly rate    = units sold in the last 12 months / 52
  --   lead weeks     = the part's lead time, else its vendor's, else 2 weeks
  --   safety stock   = two weeks of sales
  --   reorder point  = sales during the lead time + safety stock
  -- Made-to-order, custom, proprietary and blocked parts are not stocked to
  -- a reorder point, and neither is a part that sells fewer than 12 a year.
  -- -------------------------------------------------------------------------
  update nl.items i
     set safety_stock = r.safety,
         reorder_point = r.safety + ceil(r.weekly * r.lead_weeks)::int
    from (
      select
        it.item_no,
        s.units / 52.0 as weekly,
        ceil(s.units / 52.0 * 2)::int as safety,
        -- An ERP lead-time formula in weeks: '3W' -> 3, '10D' -> 2 (working
        -- days). The part's own formula first, then its vendor's.
        coalesce(
          case when it.lead_time ~ '^\d+W$' then left(it.lead_time, -1)::numeric
               when it.lead_time ~ '^\d+D$' then left(it.lead_time, -1)::numeric / 5 end,
          case when v.lead_time ~ '^\d+W$' then left(v.lead_time, -1)::numeric
               when v.lead_time ~ '^\d+D$' then left(v.lead_time, -1)::numeric / 5 end,
          2) as lead_weeks
      from nl.items it
      left join nl.vendors v on v.vendor_no = it.vendor_no
      join (
        select il.item_no, sum(il.quantity) as units
        from nl.invoice_lines il
        where il.posted_on > v_today - 365 and il.posted_on <= v_today
        group by il.item_no
      ) s on s.item_no = it.item_no
      where not it.made_to_order
        and not it.proprietary
        and not it.blocked
        and it.family <> 'custom'
        and s.units >= 12
    ) r
   where i.item_no = r.item_no;
end $$;

revoke execute on function nl_seed.extra_20_catalog_depth() from public;
