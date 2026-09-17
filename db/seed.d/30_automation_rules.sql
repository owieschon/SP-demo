-- Example automation rules, so the Automations page shows what the team has
-- already set up. The shapes follow app/src/lib/automation/catalog.ts; the
-- app checks them against the catalog again before any run.
create or replace function nl_seed.extra_30_automation_rules() returns void
language plpgsql
set search_path = ''
as $$
begin
  insert into nl.automation_rules (name, description, trigger, conditions, action, enabled, owner_id, created_by)
  values
    ('Chase big windows that closed short',
     'A window worth $10,000 or more closed short three days ago and nobody has answered.',
     'window_closed_short',
     '[{"field": "committed_value", "op": "gte", "value": 10000},
       {"field": "days_since_close", "op": "gte", "value": 3}]',
     '{"kind": "next_step", "title": "Get an answer on {commitment} for {customer}: {shortfall} still missing, closed {days_since_close} ago",
       "dueInDays": 2, "assignTo": "record_owner"}',
     true, 1, 1),
    ('Call key accounts that went quiet',
     'Accounts worth $25,000 a year that have gone twice their usual gap without ordering.',
     'account_gone_quiet',
     '[{"field": "quiet_ratio", "op": "gte", "value": 2},
       {"field": "revenue_12m", "op": "gte", "value": 25000}]',
     '{"kind": "next_step", "title": "Call {customer}: quiet {days_quiet}, usually orders every {typical_gap_days}",
       "dueInDays": 3, "assignTo": "record_owner"}',
     true, 2, 2),
    ('Warn the account owner about short orders shipping this week',
     'An open line worth $500 or more ships in the next three days and stock does not cover it.',
     'order_line_at_risk',
     '[{"field": "days_to_ship", "op": "gte", "value": 0},
       {"field": "days_to_ship", "op": "lte", "value": 3},
       {"field": "line_value", "op": "gte", "value": 500}]',
     '{"kind": "next_step", "title": "Tell {customer} about {headline}: {short_qty} short, ships in {days_to_ship}",
       "dueInDays": 1, "assignTo": "record_owner"}',
     true, 5, 5),
    ('Note commitments falling behind',
     'Switched off while the team decides whether a note or a call is better.',
     'commitment_behind_pace',
     '[{"field": "gap_pts", "op": "gte", "value": 25},
       {"field": "days_left", "op": "lte", "value": 30},
       {"field": "owner_id", "op": "eq", "value": "me"}]',
     '{"kind": "note", "body": "{commitment} is {gap_pts} behind pace with {days_left} left ({delivered_pct} delivered)."}',
     false, 3, 3);
end $$;
