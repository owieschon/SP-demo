// Scratch: build a world and run explain (analyze, buffers) on the roll-ups
// migration 0027 adds. Delete before committing.
import { createTestDb } from './src/lib/server/db/pglite.ts';

const size = (process.argv[2] ?? 'small') as 'small' | 'demo' | 'full';
const started = Date.now();
const db = await createTestDb({ size, today: '2026-09-17' });
console.log(`built ${size} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

const counts = await db.asSystem((tx) =>
	tx.sql`select
	  (select count(*) from nl.customers) customers,
	  (select count(*) from nl.invoice_lines) invoice_lines,
	  (select count(*) from nl.commitments) commitments,
	  (select count(*) from nl.quotes) quotes,
	  (select count(*) from nl.quote_revisions) revisions,
	  (select count(*) from nl.quote_revision_lines) revision_lines,
	  (select count(*) from nl.requirements) requirements,
	  (select count(*) from nl.commitment_outcomes) outcomes,
	  (select count(*) from nl.next_steps) next_steps,
	  (select count(*) from nl.activities) activities`
);
console.log(counts[0]);

// One id of each kind to measure a single-row read with.
const [pick] = await db.asSystem((tx) =>
	tx.sql<{ commitment_id: number; customer_no: string; quote_id: number }>`
		select q.commitment_id, q.customer_no, q.id as quote_id
		from nl.quote_state q
		where q.commitment_id is not null and q.versions >= 2
		order by q.versions desc, q.id
		limit 1`
);
console.log('measuring against', pick);

const queries: [string, string][] = [
	['board (0009 baseline)', 'select * from nl.commitment_progress'],
	['commitment_depth, whole view', 'select * from nl.commitment_depth'],
	['commitment_depth, one row', `select * from nl.commitment_depth where commitment_id = ${pick.commitment_id}`],
	['account_sales_record, whole view', 'select * from nl.account_sales_record'],
	[
		'account_sales_record, one row',
		`select * from nl.account_sales_record where customer_no = '${pick.customer_no}'`
	],
	['quote_state, whole view', 'select * from nl.quote_state'],
	['quote_state, one quote', `select * from nl.quote_state where id = ${pick.quote_id}`],
	['requirement_state, whole view', 'select * from nl.requirement_state'],
	[
		'requirement_state, one commitment',
		`select * from nl.requirement_state where commitment_id = ${pick.commitment_id}`
	],
	[
		'revisions of one quote, as the page reads them',
		`select r.id, r.version, r.total, r.line_count, r.is_latest, r.still_valid
		 from nl.quote_revision_state r where r.quote_id = ${pick.quote_id} order by r.version`
	],
	[
		'account record, as getAccountRecord reads it',
		`with family as (
		   select customer_no from nl.customer_family('${pick.customer_no}')
		   union select customer_no from nl.customer_ancestors('${pick.customer_no}'))
		 select coalesce(sum(r.settled_count), 0), coalesce(sum(r.kept), 0), coalesce(sum(r.quotes_lost), 0)
		 from family f join nl.account_sales_record r on r.customer_no = f.customer_no`
	]
];

for (const [label, sql] of queries) {
	const rows = await db.asUser(1, (tx) => tx.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers) ${sql}`));
	const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
	const time = plan.match(/Execution Time: ([\d.]+) ms/)?.[1] ?? '?';
	console.log(`\n### ${label}: ${time} ms`);
	console.log(plan);
}

const drift = await db.asSystem((tx) => tx.sql`select count(*) as n from nl.delivery_drift()`);
console.log('\ndelivery drift rows:', drift[0].n);
await db.close();
