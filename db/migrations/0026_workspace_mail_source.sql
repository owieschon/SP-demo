-- 0026 The workspace queue picks up the real mail drafts.
--
-- Two things happen here, and both exist because of the order the migrations
-- landed in:
--
--   1. When 0023 was written, migration 0021 was being built on another
--      branch, so the queue's mail branch was assembled from whatever columns
--      a table called nl.mail_drafts turned out to have. 0021 has landed and
--      the real shape is known, and two of those guesses were wrong: a mail
--      draft has no customer of its own (it comes from the message it replies
--      to) and no reviewer of its own (the reviewer belongs to the mailbox).
--      So the mail branch is written out properly here.
--
--   2. nl.agent_queue is a view assembled from the sources present when
--      nl.rebuild_agent_queue() last ran. On a database where 0023 was applied
--      BEFORE 0021, the view still has no mail branch at all. The call at the
--      end of this file fixes that, and it is safe to run anywhere: it always
--      rebuilds from what is there now.
--
-- 0023 is already applied on the owner's Supabase, so it is not edited; this
-- replaces the one function that changed. Nothing else about the queue moves:
-- the row shape, nl.queue_decisions and every access rule stay as they were.
--
-- Depends on 0023. Works whether or not 0021 and 0022 are applied.

create or replace function nl.agent_queue_fragment(p_source text) returns text
language plpgsql stable
set search_path = ''
as $$
declare
  v_table    text;
  v_ref      text;   -- nl.customers or nl.vendors
  v_ref_key  text;   -- customer_no or vendor_no
  v_kind     text;   -- 'account' or 'vendor'
  v_key      text;   -- SQL for the source row's own reference column
  v_summary  text;
  v_value    text;
  v_author   text;
  v_reviewer text;
begin
  if p_source = 'rfq' then
    if pg_catalog.to_regclass('nl.rfq_drafts') is null then
      return null;
    end if;
    -- An open RFQ draft is waiting for a person. needs_review counts the
    -- fields the validator could not settle, and nl.approve_rfq_draft refuses
    -- while any of them is open, so the queue shows that as its own status.
    return $frag$
      select 'rfq'::text                                            as source,
             d.id::bigint                                           as source_id,
             ('Turn emailed request R-' || d.id || ' into a quote for '
               || coalesce(c.name, 'a customer that is not settled yet'))::text as summary,
             (case when c.customer_no is not null then 'account' end)::text     as subject_kind,
             c.customer_no::text                                    as subject_no,
             c.name::text                                           as subject_name,
             (d.validation #>> '{totals,subtotal}')::numeric(12, 2) as value,
             d.created_by::int                                      as created_by_id,
             u.full_name::text                                      as created_by,
             (case when d.extractor = 'claude' then 'assistant' else 'person' end)::text as created_via,
             d.created_at                                           as created_at,
             d.updated_at                                           as row_version,
             d.created_by::int                                      as reviewer_id,
             (case when d.needs_review > 0 then 'needs_review' else 'waiting' end)::text as status
      from nl.rfq_drafts d
      join nl.users u on u.id = d.created_by
      left join nl.customers c on c.customer_no = d.customer_no
      where d.status = 'draft'
    $frag$;

  elsif p_source = 'assistant' then
    if pg_catalog.to_regclass('nl.assistant_proposals') is null then
      return null;
    end if;
    -- A draft proposal is waiting. One that was approved and then failed is
    -- waiting too, for another attempt, and shows as 'retry'.
    --
    -- Most proposals are about a commitment, so the account comes from the
    -- first option's commitment_id when it has one. The regexp test keeps a
    -- cast from ever failing on an option that has something else there.
    return $frag$
      select 'assistant'::text                     as source,
             p.id::bigint                          as source_id,
             p.summary::text                       as summary,
             (case when cu.customer_no is not null then 'account' end)::text as subject_kind,
             cu.customer_no::text                  as subject_no,
             cu.name::text                         as subject_name,
             null::numeric(12, 2)                  as value,
             p.created_by::int                     as created_by_id,
             u.full_name::text                     as created_by,
             'assistant'::text                     as created_via,
             p.created_at                          as created_at,
             p.updated_at                          as row_version,
             p.created_by::int                     as reviewer_id,
             (case when p.status = 'approved' then 'retry' else 'waiting' end)::text as status
      from nl.assistant_proposals p
      join nl.users u on u.id = p.created_by
      left join lateral (
        select cm.customer_no, cs.name
        from nl.commitments cm
        join nl.customers cs on cs.customer_no = cm.customer_no
        where cm.id = (case
                         when (p.options -> 0 -> 'input' ->> 'commitment_id') ~ '^[0-9]+$'
                           then (p.options -> 0 -> 'input' ->> 'commitment_id')::bigint
                       end)
      ) cu on true
      where p.status = 'draft'
         or (p.status = 'approved' and p.error is not null)
    $frag$;

  elsif p_source = 'mail' then
    -- The real shape, from migration 0021. Still guarded, because a database
    -- without 0021 has neither table and a view cannot name one that is not
    -- there.
    if pg_catalog.to_regclass('nl.mail_drafts') is null
       or pg_catalog.to_regclass('nl.mailboxes') is null then
      return null;
    end if;
    -- Only status 'draft' waits for a yes or a no. An approved draft whose
    -- send failed ('failed') has already had its decision and needs a resend,
    -- which is the desk page's job, not this queue's.
    --
    -- A draft the agent held (blocked_reason set) is in the queue because
    -- somebody has to deal with it, but nl.approve_mail_draft refuses a held
    -- draft, so it shows as needs_review and the page does not offer Approve.
    --
    -- Who it concerns comes from the message it replies to: a customer on the
    -- order desk, a vendor on the procurement desk. The draft itself holds
    -- neither, and the reviewer belongs to the mailbox.
    return $frag$
      select 'mail'::text                          as source,
             d.id::bigint                          as source_id,
             d.subject::text                       as summary,
             (case when cu.customer_no is not null then 'account'
                   when ve.vendor_no is not null then 'vendor' end)::text as subject_kind,
             coalesce(cu.customer_no, ve.vendor_no)::text as subject_no,
             coalesce(cu.name, ve.name)::text      as subject_name,
             null::numeric(12, 2)                  as value,
             null::int                             as created_by_id,
             (case mb.kind when 'orders' then 'the order desk agent'
                           else 'the procurement desk agent' end)::text as created_by,
             'agent'::text                         as created_via,
             d.created_at                          as created_at,
             d.updated_at                          as row_version,
             mb.reviewer_id::int                   as reviewer_id,
             (case when d.blocked_reason <> '' then 'needs_review' else 'waiting' end)::text as status
      from nl.mail_drafts d
      join nl.mailboxes mb on mb.id = d.mailbox_id
      left join nl.mail_messages m on m.id = d.in_reply_to_id
      left join nl.customers cu on cu.customer_no = m.customer_no
      left join nl.vendors ve on ve.vendor_no = m.vendor_no
      where d.status = 'draft'
    $frag$;

  elsif p_source = 'purchase' then
    -- Migration 0022's purchase requests are not in this database yet, so
    -- this branch is still built from whatever columns the table turns out to
    -- have. docs/workspace.md says which ones the queue looks for. When that
    -- work lands, write this branch out the way the mail branch above was.
    v_table   := nl.agent_queue_table(array['purchase_requests', 'purchase_request_drafts']);
    v_ref     := 'nl.vendors';
    v_ref_key := 'vendor_no';
    v_kind    := 'vendor';
    if v_table is null then
      return null;
    end if;
    -- The four columns the queue cannot do without. Without them this source
    -- stays out, and nl.agent_queue_sources() reports it as absent.
    if not (nl.agent_queue_has_column(v_table, 'id')
            and nl.agent_queue_has_column(v_table, 'status')
            and nl.agent_queue_has_column(v_table, 'created_at')
            and nl.agent_queue_has_column(v_table, 'updated_at')) then
      return null;
    end if;

    v_key := nl.agent_queue_column(v_table, v_ref_key, 'd', 'null::text');
    v_summary := case
      when nl.agent_queue_has_column(v_table, 'summary') then 'd.summary'
      when nl.agent_queue_has_column(v_table, 'subject') then 'd.subject'
      else format('%L', 'Purchase request waiting for a person')
    end;
    v_value := case
      when nl.agent_queue_has_column(v_table, 'value') then 'd.value'
      when nl.agent_queue_has_column(v_table, 'total') then 'd.total'
      when nl.agent_queue_has_column(v_table, 'total_value') then 'd.total_value'
      else 'null'
    end;
    v_author   := nl.agent_queue_column(v_table, 'created_by', 'd', 'null');
    v_reviewer := nl.agent_queue_column(v_table, 'reviewer_id', 'd', 'null');

    return format($frag$
      select 'purchase'::text                          as source,
             d.id::bigint                              as source_id,
             (%1$s)::text                              as summary,
             (case when r.%2$I is not null then %3$L end)::text as subject_kind,
             r.%2$I::text                              as subject_no,
             r.name::text                              as subject_name,
             (%4$s)::numeric(12, 2)                    as value,
             (%5$s)::int                               as created_by_id,
             coalesce(u.full_name, 'the procurement agent')::text as created_by,
             'agent'::text                             as created_via,
             d.created_at                              as created_at,
             d.updated_at                              as row_version,
             (%6$s)::int                               as reviewer_id,
             'waiting'::text                           as status
      from nl.%7$I d
      left join nl.users u on u.id = (%5$s)
      left join %8$s r on r.%2$I = (%9$s)
      where d.status in ('draft', 'waiting', 'pending', 'proposed')
    $frag$,
      v_summary, v_ref_key, v_kind, v_value, v_author, v_reviewer, v_table, v_ref, v_key);
  end if;

  return null;
end $$;

-- Assemble the view again, now that the mail branch exists. Safe to run on a
-- database that already had it: it rebuilds from whatever is present.
select nl.rebuild_agent_queue();
