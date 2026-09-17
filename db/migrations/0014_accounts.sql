-- 0014 Accounts: the people at each customer, what the team did with them,
-- and one row per account for the accounts list.
--
-- What this adds:
--   * contacts get a mobile number, notes, who added them, a row version, and
--     left_on (the day they were no longer there; null while they are);
--   * activities can name the contact they were with;
--   * nl.account_list, one row per customer with its numbers;
--   * six write functions: add and change a contact, name a commitment's
--     buyer, log a call or note, add and complete a next step.
--
-- Who may do what:
--   * anyone signed in may add a contact, log an activity or add a next step,
--     always in their own name (these only add information);
--   * a contact may be changed by the account's owner, an admin, whoever added
--     the contact, or anyone when the account has no owner;
--   * a commitment's buyer is the commitment owner's call (or an admin's);
--   * a next step is completed by its owner, the account's owner or an admin.

-- ---------------------------------------------------------------------------
-- Contacts: more to know about a person
-- ---------------------------------------------------------------------------

alter table nl.contacts
  add column mobile     text,
  add column notes      text not null default '',
  -- The day this person was no longer at the account. Null while they are.
  -- Kept rather than deleted: old calls and commitments still name them.
  add column left_on    date,
  add column created_by int references nl.users (id),
  add column created_at timestamptz not null default now(),
  add column updated_at timestamptz not null default nl.now_ms(),
  -- Someone who left is nobody's first call any more.
  add constraint contacts_primary_is_current check (not (is_primary and left_on is not null));

create index contacts_created_by_idx on nl.contacts (created_by);

create trigger contacts_touch before update on nl.contacts
  for each row execute function nl.touch_updated_at();

-- Exactly one primary contact per account. Whoever makes someone primary,
-- the badge leaves everyone else at that account first, so the unique index
-- below always holds. SECURITY DEFINER: the person moving the badge may not
-- be allowed to edit the contact it leaves, and should not need to be.
create function nl.move_primary_contact() returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update nl.contacts
     set is_primary = false
   where customer_no = new.customer_no
     and is_primary
     and id <> new.id;
  return new;
end $$;

create trigger contacts_one_primary
  before insert or update of is_primary on nl.contacts
  for each row
  when (new.is_primary)
  execute function nl.move_primary_contact();

create unique index contacts_one_primary_idx on nl.contacts (customer_no) where is_primary;

-- ---------------------------------------------------------------------------
-- Activities: who it was with
-- ---------------------------------------------------------------------------

alter table nl.activities
  add column contact_id bigint references nl.contacts (id) on delete set null;

create index activities_contact_idx on nl.activities (contact_id);

-- ---------------------------------------------------------------------------
-- The accounts list
-- ---------------------------------------------------------------------------

-- One row per customer. Every source is aggregated once, as a set, and then
-- joined by customer number; nothing is looked up row by row.
--   revenue_ytd        this calendar year up to today
--   revenue_prior_ytd  last year up to the same day (the fair comparison)
--   revenue_last_year  all of last year
-- Revenue is the invoice subtotal (before freight), credit memos included,
-- for this account alone (not its branches).
create view nl.account_list with (security_invoker = true) as
with clock as materialized (
  -- Asked once per query (see migration 0009).
  select
    t.today,
    date_trunc('year', t.today)::date as year_start,
    (date_trunc('year', t.today) - interval '1 year')::date as last_year_start,
    (t.today - interval '1 year')::date as same_day_last_year
  from (select nl.today() as today) t
),
revenue as (
  select
    i.customer_no,
    sum(i.subtotal) filter (where i.posted_on >= k.year_start and i.posted_on <= k.today) as revenue_ytd,
    sum(i.subtotal) filter (where i.posted_on >= k.last_year_start and i.posted_on <= k.same_day_last_year)
      as revenue_prior_ytd,
    sum(i.subtotal) filter (where i.posted_on >= k.last_year_start and i.posted_on < k.year_start)
      as revenue_last_year,
    max(i.posted_on) filter (where i.doc_type = 'invoice' and i.posted_on <= k.today) as last_order_on
  from nl.invoices i
  cross join clock k
  group by i.customer_no
),
branches as (
  select bill_to_no as customer_no, count(*)::int as branch_count
  from nl.customers
  where bill_to_no is not null
  group by bill_to_no
),
open_commitments as (
  select customer_no, count(*)::int as open_commitments, sum(committed_value) as open_committed,
         sum(expected_value) as open_expected
  from nl.commitment_progress
  where not is_settled
  group by customer_no
),
steps as (
  select s.customer_no,
         count(*)::int as open_steps,
         count(*) filter (where s.due_on < k.today)::int as overdue_steps
  from nl.next_steps s
  cross join clock k
  where s.completed_at is null
  group by s.customer_no
),
people as (
  select customer_no, count(*)::int as contact_count
  from nl.contacts
  where left_on is null
  group by customer_no
),
primary_contact as (
  select distinct on (customer_no) customer_no, id, full_name, title, email, phone
  from nl.contacts
  where is_primary and left_on is null
  order by customer_no, id
)
select
  c.customer_no,
  c.name,
  c.bill_to_no,
  parent.name as parent_name,
  coalesce(b.branch_count, 0) as branch_count,
  c.city,
  c.state,
  c.country,
  c.owner_id,
  u.full_name as owner_name,
  c.agency_id,
  a.name as agency_name,
  c.price_group,
  pg.label as price_group_label,
  c.blocked,
  c.closed,
  c.customer_since,
  coalesce(r.revenue_ytd, 0) as revenue_ytd,
  coalesce(r.revenue_prior_ytd, 0) as revenue_prior_ytd,
  coalesce(r.revenue_last_year, 0) as revenue_last_year,
  r.last_order_on,
  ac.typical_gap_days,
  -- Days since the last order, whether or not the account orders often
  -- enough to have a typical gap.
  (select k.today from clock k) - r.last_order_on as days_quiet,
  ac.quiet_ratio,
  -- Gone quiet: at least twice its own usual gap, and three weeks or more.
  coalesce(ac.quiet_ratio >= 2 and ac.days_quiet >= 21, false) as gone_quiet,
  coalesce(oc.open_commitments, 0) as open_commitments,
  coalesce(oc.open_committed, 0) as open_committed,
  coalesce(oc.open_expected, 0) as open_expected,
  coalesce(s.open_steps, 0) as open_steps,
  coalesce(s.overdue_steps, 0) as overdue_steps,
  coalesce(pe.contact_count, 0) as contact_count,
  pc.id as primary_contact_id,
  pc.full_name as primary_contact_name,
  pc.title as primary_contact_title,
  pc.email as primary_contact_email,
  pc.phone as primary_contact_phone
from nl.customers c
join nl.price_groups pg on pg.code = c.price_group
left join nl.customers parent on parent.customer_no = c.bill_to_no
left join nl.users u on u.id = c.owner_id
left join nl.agencies a on a.id = c.agency_id
left join revenue r on r.customer_no = c.customer_no
left join branches b on b.customer_no = c.customer_no
left join nl.account_cadence ac on ac.customer_no = c.customer_no
left join open_commitments oc on oc.customer_no = c.customer_no
left join steps s on s.customer_no = c.customer_no
left join people pe on pe.customer_no = c.customer_no
left join primary_contact pc on pc.customer_no = c.customer_no;

comment on view nl.account_list is
  'One row per customer with revenue, rhythm, open work and the primary contact (migration 0014).';

-- ---------------------------------------------------------------------------
-- Field rules shared by the contact writes
-- ---------------------------------------------------------------------------

-- Checks a contact's fields and returns them cleaned (trimmed, blanks as
-- null). Raises NL422 with a message a person can act on.
create function nl.clean_contact(
  p_full_name text,
  p_title     text,
  p_email     text,
  p_phone     text,
  p_mobile    text,
  p_notes     text
) returns table (full_name text, title text, email text, phone text, mobile text, notes text)
language plpgsql immutable
set search_path = ''
as $$
begin
  full_name := btrim(coalesce(p_full_name, ''));
  title := btrim(coalesce(p_title, ''));
  email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  phone := nullif(btrim(coalesce(p_phone, '')), '');
  mobile := nullif(btrim(coalesce(p_mobile, '')), '');
  notes := btrim(coalesce(p_notes, ''));

  if length(full_name) < 2 or length(full_name) > 100 then
    raise exception 'A contact needs a name of 2 to 100 characters.' using errcode = 'NL422';
  end if;
  if length(title) > 80 then
    raise exception 'A title is at most 80 characters.' using errcode = 'NL422';
  end if;
  if email is not null and (length(email) > 200 or email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception '% is not an email address.', email using errcode = 'NL422';
  end if;
  -- Digits, spaces and the usual punctuation, with an optional extension.
  if phone is not null and (length(phone) > 40 or phone !~ '^\+?[0-9 ().-]{7,}( *(x|ext\.?) *[0-9]{1,6})?$') then
    raise exception '% is not a phone number.', phone using errcode = 'NL422';
  end if;
  if mobile is not null and (length(mobile) > 40 or mobile !~ '^\+?[0-9 ().-]{7,}$') then
    raise exception '% is not a mobile number.', mobile using errcode = 'NL422';
  end if;
  if length(notes) > 1000 then
    raise exception 'Notes are at most 1,000 characters.' using errcode = 'NL422';
  end if;
  return next;
end $$;

create function nl.check_via(p_via text) returns void
language plpgsql immutable
set search_path = ''
as $$
begin
  if p_via is null or p_via not in ('ui', 'assistant') then
    raise exception 'Unknown source %.', coalesce(p_via, 'empty') using errcode = 'NL422';
  end if;
end $$;

-- May the signed-in user change this contact? The account's owner, an admin,
-- whoever added the contact, or anyone when the account has no owner.
create function nl.may_change_contact(p_contact_id bigint) returns boolean
language sql stable
set search_path = ''
as $$
  select exists (
    select 1
    from nl.contacts ct
    join nl.customers cu on cu.customer_no = ct.customer_no
    where ct.id = p_contact_id
      and (cu.owner_id is null
           or cu.owner_id = nl.current_user_id()
           or ct.created_by = nl.current_user_id()
           or nl.is_admin()))
$$;

-- ---------------------------------------------------------------------------
-- Writes
-- ---------------------------------------------------------------------------

-- Add a person at an account. The first current contact at an account
-- becomes its primary; asking for primary moves the badge to the new person
-- (trigger contacts_one_primary takes it off the old one).
create function nl.add_contact(
  p_customer_no text,
  p_full_name   text,
  p_title       text,
  p_email       text,
  p_phone       text,
  p_mobile      text,
  p_is_primary  boolean,
  p_notes       text,
  p_request_id  text,
  p_via         text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_clean   record;
  v_primary boolean;
  v_contact nl.contacts;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'add_contact');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  if not exists (select 1 from nl.customers where customer_no = p_customer_no) then
    raise exception 'Customer % does not exist.', coalesce(p_customer_no, 'empty') using errcode = 'NL404';
  end if;
  select * into v_clean from nl.clean_contact(p_full_name, p_title, p_email, p_phone, p_mobile, p_notes);
  if v_clean.email is not null and exists (
    select 1 from nl.contacts
    where customer_no = p_customer_no and lower(email) = v_clean.email and left_on is null) then
    raise exception '% is already on file at this account.', v_clean.email using errcode = 'NL422';
  end if;

  v_primary := coalesce(p_is_primary, false)
    or not exists (select 1 from nl.contacts
                   where customer_no = p_customer_no and is_primary and left_on is null);
  insert into nl.contacts (customer_no, full_name, title, email, phone, mobile, notes, is_primary, created_by)
  values (p_customer_no, v_clean.full_name, v_clean.title, v_clean.email, v_clean.phone, v_clean.mobile,
          v_clean.notes, v_primary, v_actor.id)
  returning * into v_contact;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'add_contact', 'contact', v_contact.id::text, p_request_id,
          jsonb_build_object('customer_no', p_customer_no, 'full_name', v_contact.full_name,
                             'title', v_contact.title, 'is_primary', v_primary));

  v_result := jsonb_build_object(
    'contact_id', v_contact.id,
    'customer_no', p_customer_no,
    'is_primary', v_primary,
    'updated_at', v_contact.updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Change a person's details, or record that they are no longer there.
-- p_left true sets left_on to today (once); false clears it.
create function nl.update_contact(
  p_contact_id          bigint,
  p_full_name           text,
  p_title               text,
  p_email               text,
  p_phone               text,
  p_mobile              text,
  p_is_primary          boolean,
  p_left                boolean,
  p_notes               text,
  p_expected_updated_at timestamptz,
  p_request_id          text,
  p_via                 text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay  jsonb;
  v_actor   nl.users;
  v_before  nl.contacts;
  v_after   nl.contacts;
  v_clean   record;
  v_left_on date;
  v_primary boolean;
  v_result  jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'update_contact');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  select * into v_before from nl.contacts where id = p_contact_id;
  if not found then
    raise exception 'Contact % does not exist.', p_contact_id using errcode = 'NL404';
  end if;
  if not nl.may_change_contact(p_contact_id) then
    raise exception 'Only the account owner, an admin or whoever added % can change them.', v_before.full_name
      using errcode = 'NL403';
  end if;

  select * into v_clean from nl.clean_contact(p_full_name, p_title, p_email, p_phone, p_mobile, p_notes);
  if v_clean.email is not null and exists (
    select 1 from nl.contacts
    where customer_no = v_before.customer_no and lower(email) = v_clean.email
      and left_on is null and id <> p_contact_id) then
    raise exception '% is already on file for someone else at this account.', v_clean.email using errcode = 'NL422';
  end if;

  v_left_on := case when coalesce(p_left, false) then coalesce(v_before.left_on, nl.today()) end;
  if v_left_on is not null and coalesce(p_is_primary, false) then
    raise exception 'Someone who is no longer there cannot be the primary contact.' using errcode = 'NL422';
  end if;
  v_primary := coalesce(p_is_primary, false);

  -- The row version must still match; making this person primary takes the
  -- badge off whoever had it (trigger contacts_one_primary).
  update nl.contacts
     set full_name = v_clean.full_name,
         title = v_clean.title,
         email = v_clean.email,
         phone = v_clean.phone,
         mobile = v_clean.mobile,
         notes = v_clean.notes,
         is_primary = v_primary,
         left_on = v_left_on
   where id = p_contact_id
     and updated_at = p_expected_updated_at
  returning * into v_after;
  if not found then
    raise exception '% changed since the page was loaded. Reload and try again.', v_before.full_name
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'update_contact', 'contact', p_contact_id::text, p_request_id,
          jsonb_build_object(
            'customer_no', v_before.customer_no,
            'before', jsonb_build_object('full_name', v_before.full_name, 'title', v_before.title,
                                         'email', v_before.email, 'phone', v_before.phone,
                                         'mobile', v_before.mobile, 'is_primary', v_before.is_primary,
                                         'left_on', v_before.left_on),
            'after', jsonb_build_object('full_name', v_after.full_name, 'title', v_after.title,
                                        'email', v_after.email, 'phone', v_after.phone,
                                        'mobile', v_after.mobile, 'is_primary', v_after.is_primary,
                                        'left_on', v_after.left_on)));

  v_result := jsonb_build_object(
    'contact_id', p_contact_id,
    'is_primary', v_after.is_primary,
    'left_on', v_after.left_on,
    'updated_at', v_after.updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Name (or clear, with a null contact) the buyer on a commitment. The buyer
-- must work at the commitment's customer, one of its branches, or the head
-- office it bills to, and must still be there.
create function nl.set_commitment_buyer(
  p_commitment_id       bigint,
  p_contact_id          bigint,
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
  v_commitment nl.commitments;
  v_contact    nl.contacts;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'set_commitment_buyer');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  select * into v_commitment from nl.commitments where id = p_commitment_id;
  if not found then
    raise exception 'Commitment % does not exist.', p_commitment_id using errcode = 'NL404';
  end if;
  if v_commitment.owner_id <> v_actor.id and v_actor.role <> 'admin' then
    raise exception 'Only the owner of commitment % or an admin can name its buyer.', p_commitment_id
      using errcode = 'NL403';
  end if;

  if p_contact_id is not null then
    select * into v_contact from nl.contacts where id = p_contact_id;
    if not found then
      raise exception 'Contact % does not exist.', p_contact_id using errcode = 'NL422';
    end if;
    if v_contact.customer_no not in (
      select f.customer_no from nl.customer_family(v_commitment.customer_no) f
      union
      select a.customer_no from nl.customer_ancestors(v_commitment.customer_no) a) then
      raise exception '% works at another account, not at this commitment''s customer.', v_contact.full_name
        using errcode = 'NL422';
    end if;
    if v_contact.left_on is not null then
      raise exception '% is no longer at the account.', v_contact.full_name using errcode = 'NL422';
    end if;
  end if;

  update nl.commitments
     set buyer_contact_id = p_contact_id
   where id = p_commitment_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'Commitment % changed since it was loaded. Reload it and try again.', p_commitment_id
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'set_commitment_buyer', 'commitment', p_commitment_id::text, p_request_id,
          jsonb_build_object('from', v_commitment.buyer_contact_id, 'to', p_contact_id));

  v_result := jsonb_build_object(
    'commitment_id', p_commitment_id,
    'buyer_contact_id', p_contact_id,
    'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Log a note, call, email or meeting, in the signed-in user's name.
-- A call says how it went; nothing else does. occurred_at may be backdated
-- up to 30 days (a call logged the next morning), never in the future.
create function nl.log_activity(
  p_customer_no   text,
  p_kind          text,
  p_call_outcome  text,
  p_body          text,
  p_contact_id    bigint,
  p_commitment_id bigint,
  p_occurred_at   timestamptz,
  p_request_id    text,
  p_via           text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_body   text := btrim(coalesce(p_body, ''));
  v_at     timestamptz := coalesce(p_occurred_at, now());
  v_id     bigint;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'log_activity');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  if not exists (select 1 from nl.customers where customer_no = p_customer_no) then
    raise exception 'Customer % does not exist.', coalesce(p_customer_no, 'empty') using errcode = 'NL404';
  end if;
  if p_kind is null or p_kind not in ('note', 'call', 'email', 'meeting') then
    raise exception 'An activity is a note, call, email or meeting, not %.', coalesce(p_kind, 'empty')
      using errcode = 'NL422';
  end if;
  if p_kind = 'call' and (p_call_outcome is null
                          or p_call_outcome not in ('reached', 'voicemail', 'no_answer', 'callback')) then
    raise exception 'Say how the call went: reached, voicemail, no answer or callback.' using errcode = 'NL422';
  end if;
  if p_kind <> 'call' and p_call_outcome is not null then
    raise exception 'Only a call has an outcome.' using errcode = 'NL422';
  end if;
  if length(v_body) = 0 or length(v_body) > 2000 then
    raise exception 'Write 1 to 2,000 characters about it.' using errcode = 'NL422';
  end if;
  if v_at > now() + interval '5 minutes' then
    raise exception 'An activity cannot be logged in the future.' using errcode = 'NL422';
  end if;
  if v_at < now() - interval '30 days' then
    raise exception 'An activity can be backdated by 30 days at most.' using errcode = 'NL422';
  end if;
  -- The contact and the commitment must belong to this account's family.
  if p_contact_id is not null and not exists (
    select 1 from nl.contacts ct
    where ct.id = p_contact_id
      and ct.customer_no in (
        select f.customer_no from nl.customer_family(p_customer_no) f
        union
        select a.customer_no from nl.customer_ancestors(p_customer_no) a)) then
    raise exception 'Contact % is not at this account.', p_contact_id using errcode = 'NL422';
  end if;
  if p_commitment_id is not null and not exists (
    select 1 from nl.commitments cm
    where cm.id = p_commitment_id
      and cm.customer_no in (
        select f.customer_no from nl.customer_family(p_customer_no) f
        union
        select a.customer_no from nl.customer_ancestors(p_customer_no) a)) then
    raise exception 'Commitment % is not for this account.', p_commitment_id using errcode = 'NL422';
  end if;

  insert into nl.activities (customer_no, commitment_id, contact_id, kind, call_outcome, body,
                             author_id, via, occurred_at)
  values (p_customer_no, p_commitment_id, p_contact_id, p_kind, p_call_outcome, v_body,
          v_actor.id, p_via, v_at)
  returning id into v_id;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'log_activity', 'activity', v_id::text, p_request_id,
          jsonb_build_object('customer_no', p_customer_no, 'kind', p_kind, 'call_outcome', p_call_outcome,
                             'contact_id', p_contact_id, 'commitment_id', p_commitment_id));

  v_result := jsonb_build_object('activity_id', v_id, 'customer_no', p_customer_no, 'kind', p_kind);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- Add a next step for an account, for yourself or a colleague who still
-- works here. Due dates run from today to two years out.
create function nl.add_next_step(
  p_customer_no   text,
  p_title         text,
  p_due_on        date,
  p_owner_id      int,
  p_commitment_id bigint,
  p_request_id    text,
  p_via           text default 'ui'
) returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_replay jsonb;
  v_actor  nl.users;
  v_title  text := btrim(coalesce(p_title, ''));
  v_owner  int;
  v_step   nl.next_steps;
  v_result jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'add_next_step');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);
  v_owner := coalesce(p_owner_id, v_actor.id);

  if not exists (select 1 from nl.customers where customer_no = p_customer_no) then
    raise exception 'Customer % does not exist.', coalesce(p_customer_no, 'empty') using errcode = 'NL404';
  end if;
  if length(v_title) < 3 or length(v_title) > 200 then
    raise exception 'A next step says what to do in 3 to 200 characters.' using errcode = 'NL422';
  end if;
  if p_due_on is not null and (p_due_on < nl.today() or p_due_on > nl.today() + 730) then
    raise exception 'A due date runs from today to two years out.' using errcode = 'NL422';
  end if;
  if not exists (select 1 from nl.users u where u.id = v_owner and u.active) then
    raise exception 'A next step goes to someone who still works here.' using errcode = 'NL422';
  end if;
  if p_commitment_id is not null and not exists (
    select 1 from nl.commitments cm
    where cm.id = p_commitment_id
      and cm.customer_no in (
        select f.customer_no from nl.customer_family(p_customer_no) f
        union
        select a.customer_no from nl.customer_ancestors(p_customer_no) a)) then
    raise exception 'Commitment % is not for this account.', p_commitment_id using errcode = 'NL422';
  end if;

  insert into nl.next_steps (customer_no, commitment_id, title, due_on, owner_id, created_by)
  values (p_customer_no, p_commitment_id, v_title, p_due_on, v_owner, v_actor.id)
  returning * into v_step;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'add_next_step', 'next_step', v_step.id::text, p_request_id,
          jsonb_build_object('customer_no', p_customer_no, 'title', v_title, 'due_on', p_due_on,
                             'owner_id', v_owner, 'commitment_id', p_commitment_id));

  v_result := jsonb_build_object('next_step_id', v_step.id, 'owner_id', v_owner, 'updated_at', v_step.updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

create function nl.complete_next_step(
  p_step_id             bigint,
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
  v_step       nl.next_steps;
  v_cust_owner int;
  v_updated_at timestamptz;
  v_result     jsonb;
begin
  v_replay := nl.claim_request(p_request_id, 'complete_next_step');
  if v_replay is not null then
    return v_replay;
  end if;
  v_actor := nl.require_active_user();
  perform nl.check_via(p_via);

  select * into v_step from nl.next_steps where id = p_step_id;
  if not found then
    raise exception 'Next step % does not exist.', p_step_id using errcode = 'NL404';
  end if;
  select owner_id into v_cust_owner from nl.customers where customer_no = v_step.customer_no;
  if v_step.owner_id <> v_actor.id
     and v_cust_owner is distinct from v_actor.id
     and v_actor.role <> 'admin' then
    raise exception 'Only the step''s owner, the account''s owner or an admin can complete it.'
      using errcode = 'NL403';
  end if;
  if v_step.completed_at is not null then
    raise exception 'That step was already done.' using errcode = 'NL422';
  end if;

  update nl.next_steps
     set completed_at = now(), completed_by = v_actor.id
   where id = p_step_id
     and updated_at = p_expected_updated_at
  returning updated_at into v_updated_at;
  if not found then
    raise exception 'That step changed since the page was loaded. Reload and try again.'
      using errcode = 'NL409';
  end if;

  insert into nl.audit_log (actor_id, via, action, entity, entity_id, request_id, detail)
  values (v_actor.id, p_via, 'complete_next_step', 'next_step', p_step_id::text, p_request_id,
          jsonb_build_object('customer_no', v_step.customer_no, 'title', v_step.title, 'owner_id', v_step.owner_id));

  v_result := jsonb_build_object('next_step_id', p_step_id, 'updated_at', v_updated_at);
  perform nl.finish_request(p_request_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- Contacts: anyone signed in may add one, in their own name; the owner, an
-- admin or whoever added a contact may change it (anyone, on an unowned
-- account). Nobody deletes: a person who left gets left_on instead. Moving
-- the primary badge off someone else is done by trigger contacts_one_primary.
create policy contacts_insert on nl.contacts for insert to nl_app
  with check (created_by = (select nl.current_user_id()));
create policy contacts_update on nl.contacts for update to nl_app
  using (
    (select nl.is_admin())
    or created_by = (select nl.current_user_id())
    or exists (
      select 1 from nl.customers cu
      where cu.customer_no = contacts.customer_no
        and (cu.owner_id is null or cu.owner_id = (select nl.current_user_id()))))
  with check (true);

grant insert (customer_no, full_name, title, email, phone, mobile, notes, is_primary, created_by)
  on nl.contacts to nl_app;
grant update (full_name, title, email, phone, mobile, notes, is_primary, left_on, updated_at)
  on nl.contacts to nl_app;

-- Contacts are people, so the read-only role gets neither the table nor
-- this view, which names each account's primary contact.
grant select on nl.account_list to nl_app;

grant execute on function
  nl.clean_contact(text, text, text, text, text, text),
  nl.check_via(text),
  nl.may_change_contact(bigint),
  nl.add_contact(text, text, text, text, text, text, boolean, text, text, text),
  nl.update_contact(bigint, text, text, text, text, text, boolean, boolean, text, timestamptz, text, text),
  nl.set_commitment_buyer(bigint, bigint, timestamptz, text, text),
  nl.log_activity(text, text, text, text, bigint, bigint, timestamptz, text, text),
  nl.add_next_step(text, text, date, int, bigint, text, text),
  nl.complete_next_step(bigint, timestamptz, text, text)
to nl_app;
