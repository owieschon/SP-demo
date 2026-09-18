// Where a column's declared purpose comes from.
//
// The intention is the data dictionary: one place that says, beside the
// column itself, what it means and who it is for, so a buyer's part row and a
// salesperson's come out of one query and one declaration. The dictionary is
// not on main yet, so the declarations sit in $lib/roles/columns.ts instead.
//
// This is the seam. It asks the database whether the dictionary has landed
// and reports the answer, which /people shows, so nobody has to guess which
// source a screen is really using. When the dictionary arrives, this file
// grows a reader and columns.ts empties out; nothing above either of them
// changes.
import type { Db } from '../db/types.ts';

export type ColumnSource = 'declared in the app' | 'the data dictionary';

/** Has the data dictionary landed in this database? */
export async function dictionaryPresent(db: Db): Promise<boolean> {
	const [row] = await db.asVisitor((tx) =>
		tx.sql<{ present: boolean }>`
			select exists (
				select 1 from pg_class c
				join pg_namespace n on n.oid = c.relnamespace
				where n.nspname = 'nl' and c.relname = 'data_dictionary') as present`
	);
	return row.present;
}

export async function columnSource(db: Db): Promise<ColumnSource> {
	return (await dictionaryPresent(db)) ? 'the data dictionary' : 'declared in the app';
}

/**
 * The other half of the same question: has the policy engine landed? If it
 * has, nl.authority_limit_override resolves a ceiling through
 * nl.resolve_policy and nl.authority_grants keeps only the grant. Migration
 * 0031 feature-detects it by name and by argument types; this is so the page
 * can say which one answered.
 */
export async function policyEnginePresent(db: Db): Promise<boolean> {
	const [row] = await db.asVisitor((tx) =>
		tx.sql<{ present: boolean }>`
			select exists (
				select 1 from pg_proc p
				join pg_namespace n on n.oid = p.pronamespace
				where n.nspname = 'nl'
				  and p.proname = 'resolve_policy'
				  and pg_get_function_identity_arguments(p.oid) = 'text, jsonb') as present`
	);
	return row.present;
}
