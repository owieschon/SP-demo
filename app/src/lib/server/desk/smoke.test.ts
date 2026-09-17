import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';

let db: Db;
beforeAll(async () => {
	db = await createTestDb({ today: '2026-09-17' });
});
afterAll(async () => {
	await db?.close();
});

it('builds', async () => {
	const msgs = await db.asSystem((tx) => tx.sql`select id, mailbox_id, from_address, subject, length(body_text) as len from nl.mail_messages order by id`);
	const breaks = await db.asSystem((tx) => tx.sql<{ n: number }>`select count(*)::int as n from nl.quantity_breaks`);
	const priced = await db.asSystem((tx) => tx.sql`
		select * from nl.desk_price_for((select customer_no from nl.customers where not blocked and not closed order by customer_no limit 1),
		 (select item_no from nl.quantity_breaks order by item_no limit 1), 12, null)`);
	expect({ msgs, breaks: breaks[0].n, priced }).toEqual('SHOW ME');
});
