// Throwaway probe: build a world, run the SQL in the file named on the
// command line, print each statement's rows. Not part of the app.
//
//   node scripts/probe.ts path/to/queries.sql [size] [today]
//
// Statements are separated by a line containing only `;;`.
import { readFileSync } from 'node:fs';
import { createTestDb, type WorldSize } from '../src/lib/server/db/pglite.ts';

const file = process.argv[2];
const size = (process.argv[3] ?? 'demo') as WorldSize;
const today = process.argv[4] ?? '2026-09-17';

const started = Date.now();
const db = await createTestDb({ size, today });
console.log(`built ${size} as of ${today} in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

const statements = readFileSync(file, 'utf8')
	.split(/^;;$/m)
	.map((s) => s.trim())
	.filter((s) => s.length > 0 && !s.startsWith('--skip'));

await db.asSystem(async (tx) => {
	for (const [i, sql] of statements.entries()) {
		const label = sql.split('\n')[0].slice(0, 90);
		console.log(`\n=== [${i}] ${label}`);
		try {
			const rows = await tx.query(sql);
			if (rows.length === 0) console.log('(no rows)');
			else console.log(JSON.stringify(rows.slice(0, 40), null, 1));
			if (rows.length > 40) console.log(`... ${rows.length} rows total`);
		} catch (error) {
			console.log(`ERROR: ${(error as Error).message}`);
		}
	}
});

await db.close();
