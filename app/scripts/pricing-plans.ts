// Plan shapes and buffer counts for the pricing objects in migration 0027.
//
//   node scripts/pricing-plans.ts            the small world
//   node scripts/pricing-plans.ts demo       the local development world
//   node scripts/pricing-plans.ts full       the full world (minutes, lots of memory)
//
// Read the buffer counts, not the milliseconds: PGlite is Postgres compiled
// to WebAssembly and its timings move with whatever else the machine is
// doing, while the number of pages a query touches does not. What these
// queries have to prove is that a lookup for one account and one part does
// not grow with the ledger.
import { createTestDb, type WorldSize } from '../src/lib/server/db/pglite.ts';

const size = (process.argv[2] ?? 'small') as WorldSize;
const started = Date.now();
const db = await createTestDb({ size, today: '2026-09-17' });
console.log(`${size} world built in ${((Date.now() - started) / 1000).toFixed(1)}s`);

await db.asSystem(async (tx) => {
	await tx.sql`analyze`;
	const [counts] = await tx.sql`select jsonb_build_object(
		'invoice_lines', (select count(*) from nl.invoice_lines),
		'items', (select count(*) from nl.items),
		'customers', (select count(*) from nl.customers),
		'sheets', (select count(*) from nl.price_sheets),
		'sheet_lines', (select count(*) from nl.price_sheet_lines),
		'sends', (select count(*) from nl.price_sheet_sends),
		'breaks', (select count(*) from nl.price_breaks),
		'exceptions', (select count(*) from nl.trade_exceptions),
		'customer_item_prices', (select count(*) from nl.customer_item_prices),
		'vendor_items', (select count(*) from nl.vendor_items),
		'vendor_item_breaks', (select count(*) from nl.vendor_item_breaks),
		'purchase_receipts', (select count(*) from nl.purchase_receipts)) as c`;
	console.log(JSON.stringify(counts.c));

	const [pick] = await tx.sql<{ customer_no: string; item_no: string }>`
		select h.customer_no, h.item_no
		from nl.customer_item_prices h
		join nl.price_breaks pb on pb.item_no = h.item_no and pb.sheet_id is not null
		group by h.customer_no, h.item_no, h.times_bought
		order by h.times_bought desc, h.customer_no, h.item_no
		limit 1`;
	console.log('probe account and part', pick);

	const queries: [string, string][] = [
		[
			'customer_item_prices, one account and part',
			`select * from nl.customer_item_prices where customer_no = '${pick.customer_no}' and item_no = '${pick.item_no}'`
		],
		[
			'customer_item_price_context, one account and part',
			`select * from nl.customer_item_price_context where customer_no = '${pick.customer_no}' and item_no = '${pick.item_no}'`
		],
		['price_quote_for', `select * from nl.price_quote_for('${pick.customer_no}', '${pick.item_no}', 12, null)`],
		['explain_price', `select nl.explain_price('${pick.customer_no}', '${pick.item_no}', 12, null)`],
		['answer_for', `select nl.answer_for('${pick.customer_no}', '${pick.item_no}', 12, null)`],
		['customer_parts, whole account', `select count(*) from nl.customer_parts('${pick.customer_no}')`],
		['exceptions_for', `select nl.exceptions_for('${pick.customer_no}', '${pick.item_no}', null)`],
		['promise_lead_days', `select * from nl.promise_lead_days('${pick.item_no}')`],
		['lead_time_for', `select * from nl.lead_time_for('${pick.item_no}', null)`],
		[
			'vendor_item_lead_times, one pair',
			`select * from nl.vendor_item_lead_times where item_no = '${pick.item_no}'`
		],
		[
			'vendor_part_lead_times, the busiest vendor',
			`select count(*) from nl.vendor_part_lead_times where vendor_no = (
			   select vendor_no from nl.vendor_items group by vendor_no
			   order by count(*) desc, vendor_no limit 1)`
		],
		['account_price_sheet, one account', `select * from nl.account_price_sheet where customer_no = '${pick.customer_no}'`]
	];

	for (const [label, q] of queries) {
		// Run it three times and keep the best, so a cold cache does not
		// dominate the figure.
		let best = Number.POSITIVE_INFINITY;
		let buffers = 0;
		let shape = '';
		for (let i = 0; i < 3; i++) {
			const plan = await tx.query<{ 'QUERY PLAN': string }>(`explain (analyze, buffers) ${q}`);
			const text = plan.map((r) => r['QUERY PLAN']).join('\n');
			const ms = Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? 0);
			if (ms < best) {
				best = ms;
				buffers = Number(/Buffers: shared hit=(\d+)/.exec(text)?.[1] ?? 0);
				shape = text
					.split('\n')
					.filter((l) => /Scan|Aggregate|Loop|Sort|Join|Function/.test(l))
					.map((l) => l.trim().replace(/\s*\(cost.*/, ''))
					.slice(0, 8)
					.join(' / ');
			}
		}
		console.log(`${best.toFixed(1)} ms  ${String(buffers).padStart(6)} buf  ${label}`);
		console.log(`        ${shape}`);
	}
});
await db.close();
