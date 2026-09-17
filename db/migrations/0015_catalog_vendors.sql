-- 0015 Parts, vendors and search: every part number and vendor becomes a
-- page worth opening.
--
--   * Vendors get the fields a purchasing screen shows (payment terms,
--     freight terms, minimum order, where they ship from) and a row version.
--   * Items get a reorder point and safety stock, so a part page can say
--     "below reorder point".
--   * nl.vendor_contacts: the people at each vendor. Contacts are people, so
--     the read-only role gets nothing on them.
--   * Three views, all derived on read:
--       nl.part_position   stock against open orders, per part
--       nl.part_summary    one row per part: catalog, stock, sales, margin, demand
--       nl.vendor_summary  one row per vendor: what it supplies and how it sells
--   * Indexes for the part page and for global search (plain btree, no
--     extension, so PGlite runs the same file).

-- ---------------------------------------------------------------------------
-- Vendor and item fields
-- ---------------------------------------------------------------------------

alter table nl.vendors
  add column terms         text not null default '',   -- payment terms, as the vendor card prints them: Net 30
  add column freight_terms text not null default '',   -- Prepaid, Prepaid and add, FOB origin
  add column min_order     numeric(12, 2),             -- smallest purchase order they accept, when they have one
  add column ships_from    text not null default '',   -- 'Toledo, OH'
  add column updated_at    timestamptz not null default nl.now_ms();

create trigger vendors_touch before update on nl.vendors
  for each row execute function nl.touch_updated_at();

-- Planning parameters from the item card. Null means the part is not
-- stocked to a reorder point (made to order, custom, or it barely sells).
alter table nl.items
  add column reorder_point int check (reorder_point >= 0),
  add column safety_stock  int check (safety_stock >= 0);

-- ---------------------------------------------------------------------------
-- Vendor contacts
-- ---------------------------------------------------------------------------

create table nl.vendor_contacts (
  id          bigint generated always as identity primary key,
  vendor_no   text not null references nl.vendors (vendor_no) on delete cascade,
  full_name   text not null check (length(full_name) between 2 and 80),
  title       text not null check (title in
                ('Inside Sales', 'Account Manager', 'Customer Service', 'Quality', 'Accounts Receivable')),
  email       text check (length(email) <= 120),
  phone       text check (length(phone) <= 30),
  is_primary  boolean not null default false,
  active      boolean not null default true,
  created_by  int references nl.users (id),        -- null when the seed or an import added it
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default nl.now_ms()
);

create index vendor_contacts_vendor_idx on nl.vendor_contacts (vendor_no);
create index vendor_contacts_created_by_idx on nl.vendor_contacts (created_by);
-- One primary contact per vendor among the active ones.
create unique index vendor_contacts_one_primary_idx on nl.vendor_contacts (vendor_no) where is_primary and active;

create trigger vendor_contacts_touch before update on nl.vendor_contacts
  for each row execute function nl.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- A part's sales: its lines by date, carrying what the part page and the
-- summaries add up, so they are read from the index alone (an index-only
-- scan) for one part, or for one vendor's parts. The existing
-- invoice_lines_item_idx (item_no) is a prefix of this one; it is kept
-- because 0002 created it, and could be dropped to save space.
create index invoice_lines_item_posted_idx
  on nl.invoice_lines (item_no, posted_on)
  include (customer_no, quantity, unit_price, amount, unit_cost);

-- Global search (app/src/lib/server/catalog/search.ts) matches a typed word
-- as a prefix of a number or a name: lower(column) like 'abc%'. A btree
-- with text_pattern_ops answers that prefix as a range scan whatever the
-- database collation is. Matches in the middle of a name ('%abc%') cannot
-- use a btree; at this size (about 4,500 customers, 11,400 parts, 1,300
-- vendors) that is a short sequential scan, and needs no pg_trgm extension.
create index search_customers_name_idx on nl.customers (lower(name) text_pattern_ops);
create index search_customers_no_idx on nl.customers (lower(customer_no) text_pattern_ops);
create index search_customers_city_idx on nl.customers (lower(city) text_pattern_ops);
create index search_items_no_idx on nl.items (lower(item_no) text_pattern_ops);
create index search_vendors_name_idx on nl.vendors (lower(name) text_pattern_ops);
create index search_vendors_no_idx on nl.vendors (lower(vendor_no) text_pattern_ops);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------

-- Stock against open orders, per part.
--   incoming             = on production order + on purchase order
--   projected_available  = on hand + incoming - open order quantity
--   below_reorder_point  = projected available under the reorder point,
--                          which is how an ERP's reorder policy reads it
-- open_qty and short_qty come from nl.open_line_allocation (0010), which
-- hands on-hand stock to the oldest ship dates first.
create view nl.part_position with (security_invoker = true) as
select
  i.item_no,
  i.vendor_no,
  i.blocked,
  i.reorder_point,
  i.safety_stock,
  coalesce(s.on_hand, 0)             as on_hand,
  coalesce(s.on_production_order, 0) as on_production_order,
  coalesce(s.on_purchase_order, 0)   as on_purchase_order,
  coalesce(od.open_lines, 0)         as open_lines,
  coalesce(od.open_qty, 0)           as open_qty,
  coalesce(od.open_value, 0)         as open_value,
  coalesce(od.short_lines, 0)        as short_lines,
  coalesce(od.short_qty, 0)          as short_qty,
  od.next_ship_date,
  coalesce(s.on_hand, 0) + coalesce(s.on_production_order, 0) + coalesce(s.on_purchase_order, 0)
    - coalesce(od.open_qty, 0) as projected_available,
  (i.reorder_point is not null
   and coalesce(s.on_hand, 0) + coalesce(s.on_production_order, 0) + coalesce(s.on_purchase_order, 0)
       - coalesce(od.open_qty, 0) < i.reorder_point) as below_reorder_point
from nl.items i
left join nl.stock s on s.item_no = i.item_no
left join (
  select
    a.item_no,
    count(*)                           as open_lines,
    sum(a.quantity)                    as open_qty,
    sum(a.open_value)                  as open_value,
    count(*) filter (where a.short > 0) as short_lines,
    sum(a.short)                       as short_qty,
    min(a.ship_date)                   as next_ship_date
  from nl.open_line_allocation a
  group by a.item_no
) od on od.item_no = i.item_no;

-- One row per part with everything the parts list and a part page's header
-- show.
--
-- Sales windows end today: "12 months" is the year up to today, "prior 12"
-- the year before that. Gross margin is from the invoice lines themselves
-- (price paid against the cost recorded on each line), net of credit memos.
--
-- Plan shape:
--   * Dates are scalar subqueries, so nl.today() runs once per query (an
--     InitPlan), not once per line (see 0009).
--   * Sales are one lateral subquery: for each part the view returns, it
--     reads that part's lines as a range of invoice_lines_item_posted_idx,
--     from the index alone (no table access), and adds up both windows and
--     the last sale in the one pass. So the cost follows the rows asked for:
--     one part, one vendor's parts, one family, or the whole list.
create view nl.part_summary with (security_invoker = true) as
select
  i.item_no,
  i.description,
  i.category,
  i.family,
  i.product_group,
  i.unit_cost,
  i.list_price,
  case when i.list_price > 0 then round((i.list_price - i.unit_cost) / i.list_price, 4) end as list_margin,
  i.replenishment,
  i.work_center,
  i.vendor_no,
  i.lead_time,
  i.made_to_order,
  i.proprietary,
  i.blocked,
  i.reorder_point,
  i.safety_stock,
  s.shelf,
  s.bin,
  s.as_of as stock_as_of,
  pp.on_hand,
  pp.on_production_order,
  pp.on_purchase_order,
  pp.open_lines,
  pp.open_qty,
  pp.open_value,
  pp.short_lines,
  pp.short_qty,
  pp.next_ship_date,
  pp.projected_available,
  pp.below_reorder_point,
  coalesce(sold.units_12m, 0)         as units_12m,
  coalesce(sold.revenue_12m, 0)       as revenue_12m,
  coalesce(sold.cost_12m, 0)          as cost_12m,
  case when sold.revenue_12m > 0
       then round((sold.revenue_12m - sold.cost_12m) / sold.revenue_12m, 4) end as margin_12m,
  coalesce(sold.buyers_12m, 0)        as buyers_12m,
  coalesce(sold.units_prior_12m, 0)   as units_prior_12m,
  coalesce(sold.revenue_prior_12m, 0) as revenue_prior_12m,
  sold.last_sold_on
from nl.items i
left join nl.stock s on s.item_no = i.item_no
join nl.part_position pp on pp.item_no = i.item_no
left join lateral (
  select
    sum(il.quantity) filter (where il.posted_on > w.year_ago and il.posted_on <= w.today)     as units_12m,
    sum(il.amount) filter (where il.posted_on > w.year_ago and il.posted_on <= w.today)       as revenue_12m,
    sum(il.quantity * il.unit_cost)
      filter (where il.posted_on > w.year_ago and il.posted_on <= w.today)                    as cost_12m,
    count(distinct il.customer_no)
      filter (where il.posted_on > w.year_ago and il.posted_on <= w.today and il.quantity > 0) as buyers_12m,
    sum(il.quantity) filter (where il.posted_on > w.two_years_ago and il.posted_on <= w.year_ago) as units_prior_12m,
    sum(il.amount) filter (where il.posted_on > w.two_years_ago and il.posted_on <= w.year_ago)   as revenue_prior_12m,
    max(il.posted_on) filter (where il.quantity > 0)                                          as last_sold_on
  from nl.invoice_lines il
  cross join (
    select (select nl.today()) as today,
           (select (nl.today() - interval '1 year')::date) as year_ago,
           (select (nl.today() - interval '2 years')::date) as two_years_ago
  ) w
  where il.item_no = i.item_no
) sold on true;

-- One row per vendor: its card, what it supplies and how that sells.
-- Both subqueries are grouped by vendor_no, so a query for one vendor has
-- the condition pushed into them: that vendor's items by items_vendor_idx,
-- then their lines from invoice_lines_item_posted_idx.
create view nl.vendor_summary with (security_invoker = true) as
select
  v.vendor_no,
  v.name,
  v.city,
  v.state,
  v.lead_time,
  v.terms,
  v.freight_terms,
  v.min_order,
  v.ships_from,
  v.updated_at,
  coalesce(p.items, 0)               as items,
  coalesce(p.active_items, 0)        as active_items,
  coalesce(p.items_short, 0)         as items_short,
  coalesce(p.short_qty, 0)           as short_qty,
  coalesce(p.items_below_reorder, 0) as items_below_reorder,
  coalesce(r.units_12m, 0)           as units_12m,
  coalesce(r.revenue_12m, 0)         as revenue_12m
from nl.vendors v
left join (
  select
    pp.vendor_no,
    count(*)                                     as items,
    count(*) filter (where not pp.blocked)       as active_items,
    count(*) filter (where pp.short_qty > 0)     as items_short,
    sum(pp.short_qty)                            as short_qty,
    count(*) filter (where pp.below_reorder_point) as items_below_reorder
  from nl.part_position pp
  where pp.vendor_no is not null
  group by pp.vendor_no
) p on p.vendor_no = v.vendor_no
left join (
  select
    i.vendor_no,
    sum(il.quantity) as units_12m,
    sum(il.amount)   as revenue_12m
  from nl.items i
  join nl.invoice_lines il on il.item_no = i.item_no
  where i.vendor_no is not null
    and il.posted_on > (select (nl.today() - interval '1 year')::date)
    and il.posted_on <= (select nl.today())
  group by i.vendor_no
) r on r.vendor_no = v.vendor_no;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Add a person at a vendor. Operations and admins keep the vendor list, so
-- only they may. A new primary contact takes over from the old one.
--
-- The vendor's row version is the lock: the page sends the updated_at it
-- loaded, and adding a contact moves it. Two people adding a primary
-- contact from stale pages cannot both win.
create function nl.add_vendor_contact(
  p_vendor_no           text,
  p_full_name           text,
  p_title               text,
  p_email               text,
  p_phone               text,
  p_is_primary          boolean,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay     jsonb;
  v_actor      nl.users;
  v_name       text := nullif(regexp_replace(trim(coalesce(p_full_name, '')), '\s+', ' ', 'g'), '');
  v_email      text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_phone      text := nullif(trim(coalesce(p_phone, '')), '');
  v_primary    boolean := coalesce(p_is_primary, false);
  v_vendor     nl.vendors;
  v_demoted    bigint;
  v_id         bigint;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'add_vendor_contact');
  if v_replay is not null then
    return v_replay;
  end if;

  v_actor := nl.require_active_user();

  -- Field rule: the vendor list belongs to operations.
  if v_actor.role not in ('operations', 'admin') then
    raise exception 'Only operations or an admin can add a vendor contact.' using errcode = 'NL403';
  end if;

  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;
  if v_name is null or length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'A contact needs a name of 2 to 80 characters.' using errcode = 'NL422';
  end if;
  if p_title is null or p_title not in
     ('Inside Sales', 'Account Manager', 'Customer Service', 'Quality', 'Accounts Receivable') then
    raise exception 'Pick a title from the list, not %.', coalesce(p_title, 'empty') using errcode = 'NL422';
  end if;
  if v_email is null and v_phone is null then
    raise exception 'Give an email address or a phone number, so someone can reach them.' using errcode = 'NL422';
  end if;
  if v_email is not null and (length(v_email) > 120 or v_email !~ '^[^@\s]+@[^@\s]+\.[a-z]{2,}$') then
    raise exception '% does not look like an email address.', v_email using errcode = 'NL422';
  end if;
  if v_phone is not null and (length(v_phone) > 30 or v_phone !~ '^[0-9()+. -]{7,30}$') then
    raise exception '% does not look like a phone number.', v_phone using errcode = 'NL422';
  end if;

  select * into v_vendor from nl.vendors where vendor_no = p_vendor_no;
  if not found then
    raise exception 'Vendor % does not exist.', coalesce(p_vendor_no, 'empty') using errcode = 'NL404';
  end if;

  if v_email is not null and exists (
    select 1 from nl.vendor_contacts
    where vendor_no = p_vendor_no and active and lower(email) = v_email) then
    raise exception '% is already a contact at %.', v_email, v_vendor.name using errcode = 'NL422';
  end if;

  -- Optimistic lock on the vendor: the page must have seen the current list.
  update nl.vendors
     set updated_at = updated_at
   where vendor_no = p_vendor_no
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'The contacts for % changed since the page was loaded. Reload and try again.', v_vendor.name
      using errcode = 'NL409';
  end if;

  if v_primary then
    update nl.vendor_contacts
       set is_primary = false
     where vendor_no = p_vendor_no and is_primary and active
    returning id into v_demoted;
  end if;

  insert into nl.vendor_contacts (vendor_no, full_name, title, email, phone, is_primary, created_by)
  values (p_vendor_no, v_name, p_title, v_email, v_phone, v_primary, v_actor.id)
  returning id into v_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'add_vendor_contact', 'vendor', p_vendor_no, p_request_id,
          jsonb_build_object(
            'contact_id', v_id,
            'full_name', v_name,
            'title', p_title,
            'is_primary', v_primary,
            'replaced_primary', v_demoted));

  v_result := jsonb_build_object(
    'contact_id', v_id,
    'vendor_no', p_vendor_no,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.vendor_contacts enable row level security;

create policy vendor_contacts_read on nl.vendor_contacts for select to nl_app using (true);
-- The write function checks the same rule first and says why; these are the backstop.
create policy vendor_contacts_insert on nl.vendor_contacts for insert to nl_app
  with check (created_by = (select nl.current_user_id()) and (select nl.can_run_imports()));
create policy vendor_contacts_update on nl.vendor_contacts for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));
create policy vendors_update on nl.vendors for update to nl_app
  using ((select nl.can_run_imports()))
  with check ((select nl.can_run_imports()));

grant select, insert on nl.vendor_contacts to nl_app;
grant update (is_primary, active, updated_at) on nl.vendor_contacts to nl_app;
grant update (updated_at) on nl.vendors to nl_app;
grant select on nl.part_position, nl.part_summary, nl.vendor_summary to nl_app;

-- The summaries hold no people, so the read-only role may read them too.
-- nl.vendor_contacts is people: no grant.
grant select on nl.part_position, nl.part_summary, nl.vendor_summary to nl_readonly;

grant execute on function
  nl.add_vendor_contact(text, text, text, text, text, boolean, timestamptz, text, text)
to nl_app;
