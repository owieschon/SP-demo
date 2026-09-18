-- Who is responsible for what, in the invented world: the five roles whose
-- home page has to fit on one screen, the two desk agents as principals
-- beside them, and the scope, authority and disclosure rows that make each
-- home short.
--
-- The six to sign in as:
--
--   Ines Carver     inside sales   drafts to send, quotes running out
--   Lena Ortmann    buyer          coverage gaps to buy, costs going up
--   Wes Tanner      planner        shortages on parts made here
--   Rae Sandoval    warehouse      picks, receipts, counts
--   Priya Raman     ops manager    policies, agent trust, what escaped
--   Hollis Vance    chief exec     the whole business, drillable to a row
--
-- Nothing in the NEW model resolves a permission from a preset name at request
-- time. The preset is only what these rows were seeded FROM, so an edit on
-- /people sticks and moving somebody between presets changes nothing in it.
--
-- But the old model is still here, and this file must not pretend otherwise.
-- Eight write functions from migrations 0010, 0015, 0016 and 0019 still read
-- nl.users.role directly, as `role not in ('operations', 'admin')`. So this
-- file deliberately does NOT rewrite that column: everybody keeps the coarse
-- value they were seeded with, and every write that worked yesterday works
-- today. What it writes instead is the responsibility line, which nothing
-- gated on and which the picker previously had to guess from a role name.
--
-- The grants below are the replacement for those eight checks, seeded for
-- exactly the people who pass them now, so converting the guards is a
-- migration that changes behaviour for nobody. That conversion is the next
-- piece of work and it has not been done; see docs/roles.md.
--
-- Account scope is taken from nl.customers.owner_id, which is where the book
-- already lives, rather than invented again. Inside sales cover one account
-- manager's book each, because that is how an inside salesperson gets a
-- reason to see a quote that is running out.
create or replace function nl_seed.extra_90_roles() returns void
language plpgsql
set search_path = ''
as $$
declare
  v_today date := (select today from nl_seed.settings);
  -- The one admin, recorded as having handed everything out.
  v_by    int  := 1;
begin
  -- -------------------------------------------------------------------------
  -- One more person: the warehouse has nobody in the original fourteen
  -- -------------------------------------------------------------------------

  insert into nl.users (id, email, full_name, title, role, active, kind, responsibility)
  values (15, 'rae.sandoval@northline.example', 'Rae Sandoval', 'Warehouse Lead',
          -- 'operations', not 'warehouse', and the header explains why: eight
          -- older write functions still gate on this column, and she has to be
          -- able to post a count on the day she is hired.
          'operations', true, 'person',
          'Picks, packs and ships out of both buildings, and posts the counts.')
  on conflict (id) do nothing;

  -- And the person the whole place answers to. Every other role exists to
  -- make one person's day small. This one exists to make the business
  -- legible, which is a different job: the widest scope, nothing withheld,
  -- and deliberately almost no operational authority, so that other people's
  -- queues do not pile onto a home page meant for reading the business.
  insert into nl.users (id, email, full_name, title, role, active, kind, responsibility)
  values (16, 'hollis.vance@northline.example', 'Hollis Vance', 'Chief Executive',
          'ceo', true, 'person',
          'Answers for the whole business. Sets the policies and decides what the agents may do alone.')
  on conflict (id) do nothing;

  -- -------------------------------------------------------------------------
  -- The presets, and one line each saying what the person answers for
  -- -------------------------------------------------------------------------

  -- The five account managers and the one who left keep the original preset:
  -- their book is their scope and nothing about them changes.
  update nl.users set responsibility =
    'Owns a book of accounts and answers for every commitment in it.'
  where id in (2, 3, 4, 8, 9);

  update nl.users set responsibility =
    'No longer with the company. The database refuses writes in this name.'
  where id = 7;

  update nl.users set responsibility =
    'Runs sales. Sets what everybody else may approve, and can answer for any account.'
  where id = 1;

  update nl.users set responsibility =
    'Owns the policies, the agents'' autonomy and everything that escaped them.'
  where id = 5;

  update nl.users set responsibility =
    'Reviews what the order desk drafts and sends the replies.'
  where id = 6;

  update nl.users set responsibility =
    'Quotes and answers for the accounts Dana Whitlock owns.'
  where id = 10;

  update nl.users set responsibility =
    'Quotes and answers for the accounts Sam Ortiz owns.'
  where id = 11;

  update nl.users set responsibility =
    'Quotes and answers for the accounts Tariq Hale owns.'
  where id = 14;

  update nl.users set responsibility =
    'Plans the families we make here and decides what a short line does.'
  where id = 12;

  update nl.users set responsibility =
    'Buys the parts we do not make, and accepts or refuses a supplier''s new cost.'
  where id = 13;

  -- -------------------------------------------------------------------------
  -- The two desk agents, as principals in the same table
  -- -------------------------------------------------------------------------

  -- They have an email address because their mailbox does, and no password,
  -- no session and no way in: the sign-in picker and the session lookup both
  -- say kind = 'person'.
  insert into nl.users (id, email, full_name, title, role, active, kind, responsibility)
  values
    (101, 'order-desk-agent@northline.example', 'Order desk agent', 'Agent',
     'agent', true, 'agent',
     'Reads the order desk mailbox and drafts customer replies for a person to send.'),
    (102, 'procurement-desk-agent@northline.example', 'Procurement desk agent', 'Agent',
     'agent', true, 'agent',
     'Reads the procurement mailbox and drafts supplier messages for a person to send.')
  on conflict (id) do nothing;

  -- -------------------------------------------------------------------------
  -- Scope: which slice of the world is whose
  -- -------------------------------------------------------------------------

  -- Every account manager's own book, straight from the book itself.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  select cu.owner_id, 'account', cu.customer_no, v_by
  from nl.customers cu
  where cu.owner_id is not null
  on conflict do nothing;

  -- Inside sales cover one manager's book each. Jordan Pike runs the order
  -- desk and covers Marcus Bell's, so his home has something in it on a day
  -- when the mail queue is empty.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  select cover.inside_id, 'account', cu.customer_no, v_by
  from (values (10, 2), (11, 4), (14, 9), (6, 3)) as cover(inside_id, manager_id)
  join nl.customers cu on cu.owner_id = cover.manager_id
  on conflict do nothing;

  -- The ops manager, the admin and the chief executive hold every dimension.
  -- This is the decision the brief asks for: seeing everything is a row
  -- somebody granted, not what happens when nobody said otherwise.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  select u.id, d.dimension, null, v_by
  from nl.users u
  cross join unnest(nl.scope_dimensions()) as d(dimension)
  where u.id in (1, 5, 16)
  on conflict do nothing;

  -- The buyer works every supplier and the procurement desk.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  values (13, 'vendor', null, v_by),
         (13, 'mailbox', '2', v_by)
  on conflict do nothing;

  -- Inside sales work the orders mailbox, so a draft the desk writes lands on
  -- the home of whoever is on the desk that day.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  select u.id, 'mailbox', '1', v_by
  from nl.users u
  where u.id in (6, 10, 11, 14)
  on conflict do nothing;

  -- The planner plans the families that are made or assembled here, not the
  -- whole catalog: a family we only buy in is the buyer's.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  select 12, 'part_family', i.family, v_by
  from nl.items i
  where i.replenishment in ('Prod. Order', 'Assembly')
  group by i.family
  on conflict do nothing;

  -- The warehouse lead works both buildings.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  select 15, 'warehouse', l.code, v_by
  from nl.locations l
  where l.active
  on conflict do nothing;

  -- An agent's mailbox IS its scope. Nothing else about it is in scope, which
  -- is why the order desk agent cannot read a supplier thread.
  insert into nl.user_scope (user_id, dimension, value, granted_by)
  select case when mb.kind = 'orders' then 101 else 102 end, 'mailbox', mb.id::text, v_by
  from nl.mailboxes mb
  on conflict do nothing;

  -- -------------------------------------------------------------------------
  -- Authority: what each of them may decide, and up to what
  -- -------------------------------------------------------------------------

  -- Account managers: their own accounts, their own commitments, and a quote
  -- up to the size they would normally sign.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  select u.id, g.authority, g.limit_amount, v_today, g.note, v_by
  from nl.users u
  cross join (values
    ('answer_commitment',      null::numeric, 'Answers for the windows in their own book.'),
    ('approve_agent_proposal', null::numeric, 'Decides what the assistant proposes to them.'),
    ('approve_quote',          25000::numeric, 'Signs a quote up to twenty five thousand.')
  ) as g(authority, limit_amount, note)
  where u.id in (2, 3, 4, 8, 9)
  on conflict do nothing;

  -- Inside sales: the desk's drafts, the quotes, the windows on the book they
  -- cover. A smaller ceiling than the manager who owns the account, so a big
  -- quote stays on the manager's home and off theirs.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  select u.id, g.authority, g.limit_amount, v_today, g.note, v_by
  from nl.users u
  cross join (values
    ('approve_reply',          null::numeric, 'Sends what the order desk drafted.'),
    ('answer_commitment',      null::numeric, 'Answers a window that closed short.'),
    ('approve_agent_proposal', null::numeric, 'Decides what the assistant proposes to them.'),
    ('approve_quote',          7500::numeric, 'Signs a quote up to seven thousand five hundred.')
  ) as g(authority, limit_amount, note)
  where u.id in (6, 10, 11, 14)
  on conflict do nothing;

  -- The buyer.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  values
    (13, 'release_purchase_order', 50000, v_today, 'Commits up to fifty thousand to a supplier.', v_by),
    (13, 'accept_price_increase', 400, v_today, 'Accepts a new unit cost up to four hundred.', v_by),
    (13, 'approve_reply', null, v_today, 'Sends what the procurement desk drafted.', v_by)
  on conflict do nothing;

  -- The planner.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  values
    (12, 'resolve_shortage', null, v_today, 'Decides what a short line on a made part does.', v_by)
  on conflict do nothing;

  -- The warehouse lead. Nothing here has a dollar figure: the decisions are
  -- did it get picked, did it arrive, is the count right.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  values
    (15, 'confirm_pick', null, v_today, 'Says a shipment is picked.', v_by),
    (15, 'receive_stock', null, v_today, 'Receives a transfer in.', v_by),
    (15, 'count_stock', null, v_today, 'Posts a cycle count.', v_by)
  on conflict do nothing;

  -- The ops manager. Her SCOPE is everything, which is the "only the ops
  -- manager sees everything" decision. Her AUTHORITY deliberately is not:
  -- she holds the policy surface, the exceptions and the margin floor, and
  -- she does not hold confirm_pick or release_purchase_order, so the
  -- warehouse's and the buyer's queues do not land on her home. She can give
  -- herself any of them in one edit, because she holds change_policy, and
  -- that is the right shape: stepping into somebody's job is a deliberate
  -- act, not what happens by default.
  --
  -- answer_commitment is here because an unanswered window IS an exception
  -- that escaped: the rep did not answer it and the nightly job could not.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  values
    (5, 'change_policy', null, v_today, 'Sets what everybody, and every agent, may decide.', v_by),
    (5, 'review_exception', null, v_today, 'Handles what an agent stopped on.', v_by),
    (5, 'override_margin_floor', null, v_today, 'The only person who may price below the floor.', v_by),
    (5, 'approve_agent_proposal', null, v_today, 'Decides what the assistant proposes.', v_by),
    (5, 'answer_commitment', null, v_today, 'Chases a window nobody answered.', v_by)
  on conflict do nothing;

  -- The admin, who is in sales: the policy surface, the loads, and no
  -- ceiling on a quote. Not the warehouse's decisions.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  values
    (1, 'change_policy', null, v_today, 'Sets what everybody may approve.', v_by),
    (1, 'run_import', null, v_today, 'Can stage and apply a load.', v_by),
    (1, 'answer_commitment', null, v_today, 'Can answer for any account.', v_by),
    (1, 'approve_agent_proposal', null, v_today, 'Decides what the assistant proposes.', v_by),
    (1, 'review_exception', null, v_today, 'Handles what an agent could not.', v_by),
    (1, 'approve_quote', null, v_today, 'No ceiling on a quote.', v_by)
  on conflict do nothing;

  -- run_import is the one rule that used to be a role check. 0010 read
  -- role in ('operations', 'admin'), which was these six people, so they keep
  -- it and nothing they could do before has changed.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  select u.id, 'run_import', null, v_today,
         'Held before this was data, when the rule was a role check.', v_by
  from nl.users u
  where u.id in (5, 6, 12, 13, 14)
  on conflict do nothing;

  -- The chief executive. The scope above is everything; the authority here is
  -- narrow on purpose and it is the same argument the ops manager's block
  -- makes. Reading the business is not the same as running somebody's queue,
  -- so there is no approve_quote, no release_purchase_order, no confirm_pick:
  -- none of that should land on a home page meant for seeing the whole place
  -- at once. What is here is what only this person should settle: the
  -- policies, how far the agents may go on their own, and the floor.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  values
    (16, 'change_policy', null, v_today, 'Sets the rules the business and its agents run on.', v_by),
    (16, 'review_exception', null, v_today, 'The last stop for anything nobody else settled.', v_by),
    (16, 'override_margin_floor', null, v_today, 'May price below the floor, and is asked why.', v_by)
  on conflict do nothing;

  -- The agents. Autonomy 1 is "draft for a person": the desk writes and
  -- queues, and a person sends. Raising either of these to 2 is the same
  -- write as raising the buyer's fifty thousand, which is the point.
  insert into nl.authority_grants (user_id, authority, limit_amount, starts_on, note, granted_by)
  values
    (101, 'agent_autonomy', 1, v_today, 'Drafts, and a person sends.', v_by),
    (102, 'agent_autonomy', 1, v_today, 'Drafts, and a person sends.', v_by)
  on conflict do nothing;

  -- -------------------------------------------------------------------------
  -- Disclosure: what each of them may be shown at all
  -- -------------------------------------------------------------------------

  -- Sales and the warehouse see the commercial side: list price, the price
  -- this account pays, availability, lead times. Not unit cost, not margin,
  -- not the floor.
  insert into nl.disclosure_grants (user_id, level, note, granted_by)
  select u.id, 'customer',
         'Prices and availability. Cost, margin and the floor are not on this screen.', v_by
  from nl.users u
  where u.id in (2, 3, 4, 6, 7, 8, 9, 10, 11, 14, 15)
  on conflict (user_id) do nothing;

  -- Buying, planning and running the place needs the cost side.
  insert into nl.disclosure_grants (user_id, level, note, granted_by)
  select u.id, 'internal', 'Everything, including cost, margin and the floor.', v_by
  from nl.users u
  where u.id in (1, 5, 12, 13, 16)
  on conflict (user_id) do nothing;

  -- An agent's disclosure is its mailbox's, read from the mailbox rather than
  -- written down twice. It is the same level already enforced on every draft
  -- it assembles (app/src/lib/server/desk/policy.ts).
  insert into nl.disclosure_grants (user_id, level, note, granted_by)
  select case when mb.kind = 'orders' then 101 else 102 end,
         mb.disclosure,
         'From the mailbox. The same level its drafts are checked against.', v_by
  from nl.mailboxes mb
  on conflict (user_id) do nothing;
end $$;
