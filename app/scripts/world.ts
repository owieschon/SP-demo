// Build the Northline world in a throwaway in-memory database and print what
// came out. Handy after changing db/seed.sql or a migration.
//
//   node scripts/world.ts                  small world, today pinned to 2026-09-17
//   node scripts/world.ts full             the full world
//   node scripts/world.ts full 2026-12-01  the full world as of another day
import { createTestDb, type WorldSize } from '../src/lib/server/db/pglite.ts';

const size = (process.argv[2] ?? 'small') as WorldSize;
const today = process.argv[3] ?? '2026-09-17';

const started = Date.now();
const db = await createTestDb({ size, today });
console.log(`built the ${size} world as of ${today} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

await db.asSystem(async (tx) => {
	const [summary] = await tx.sql`
		select jsonb_build_object(
			'customers', (select count(*) from nl.customers),
			'items', (select count(*) from nl.items),
			'invoices', (select count(*) from nl.invoices where doc_type = 'invoice'),
			'credit_memos', (select count(*) from nl.invoices where doc_type = 'credit_memo'),
			'invoice_lines', (select count(*) from nl.invoice_lines),
			'activities', (select count(*) from nl.activities),
			'revenue_by_year', (select jsonb_object_agg(y, v) from (
				select extract(year from posted_on)::int as y, round(sum(subtotal)) as v
				from nl.invoices group by 1) r)) as counts`;
	console.log(summary.counts);

	const nightly = await tx.sql`select nl.answer_pushed_windows() as result`;
	console.log('nightly job:', nightly[0].result);

	const board = await tx.sql`
		select p.id, p.status, p.needs_outcome, p.customer_no, c.name as customer, p.title,
		       p.delivered, p.committed_value, p.confidence, p.expected_value, p.starts_on, p.ends_on
		from nl.commitment_progress p
		join nl.customers c on c.customer_no = p.customer_no
		order by array_position(array['promised','quoted','delivering','kept','pushed','broken'], p.status), p.id`;
	console.table(board);
});

await db.close();
