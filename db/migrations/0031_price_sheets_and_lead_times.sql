-- 0031 Published price sheets, published ladders, what a customer is used to
-- paying, and the exceptions that explain a number.
--
-- Migration 0018 gave the business one pricing rule with four sources, and
-- 0021 added quantity breaks per part. Both are true as far as they go, and
-- neither is the thing a buyer is holding. A buyer holds a price sheet: a
-- document with a name, a date on it, a tier and a price per part. They
-- remember what they paid last time. When a number moves they want to know
-- which letter said so, from when, and who signed it.
--
-- So this migration adds the paperwork behind the price:
--
--   nl.price_sheets         a published sheet: name, window, tier
--   nl.price_sheet_lines    the page price per part on that sheet
--   nl.price_sheet_sends    which sheet each account was last sent
--   nl.account_price_sheet  the sheet an account is holding, and how old it is
--   nl.price_breaks         a published volume ladder, owned by a sheet or a tier
--   nl.customer_item_prices what an account has paid for a part: last, average,
--                           high, low, how often
--   nl.customer_item_price_context the same, next to today's sheet and tier
--                           price, with the "this looks like a jump" flag
--   nl.trade_exceptions     price increases, surcharges, customer exceptions,
--                           lead time slips, allocation, discontinuations and
--                           order minimums, each with a reason, a date and an
--                           owner
--   nl.trade_exception_status / nl.trade_exceptions_live
--   nl.exceptions_for()     the exceptions that reach one account and part
--   nl.lead_time_for()      the lead time for a part today, and why if it slipped
--   nl.price_quote_for()    the quote level rule: sheets and ladders on top of 0018
--   nl.explain_price()      the price AND the reasoning, as one JSON answer
--   nl.customer_parts()     everything under one account's roof, with its state
--   nl.answer_for()         price, history, exceptions, lead time and
--                           availability in one call, for an agent's reply
--
-- and, because a promise is worth no more than the lead time behind it, the
-- vendor and part relationship that a lead time actually lives in:
--
--   nl.vendor_items         vendor and part: primary or alternate, the quoted
--                           lead time with its provenance, minimum order,
--                           order multiple, allocation and discontinuation
--   nl.vendor_item_breaks   what the vendor charges at each quantity
--   nl.purchase_receipts    ordered, promised and received, per purchase line
--   nl.vendor_item_lead_times  observed: count, median, ninetieth, worst, late
--   nl.vendor_item_commitments what they promised on each open line, against
--                           what they quoted
--   nl.promise_lead_days()  the lead time to promise with, and why
--   nl.vendor_part_lead_times  quoted against observed, worst tail first
--   nl.item_lead_days()     replaced, so 0016 and 0022 read the new source
--                           without changing
--
-- Three decisions shaped it.
--
-- 1. The current sheet cannot disagree with nl.price_for(). A sheet line for
--    the generation in force is seeded as exactly
--    round(list_price * (1 - tier discount), 2), which is what 0018 calls the
--    group discount. The sheet therefore changes the wording of an answer, not
--    the number: "the March 2026 Dealer sheet" instead of "list less 45%". A
--    test holds them to the same figure for every part on every current sheet.
--
-- 2. nl.price_for() is left exactly as it was. The quote level rule is a new
--    function, nl.price_quote_for(), because a quote knows two things a part
--    does not: a quantity, and which sheet the buyer is holding. Screens and
--    agents move over to it; nothing that reads the old one changes its mind.
--
-- 3. A surcharge and an announced increase do not move today's price. They are
--    reported next to it with the dollars they would add and the day they
--    start, because that is how they arrive in a real business: a separate
--    line on the invoice, or a letter about next quarter. A customer specific
--    exception that pins an older sheet does move the price, because that is
--    what it was written to do, and it is the one exception kind that sits in
--    the precedence order.
--
-- Nothing here is written by the app. The seed and the imports fill these
-- tables; everyone else reads them.

-- ---------------------------------------------------------------------------
-- Constants
-- ---------------------------------------------------------------------------

-- How far above what an account last paid a quote may go before the app says
-- so out loud. Seven percent is roughly two years of list price movement in
-- this business, so anything past it is a number the buyer will query, and a
-- person would rather hear about it from us first.
create function nl.price_jump_pct() returns numeric
language sql immutable
set search_path = ''
as $$ select 0.07::numeric $$;

-- How long a price sheet in a buyer's hand is treated as current enough to
-- quote from without mentioning it. Past this, a reply says which sheet they
-- hold and what has changed since.
create function nl.price_sheet_stale_days() returns int
language sql immutable
set search_path = ''
as $$ select 210 $$;

-- ---------------------------------------------------------------------------
-- Published price sheets
-- ---------------------------------------------------------------------------

-- One published sheet: a document a customer has in their hand. A sheet
-- belongs to exactly one tier, runs from a date to a date, and carries a page
-- price for each part it covers. effective_to null means this is the
-- generation in force.
create table nl.price_sheets (
  id             bigint generated always as identity primary key,
  code           text not null unique,        -- PS-DEALER-2026-03
  name           text not null,               -- Dealer net prices, March 2026
  price_group    text not null references nl.price_groups (code),
  effective_from date not null,
  effective_to   date,                        -- null while this is the current sheet
  published_on   date not null,               -- the day it went out
  note           text not null default '',
  created_at     timestamptz not null default now(),
  constraint price_sheets_window check (effective_to is null or effective_to >= effective_from),
  constraint price_sheets_published check (published_on <= effective_from)
);

comment on table nl.price_sheets is
  'Published price sheets, one generation per row. The sheet with effective_to null is the one in force for that tier.';

-- One current sheet per tier: "the sheet" cannot have two answers, for the
-- same reason an open price agreement cannot.
create unique index price_sheets_one_current_idx
  on nl.price_sheets (price_group) where effective_to is null;

-- The lookup nl.price_quote_for() makes: this tier, the sheet whose window
-- covers a date.
create index price_sheets_group_window_idx
  on nl.price_sheets (price_group, effective_from desc);

-- The page price for one part on one sheet. list_at_publication is the list
-- price the sheet was worked out from, kept so an old sheet still explains
-- itself after list has moved.
create table nl.price_sheet_lines (
  sheet_id            bigint not null references nl.price_sheets (id) on delete cascade,
  item_no             text not null references nl.items (item_no) on delete cascade,
  sheet_price         numeric(12, 2) not null check (sheet_price > 0),
  list_at_publication numeric(12, 2) not null check (list_at_publication > 0),
  note                text not null default '',
  primary key (sheet_id, item_no)
);

comment on table nl.price_sheet_lines is
  'The page price per part on a published sheet. The current generation agrees with nl.price_for() group discount to the cent.';

-- "What does this part cost on every sheet it has ever been on", for a part
-- page and for the sheet a customer is holding.
create index price_sheet_lines_item_idx
  on nl.price_sheet_lines (item_no) include (sheet_price, list_at_publication);

-- Which sheet went to which account, and when. A log rather than one column,
-- because "they are still working off the November sheet" is a fact about a
-- day, and an account that has been on the book for years has a trail.
create table nl.price_sheet_sends (
  customer_no text not null references nl.customers (customer_no) on delete cascade,
  sheet_id    bigint not null references nl.price_sheets (id) on delete cascade,
  sent_on     date not null,
  sent_how    text not null check (sent_how in ('email', 'mail', 'rep visit', 'portal')),
  note        text not null default '',
  primary key (customer_no, sheet_id)
);

create index price_sheet_sends_sheet_idx on nl.price_sheet_sends (sheet_id);

-- "Which sheet is this account holding": the newest send for one customer.
-- The primary key is (customer_no, sheet_id) and cannot answer that without
-- sorting, so this one carries the date. On the small world the planner scans
-- the table instead and is right to; it is here for the full world, where the
-- send log holds a row per account per generation.
create index price_sheet_sends_holding_idx
  on nl.price_sheet_sends (customer_no, sent_on desc, sheet_id desc);

-- The sheet an account is actually holding: the newest one they were sent.
-- days_old is how long ago that was, and stale says it is old enough that a
-- reply should mention it.
create view nl.account_price_sheet with (security_invoker = true) as
select
  s.customer_no,
  s.sheet_id,
  ps.code                       as sheet_code,
  ps.name                       as sheet_name,
  ps.price_group,
  ps.effective_from,
  ps.effective_to,
  ps.effective_to is null       as is_current,
  s.sent_on,
  s.sent_how,
  (nl.today() - s.sent_on)::int as days_old,
  (nl.today() - s.sent_on)::int > nl.price_sheet_stale_days() as stale,
  -- How many generations behind the current sheet they are.
  (select count(*)::int
   from nl.price_sheets newer
   where newer.price_group = ps.price_group
     and newer.effective_from > ps.effective_from
     and newer.effective_from <= nl.today()) as generations_behind
from (
  select distinct on (customer_no) customer_no, sheet_id, sent_on, sent_how
  from nl.price_sheet_sends
  order by customer_no, sent_on desc, sheet_id desc
) s
join nl.price_sheets ps on ps.id = s.sheet_id;

-- ---------------------------------------------------------------------------
-- Published volume ladders
-- ---------------------------------------------------------------------------

-- A published ladder rung: this many or more of this part costs this each.
-- A rung belongs either to a sheet (it is printed on that document) or to a
-- tier (a standing ladder that outlives one sheet generation), never to both
-- and never to neither.
--
-- The shape is a price per rung, not a discount, because that is what the
-- sheet prints and what the buyer reads back to us. The first rung is the
-- quantity 1 price and equals the sheet price for the part, so a ladder is
-- self describing: every rung can be quoted without looking anywhere else.
create table nl.price_breaks (
  id             bigint generated always as identity primary key,
  sheet_id       bigint references nl.price_sheets (id) on delete cascade,
  price_group    text references nl.price_groups (code) on delete cascade,
  item_no        text not null references nl.items (item_no) on delete cascade,
  min_quantity   int not null check (min_quantity >= 1),
  break_price    numeric(12, 2) not null check (break_price > 0),
  note           text not null default '',
  constraint price_breaks_one_owner check (num_nonnulls(sheet_id, price_group) = 1)
);

comment on table nl.price_breaks is
  'Published volume ladders. A rung belongs to a sheet or to a tier. Rung one is the sheet price, so the ladder explains itself.';

-- One price per rung. nulls not distinct so the partial owner columns take
-- part in the key instead of letting a duplicate through.
create unique index price_breaks_rung_idx
  on nl.price_breaks (sheet_id, price_group, item_no, min_quantity) nulls not distinct;

-- The lookups: a sheet's ladder for one part, and a tier's.
create index price_breaks_sheet_item_idx
  on nl.price_breaks (sheet_id, item_no, min_quantity) include (break_price, note);
create index price_breaks_group_item_idx
  on nl.price_breaks (price_group, item_no, min_quantity) include (break_price, note);

-- What happens when an agreement and a ladder both reach a quantity. The
-- default is the better price for the customer, because a buyer who has both
-- documents will read whichever is lower back to us and be right to. An
-- agreement written as a firm net price says 'agreement only' instead, and
-- then the ladder never goes under it.
alter table nl.customer_prices
  add column break_policy text not null default 'better of'
    check (break_policy in ('better of', 'agreement only'));

comment on column nl.customer_prices.break_policy is
  'better of: a published ladder may go under the agreed price. agreement only: the agreed price is firm at every quantity.';

-- ---------------------------------------------------------------------------
-- What each customer is used to paying
-- ---------------------------------------------------------------------------

-- One row per account and part, from the account's own invoice history: what
-- they last paid and when, the twelve month average, the highest and lowest,
-- and how often they buy it.
--
-- Grouped once over the ledger rather than stored, because customer_no and
-- item_no are the grouping keys: a filter on either is pushed below the
-- aggregate, so one lookup reads that account's lines for that part and
-- nothing else. invoice_lines_customer_item_idx below is what makes that an
-- index only scan at full scale.
--
-- Credit memo lines are left out on purpose. A return at a negative quantity
-- is not a price the buyer remembers paying, and a price correction carries
-- quantity 0, so both would distort "what they are used to".
create view nl.customer_item_prices with (security_invoker = true) as
select
  il.customer_no,
  il.item_no,
  count(*)::int                         as times_bought,
  sum(il.quantity)::int                 as units,
  sum(il.amount)                        as revenue,
  min(il.posted_on)                     as first_bought,
  max(il.posted_on)                     as last_bought,
  -- The newest line's price, quantity and invoice, in the same pass.
  (array_agg(il.unit_price order by il.posted_on desc, il.invoice_no desc, il.line_no desc))[1]
                                        as last_price,
  (array_agg(il.quantity order by il.posted_on desc, il.invoice_no desc, il.line_no desc))[1]
                                        as last_quantity,
  (array_agg(il.invoice_no order by il.posted_on desc, il.invoice_no desc, il.line_no desc))[1]
                                        as last_invoice_no,
  max(il.unit_price)                    as high_price,
  min(il.unit_price)                    as low_price,
  -- Weighted by quantity, so one odd small order does not move it. Null when
  -- they have not bought it in the last year.
  case when sum(il.quantity) filter (where il.posted_on > nl.today() - 365) > 0
       then round(sum(il.quantity * il.unit_price) filter (where il.posted_on > nl.today() - 365)
                  / sum(il.quantity) filter (where il.posted_on > nl.today() - 365), 2)
  end                                   as avg_price_12m,
  sum(il.quantity) filter (where il.posted_on > nl.today() - 365)::int as units_12m,
  count(*) filter (where il.posted_on > nl.today() - 365)::int         as times_12m
from nl.invoice_lines il
where il.quantity > 0
group by il.customer_no, il.item_no;

comment on view nl.customer_item_prices is
  'What an account has paid for a part: last, twelve month average, high, low. Invoices only, no credit memos.';

-- The index that makes the per account per part lookup read the index and
-- nothing else. The delivery index (0005) is keyed on item then date and the
-- margin index (0018) on customer then date; neither can find one account's
-- lines for one part without reading rows it does not want.
--
-- At full scale (450,000 lines) this costs about 40 MB and turns the lookup
-- from a bitmap scan over one account's whole history into an index only scan
-- of the handful of lines for that part.
create index invoice_lines_customer_item_idx
  on nl.invoice_lines (customer_no, item_no, posted_on desc)
  include (quantity, unit_price, amount, invoice_no, line_no);

-- The same history, next to what we would charge today, with the flag that
-- stops an agent quoting a number the buyer will not recognise.
--
-- Worked out with joins, not with a call to nl.price_for() per row: every
-- function in this schema pins its search_path, which stops Postgres inlining
-- it, so a call per row would stay a call per row (DECISIONS.md 10 and the
-- same finding behind nl.freight_by_month in 0018). sheet_price and
-- tier_price are therefore read straight off the sheet line and the tier
-- discount, which is exactly what the sheet was built from.
create view nl.customer_item_price_context with (security_invoker = true) as
select
  h.customer_no,
  h.item_no,
  h.times_bought,
  h.units,
  h.first_bought,
  h.last_bought,
  h.last_price,
  h.last_quantity,
  h.last_invoice_no,
  h.high_price,
  h.low_price,
  h.avg_price_12m,
  h.units_12m,
  h.times_12m,
  (nl.today() - h.last_bought)::int as days_since,
  c.price_group,
  pg.discount                       as tier_discount,
  i.list_price,
  round(i.list_price * (1 - pg.discount), 2) as tier_price,
  sheet.sheet_id,
  sheet.sheet_code,
  sheet.sheet_price,
  -- What we would put in front of them today at quantity one: the sheet if
  -- the part is on it, otherwise the tier price.
  coalesce(sheet.sheet_price, round(i.list_price * (1 - pg.discount), 2)) as today_price,
  -- How far today's number sits above what they last paid, as a share.
  case when h.last_price > 0
       then round((coalesce(sheet.sheet_price, round(i.list_price * (1 - pg.discount), 2)) - h.last_price)
                  / h.last_price, 4)
  end as above_last_paid_pct,
  case when h.last_price > 0
       then (coalesce(sheet.sheet_price, round(i.list_price * (1 - pg.discount), 2)) - h.last_price)
            / h.last_price > nl.price_jump_pct()
       else false
  end as above_last_paid
from nl.customer_item_prices h
join nl.customers c on c.customer_no = h.customer_no
join nl.price_groups pg on pg.code = c.price_group
join nl.items i on i.item_no = h.item_no
left join lateral (
  select ps.id as sheet_id, ps.code as sheet_code, psl.sheet_price
  from nl.price_sheets ps
  join nl.price_sheet_lines psl on psl.sheet_id = ps.id and psl.item_no = h.item_no
  where ps.price_group = c.price_group
    and ps.effective_from <= nl.today()
    and (ps.effective_to is null or ps.effective_to >= nl.today())
  order by ps.effective_from desc
  limit 1
) sheet on true;

comment on view nl.customer_item_price_context is
  'What an account is used to paying for a part, next to today sheet and tier price, with the above_last_paid flag.';

-- ---------------------------------------------------------------------------
-- The exceptions that explain a number
-- ---------------------------------------------------------------------------

-- Everything that happens in a parts business between "here is the sheet
-- price" and "here is what you will actually get, when, and why". One table
-- with a kind, so an agent looks in one place instead of seven.
--
-- Each row carries a reason, the day it was announced, its window, and the
-- person who owns it, because an explanation that cannot say who decided
-- something is an apology rather than an answer.
--
-- Scope is how wide it reaches: one part, a family, a product group, or the
-- whole catalog. customer_no null means it applies to everyone; price_group
-- null means every tier.
create table nl.trade_exceptions (
  id             bigint generated always as identity primary key,
  kind           text not null check (kind in (
                   'price increase',     -- announced for a future date
                   'surcharge',          -- temporary material or freight percent
                   'customer exception', -- this account keeps an older sheet
                   'lead time',          -- longer than the item card says, with a reason
                   'allocation',         -- a limit per order while stock is short
                   'discontinued',       -- with a replacement part
                   'order minimum')),    -- a minimum order value or a pack size
  scope          text not null check (scope in ('item', 'family', 'product_group', 'catalog')),
  item_no        text references nl.items (item_no) on delete cascade,
  family         text,
  product_group  text,
  customer_no    text references nl.customers (customer_no) on delete cascade,
  price_group    text references nl.price_groups (code),
  announced_on   date not null,
  effective_from date not null,
  effective_to   date,                   -- null means it has no end date yet
  -- Only the fields the kind uses are filled in. The checks below say which.
  pct            numeric(6, 4),          -- a price increase or a surcharge
  amount         numeric(12, 2),         -- an order minimum in dollars
  quantity       int,                    -- a pack size, or an allocation limit
  days           int,                    -- the lead time now, in days
  held_sheet_id  bigint references nl.price_sheets (id),   -- a customer exception pins this sheet
  replacement_item_no text references nl.items (item_no),
  reason         text not null,          -- why, in a sentence
  wording        text not null default '', -- what the letter said, or what to say on the phone
  owner_id       int not null references nl.users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default nl.now_ms(),
  constraint trade_exceptions_window check (effective_to is null or effective_to >= effective_from),
  constraint trade_exceptions_announced check (announced_on <= effective_from),
  -- The scope column and the scope columns agree.
  constraint trade_exceptions_scope check (
    case scope
      when 'item'          then item_no is not null and family is null and product_group is null
      when 'family'        then family is not null and item_no is null and product_group is null
      when 'product_group' then product_group is not null and item_no is null and family is null
      else item_no is null and family is null and product_group is null
    end),
  -- Each kind carries the numbers it needs and no others.
  constraint trade_exceptions_fields check (
    case kind
      when 'price increase'     then pct is not null and pct > 0
      when 'surcharge'          then pct is not null and pct > 0
      when 'customer exception' then customer_no is not null and held_sheet_id is not null
      when 'lead time'          then days is not null and days > 0
      when 'allocation'         then quantity is not null and quantity > 0
      when 'discontinued'       then scope = 'item' and replacement_item_no is not null
      when 'order minimum'      then amount is not null or quantity is not null
    end),
  -- A reason is the point of the row.
  constraint trade_exceptions_reason check (btrim(reason) <> '')
);

comment on table nl.trade_exceptions is
  'Every published exception to normal price, lead time and ordering, each with a reason, a window and an owner.';

create index trade_exceptions_item_idx on nl.trade_exceptions (item_no, effective_from desc);
create index trade_exceptions_family_idx on nl.trade_exceptions (family, effective_from desc);
create index trade_exceptions_group_idx on nl.trade_exceptions (product_group, effective_from desc);
create index trade_exceptions_customer_idx on nl.trade_exceptions (customer_no, effective_from desc);
create index trade_exceptions_kind_idx on nl.trade_exceptions (kind, effective_from desc);
create index trade_exceptions_owner_idx on nl.trade_exceptions (owner_id);

create trigger trade_exceptions_touch before update on nl.trade_exceptions
  for each row execute function nl.touch_updated_at();

-- Where an exception is in its life, on a date. 'announced' is the useful one:
-- it has gone out to customers but has not started, which is exactly the
-- thing a reply needs to warn about.
create function nl.trade_exception_status(
  p_effective_from date,
  p_effective_to   date,
  p_on_date        date
) returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_effective_from > p_on_date then 'announced'
    when p_effective_to is not null and p_effective_to < p_on_date then 'expired'
    else 'live'
  end
$$;

-- Every exception with its status today, which is what an exceptions screen
-- lists and what the seed checks itself against.
create view nl.trade_exceptions_live with (security_invoker = true) as
select
  e.*,
  nl.trade_exception_status(e.effective_from, e.effective_to, nl.today()) as status,
  case when e.effective_to is not null then (e.effective_to - nl.today())::int end as days_left
from nl.trade_exceptions e;

-- The exceptions that reach one account and one part on one date, newest
-- first, as JSON. Scope is resolved here: an item row matches the part, a
-- family row matches its family, a product group row its group, and a catalog
-- row everything. A row with a customer matches only that account; a row with
-- a tier matches only accounts in it.
--
-- 'announced' rows are included on purpose. A price increase that starts in
-- six weeks is the single most useful thing to say when a buyer asks how long
-- a number is good for.
create function nl.exceptions_for(p_customer_no text, p_item_no text, p_on_date date)
returns jsonb
language sql stable
set search_path = ''
as $$
  with params as (
    select coalesce(p_on_date, nl.today()) as on_date
  ),
  item as (
    select i.item_no, i.family, i.product_group from nl.items i where i.item_no = p_item_no
  ),
  cust as (
    select c.customer_no, c.price_group from nl.customers c where c.customer_no = p_customer_no
  ),
  matched as (
    select
      e.*,
      nl.trade_exception_status(e.effective_from, e.effective_to, p.on_date) as status
    from nl.trade_exceptions e
    cross join params p
    cross join item it
    left join cust cu on true
    where (e.item_no = it.item_no
           or e.family = it.family
           or e.product_group = it.product_group
           or e.scope = 'catalog')
      and (e.customer_no is null or e.customer_no = cu.customer_no)
      and (e.price_group is null or e.price_group = cu.price_group)
      -- An exception that ran out more than a quarter ago is history, not
      -- context. One that ended last month still explains last month's price.
      and (e.effective_to is null or e.effective_to >= p.on_date - 90)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', m.id,
      'kind', m.kind,
      'scope', m.scope,
      'status', m.status,
      'item_no', m.item_no,
      'family', m.family,
      'product_group', m.product_group,
      'customer_no', m.customer_no,
      'price_group', m.price_group,
      'announced_on', m.announced_on,
      'effective_from', m.effective_from,
      'effective_to', m.effective_to,
      'pct', m.pct,
      'amount', m.amount,
      'quantity', m.quantity,
      'days', m.days,
      'held_sheet_id', m.held_sheet_id,
      'replacement_item_no', m.replacement_item_no,
      'reason', m.reason,
      'wording', m.wording,
      'owner_id', m.owner_id)
    order by
      -- Live first, then what is coming, then what has just ended.
      case m.status when 'live' then 1 when 'announced' then 2 else 3 end,
      m.effective_from desc, m.id), '[]'::jsonb)
  from matched m
$$;

-- ---------------------------------------------------------------------------
-- Lead time per vendor and part, in the three kinds it actually comes in
-- ---------------------------------------------------------------------------

-- Until now there were two lead time fields in the whole system:
-- nl.items.lead_time and nl.vendors.lead_time, each one text holding an ERP
-- date formula, and nl.lead_time_days() coalescing the item, then the vendor,
-- then a constant. So the vendor page showed one figure for every part a
-- vendor supplies, and a promise to a customer could rest on a guess with no
-- provenance at all.
--
-- Buying happens per vendor and per part, so that is where this lives, and a
-- lead time there is three different things that are regularly three
-- different numbers:
--
--   quoted     what the vendor says, with the day they said it and the quote
--              it came from. A claim, not a fact.
--   committed  what they promised on one open purchase order line. Often not
--              the quote.
--   observed   what actually happened, worked out from receipts. Kept as a
--              count, a median, a ninetieth percentile, the worst one and the
--              share that arrived late, because the tail is the decision. A
--              vendor whose median is 18 days and whose ninetieth is 45 is
--              not the same supplier as one that is 24 days every time, and
--              an average calls them the same.
--
-- And then the part that matters: what the system PROMISES with.
-- nl.promise_lead_days() uses the observed percentile where there is enough
-- history, the quote where there is not, the item card, the vendor card as a
-- default, and the house default last. It always says which it used and why,
-- and it refuses to promise a date at all for a part on allocation, because
-- promising one late is worse than saying we cannot.
--
-- Compatibility: nl.item_lead_days() keeps its signature and is replaced
-- below so the new source is authoritative underneath it. The forecast, the
-- projection and available to promise call it and do not change. A part with
-- no vendor-part row and no receipts falls all the way through to the old
-- coalesce chain, so a fixture with nothing but an item card still answers
-- the same number it always did.

-- ---------------------------------------------------------------------------
-- Policy: how much history a promise needs, and which percentile it uses
-- ---------------------------------------------------------------------------

-- How many receipts a vendor and part need before the observed figure is
-- trusted over the vendor's own quote. Four is the smallest number from which
-- a ninetieth percentile says anything at all; below it the quote is a better
-- guess than a short sample.
create function nl.promise_min_receipts() returns int
language sql stable
set search_path = ''
as $$
  select coalesce(
    -- A policy engine, if this database has one, decides it instead. Feature
    -- detected rather than depended on, because it is on another branch.
    (select nullif(current_setting('nl.promise_min_receipts', true), '')::int),
    4)
$$;

-- Which percentile of the observed spread a customer-facing promise uses. The
-- ninetieth, not the median: half of a median is late by definition, and a
-- promise a buyer can plan around has to cover the tail.
create function nl.promise_percentile() returns numeric
language sql stable
set search_path = ''
as $$
  select coalesce(
    (select nullif(current_setting('nl.promise_percentile', true), '')::numeric),
    0.90::numeric)
$$;

-- ---------------------------------------------------------------------------
-- The vendor and part relationship
-- ---------------------------------------------------------------------------

-- One row per vendor and part: everything a buyer needs before they can place
-- an order, and the quoted lead time with its provenance.
create table nl.vendor_items (
  vendor_no           text not null references nl.vendors (vendor_no) on delete cascade,
  item_no             text not null references nl.items (item_no) on delete cascade,
  -- Whether this vendor is where the part normally comes from, or a second
  -- source kept for when it does not.
  is_primary          boolean not null default false,
  vendor_item_no      text not null default '',       -- their number for it
  -- Quoted: what they say, when they said it, and where it is written down.
  quoted_lead_days    int check (quoted_lead_days > 0),
  quoted_on           date,
  quote_reference     text not null default '',
  -- What a buyer cannot act without.
  min_order_qty       int not null default 1 check (min_order_qty >= 1),
  order_multiple      int not null default 1 check (order_multiple >= 1),
  unit_cost           numeric(12, 2) check (unit_cost >= 0),
  -- Whether we can buy it from them at all today.
  status              text not null default 'active'
                      check (status in ('active', 'allocation', 'discontinued')),
  status_note         text not null default '',
  replacement_item_no text references nl.items (item_no),
  updated_at          timestamptz not null default nl.now_ms(),
  primary key (vendor_no, item_no),
  -- A quoted figure without a date is a rumour.
  constraint vendor_items_quote_dated check ((quoted_lead_days is null) = (quoted_on is null)),
  constraint vendor_items_replacement check (
    status = 'discontinued' or replacement_item_no is null)
);

comment on table nl.vendor_items is
  'Vendor and part: primary or alternate source, the quoted lead time with its provenance, and the ordering rules.';

-- One primary source per part. Two would make "where does this come from" a
-- question with two answers, the same reason there is one open agreement per
-- account and part.
create unique index vendor_items_one_primary_idx
  on nl.vendor_items (item_no) where is_primary;

-- "Who can supply this part", which is what a promise and a purchase request
-- both start from.
create index vendor_items_item_idx
  on nl.vendor_items (item_no, is_primary desc)
  include (vendor_no, quoted_lead_days, status, min_order_qty, order_multiple);

-- The vendor's own price ladder for one part. Same shape as a customer
-- ladder: a quantity and a price each, so one editor and one rollup work for
-- both (see nl.price_breaks).
create table nl.vendor_item_breaks (
  vendor_no    text not null,
  item_no      text not null,
  min_quantity int not null check (min_quantity >= 1),
  unit_cost    numeric(12, 2) not null check (unit_cost >= 0),
  note         text not null default '',
  primary key (vendor_no, item_no, min_quantity),
  foreign key (vendor_no, item_no) references nl.vendor_items (vendor_no, item_no) on delete cascade
);

comment on table nl.vendor_item_breaks is
  'What the vendor charges at each quantity. Rung one is their price at one piece.';

create index vendor_item_breaks_item_idx on nl.vendor_item_breaks (item_no, min_quantity);

-- ---------------------------------------------------------------------------
-- Observed: what actually arrived
-- ---------------------------------------------------------------------------

-- One row per received purchase order line. This is the only place the
-- observed lead time comes from, and it is never summarised into a stored
-- column: nl.vendor_item_lead_times groups it on read, so a figure on the
-- vendor page cannot be stale or hand edited.
--
-- ordered_on is the day the line was placed, promised_on is what the vendor
-- committed to on that line, and received_on is what happened. The three
-- together are what make "they quote 21 days and hit 34" a sentence with
-- evidence behind it.
create table nl.purchase_receipts (
  document_no text not null,
  line_no     int not null,
  vendor_no   text not null references nl.vendors (vendor_no),
  item_no     text not null references nl.items (item_no),
  ordered_on  date not null,
  promised_on date not null,
  received_on date not null,
  quantity    int not null check (quantity > 0),
  -- What the vendor billed for the goods themselves.
  unit_cost   numeric(12, 2) not null check (unit_cost >= 0),
  -- What it cost to get them here. The item card carries one cost figure and
  -- it is the goods figure, so a margin worked out from it is flattering by
  -- whatever these two add up to. Kept per receipt because they move: a part
  -- flown in to cover a shortage lands at a different cost from the same part
  -- on a full truck.
  freight_in  numeric(12, 2) not null default 0 check (freight_in >= 0),
  duty        numeric(12, 2) not null default 0 check (duty >= 0),
  primary key (document_no, line_no),
  constraint purchase_receipts_order check (promised_on >= ordered_on and received_on >= ordered_on)
);

comment on table nl.purchase_receipts is
  'Received purchase order lines: ordered, promised and received. The only source of the observed lead time.';

-- The grouping nl.vendor_item_lead_times makes, carrying the columns it reads
-- so the percentiles never visit the table.
create index purchase_receipts_lead_idx
  on nl.purchase_receipts (vendor_no, item_no, received_on desc)
  include (ordered_on, promised_on, quantity);

create index purchase_receipts_item_idx
  on nl.purchase_receipts (item_no, received_on desc);

-- What a part has actually cost us delivered, per vendor and part.
--
-- nl.items.unit_cost and the cost timeline in 0018 both carry the goods
-- figure, which is what the vendor invoiced. Freight in and duty are real
-- money and they are not in it, so every margin in the app is flattering by
-- the uplift below. This view is where that gap becomes a number rather than
-- a suspicion.
--
-- Grouped on read, never stored: a receipt is the fact, and a landed cost is
-- arithmetic over the receipts, so it cannot go stale or be hand edited.
create view nl.landed_cost with (security_invoker = true) as
select
  r.vendor_no,
  r.item_no,
  count(*)::int            as receipts,
  max(r.received_on)       as last_received,
  sum(r.quantity)::int     as units,
  sum(r.quantity * r.unit_cost) as goods,
  sum(r.freight_in)        as freight_in,
  sum(r.duty)              as duty,
  round(sum(r.quantity * r.unit_cost) / sum(r.quantity), 4) as invoiced_unit_cost,
  round((sum(r.quantity * r.unit_cost) + sum(r.freight_in) + sum(r.duty)) / sum(r.quantity), 4)
    as landed_unit_cost,
  -- How much the goods figure understates what the part really costs.
  round((sum(r.freight_in) + sum(r.duty)) / nullif(sum(r.quantity * r.unit_cost), 0), 4)
    as uplift_pct,
  -- The same thing over the last year only, because freight moved.
  round(sum(r.quantity * r.unit_cost) filter (where r.received_on > nl.today() - 365)
        / nullif(sum(r.quantity) filter (where r.received_on > nl.today() - 365), 0), 4)
    as invoiced_unit_cost_12m,
  round((sum(r.quantity * r.unit_cost) filter (where r.received_on > nl.today() - 365)
         + sum(r.freight_in) filter (where r.received_on > nl.today() - 365)
         + sum(r.duty) filter (where r.received_on > nl.today() - 365))
        / nullif(sum(r.quantity) filter (where r.received_on > nl.today() - 365), 0), 4)
    as landed_unit_cost_12m
from nl.purchase_receipts r
group by r.vendor_no, r.item_no;

comment on view nl.landed_cost is
  'What a part has cost delivered: goods plus freight in plus duty, per vendor and part, from receipts.';

-- What a vendor actually does on one part. Deliberately no mean: an average
-- hides the tail, and the tail is what a buyer has to plan around.
create view nl.vendor_item_lead_times with (security_invoker = true) as
select
  r.vendor_no,
  r.item_no,
  count(*)::int                                  as receipts,
  min(r.received_on)                             as first_received,
  max(r.received_on)                             as last_received,
  min((r.received_on - r.ordered_on))::int       as best_days,
  max((r.received_on - r.ordered_on))::int       as worst_days,
  -- Cast to numeric: percentile_cont returns double precision, and every
  -- other figure in this schema that a screen shows is numeric.
  round(percentile_cont(0.5) within group (order by (r.received_on - r.ordered_on))::numeric, 1)
    as median_days,
  round(percentile_cont(0.9) within group (order by (r.received_on - r.ordered_on))::numeric, 1)
    as p90_days,
  count(*) filter (where r.received_on > r.promised_on)::int as late_receipts,
  round(count(*) filter (where r.received_on > r.promised_on)::numeric / count(*), 4) as late_share,
  -- How far past the promise the late ones ran, which is the number a buyer
  -- quotes back at the vendor.
  coalesce(max((r.received_on - r.promised_on)) filter (where r.received_on > r.promised_on), 0)::int
    as worst_days_late
from nl.purchase_receipts r
group by r.vendor_no, r.item_no;

comment on view nl.vendor_item_lead_times is
  'Observed lead time per vendor and part, from receipts: count, median, ninetieth percentile, worst, late share. No average, on purpose.';

-- Committed: what the vendor promised on each open purchase order line, next
-- to what they quoted. The difference is the thing to raise on the call.
create view nl.vendor_item_commitments with (security_invoker = true) as
select
  l.document_no,
  l.line_no,
  l.vendor_no,
  l.item_no,
  l.quantity,
  l.first_seen_on                                        as ordered_on,
  coalesce(l.promised_date, l.due_date)                  as committed_date,
  (coalesce(l.promised_date, l.due_date) - l.first_seen_on)::int as committed_days,
  vi.quoted_lead_days,
  case when vi.quoted_lead_days is not null
       then (coalesce(l.promised_date, l.due_date) - l.first_seen_on)::int - vi.quoted_lead_days
  end as days_over_quote,
  coalesce(l.promised_date, l.due_date) < nl.today()     as overdue
from nl.open_purchase_lines l
left join nl.vendor_items vi
  on vi.vendor_no = l.vendor_no and vi.item_no = l.item_no;

-- ---------------------------------------------------------------------------
-- What the system promises with
-- ---------------------------------------------------------------------------

-- The observed figure a promise uses: the configured percentile of the
-- spread. Kept as its own function so the percentile can move in one place
-- and so nl.promise_lead_days() reads as a rule rather than as arithmetic.
--
-- The view publishes the median and the ninetieth because those are the two a
-- person reads. Any other percentile between them is interpolated from the
-- pair rather than re-read from the receipts, which is close enough for a
-- promise and costs nothing.
create function nl.observed_promise_days(p_median numeric, p_p90 numeric) returns numeric
language sql immutable
set search_path = ''
as $$
  select case
    when p_p90 is null then p_median
    when nl.promise_percentile() >= 0.90 then p_p90
    when nl.promise_percentile() <= 0.50 then p_median
    -- Straight line between the two published points.
    else p_median + (p_p90 - p_median) * (nl.promise_percentile() - 0.50) / 0.40
  end
$$;


-- The lead time to use for one part, and why. One row, always.
--
-- basis, in the order the rule tries them:
--
--   observed        enough receipts from the primary source, ninetieth percentile
--   quoted          what that vendor says, because the history is too thin
--   item card       the part's own ERP date formula
--   vendor default  the vendor card's formula, which is a default for every
--                   part they supply and is labelled as one
--   default         nl.default_lead_days() for the replenishment method
--
-- can_promise is false where a date should not be given to a customer at all:
-- the primary source has the part on allocation, or has discontinued it. A
-- part on allocation gets no promise rather than a promise it will miss.
--
-- lead_days is always a number, even when can_promise is false, because the
-- forecast and the projection need something to plan with. That is what keeps
-- nl.item_lead_days() and its callers working unchanged.
create function nl.promise_lead_days(p_item_no text)
returns table (
  item_no             text,
  lead_days           int,
  basis               text,
  detail              text,
  can_promise         boolean,
  vendor_no           text,
  is_primary          boolean,
  receipts            int,
  median_days         numeric,
  p90_days            numeric,
  worst_days          int,
  late_share          numeric,
  quoted_lead_days    int,
  quoted_on           date,
  quote_reference     text,
  vendor_status       text,
  status_note         text,
  replacement_item_no text,
  min_order_qty       int,
  order_multiple      int
)
language sql stable
set search_path = ''
as $$
  with item as (
    select i.item_no, i.family, i.replenishment, i.lead_time, i.vendor_no as card_vendor_no
    from nl.items i
    where i.item_no = p_item_no
  ),
  -- Where the part normally comes from: the primary vendor-part row, else the
  -- one the item card names, else any vendor that supplies it.
  source as (
    select vi.*
    from nl.vendor_items vi, item it
    where vi.item_no = it.item_no
    order by vi.is_primary desc,
             (vi.vendor_no = it.card_vendor_no) desc,
             vi.vendor_no
    limit 1
  ),
  -- The observed figures for that source, aggregated straight off the
  -- receipts rather than read out of nl.vendor_item_lead_times.
  --
  -- The view is the same arithmetic, and a test holds the two to the same
  -- answer for every pair (the pattern 0018 set with nl.freight_by_month).
  -- The reason for the duplication is that a value from a CTE cannot be
  -- pushed into a view's group by, so reading the view here grouped the whole
  -- receipts table on every call: 37 buffers a part instead of 4, which
  -- showed up at once in nl.customer_parts.
  seen as (
    select
      count(*)::int as receipts,
      round(percentile_cont(0.5) within group (order by (r.received_on - r.ordered_on))::numeric, 1)
        as median_days,
      round(percentile_cont(0.9) within group (order by (r.received_on - r.ordered_on))::numeric, 1)
        as p90_days,
      max((r.received_on - r.ordered_on))::int as worst_days,
      case when count(*) > 0
           then round(count(*) filter (where r.received_on > r.promised_on)::numeric / count(*), 4)
      end as late_share
    from nl.purchase_receipts r, source s
    where r.vendor_no = s.vendor_no and r.item_no = s.item_no
  ),
  card as (
    select
      nl.lead_time_days(it.lead_time) as item_card_days,
      nl.lead_time_days(v.lead_time)  as vendor_card_days,
      nl.default_lead_days(it.replenishment) as house_days
    from item it
    left join nl.vendors v on v.vendor_no = coalesce((select vendor_no from source), it.card_vendor_no)
  ),
  pick as (
    select case
      when (select receipts from seen) >= nl.promise_min_receipts() then 'observed'
      when (select quoted_lead_days from source) is not null then 'quoted'
      when c.item_card_days is not null then 'item card'
      when c.vendor_card_days is not null then 'vendor default'
      else 'default'
    end as basis
    from card c
  )
  select
    it.item_no,
    case p.basis
      -- Rounded up: a promise made on a fraction of a day is a promise
      -- rounded down by accident.
      when 'observed'       then ceil(nl.observed_promise_days(sn.median_days, sn.p90_days))::int
      when 'quoted'         then s.quoted_lead_days
      when 'item card'      then c.item_card_days
      when 'vendor default' then c.vendor_card_days
      else c.house_days
    end,
    p.basis,
    case p.basis
      when 'observed' then 'The ' || round(nl.promise_percentile() * 100)
        || 'th percentile of ' || sn.receipts || ' receipts from this vendor on this part'
        || ', median ' || round(sn.median_days) || ' days'
      when 'quoted' then 'What the vendor quoted on ' || s.quoted_on
        || coalesce(nullif(', ' || s.quote_reference, ', '), '')
        || ', because there '
        || case when coalesce(sn.receipts, 0) = 1 then 'is only 1 receipt'
                else 'are only ' || coalesce(sn.receipts, 0) || ' receipts' end
        || ' to go on'
      when 'item card' then 'The date formula on the item card, ' || it.lead_time
      when 'vendor default' then 'The vendor card default for every part they supply, '
        || 'because this part has no history and no quote of its own'
      else 'The house default for a ' || it.replenishment || ' part'
    end,
    -- A part on allocation or discontinued at its source gets no promise.
    coalesce(s.status, 'active') = 'active',
    s.vendor_no,
    s.is_primary,
    coalesce(sn.receipts, 0),
    sn.median_days,
    sn.p90_days,
    sn.worst_days,
    sn.late_share,
    s.quoted_lead_days,
    s.quoted_on,
    s.quote_reference,
    coalesce(s.status, 'active'),
    coalesce(s.status_note, ''),
    s.replacement_item_no,
    coalesce(s.min_order_qty, 1),
    coalesce(s.order_multiple, 1)
  from item it
  cross join card c
  cross join pick p
  left join source s on true
  left join seen sn on true
$$;

-- The compatibility seam. Same signature, same return type, same callers
-- (nl.available_to_promise and the projection in 0016, the coverage screens
-- in 0022): they now get the promise rule's answer instead of a coalesce over
-- two text fields, and they did not have to change to get it.
--
-- It returns lead_days rather than the promise, so a part on allocation still
-- has a number the forecast can plan with. Anything customer facing should
-- call nl.promise_lead_days() and read can_promise.
create or replace function nl.item_lead_days(p_item_no text) returns int
language sql stable
set search_path = ''
as $$
  select lead_days from nl.promise_lead_days(p_item_no)
$$;

-- Migration 0029 has its own copy of the old three step chain, because the
-- procurement desk has to work on a database without 0016. It is replaced here
-- for the same reason nl.item_lead_days() is: the replenishment maths, the
-- order-by dates and the purchase requests should plan on what the vendor
-- actually does, and none of their callers has to change to get it. Same
-- signature, same return type.
create or replace function nl.item_lead_time_days(p_item_no text) returns int
language sql stable
set search_path = ''
as $$
  select lead_days from nl.promise_lead_days(p_item_no)
$$;

-- The buyer's work list: every part a vendor supplies, with what they quote
-- next to what they do, worst tail first. This is what replaces the single
-- lead time figure on a vendor page.
--
-- tail_days is the gap between the quote and the ninetieth percentile: the
-- number of days a plan built on the quote would be short by, one part in
-- ten. Sorting by it puts the parts that will bite first at the top.
create view nl.vendor_part_lead_times with (security_invoker = true) as
select
  vi.vendor_no,
  vi.item_no,
  i.description,
  i.family,
  vi.is_primary,
  vi.status,
  vi.status_note,
  vi.replacement_item_no,
  vi.min_order_qty,
  vi.order_multiple,
  vi.unit_cost,
  vi.quoted_lead_days,
  vi.quoted_on,
  vi.quote_reference,
  lt.receipts,
  lt.median_days,
  lt.p90_days,
  lt.worst_days,
  lt.late_receipts,
  lt.late_share,
  lt.worst_days_late,
  lt.last_received,
  -- How far the tail runs past the quote. Null while there is no history to
  -- compare, which is itself worth showing.
  case when lt.p90_days is not null and vi.quoted_lead_days is not null
       then (lt.p90_days - vi.quoted_lead_days)
  end as tail_days,
  pl.lead_days   as promise_days,
  pl.basis       as promise_basis,
  pl.detail      as promise_detail,
  pl.can_promise,
  -- Whether the observed figure is trusted yet, which is what the basis turns on.
  coalesce(lt.receipts, 0) >= nl.promise_min_receipts() as history_is_enough
from nl.vendor_items vi
join nl.items i on i.item_no = vi.item_no
left join nl.vendor_item_lead_times lt
  on lt.vendor_no = vi.vendor_no and lt.item_no = vi.item_no
cross join lateral nl.promise_lead_days(vi.item_no) pl;

comment on view nl.vendor_part_lead_times is
  'Quoted against observed per vendor and part, with the promise basis. Sort by tail_days desc for a buyer work list.';

-- The lead time for a part on a date, why it is what it is, and whether it is
-- safe to promise. The vendor and part relationship decides the normal figure
-- (nl.promise_lead_days above); a live lead time exception overrides it
-- upward and brings a reason and an owner with it.
--
-- basis is the promise basis, or 'exception' when a published slip has moved
-- the date out past it. Everywhere a date appears, that word appears with it.
create function nl.lead_time_for(p_item_no text, p_on_date date)
returns table (
  item_no      text,
  days         int,
  card_days    int,
  slipped      boolean,
  basis        text,
  basis_detail text,
  can_promise  boolean,
  vendor_no    text,
  receipts     int,
  median_days  numeric,
  p90_days     numeric,
  late_share   numeric,
  reason       text,
  wording      text,
  owner_id     int,
  since        date,
  until        date
)
language sql stable
set search_path = ''
as $$
  select
    i.item_no,
    greatest(coalesce(ex.days, pl.lead_days), pl.lead_days),
    -- card_days keeps its old name and its old meaning for the callers that
    -- already read it: the figure before any published slip.
    pl.lead_days,
    ex.days is not null and ex.days > pl.lead_days,
    case when ex.days is not null and ex.days > pl.lead_days then 'exception' else pl.basis end,
    case when ex.days is not null and ex.days > pl.lead_days then ex.reason else pl.detail end,
    -- A published slip does not stop us promising; it changes the date. An
    -- allocation does stop us.
    pl.can_promise,
    pl.vendor_no,
    pl.receipts,
    pl.median_days,
    pl.p90_days,
    pl.late_share,
    coalesce(ex.reason, ''),
    coalesce(ex.wording, ''),
    ex.owner_id,
    ex.effective_from,
    ex.effective_to
  from nl.items i
  cross join lateral nl.promise_lead_days(i.item_no) pl
  cross join lateral (select coalesce(p_on_date, nl.today()) as on_date) p
  -- The longest live slip that reaches this part, so a family wide vendor
  -- problem is not hidden by a shorter item level one.
  left join lateral (
    select e.days, e.reason, e.wording, e.owner_id, e.effective_from, e.effective_to
    from nl.trade_exceptions e
    where e.kind = 'lead time'
      and (e.item_no = i.item_no or e.family = i.family or e.product_group = i.product_group
           or e.scope = 'catalog')
      and e.effective_from <= p.on_date
      and (e.effective_to is null or e.effective_to >= p.on_date)
    order by e.days desc, e.effective_from desc
    limit 1
  ) ex on true
  where i.item_no = p_item_no
$$;
-- ---------------------------------------------------------------------------
-- The quote level price rule
-- ---------------------------------------------------------------------------

-- The price this account pays for this many of this part on this day, which
-- published document said so, and what the ladder does next. This is
-- nl.price_for() with two things a quote knows that a part does not: a
-- quantity, and which sheet the buyer is holding.
--
-- The base price, in order:
--
--   1. agreement       an agreed net price whose window covers the day
--   2. held sheet      a live customer exception pinning an older sheet
--   3. last paid       what they last paid inside a year, if it clears the floor
--   4. sheet           the page price on the sheet in force for their tier
--   5. group discount  list less their tier discount, for a part no sheet covers
--   6. list            list price, for an account we do not know
--
-- Then the ladder. The rungs come from the sheet in force if it prints a
-- ladder for the part, otherwise from the tier's standing ladder. The rung
-- that applies is the deepest one the quantity reaches, and it only applies
-- if it is lower than the base price: the better price for the customer.
--
-- Where an agreement and a rung both reach a quantity,
-- nl.customer_prices.break_policy decides. 'better of' (the default) lets the
-- rung go under the agreed price, because a buyer holding both documents will
-- read the lower one back to us and be right to. 'agreement only' holds the
-- agreed price at every quantity.
--
-- next_price is what they would actually pay at the next rung up, not the
-- printed rung, so a reply can say "buy twelve and it is this" and be right
-- even when an agreement is already better than the ladder.
--
-- below_floor stays a flag and never a veto, exactly as in 0018.
create function nl.price_quote_for(
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
  price          numeric,      -- the base price, before any rung
  rule           text,
  detail         text,
  sheet_id       bigint,
  sheet_code     text,
  sheet_name     text,
  sheet_price    numeric,
  agreement_net  numeric,
  agreement_from date,
  agreement_to   date,
  break_policy   text,
  break_quantity int,          -- the rung that set the price, null when none did
  break_price    numeric,
  break_note     text,
  break_owner    text,         -- 'sheet' or 'tier', so a reply can name the document
  unit_price     numeric,      -- what to quote
  extended       numeric,
  next_quantity  int,
  next_price     numeric,      -- what they would pay at that quantity
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
    select
      p_customer_no as customer_no,
      p_item_no     as item_no,
      greatest(coalesce(p_quantity, 1), 1) as quantity,
      coalesce(p_on_date, nl.today())      as on_date
  ),
  base as (
    select
      a.customer_no,
      a.item_no,
      a.quantity,
      a.on_date,
      i.list_price,
      i.family,
      i.product_group,
      cu.customer_no is not null as known_customer,
      cu.price_group,
      coalesce(pg.discount, 0) as discount,
      c.unit_cost,
      round(c.unit_cost / (1 - nl.min_margin()), 2) as floor_price
    from asked a
    join nl.items i on i.item_no = a.item_no
    left join nl.customers cu on cu.customer_no = a.customer_no
    left join nl.price_groups pg on pg.code = cu.price_group
    -- One call, not two: nl.item_cost_on pins its search_path, so Postgres
    -- cannot inline it and every mention of it is another function call.
    cross join lateral (select nl.item_cost_on(i.item_no, a.on_date) as unit_cost) c
  ),
  -- The sheet in force for their tier on the day, and the page price on it.
  sheet as (
    select ps.id, ps.code, ps.name, psl.sheet_price
    from base b
    join nl.price_sheets ps
      on ps.price_group = b.price_group
     and ps.effective_from <= b.on_date
     and (ps.effective_to is null or ps.effective_to >= b.on_date)
    join nl.price_sheet_lines psl
      on psl.sheet_id = ps.id and psl.item_no = b.item_no
    order by ps.effective_from desc
    limit 1
  ),
  -- 1. an agreed price whose window covers the day
  agreement as (
    select cp.net_price, cp.valid_from, cp.valid_to, cp.break_policy
    from base b
    join nl.customer_prices cp
      on cp.customer_no = b.customer_no
     and cp.item_no = b.item_no
     and cp.valid_from <= b.on_date
     and (cp.valid_to is null or cp.valid_to >= b.on_date)
    order by cp.valid_from desc
    limit 1
  ),
  -- 2. a live customer exception pinning an older sheet, and its page price.
  -- The cheapest pinned sheet wins, because an exception written to protect a
  -- customer should not leave them worse off than the one before it.
  held as (
    select e.id as exception_id, e.effective_to, e.reason, ps.code, ps.name, psl.sheet_price
    from base b
    join nl.trade_exceptions e
      on e.kind = 'customer exception'
     and e.customer_no = b.customer_no
     and (e.item_no = b.item_no or e.family = b.family or e.product_group = b.product_group
          or e.scope = 'catalog')
     and e.effective_from <= b.on_date
     and (e.effective_to is null or e.effective_to >= b.on_date)
    join nl.price_sheets ps on ps.id = e.held_sheet_id
    join nl.price_sheet_lines psl
      on psl.sheet_id = ps.id and psl.item_no = b.item_no
    order by psl.sheet_price, e.effective_from desc
    limit 1
  ),
  -- 3. the last price they actually paid, inside the last twelve months
  last_paid as (
    select il.unit_price, il.posted_on
    from base b
    join nl.invoice_lines il
      on il.customer_no = b.customer_no
     and il.item_no = b.item_no
     and il.quantity > 0
     and il.posted_on <= b.on_date
     and il.posted_on > b.on_date - 365
    order by il.posted_on desc, il.invoice_no desc, il.line_no desc
    limit 1
  ),
  -- Which rule wins, kept apart from what it says so the precedence lives in
  -- one place instead of once per column.
  pick as (
    select case
      when (select net_price from agreement) is not null then 'agreement'
      when (select sheet_price from held) is not null then 'held sheet'
      when (select unit_price from last_paid) is not null
       and (select unit_price from last_paid) >= b.floor_price then 'last paid'
      when (select sheet_price from sheet) is not null then 'sheet'
      when b.known_customer then 'group discount'
      else 'list'
    end as rule
    from base b
  ),
  priced as (
    select
      p.rule,
      case p.rule
        when 'agreement'      then (select net_price from agreement)
        when 'held sheet'     then (select sheet_price from held)
        when 'last paid'      then (select unit_price from last_paid)
        when 'sheet'          then (select sheet_price from sheet)
        when 'group discount' then round(b.list_price * (1 - b.discount), 2)
        else b.list_price
      end as price,
      case p.rule
        when 'agreement' then 'Agreed price in force since '
          || (select valid_from from agreement)
          || case when (select valid_to from agreement) is null then ', open ended'
                  else ', to ' || (select valid_to from agreement) end
        when 'held sheet' then 'This account holds ' || (select name from held)
          || case when (select effective_to from held) is not null
                  then ' until ' || (select effective_to from held) else '' end
        when 'last paid' then 'The price they last paid, on ' || (select posted_on from last_paid)
        when 'sheet' then (select name from sheet) || ', page price'
        when 'group discount' then 'List less the ' || round(b.discount * 100)
          || '% ' || coalesce(b.price_group, '') || ' discount'
        else 'List price'
      end as detail,
      -- A firm agreement refuses every rung.
      p.rule = 'agreement'
        and coalesce((select break_policy from agreement), 'better of') = 'agreement only' as firm
    from base b, pick p
  ),
  -- The ladder: the sheet's rungs if it prints any for this part, else the
  -- tier's standing ladder. One or the other, never the two mixed together.
  ladder as (
    select pb.min_quantity, pb.break_price, pb.note, 'sheet'::text as owner
    from nl.price_breaks pb
    where pb.sheet_id = (select id from sheet)
      and pb.item_no = (select item_no from base)
    union all
    select pb.min_quantity, pb.break_price, pb.note, 'tier'
    from nl.price_breaks pb, base b
    where pb.price_group = b.price_group
      and pb.item_no = b.item_no
      and not exists (
        select 1 from nl.price_breaks s
        where s.sheet_id = (select id from sheet) and s.item_no = b.item_no)
  ),
  -- The deepest rung the quantity reaches. Rung one is the sheet price, so it
  -- is not a break: it is the number the base rule already has.
  applied as (
    select l.min_quantity, l.break_price, l.note, l.owner
    from ladder l, asked a
    where l.min_quantity <= a.quantity and l.min_quantity > 1
    order by l.min_quantity desc
    limit 1
  ),
  -- The next rung up, so a reply can say what buying more would cost.
  upcoming as (
    select l.min_quantity, l.break_price
    from ladder l, asked a
    where l.min_quantity > a.quantity
    order by l.min_quantity
    limit 1
  ),
  final as (
    select
      pr.rule,
      pr.price,
      pr.detail,
      pr.firm,
      -- The rung sets the price only when it is allowed to and only when it
      -- is lower. Anything else is a rung that did not apply.
      (ap.break_price is not null and not pr.firm and ap.break_price < pr.price) as break_applied,
      ap.min_quantity as break_quantity,
      ap.break_price,
      ap.note as break_note,
      ap.owner as break_owner
    from priced pr
    left join applied ap on true
  )
  select
    b.customer_no,
    b.item_no,
    b.on_date,
    b.quantity,
    f.price,
    f.rule,
    f.detail,
    (select id from sheet),
    (select code from sheet),
    (select name from sheet),
    (select sheet_price from sheet),
    (select net_price from agreement),
    (select valid_from from agreement),
    (select valid_to from agreement),
    (select break_policy from agreement),
    case when f.break_applied then f.break_quantity end,
    case when f.break_applied then f.break_price end,
    case when f.break_applied then f.break_note else '' end,
    case when f.break_applied then f.break_owner end,
    case when f.break_applied then f.break_price else f.price end as unit_price,
    round(b.quantity * case when f.break_applied then f.break_price else f.price end, 2),
    (select min_quantity from upcoming),
    -- What they would pay at that quantity, not the printed rung.
    case when (select break_price from upcoming) is not null
         then case when f.firm then f.price
                   else least(f.price, (select break_price from upcoming)) end
    end,
    b.list_price,
    b.discount,
    b.unit_cost,
    b.floor_price,
    case when (case when f.break_applied then f.break_price else f.price end) > 0
         then round(((case when f.break_applied then f.break_price else f.price end) - b.unit_cost)
                    / (case when f.break_applied then f.break_price else f.price end), 4) end,
    (case when f.break_applied then f.break_price else f.price end) < b.floor_price
  from base b, final f
$$;

-- ---------------------------------------------------------------------------
-- One function that explains a price
-- ---------------------------------------------------------------------------

-- The price, and the whole reasoning behind it, as one JSON answer. An agent
-- or a screen reads this instead of assembling its own story out of five
-- queries, so two of them cannot tell the same customer two different things.
--
-- It answers "why is this more than last time" without a second call:
--
--   quote           the number, the rule that set it, the whole ladder
--   sheet           the sheet in force for their tier
--   customer_sheet  the sheet they are actually holding, their price on it,
--                   and the difference
--   history         last paid and when, the twelve month average, high, low,
--                   and the above_last_paid flag with the size of the jump
--   cost            cost that day, the floor, margin, below_floor
--   lead_time       days, whether it slipped, and why
--   next_increase   the announced increase that will move this number next
--   surcharges      what is riding on top, and the dollars on this quantity
--   exceptions      every published exception that reaches this account and
--                   part, live and announced, each with its reason and owner
--   talking_points  what a person should say, in plain sentences
--
-- An exception's owner comes back as owner_id and never as a name: the read
-- only role the assistant uses has no grant on nl.users, so a page resolves
-- the name itself and this function stays safe to grant to both roles.
--
-- Null for a part that is not in the catalog.
create function nl.explain_price(
  p_customer_no text,
  p_item_no     text,
  p_quantity    int,
  p_on_date     date
) returns jsonb
language sql stable
set search_path = ''
as $$
  with q as (
    select * from nl.price_quote_for(p_customer_no, p_item_no, p_quantity, p_on_date)
  ),
  item as (
    select i.item_no, i.description, i.family, i.product_group, i.replenishment, i.blocked
    from nl.items i
    where i.item_no = p_item_no
  ),
  cust as (
    select c.customer_no, c.name, c.price_group
    from nl.customers c
    where c.customer_no = p_customer_no
  ),
  -- What they are used to paying, from their own invoices.
  hist as (
    select h.*
    from nl.customer_item_prices h
    where h.customer_no = p_customer_no and h.item_no = p_item_no
  ),
  -- The sheet they hold, and their page price on it, which is the number they
  -- will read back to us.
  holding as (
    select
      aps.sheet_id, aps.sheet_code, aps.sheet_name, aps.sent_on, aps.sent_how,
      aps.days_old, aps.stale, aps.is_current, aps.generations_behind,
      psl.sheet_price
    from nl.account_price_sheet aps
    left join nl.price_sheet_lines psl
      on psl.sheet_id = aps.sheet_id and psl.item_no = p_item_no
    where aps.customer_no = p_customer_no
  ),
  -- The whole ladder, so a reply can quote any rung without asking again.
  ladder as (
    select jsonb_agg(jsonb_build_object(
             'min_quantity', r.min_quantity, 'break_price', r.break_price,
             'note', r.note, 'owner', r.owner)
           order by r.min_quantity) as rungs
    from (
      select pb.min_quantity, pb.break_price, pb.note, 'sheet'::text as owner
      from nl.price_breaks pb, q
      where pb.sheet_id = q.sheet_id and pb.item_no = q.item_no
      union all
      select pb.min_quantity, pb.break_price, pb.note, 'tier'
      from nl.price_breaks pb, q, cust c
      where pb.price_group = c.price_group
        and pb.item_no = q.item_no
        and not exists (
          select 1 from nl.price_breaks s
          where s.sheet_id = q.sheet_id and s.item_no = q.item_no)
    ) r
  ),
  lead_time as (
    select * from nl.lead_time_for(p_item_no, p_on_date)
  ),
  -- What the part has cost us delivered, from the source we buy it from.
  landed as (
    select lc.landed_unit_cost, lc.uplift_pct
    from nl.landed_cost lc
    where lc.item_no = p_item_no
    order by lc.receipts desc, lc.vendor_no
    limit 1
  ),
  ex as (
    select nl.exceptions_for(p_customer_no, p_item_no, p_on_date) as rows
  ),
  -- The announced increase that will move this price next, and the live
  -- surcharges riding on top of it, pulled out of the exception list so a
  -- caller does not have to filter JSON to answer the two questions every
  -- buyer asks: how long is this good for, and what are these extras.
  next_increase as (
    select e.pct, e.effective_from, e.scope, e.reason, e.wording, e.owner_id
    from jsonb_to_recordset((select rows from ex))
      as e(kind text, status text, pct numeric, effective_from date, reason text,
           wording text, owner_id int, scope text)
    where e.kind = 'price increase' and e.status = 'announced'
    order by e.effective_from
    limit 1
  ),
  -- A live allocation limit and a pack size, pulled out for the same reason
  -- as the increase and the surcharges: they change what a person can promise
  -- to send, and a caller should not have to filter JSON to find them.
  allocation as (
    select e.quantity, e.effective_to, e.reason, e.owner_id
    from jsonb_to_recordset((select rows from ex))
      as e(kind text, status text, quantity int, effective_to date, reason text, owner_id int)
    where e.kind = 'allocation' and e.status = 'live'
    order by e.quantity
    limit 1
  ),
  pack as (
    select e.quantity, e.amount
    from jsonb_to_recordset((select rows from ex))
      as e(kind text, status text, scope text, quantity int, amount numeric)
    where e.kind = 'order minimum' and e.status = 'live' and e.scope = 'item'
    limit 1
  ),
  surcharges as (
    select
      sum(e.pct) as pct,
      jsonb_agg(jsonb_build_object('pct', e.pct, 'reason', e.reason, 'owner_id', e.owner_id)
                order by e.pct desc) as rows
    from jsonb_to_recordset((select rows from ex))
      as e(kind text, status text, pct numeric, reason text, owner_id int)
    where e.kind = 'surcharge' and e.status = 'live'
  ),
  -- The jump against what they last paid, worked out on the price we are
  -- about to quote rather than on the sheet price, because the quantity is
  -- part of the question.
  jump as (
    select
      h.last_price,
      case when h.last_price > 0 then round((q.unit_price - h.last_price) / h.last_price, 4) end as pct
    from q left join hist h on true
  ),
  points as (
    select array_remove(array[
      -- Where the number came from.
      case q.rule
        when 'sheet' then 'This is the page price on '
          || coalesce(q.sheet_name, 'the current sheet') || '.'
        when 'agreement' then 'This is their agreed price, in force since ' || q.agreement_from || '.'
        when 'held sheet' then q.detail || '.'
        when 'last paid' then 'This holds the price they paid last time.'
        when 'group discount' then 'This part is not on the printed sheet, so it prices off their '
          || round(q.discount * 100) || '% tier discount.'
        else 'We have no tier on file for this account, so this is list price.'
      end,
      -- The ladder.
      case when q.break_quantity is not null
           then 'At ' || q.quantity || ' the published ' || q.break_owner || ' ladder takes it to '
                || to_char(q.unit_price, 'FM999999990.00') || ' each.' end,
      case when q.next_quantity is not null and q.next_price < q.unit_price
           then 'At ' || q.next_quantity || ' or more it drops to '
                || to_char(q.next_price, 'FM999999990.00') || ' each.' end,
      -- What they last paid, and the jump if there is one.
      case when j.pct is not null and j.pct > nl.price_jump_pct()
           then 'They last paid ' || to_char(j.last_price, 'FM999999990.00') || ', so this is '
                || round(j.pct * 100) || '% more. Say why before they ask.'
           when j.last_price is not null
           then 'They last paid ' || to_char(j.last_price, 'FM999999990.00') || ', so this is in line.'
           else 'This account has not bought this part before, so there is no number to compare with.'
      end,
      -- The sheet in their hand.
      case when hd.sheet_id is not null and not hd.is_current and hd.sheet_price is not null
           then 'They are holding ' || hd.sheet_name || ', which shows '
                || to_char(hd.sheet_price, 'FM999999990.00')
                || ' for this part. Quote the current sheet and say the older one has been replaced.'
      end,
      -- How long the number is good for.
      case when ni.pct is not null
           then 'The announced increase of ' || round(ni.pct * 100, 1) || '% starts '
                || ni.effective_from || ', so this number holds until then.' end,
      -- The extras.
      case when sc.pct is not null
           then 'A surcharge of ' || round(sc.pct * 100, 1)
                || '% is live and is billed as its own line, not inside this price.' end,
      -- What they are allowed to order, which is not the same question as
      -- what it costs or when it ships.
      case when al.quantity is not null
           then 'This part is on allocation: up to ' || al.quantity || ' per order'
                || case when al.effective_to is not null then ' until ' || al.effective_to else '' end
                || '. ' || al.reason || '.' end,
      case when pk.quantity is not null
           then 'It ships in cartons of ' || pk.quantity
                || ', so an order rounds up to the next full carton.' end,
      -- When they can have it, and where that figure comes from. A date a
      -- buyer is meant to plan around has to say what it rests on.
      case
        when not ld.can_promise
          then 'Do not give a date on this part yet: ' || ld.basis_detail
               || '. Say we will confirm one.'
        when ld.slipped
          then 'Lead time has moved out to ' || ld.days || ' days: ' || ld.reason || '.'
        when ld.basis = 'observed'
          then 'Lead time is ' || ld.days || ' days, from what this vendor has actually done on '
               || ld.receipts || ' orders of this part.'
        when ld.basis = 'quoted'
          then 'Lead time is ' || ld.days || ' days, which is what the vendor quotes. We have too'
               || ' little history on this part to do better than their word.'
        when ld.basis = 'vendor default'
          then 'Lead time is ' || ld.days || ' days, the vendor default for every part they'
               || ' supply, not a figure for this part.'
        else 'Lead time is ' || ld.days || ' days, from the item card.'
      end,
      -- Whether it pays.
      case when q.below_floor
           then 'This price is under the ' || round(nl.min_margin() * 100)
                || '% margin floor, so it needs a person to agree it.' end
    ], null) as rows
    from q
    cross join lead_time ld
    left join jump j on true
    left join holding hd on true
    left join next_increase ni on true
    left join surcharges sc on true
    left join allocation al on true
    left join pack pk on true
  )
  select jsonb_build_object(
    'customer_no', p_customer_no,
    'customer_name', (select name from cust),
    'price_group', (select price_group from cust),
    'item_no', q.item_no,
    'description', (select description from item),
    'family', (select family from item),
    'quantity', q.quantity,
    'on_date', q.on_date,
    'unit_price', q.unit_price,
    'extended', q.extended,
    'quote', jsonb_build_object(
      'rule', q.rule,
      'detail', q.detail,
      'base_price', q.price,
      'list_price', q.list_price,
      'tier_discount', q.discount,
      'tier_price', round(q.list_price * (1 - q.discount), 2),
      'break_quantity', q.break_quantity,
      'break_price', q.break_price,
      'break_note', nullif(q.break_note, ''),
      'break_owner', q.break_owner,
      'next_quantity', q.next_quantity,
      'next_price', q.next_price,
      'ladder', coalesce((select rungs from ladder), '[]'::jsonb)),
    'sheet', case when q.sheet_id is not null then jsonb_build_object(
      'id', q.sheet_id, 'code', q.sheet_code, 'name', q.sheet_name,
      'sheet_price', q.sheet_price) end,
    'customer_sheet', (
      select jsonb_build_object(
        'id', hd.sheet_id, 'code', hd.sheet_code, 'name', hd.sheet_name,
        'sent_on', hd.sent_on, 'sent_how', hd.sent_how, 'days_old', hd.days_old,
        'stale', hd.stale, 'is_current', hd.is_current,
        'generations_behind', hd.generations_behind,
        'their_price', hd.sheet_price,
        'difference', case when hd.sheet_price is not null
                           then round(q.unit_price - hd.sheet_price, 2) end,
        'difference_pct', case when hd.sheet_price > 0
                               then round((q.unit_price - hd.sheet_price) / hd.sheet_price, 4) end)
      from holding hd),
    'agreement', case when q.agreement_net is not null then jsonb_build_object(
      'net_price', q.agreement_net, 'valid_from', q.agreement_from, 'valid_to', q.agreement_to,
      'break_policy', q.break_policy) end,
    'history', (
      select jsonb_build_object(
        'times_bought', h.times_bought,
        'units', h.units,
        'first_bought', h.first_bought,
        'last_bought', h.last_bought,
        'last_price', h.last_price,
        'last_quantity', h.last_quantity,
        'last_invoice_no', h.last_invoice_no,
        'avg_price_12m', h.avg_price_12m,
        'high_price', h.high_price,
        'low_price', h.low_price,
        'days_since', (q.on_date - h.last_bought)::int,
        'above_last_paid_pct', (select pct from jump),
        'above_last_paid', coalesce((select pct from jump) > nl.price_jump_pct(), false))
      from hist h),
    'never_bought', not exists (select 1 from hist),
    'cost', jsonb_build_object(
      'unit_cost', q.unit_cost,
      'floor_price', q.floor_price,
      'min_margin', nl.min_margin(),
      'margin_pct', q.margin_pct,
      'below_floor', q.below_floor,
      -- What the part has actually cost delivered, and the margin at that
      -- figure rather than at the goods cost. Null for a part we have never
      -- received, which is most made parts. The flagged margin stays the one
      -- the rest of the app uses; this sits beside it so nobody has to guess
      -- how flattering it is.
      'landed_unit_cost', (select lc.landed_unit_cost from landed lc),
      'landed_uplift_pct', (select lc.uplift_pct from landed lc),
      'landed_margin_pct', (select case when q.unit_price > 0
                                        then round((q.unit_price - lc.landed_unit_cost) / q.unit_price, 4) end
                            from landed lc)),
    'lead_time', (
      select jsonb_build_object(
        'days', ld.days, 'card_days', ld.card_days, 'slipped', ld.slipped,
        -- Where the figure came from, in the vocabulary nl.promise_lead_days
        -- uses: observed, quoted, item card, vendor default, default, or
        -- exception when a published slip has moved it out.
        'basis', ld.basis,
        'basis_detail', ld.basis_detail,
        'can_promise', ld.can_promise,
        'vendor_no', ld.vendor_no,
        'receipts', ld.receipts,
        'median_days', ld.median_days,
        'p90_days', ld.p90_days,
        'late_share', ld.late_share,
        'reason', nullif(ld.reason, ''), 'wording', nullif(ld.wording, ''),
        'owner_id', ld.owner_id, 'since', ld.since, 'until', ld.until,
        'earliest_ship', q.on_date + ld.days)
      from lead_time ld),
    'next_increase', (
      select jsonb_build_object(
        'pct', ni.pct, 'effective_from', ni.effective_from, 'scope', ni.scope,
        'reason', ni.reason, 'wording', nullif(ni.wording, ''), 'owner_id', ni.owner_id,
        'price_after', round(q.unit_price * (1 + ni.pct), 2))
      from next_increase ni),
    'allocation', (
      select jsonb_build_object('quantity', al.quantity, 'until', al.effective_to,
                                'reason', al.reason, 'owner_id', al.owner_id)
      from allocation al),
    'pack_size', (select quantity from pack),
    'surcharges', coalesce((select rows from surcharges), '[]'::jsonb),
    'surcharge_pct', (select pct from surcharges),
    'surcharge_amount', case when (select pct from surcharges) is not null
                             then round(q.extended * (select pct from surcharges), 2) end,
    'exceptions', (select rows from ex),
    'talking_points', to_jsonb(coalesce((select rows from points), array[]::text[])))
  from q
$$;


-- ---------------------------------------------------------------------------
-- Everything under one customer's roof
-- ---------------------------------------------------------------------------

-- Every part this account has ever bought, with what they spent on it, when
-- they last did, what they paid, whether they are still buying it, and what
-- state the part is in today.
--
-- This is the answer to a question about a part the customer owns rather than
-- a part we are trying to sell: something they bought three years ago, that we
-- may no longer stock, that may have been replaced.
--
-- The history is one aggregate over one range of
-- invoice_lines_customer_item_idx: the whole account's ledger read once, not
-- once per part. It deliberately does not go through
-- nl.customer_item_prices, which would group the same rows again for every
-- part on the list, and it works the card lead time out from the columns it
-- has already joined rather than calling nl.item_lead_days() per row. On the
-- small world that took one account of 110 parts from 3,900 buffers to about
-- 700.
--
-- buying_status is about the account's habit with this one part:
--   active   bought inside the last 180 days
--   slowing  bought between 180 and 365 days ago
--   quiet    not bought for over a year
--
-- part_status is about the part itself, in the order that matters to a caller:
--   discontinued  we have stopped selling it, and there is a replacement
--   available     there is free stock
--   on order      none on the shelf, but supply is on the way
--   short         none on the shelf and nothing on the way
create function nl.customer_parts(p_customer_no text)
returns table (
  customer_no      text,
  item_no          text,
  description      text,
  family           text,
  product_group    text,
  times_bought     int,
  units            int,
  revenue          numeric,
  units_12m        int,
  revenue_12m      numeric,
  times_12m        int,
  first_bought     date,
  last_bought      date,
  days_since       int,
  last_price       numeric,
  last_quantity    int,
  avg_price_12m    numeric,
  high_price       numeric,
  low_price        numeric,
  today_price      numeric,
  above_last_paid  boolean,
  buying_status    text,
  part_status      text,
  on_hand          int,
  on_order         int,
  lead_days        int,
  lead_slipped     boolean,
  /** Which source the lead time came from: see nl.promise_lead_days(). */
  lead_basis       text,
  can_promise      boolean,
  source_vendor_no text,
  blocked          boolean,
  discontinued_on  date,
  replacement_item_no text,
  replacement_description text
)
language sql stable
set search_path = ''
as $$
  -- Both of these are materialized on purpose. Postgres would otherwise
  -- inline a CTE used once, and then nl.today() and the sheet lookup would
  -- run again for every part on the list.
  with params as materialized (
    select nl.today() as today
  ),
  -- The account, its tier and the sheet in force for it: one row, read once.
  who as materialized (
    select c.customer_no, c.price_group, pg.discount,
           (select ps.id
            from nl.price_sheets ps, params p
            where ps.price_group = c.price_group
              and ps.effective_from <= p.today
              and (ps.effective_to is null or ps.effective_to >= p.today)
            order by ps.effective_from desc
            limit 1) as sheet_id
    from nl.customers c
    left join nl.price_groups pg on pg.code = c.price_group
    where c.customer_no = p_customer_no
  ),
  -- The live lead time slips and discontinuations, all of them, once. The
  -- table holds a few dozen rows, so pulling them into a CTE turns two index
  -- lookups per part into a scan of one page.
  live_ex as (
    select e.kind, e.scope, e.item_no, e.family, e.product_group, e.days,
           e.effective_from, e.replacement_item_no
    from nl.trade_exceptions e, params p
    where e.kind in ('lead time', 'discontinued')
      and e.effective_from <= p.today
      and (e.effective_to is null or e.effective_to >= p.today)
  ),
  -- Open supply per part, one pass over both tables. They hold open documents
  -- rather than history, a few thousand rows at full scale, so grouping them
  -- once beats two correlated lookups per part: the planner inlined the
  -- lateral that used to do that and re-ran it for every part on the list.
  supply as (
    select s.item_no, sum(s.quantity)::int as on_order
    from (
      select pl.item_no, pl.quantity from nl.open_purchase_lines pl
      union all
      select po.item_no, po.quantity from nl.open_production_orders po
    ) s
    group by s.item_no
  ),
  -- Everything they have bought, in one pass over their own lines.
  hist as (
    select
      il.item_no,
      count(*)::int                 as times_bought,
      sum(il.quantity)::int         as units,
      sum(il.amount)                as revenue,
      min(il.posted_on)             as first_bought,
      max(il.posted_on)             as last_bought,
      (array_agg(il.unit_price order by il.posted_on desc, il.invoice_no desc, il.line_no desc))[1]
                                    as last_price,
      (array_agg(il.quantity order by il.posted_on desc, il.invoice_no desc, il.line_no desc))[1]
                                    as last_quantity,
      max(il.unit_price)            as high_price,
      min(il.unit_price)            as low_price,
      coalesce(sum(il.quantity) filter (where il.posted_on > p.today - 365), 0)::int as units_12m,
      coalesce(sum(il.amount) filter (where il.posted_on > p.today - 365), 0)        as revenue_12m,
      count(*) filter (where il.posted_on > p.today - 365)::int                      as times_12m,
      case when sum(il.quantity) filter (where il.posted_on > p.today - 365) > 0
           then round(sum(il.quantity * il.unit_price) filter (where il.posted_on > p.today - 365)
                      / sum(il.quantity) filter (where il.posted_on > p.today - 365), 2)
      end as avg_price_12m
    from nl.invoice_lines il, params p
    where il.customer_no = p_customer_no
      and il.quantity > 0
    group by il.item_no
  )
  select
    p_customer_no,
    h.item_no,
    i.description,
    i.family,
    i.product_group,
    h.times_bought,
    h.units,
    h.revenue,
    h.units_12m,
    h.revenue_12m,
    h.times_12m,
    h.first_bought,
    h.last_bought,
    (p.today - h.last_bought)::int,
    h.last_price,
    h.last_quantity,
    h.avg_price_12m,
    h.high_price,
    h.low_price,
    today.price,
    -- The same flag nl.customer_item_price_context carries, at quantity one.
    coalesce(h.last_price > 0 and (today.price - h.last_price) / h.last_price > nl.price_jump_pct(),
             false),
    case
      when h.last_bought > p.today - 180 then 'active'
      when h.last_bought > p.today - 365 then 'slowing'
      else 'quiet'
    end,
    case
      when disc.effective_from is not null then 'discontinued'
      when coalesce(st.on_hand, 0) > 0 then 'available'
      when coalesce(su.on_order, 0) > 0 then 'on order'
      else 'short'
    end,
    coalesce(st.on_hand, 0),
    coalesce(su.on_order, 0),
    greatest(coalesce(slip.days, pl.lead_days), pl.lead_days),
    coalesce(slip.days > pl.lead_days, false),
    case when slip.days > pl.lead_days then 'exception' else pl.basis end,
    pl.can_promise,
    pl.vendor_no,
    i.blocked,
    disc.effective_from,
    disc.replacement_item_no,
    rep.description
  from hist h
  cross join params p
  cross join who w
  join nl.items i on i.item_no = h.item_no
  left join nl.stock st on st.item_no = h.item_no
  -- The page price on the sheet in force, else their tier price. A primary
  -- key lookup per part on a sheet id that was worked out once.
  left join nl.price_sheet_lines psl
    on psl.sheet_id = w.sheet_id and psl.item_no = h.item_no
  cross join lateral (
    select coalesce(psl.sheet_price,
                    round(i.list_price * (1 - coalesce(w.discount, 0)), 2)) as price
  ) today
  -- The lead time, from the one rule that decides which source it comes
  -- from. nl.lead_time_for() is not called here, only the rule underneath it:
  -- this list applies the published slip itself, off the live_ex CTE, rather
  -- than paying for a second non-inlinable call and a second index lookup per
  -- part. A test holds the two to the same number for every part, the way
  -- 0018 holds nl.freight_by_month to nl.freight_for().
  cross join lateral nl.promise_lead_days(h.item_no) pl
  -- The longest live slip that reaches this part, so a family wide vendor
  -- problem is not hidden by a shorter item level one.
  left join lateral (
    select e.days
    from live_ex e
    where e.kind = 'lead time'
      and (e.item_no = h.item_no or e.family = i.family or e.product_group = i.product_group
           or e.scope = 'catalog')
    order by e.days desc
    limit 1
  ) slip on true
  left join supply su on su.item_no = h.item_no
  -- A live discontinuation, with the part that replaces it.
  left join lateral (
    select e.effective_from, e.replacement_item_no
    from live_ex e
    where e.kind = 'discontinued'
      and e.item_no = h.item_no
    order by e.effective_from desc
    limit 1
  ) disc on true
  left join nl.items rep on rep.item_no = disc.replacement_item_no
$$;


-- ---------------------------------------------------------------------------
-- One call that answers a customer
-- ---------------------------------------------------------------------------

-- Price, history, exceptions, lead time and availability, in one answer.
--
-- nl.explain_price() says what the number is and why. This adds the other
-- half of every real question: when can I have it. The desk agent calls this
-- once inside a reply, so it must not need a second query for anything a
-- buyer would ask in the same breath.
--
--   price          from nl.explain_price(): the rule, the ladder, the sheet
--   history        what this account last paid, and how today compares
--   ladder         the rung below and the rung above the quantity asked for
--   exceptions     everything published that reaches this account and part
--   availability   free stock now, the earliest date the whole quantity can
--                  ship, and which purchase or production order decides it
--   lead_time      days and whether it slipped, with the reason
--   replacement    the part that supersedes this one, if it is discontinued
--   reply          one or two sentences a person can paste into an email
--
-- Availability comes from nl.item_truth() when the manufacturing model is
-- installed, because a rolled lead time down a real bill of materials beats
-- an item card. It is feature detected rather than depended on, so this
-- function works on a database that has migration 0016 and nothing newer.
--
-- Null for a part that is not in the catalog.
create function nl.answer_for(
  p_customer_no text,
  p_item_no     text,
  p_quantity    int,
  p_needed_by   date
) returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_today    date := nl.today();
  v_quantity int  := greatest(coalesce(p_quantity, 1), 1);
  v_needed   date := coalesce(p_needed_by, nl.today());
  v_price    jsonb;
  v_atp      jsonb;
  v_truth    jsonb;
  v_ship     date;
  v_basis    text;
  v_reply    text[] := '{}';
  v_rep      record;
  v_lead     jsonb;
  v_can_promise boolean;
begin
  v_price := nl.explain_price(p_customer_no, p_item_no, v_quantity, v_today);
  if v_price is null then
    return null;          -- not a part we sell
  end if;

  -- What the supply side says. Available to promise (migration 0016) nets the
  -- quantity against earlier promises and the open orders, which is the honest
  -- answer to "can I have twelve by Friday".
  v_atp := nl.available_to_promise(p_item_no, v_quantity, v_needed);

  -- The manufacturing model, if this database has it. Feature detected so
  -- the same function runs on a database without it.
  if to_regprocedure('nl.item_truth(text)') is not null then
    execute 'select nl.item_truth($1)' into v_truth using p_item_no;
  end if;

  v_lead := v_price -> 'lead_time';

  -- The earliest ship date, and where it came from. The rolled model wins
  -- when it is there, because it knows the parts below this one.
  --
  -- The basis vocabulary is the one available to promise already uses
  -- ('stock', 'supply', 'lead_time'), with the new sources added rather than
  -- swapped in: where the date rests on a lead time, say which lead time.
  -- 'rolled' is the manufacturing model's own answer.
  if v_truth ? 'earliest_ship' and (v_truth -> 'earliest_ship') <> 'null'::jsonb then
    v_ship  := (v_truth ->> 'earliest_ship')::date;
    v_basis := 'rolled';
  else
    v_ship  := (v_atp ->> 'earliest_date')::date;
    v_basis := v_atp ->> 'earliest_basis';
    if v_basis = 'lead_time' then
      v_basis := v_lead ->> 'basis';
    end if;
  end if;

  -- A part on allocation or discontinued at its source gets no date at all.
  -- A promise we will miss is worse than saying we will come back with one.
  v_can_promise := coalesce((v_lead ->> 'can_promise')::boolean, true);

  -- The replacement part, when this one has been discontinued.
  select e.replacement_item_no, i.description, e.effective_from, e.reason, e.owner_id
    into v_rep
  from nl.trade_exceptions e
  join nl.items i on i.item_no = e.replacement_item_no
  where e.kind = 'discontinued'
    and e.item_no = p_item_no
    and e.effective_from <= v_today
    and (e.effective_to is null or e.effective_to >= v_today)
  order by e.effective_from desc
  limit 1;

  -- The sentences. Price first, because that is what was asked; then when it
  -- can ship; then the one thing that would make the number look wrong.
  v_reply := v_reply || format('%s at %s each, %s.',
    v_price ->> 'item_no',
    to_char((v_price ->> 'unit_price')::numeric, 'FM999999990.00'),
    v_price -> 'quote' ->> 'detail');

  if not v_can_promise then
    v_reply := v_reply || format(
      'We cannot put a date on this yet: %s. We will confirm one before you place the order.',
      v_lead ->> 'basis_detail');
  elsif v_ship <= v_needed then
    v_reply := v_reply || format('We can ship all %s by %s.', v_quantity, v_ship);
  else
    v_reply := v_reply || format('We can ship %s now and all %s by %s.',
      coalesce((v_atp ->> 'free_now')::int, 0), v_quantity, v_ship);
  end if;

  if coalesce((v_price -> 'history' ->> 'above_last_paid')::boolean, false) then
    v_reply := v_reply || format('That is %s%% above the %s they last paid on %s.',
      round(((v_price -> 'history' ->> 'above_last_paid_pct')::numeric) * 100),
      to_char((v_price -> 'history' ->> 'last_price')::numeric, 'FM999999990.00'),
      v_price -> 'history' ->> 'last_bought');
  end if;

  if coalesce((v_lead ->> 'slipped')::boolean, false) then
    v_reply := v_reply || format('Lead time on this part is out to %s days: %s.',
      v_lead ->> 'days', v_lead ->> 'reason');
  elsif v_lead ->> 'basis' = 'observed' then
    -- Say what the date rests on. This is the sentence that makes a promise
    -- something a buyer can plan around rather than a number off a card.
    v_reply := v_reply || format(
      'That date is what this vendor has actually done on the last %s orders of this part, not a'
      || ' figure off the item card.', v_lead ->> 'receipts');
  end if;

  if v_rep.replacement_item_no is not null then
    v_reply := v_reply || format('%s has been discontinued and is replaced by %s, %s.',
      p_item_no, v_rep.replacement_item_no, v_rep.description);
  end if;

  return jsonb_build_object(
    'customer_no', p_customer_no,
    'customer_name', v_price ->> 'customer_name',
    'item_no', p_item_no,
    'description', v_price ->> 'description',
    'quantity', v_quantity,
    'needed_by', v_needed,
    'on_date', v_today,
    'unit_price', (v_price ->> 'unit_price')::numeric,
    'extended', (v_price ->> 'extended')::numeric,
    'price', v_price -> 'quote',
    'sheet', v_price -> 'sheet',
    'customer_sheet', v_price -> 'customer_sheet',
    'agreement', v_price -> 'agreement',
    'history', v_price -> 'history',
    'never_bought', v_price -> 'never_bought',
    'cost', v_price -> 'cost',
    'lead_time', v_lead,
    'next_increase', v_price -> 'next_increase',
    'surcharges', v_price -> 'surcharges',
    'surcharge_amount', v_price -> 'surcharge_amount',
    'exceptions', v_price -> 'exceptions',
    'availability', jsonb_build_object(
      'on_hand', v_atp -> 'on_hand',
      'promised_earlier', v_atp -> 'promised_earlier',
      'free_now', v_atp -> 'free_now',
      'can_meet', v_can_promise and v_ship <= v_needed,
      'can_promise', v_can_promise,
      'earliest_ship', case when v_can_promise then v_ship end,
      'earliest_basis', case when v_can_promise then v_basis else 'not promisable' end,
      'covering', v_atp -> 'covering',
      'incoming', v_atp -> 'incoming'),
    'rolled', v_truth,
    'replacement', case when v_rep.replacement_item_no is not null then jsonb_build_object(
      'item_no', v_rep.replacement_item_no,
      'description', v_rep.description,
      'since', v_rep.effective_from,
      'reason', v_rep.reason,
      'owner_id', v_rep.owner_id) end,
    'talking_points', v_price -> 'talking_points',
    'reply', to_jsonb(v_reply));
end $$;


-- ---------------------------------------------------------------------------
-- The last unnamed number
-- ---------------------------------------------------------------------------

-- nl.sample_open_purchase_lines() (migration 0022) invented the open purchase
-- book for the seeded world, and it dated every line off
-- coalesce(item formula, vendor formula, 21). That 21 was the only lead time
-- figure left in the schema with no name, no provenance and no way to change
-- it, and it decided a date that the forecast then treated as a fact.
--
-- The whole function is repeated here because Postgres has no way to change
-- one line of it, and it is not edited otherwise: only the one coalesce
-- changes, to a call on the promise rule. If 0022 is ever revised, this copy
-- has to be revised with it.
create or replace function nl.sample_open_purchase_lines(p_day date)
returns table (
  row_no        int,
  document_no   text,
  line_no       int,
  vendor_no     text,
  item_no       text,
  description   text,
  due_date      date,
  promised_date date,
  quantity      int,
  location_code text
)
language sql stable
set search_path = ''
as $$
with plan_all as (
  select * from nl.sample_supply_plan()
),
bought as (
  select * from plan_all p
  where p.covered and not p.made and p.vendor_no is not null
),
-- One line per requirement, due around the day it is needed.
against_demand as (
  select b.item_no, b.description, b.vendor_no, b.today, b.lead_days,
         'po|' || b.item_no || '|' || b.seq as key,
         false as received,
         b.quantity,
         case
           -- A part needed in the next few days whose vendor is already late.
           when b.need_by <= b.today + 3
                and nl.sample_draw('po.over.soon|' || b.item_no || '|' || b.seq) < 0.75::double precision
             then b.today - (1 + floor(nl.sample_draw('po.over|' || b.item_no || '|' || b.seq) * 20)::int)
           -- There in time.
           when nl.sample_draw('po.when|' || b.item_no || '|' || b.seq) < 0.55::double precision
             then greatest(b.need_by - floor(nl.sample_draw('po.early|' || b.item_no || '|' || b.seq) * 11)::int,
                           b.today)
           -- Lands after it is needed: this is what makes a customer line late.
           when nl.sample_draw('po.when|' || b.item_no || '|' || b.seq) < 0.95::double precision
             then b.need_by + (1 + floor(nl.sample_draw('po.late|' || b.item_no || '|' || b.seq) * 21)::int)
           -- Already past due, for a need further out.
           else b.today - (1 + floor(nl.sample_draw('po.over|' || b.item_no || '|' || b.seq) * 20)::int)
         end as due_now
  from bought b
),
-- Stocked parts nobody is waiting for, bought back up to their reorder point
-- now and then. Parts with a requirement are left out: their cover is decided
-- above, and a part deliberately left uncovered must stay uncovered.
replenishment as (
  select i.item_no, i.description, i.vendor_no, c.today,
         -- Was: coalesce(item formula, vendor formula, 21). The 21 was a bare
         -- number with no name and no provenance, and it decided a date. This
         -- now asks the promise rule, which answers from what the vendor has
         -- actually done and falls back through the same formulas to a named
         -- default for the replenishment method.
         nl.item_lead_days(i.item_no) as lead_days,
         'po.rep|' || i.item_no as key,
         false as received,
         greatest(5, i.reorder_point - s.on_hand)::int as quantity,
         c.today + (7 + floor(nl.sample_draw('po.rep.due|' || i.item_no) * 45)::int) as due_now
  from nl.items i
  join nl.stock s on s.item_no = i.item_no
  join nl.vendors v on v.vendor_no = i.vendor_no
  cross join (select nl.today() as today) c
  where i.replenishment = 'Purchase'
    and not i.blocked
    and i.reorder_point is not null
    and s.on_hand < i.reorder_point
    and nl.sample_draw('po.rep|' || i.item_no) < 0.25::double precision
    and not exists (select 1 from plan_all p where p.item_no = i.item_no)
),
-- For one covered part in eight, a line that landed today: it is in
-- yesterday's file and gone from today's, which is what day over day shows.
landed as (
  select b.item_no, b.description, b.vendor_no, b.today, b.lead_days,
         'po.recv|' || b.item_no as key,
         true as received,
         greatest(1, b.quantity / 2)::int as quantity,
         b.today - floor(nl.sample_draw('po.got|' || b.item_no) * 6)::int as due_now
  from bought b
  where b.seq = 1 and nl.sample_draw('po.recv|' || b.item_no) < 0.12::double precision
),
lines as (
  select * from against_demand
  union all select * from replenishment
  union all select * from landed
),
dated as (
  select l.*,
         -- A vendor who moves a date out only does it once, a day or two ago.
         case
           when not l.received and nl.sample_draw(l.key || '|slip') < 0.12::double precision
           then 3 + floor(nl.sample_draw(l.key || '|slip.days') * 12)::int
           else 0
         end as slipped,
         l.today - floor(nl.sample_draw(l.key || '|slip.on') * 3)::int as slipped_on
  from lines l
),
ordered as (
  select d.*,
         -- What the vendor promised first, and when we placed the order: a
         -- lead time before the promised date, or, for an order promised far
         -- out, somewhere in the last six weeks. One order in twenty was
         -- placed today, which is what makes it "new" in today's file.
         d.due_now - d.slipped as promised,
         case
           when not d.received and nl.sample_draw(d.key || '|new') < 0.05::double precision then d.today
           else least(d.due_now - d.slipped - d.lead_days,
                      d.today - 1 - floor(nl.sample_draw(d.key || '|lag') * 45)::int)
         end as ordered_on,
         case when d.received then d.today else null::date end as received_on
  from dated d
),
-- One purchase order per vendor per week of first promise; the numbering
-- covers every line in the world, so a document keeps its number whichever
-- day is asked about.
numbered as (
  select o.*,
         dense_rank() over (order by o.vendor_no, to_char(o.promised, 'IYYY-IW')) as po_seq,
         row_number() over (partition by o.vendor_no, to_char(o.promised, 'IYYY-IW')
                            order by o.item_no, o.key) as po_line
  from ordered o
),
open_lines as (
  select 'PO-' || lpad((104000 + n.po_seq)::text, 6, '0') as document_no,
         (n.po_line * 10000)::int as line_no,
         n.vendor_no, n.item_no, n.description,
         -- Before the day the vendor moved it, the file showed the old date.
         case when n.slipped > 0 and p_day < n.slipped_on then n.promised else n.due_now end as due_date,
         n.promised as promised_date,
         n.quantity
  from numbered n
  where n.ordered_on <= p_day
    and (n.received_on is null or n.received_on > p_day)
)
select
  (row_number() over (order by l.document_no collate "C", l.line_no))::int as row_no,
  l.document_no, l.line_no, l.vendor_no, l.item_no, l.description,
  l.due_date, l.promised_date, l.quantity, 'MAIN'::text as location_code
from open_lines l
order by l.document_no collate "C", l.line_no
$$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.price_sheets enable row level security;
alter table nl.price_sheet_lines enable row level security;
alter table nl.price_sheet_sends enable row level security;
alter table nl.price_breaks enable row level security;
alter table nl.trade_exceptions enable row level security;
alter table nl.vendor_items enable row level security;
alter table nl.vendor_item_breaks enable row level security;
alter table nl.purchase_receipts enable row level security;

-- All five are about published prices, parts and policy, not about people, so
-- the read only role the assistant uses may read them. An exception records
-- its owner as a user id and never as a name, so nothing here has to be held
-- back. Nobody writes any of them from the app: the seed and the imports fill
-- them, and there is no insert, update or delete policy at all.
create policy price_sheets_read on nl.price_sheets
  for select to nl_app, nl_readonly using (true);
create policy price_sheet_lines_read on nl.price_sheet_lines
  for select to nl_app, nl_readonly using (true);
create policy price_sheet_sends_read on nl.price_sheet_sends
  for select to nl_app, nl_readonly using (true);
create policy price_breaks_read on nl.price_breaks
  for select to nl_app, nl_readonly using (true);
create policy trade_exceptions_read on nl.trade_exceptions
  for select to nl_app, nl_readonly using (true);

-- The vendor and part tables are about parts, prices and dates. A receipt
-- names a document and a date, never a person, so both roles may read them.
create policy vendor_items_read on nl.vendor_items
  for select to nl_app, nl_readonly using (true);
create policy vendor_item_breaks_read on nl.vendor_item_breaks
  for select to nl_app, nl_readonly using (true);
create policy purchase_receipts_read on nl.purchase_receipts
  for select to nl_app, nl_readonly using (true);

grant select on nl.price_sheets, nl.price_sheet_lines, nl.price_sheet_sends,
  nl.price_breaks, nl.trade_exceptions, nl.vendor_items, nl.vendor_item_breaks,
  nl.purchase_receipts to nl_app, nl_readonly;

grant select on nl.account_price_sheet, nl.customer_item_prices,
  nl.customer_item_price_context, nl.trade_exceptions_live,
  nl.vendor_item_lead_times, nl.vendor_item_commitments, nl.vendor_part_lead_times,
  nl.landed_cost
to nl_app, nl_readonly;

grant execute on function
  nl.price_jump_pct(),
  nl.price_sheet_stale_days(),
  nl.promise_min_receipts(),
  nl.promise_percentile(),
  nl.observed_promise_days(numeric, numeric),
  nl.promise_lead_days(text),
  nl.trade_exception_status(date, date, date),
  nl.exceptions_for(text, text, date),
  nl.lead_time_for(text, date),
  nl.price_quote_for(text, text, int, date),
  nl.explain_price(text, text, int, date),
  nl.customer_parts(text),
  nl.answer_for(text, text, int, date)
to nl_app, nl_readonly;
