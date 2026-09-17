-- 0005 The index behind delivery measurement.
--
-- nl.commitment_lines looks invoice lines up by customer, then item, then a
-- posting-date range. This index is exactly that lookup, and it carries the
-- amount, so summing delivery never has to visit the table itself (an
-- index-only scan). It has its own migration so docs/sql.md can show the
-- query plan before and after it.
create index invoice_lines_delivery_idx
  on nl.invoice_lines (customer_no, item_no, posted_on)
  include (amount);
