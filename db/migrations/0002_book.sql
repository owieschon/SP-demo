-- 0002 The book: what the ERP knows. Customers, the parts catalog, stock,
-- and the invoice ledger.
--
-- The ERP can only produce file exports, so these tables are shaped like its
-- exports and keyed on its natural keys (customer number, item number,
-- invoice number). The app reads them; only imports and the seed write them.
-- The one exception is who owns a customer, which people change in the app.

-- ---------------------------------------------------------------------------
-- Sales agencies and price groups
-- ---------------------------------------------------------------------------

create table nl.agencies (
  id        int primary key,
  code      text not null unique,   -- the salesperson code on the customer master
  name      text not null,
  territory text not null default ''
);

comment on table nl.agencies is 'Independent sales agencies that represent Northline. A customer with no agency is a house account.';

create table nl.price_groups (
  code     text primary key,        -- ERP code, kept verbatim (it is cut at 10 characters: PERFORMANC)
  label    text not null,
  discount numeric(5, 4) not null check (discount >= 0 and discount < 1)
);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------

create table nl.customers (
  customer_no       text primary key,
  name              text not null,
  -- The account this one is billed to: a branch points at its head office.
  bill_to_no        text references nl.customers (customer_no),
  city              text not null default '',
  state             text not null default '',
  country           text not null default 'US',
  -- Used to match an emailed request to its account.
  email_domain      text,
  price_group       text not null references nl.price_groups (code),
  ships_own_carrier boolean not null default false,
  blocked           boolean not null default false,
  closed            boolean not null default false,
  owner_id          int references nl.users (id),
  agency_id         int references nl.agencies (id),
  customer_since    date not null,
  updated_at        timestamptz not null default nl.now_ms(),
  constraint customers_not_own_bill_to check (bill_to_no <> customer_no)
);

create index customers_bill_to_idx on nl.customers (bill_to_no);
create index customers_owner_idx on nl.customers (owner_id);
create index customers_agency_idx on nl.customers (agency_id);
create index customers_price_group_idx on nl.customers (price_group);
create index customers_email_domain_idx on nl.customers (lower(email_domain));

create trigger customers_touch before update on nl.customers
  for each row execute function nl.touch_updated_at();

create table nl.contacts (
  id          bigint generated always as identity primary key,
  customer_no text not null references nl.customers (customer_no) on delete cascade,
  full_name   text not null,
  title       text not null default '',
  email       text,
  phone       text,
  is_primary  boolean not null default false
);

create index contacts_customer_idx on nl.contacts (customer_no);
create index contacts_email_idx on nl.contacts (lower(email));

-- ---------------------------------------------------------------------------
-- The catalog
-- ---------------------------------------------------------------------------

create table nl.vendors (
  vendor_no text primary key,
  name      text not null,
  city      text not null default '',
  state     text not null default '',
  lead_time text not null default ''     -- ERP date formula, verbatim: 3W
);

create table nl.items (
  item_no       text primary key,
  description   text not null,
  category      text not null,           -- ERP item category: ELBOWS, STACKS, PIPE ...
  family        text not null,           -- elbow, stack, pipe, muffler, clamp, flex, shield, bracket, kit, custom, proprietary
  product_group text not null,
  unit_cost     numeric(12, 2) not null check (unit_cost >= 0),
  list_price    numeric(12, 2) not null check (list_price >= 0),
  replenishment text not null,           -- ERP value, verbatim: Prod. Order, Purchase, Assembly
  work_center   text not null default '',
  vendor_no     text references nl.vendors (vendor_no),
  lead_time     text not null default '',
  made_to_order boolean not null default false,
  proprietary   boolean not null default false,
  blocked       boolean not null default false
);

create index items_family_idx on nl.items (family);
create index items_vendor_idx on nl.items (vendor_no);

-- What the item master says is on the shelf.
create table nl.stock (
  item_no             text primary key references nl.items (item_no) on delete cascade,
  on_hand             int not null default 0,
  on_production_order int not null default 0,
  on_purchase_order   int not null default 0,
  shelf               text not null default '',
  bin                 text not null default '',
  as_of               date not null
);

-- ---------------------------------------------------------------------------
-- The invoice ledger
-- ---------------------------------------------------------------------------

create table nl.invoices (
  invoice_no  text primary key,
  doc_type    text not null check (doc_type in ('invoice', 'credit_memo')),
  customer_no text not null references nl.customers (customer_no),   -- sell-to
  bill_to_no  text not null references nl.customers (customer_no),
  posted_on   date not null,
  order_no    text,
  customer_po text,
  freight     numeric(12, 2) not null default 0,
  -- A credit memo names the invoice it credits.
  applies_to  text references nl.invoices (invoice_no),
  -- Lines repeat the header's customer and date (below); this key lets a
  -- foreign key hold them to the header.
  unique (invoice_no, customer_no, posted_on)
);

create index invoices_customer_posted_idx on nl.invoices (customer_no, posted_on);
create index invoices_bill_to_idx on nl.invoices (bill_to_no);
create index invoices_applies_to_idx on nl.invoices (applies_to);

-- One row per invoiced part. The export repeats the header's sell-to
-- customer and posting date on every line, and so does this table: the
-- queries that measure delivery filter lines by exactly those two columns.
-- The composite foreign key makes it impossible for a line to disagree with
-- its header.
create table nl.invoice_lines (
  invoice_no  text not null,
  line_no     int not null,
  customer_no text not null,
  posted_on   date not null,
  item_no     text not null references nl.items (item_no),
  quantity    int not null,              -- negative on a credit memo
  unit_price  numeric(12, 2) not null,
  amount      numeric(12, 2) not null,   -- negative on a credit memo
  unit_cost   numeric(12, 2) not null,
  primary key (invoice_no, line_no),
  foreign key (invoice_no, customer_no, posted_on)
    references nl.invoices (invoice_no, customer_no, posted_on) on delete cascade
);

-- The index that makes delivery measurement fast is added on its own in
-- 0004, so docs/sql.md can show the plan before and after it.
create index invoice_lines_item_idx on nl.invoice_lines (item_no);
create index invoice_lines_header_idx on nl.invoice_lines (invoice_no, customer_no, posted_on);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

alter table nl.agencies enable row level security;
alter table nl.price_groups enable row level security;
alter table nl.customers enable row level security;
alter table nl.contacts enable row level security;
alter table nl.vendors enable row level security;
alter table nl.items enable row level security;
alter table nl.stock enable row level security;
alter table nl.invoices enable row level security;
alter table nl.invoice_lines enable row level security;

-- The whole team sees the whole book.
create policy agencies_read on nl.agencies for select to nl_app, nl_readonly using (true);
create policy price_groups_read on nl.price_groups for select to nl_app, nl_readonly using (true);
create policy customers_read on nl.customers for select to nl_app, nl_readonly using (true);
create policy contacts_read on nl.contacts for select to nl_app using (true);
create policy vendors_read on nl.vendors for select to nl_app, nl_readonly using (true);
create policy items_read on nl.items for select to nl_app, nl_readonly using (true);
create policy stock_read on nl.stock for select to nl_app, nl_readonly using (true);
create policy invoices_read on nl.invoices for select to nl_app, nl_readonly using (true);
create policy invoice_lines_read on nl.invoice_lines for select to nl_app, nl_readonly using (true);

-- Only a customer's owner or an admin may change the customer (in practice:
-- hand it to another owner). Unowned customers can be claimed by an admin.
-- The new owner must be an active user, or nobody.
create policy customers_owner_update on nl.customers for update to nl_app
  using (owner_id = (select nl.current_user_id()) or (select nl.is_admin()))
  with check (
    owner_id is null
    or exists (select 1 from nl.users u where u.id = owner_id and u.active));

grant select on nl.agencies, nl.price_groups, nl.customers, nl.contacts, nl.vendors,
  nl.items, nl.stock, nl.invoices, nl.invoice_lines to nl_app;
grant update (owner_id) on nl.customers to nl_app;

-- Contacts are people, so the read-only role does not get them.
grant select on nl.agencies, nl.price_groups, nl.customers, nl.vendors,
  nl.items, nl.stock, nl.invoices, nl.invoice_lines to nl_readonly;
