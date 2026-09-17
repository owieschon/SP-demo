-- 0004 Invoice subtotals.
--
-- The ERP's line-level export only reaches back to January of the year
-- before last; the invoice export reaches a year further. So an older invoice
-- can exist with no lines loaded. Its subtotal (what its lines added up to,
-- before freight) is what revenue history reads, instead of summing lines
-- that are not there.
alter table nl.invoices
  add column subtotal numeric(12, 2) not null default 0;

create index invoices_posted_idx on nl.invoices (posted_on) include (subtotal, doc_type);
