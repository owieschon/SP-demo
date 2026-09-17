// Regenerate the sample ERP exports in fixtures/exports/ from the small
// world, with today pinned, so the files never change unless the world or
// the generator does.
//
//   node scripts/exports.ts               today 2026-09-17
//   node scripts/exports.ts 2026-10-01    another day (the tests expect 2026-09-17)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTestDb } from '../src/lib/server/db/pglite.ts';
import { FIXTURE_FILE_NAMES, sampleFile } from '../src/lib/server/exports/samples.ts';
import type { SampleKind } from '../src/lib/components/exports/types.ts';

const today = process.argv[2] ?? '2026-09-17';
const outDir = resolve(process.cwd(), '..', 'fixtures', 'exports');
const kinds: SampleKind[] = ['yesterday', 'today', 'messy', 'partial', 'stale', 'wrong-report'];

const db = await createTestDb({ size: 'small', today });
mkdirSync(outDir, { recursive: true });

await db.asSystem(async (tx) => {
	for (const kind of kinds) {
		const file = await sampleFile(tx, kind);
		const name = FIXTURE_FILE_NAMES[kind](today);
		writeFileSync(join(outDir, name), file.text, 'utf8');
		// Data rows: every non-blank line after the header.
		const rows = file.text.split(/\r?\n/).filter((line) => line.trim() !== '').length - 1;
		console.log(`${name.padEnd(34)} ${String(rows).padStart(5)} rows`);
	}
});

await db.close();
