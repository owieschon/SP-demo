-- Fingerprints of the schema and the world, one hash per part.
--
-- Run it on Supabase and on the local PGlite database (app/scripts/fingerprint.ts)
-- as of the same day. Matching hashes mean both hold the same functions, views,
-- columns and policies, and the same customers, parts, ledger and commitments.
select
  (select md5(string_agg(n.nspname || '.' || p.proname || ':' || md5(p.prosrc) || ':'
                         || coalesce(array_to_string(p.proconfig, ';'), ''),
                         ',' order by n.nspname, p.proname, md5(p.prosrc)))
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('nl', 'nl_seed')) as functions,
  (select md5(string_agg(c.relname || ':' || md5(pg_get_viewdef(c.oid)), ',' order by c.relname))
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'nl' and c.relkind = 'v') as views,
  (select md5(string_agg(table_name || '.' || column_name || ':' || data_type || ':' || coalesce(column_default, ''),
                         ',' order by table_name, ordinal_position))
     from information_schema.columns
    where table_schema = 'nl') as columns,
  (select md5(string_agg(tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':'
                         || coalesce(with_check, '') || ':' || array_to_string(roles, '|'),
                         ',' order by tablename, policyname))
     from pg_policies
    where schemaname = 'nl') as policies,
  (select md5(string_agg(customer_no || '|' || name || '|' || coalesce(owner_id::text, '-'), ',' order by customer_no))
     from nl.customers) as customers,
  (select md5(string_agg(item_no || '|' || unit_cost || '|' || list_price, ',' order by item_no))
     from nl.items) as items,
  (select count(*) || ' lines, ' || sum(amount) from nl.invoice_lines) as ledger,
  (select md5(string_agg(id || '|' || status || '|' || delivered || '|' || committed_value, ',' order by id))
     from nl.commitment_progress) as commitments;
