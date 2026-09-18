// Disclosure, enforced on the payload rather than on the page.
//
// A column hidden in markup is still in the JSON the browser received, still
// in the response an agent reads, and still in anything that logs the
// payload. So the narrowing happens here, where the rows are assembled: a
// value an inside salesperson may not be told is not in the object at all.
//
// The vocabulary is the desk agent's. Its disclosure policy already decides,
// fact kind by fact kind, what may leave the building
// (app/src/lib/server/desk/policy.ts), and the database keeps the same lists
// in nl.disclosure_allows() so a screen and an outgoing draft cannot
// disagree. A test compares the two lists directly.
import { DISCLOSURE_ALLOWS } from '../desk/policy.ts';
import type { Disclosure, FactKind } from '$lib/desk/types';
import { columnsFor, type ColumnPurpose, type Purpose } from '$lib/roles/columns';
import type { Db } from '../db/types.ts';

/** What this level may be shown, from the app's own copy of the policy. */
export function allowedKinds(level: Disclosure): readonly FactKind[] {
	return DISCLOSURE_ALLOWS[level];
}

export function maySee(level: Disclosure, kind: FactKind): boolean {
	return DISCLOSURE_ALLOWS[level].includes(kind);
}

/** The database's copy, so a test can prove the two agree. */
export async function allowedKindsInDb(db: Db, level: Disclosure): Promise<string[]> {
	const [row] = await db.asVisitor((tx) =>
		tx.sql<{ kinds: string[] }>`select nl.disclosure_allows(${level}) as kinds`
	);
	return row.kinds;
}

/**
 * The columns a screen shows: the ones declared for this purpose, narrowed to
 * what this level allows. Same query behind it either way; a buyer's part row
 * carries landed cost and a salesperson's does not.
 */
export function columnsSeen(purpose: Purpose, level: Disclosure): ColumnPurpose[] {
	return columnsFor(purpose, DISCLOSURE_ALLOWS[level]);
}

/**
 * Narrow assembled rows to those columns. Keys the columns do not name are
 * dropped too, so a row cannot smuggle a value through by not being declared.
 */
export function assemble<T extends Record<string, unknown>>(
	rows: T[],
	columns: ColumnPurpose[]
): Record<string, unknown>[] {
	const keys = columns.map((c) => c.key);
	return rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const key of keys) {
			if (key in row) out[key] = row[key];
		}
		return out;
	});
}
