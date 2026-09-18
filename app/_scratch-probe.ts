// Scratch: build a world and print shape probes. Delete before committing.
import { createTestDb } from './src/lib/server/db/pglite.ts';

const size = (process.argv[2] ?? 'small') as 'small' | 'demo' | 'full';
const started = Date.now();
const db = await createTestDb({ size, today: '2026-09-17' });
console.log(`built ${size} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

await db.asSystem(async (tx) => {
	console.log(
		await tx.sql`
			select
			  (select count(*) from nl.commitments) as commitments,
			  (select count(*) from nl.quotes) as quotes,
			  (select count(*) from nl.quote_revisions) as revisions,
			  (select count(*) from nl.quote_revision_lines) as rev_lines,
			  (select count(*) from nl.requirements) as requirements,
			  (select count(*) from nl.next_steps where commitment_id is not null) as c_steps,
			  (select count(*) from nl.commitment_outcomes) as outcomes,
			  (select count(*) from nl.commitment_outcomes where next_commitment_id is not null) as follow_ons,
			  (select count(*) from nl.activities where commitment_id is not null) as c_activity`
	);
	console.log('-- quotes per commitment');
	console.table(
		await tx.sql`select n, count(*) as commitments from (
		  select c.id, count(q.id) as n from nl.commitments c
		  left join nl.quotes q on q.commitment_id = c.id group by c.id) s
		  group by n order by n`
	);
	console.log('-- versions per quote');
	console.table(
		await tx.sql`select versions, count(*) as quotes from nl.quote_state group by versions order by versions`
	);
	console.log('-- quote outcomes');
	console.table(await tx.sql`select outcome, count(*) from nl.quote_state group by outcome order by 2 desc`);
	console.log('-- revision outcomes and reasons');
	console.table(
		await tx.sql`select outcome, outcome_reason, count(*) from nl.quote_revisions group by 1, 2 order by 3 desc limit 12`
	);
	console.log('-- change reasons');
	console.table(await tx.sql`select change_reason, count(*) from nl.quote_revisions group by 1 order by 2 desc`);
	console.log('-- requirements');
	console.table(
		await tx.sql`select kind, count(*) total, count(*) filter (where satisfied) met,
		  count(*) filter (where overdue) overdue from nl.requirement_state group by kind order by 2 desc`
	);
	console.log('-- next steps per commitment');
	console.table(
		await tx.sql`select n, count(*) as commitments from (
		  select c.id, count(s.id) as n from nl.commitments c
		  left join nl.next_steps s on s.commitment_id = c.id group by c.id) s
		  group by n order by n`
	);
	console.log('-- next step state');
	console.table(
		await tx.sql`select source, kind,
		  count(*) filter (where completed_at is null) open,
		  count(*) filter (where completed_at is null and due_on < nl.today()) overdue,
		  count(*) filter (where completed_at is null and due_on = nl.today()) due_today,
		  count(*) filter (where completed_at is not null) done,
		  count(*) filter (where completed_at::date > due_on) done_late
		  from nl.next_steps group by 1, 2 order by 1, 2`
	);
	console.log('-- settled per account, and patterns');
	console.table(
		await tx.sql`select settled_count, count(*) as accounts from nl.account_sales_record
		  where settled_count > 0 group by 1 order by 1`
	);
	console.table(
		await tx.sql`select customer_no, kept, pushed, broken, kept_rate, pattern, quotes_won, quotes_lost, top_loss_reason
		  from nl.account_sales_record where settled_count >= 3 order by kept_rate, settled_count desc limit 10`
	);
	console.log('-- commitment depth spread');
	console.table(
		await tx.sql`select
		  count(*) as commitments,
		  count(*) filter (where is_bare) as bare,
		  count(*) filter (where quote_count = 0) as no_quote,
		  count(*) filter (where quote_count >= 2) as two_plus_quotes,
		  count(*) filter (where requirements > 0) as with_requirements,
		  count(*) filter (where open_steps = 0) as no_open_step,
		  count(*) filter (where overdue_steps > 0) as overdue,
		  count(*) filter (where agent_steps > 0) as agent,
		  count(*) filter (where answers >= 2) as two_plus_answers
		  from nl.commitment_depth`
	);
	console.log('-- drift');
	console.table(await tx.sql`select * from nl.delivery_drift() limit 5`);
});
await db.close();
