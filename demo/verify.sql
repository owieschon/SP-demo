-- After demo.build(): does the world read the way the screens need it to?
-- Each query is one check; run them one at a time or all at once.

-- 1. The board: every deal status should appear, and the two window-closed deals should carry the question.
select status, count(*) as deals, count(*) filter (where days_over is not null) as with_question from public.v_commitments_board group by status order by status;

-- 2. Revenue by year through the one view every figure reads.
select extract(year from posting_date)::int as year, round(sum(net), 0) as revenue from public.v_invoice_net group by 1 order by 1;

-- 3. Today, as the admin seeing everyone: the mix of kinds and the top urgencies.
select kind, count(*) as rows, max(urgency) as top_urgency from public.gr_today(true) group by kind order by top_urgency desc;

-- 4. The warehouse buckets after oldest-first allocation, and how many orders can ship now.
select bucket, count(*) as orders, round(sum(value_open)) as open_value from public.v_wh_orders group by bucket order by bucket;

-- 5. Shortages by cover state (nothing started should be the loudest).
select cover, count(*) as parts, round(sum(short_value)) as value from public.v_wh_shortages group by cover order by parts desc;

-- 6. Reorder reminders: pairs the gate lets through.
select count(*) as due_pairs, count(distinct account_id) as accounts from public.v_item_reorder_due;

-- 7. Account health mix on the book.
select status, count(*) from public.v_accounts_book group by status order by 2 desc;

-- 8. Nudges the nightly job produced.
select kind, count(*) from public.nudges group by kind order by 2 desc;

-- 9. Find a part, the way the screen calls it.
select item_no, account, cur, prev from public.gr_find_part_accounts('L490', null, 5);

-- 10. Nothing fell out of the mirror.
select count(*) as mirror_failures from public.mirror_failures;
