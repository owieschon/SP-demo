// Print the schema and world fingerprints (db/fingerprint.sql) for a
// freshly built local world, to compare with the same query on Supabase.
//
//   node scripts/fingerprint.ts                   full world as of 2026-09-17
//   node scripts/fingerprint.ts 2026-09-18        full world as of another day
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findDbDir } from '../src/lib/server/db/files.ts';
import { createTestDb } from '../src/lib/server/db/pglite.ts';

const today = process.argv[2] ?? '2026-09-17';
const db = await createTestDb({ size: 'full', today });
const sql = readFileSync(join(findDbDir(), 'fingerprint.sql'), 'utf8');

await db.asSystem(async (tx) => {
	await tx.query('select nl.answer_pushed_windows()');
	const [row] = await tx.query(sql);
	console.log(JSON.stringify(row, null, 2));
});
await db.close();
