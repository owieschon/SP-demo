/*
  What this reader may be shown.

  Disclosure decides, fact kind by fact kind, whether a value may appear at
  all. The vocabulary and the lists are not this feature's: they belong to the
  desk agent's policy and to nl.disclosure_allows(), and a test in the roles
  work already holds those two to each other. So this file asks the database
  which level the reader holds and then asks the app's own maySee() what that
  level allows. Nothing here decides anything.

  Two fact kinds matter on the overview: `unit_cost` and `margin`. Everything
  else it shows (an account name, a price the customer paid, a lead time, a
  commitment) is allowed at every level, and a page that invented a stricter
  rule than /accounts and /parts already apply would be lying about the
  product rather than protecting anything.

  When a figure is not allowed it is left OUT of the assembled payload. Hiding
  it in the markup would still put cost in the JSON the browser received, in
  the response an outside agent reads, and in anything that logs a payload.
  The tests check the payload, not the rendering.

  The existence check is still here even though the roles model has landed on
  main, for two reasons: this branch is merged into a database that may not
  have 0031 yet, and a feature that silently assumes a table is a feature that
  fails loudly the one time it is wrong.
*/
import type { Db, Tx } from '../db/types.ts';
import { maySee } from '../roles/disclosure.ts';
import type { Disclosure as Level } from '$lib/desk/types';

export interface Disclosure {
	/** The level this reader holds, or null when the model is absent. */
	level: Level | null;
	/** True when this reader may be shown unit cost. */
	cost: boolean;
	/** True when this reader may be shown gross margin. */
	margin: boolean;
	/** False when the roles model is not in this database at all. */
	modelPresent: boolean;
}

/*
  What the overview did before disclosure existed, and what it does on a
  database without the roles model: show everything, the way /parts and the
  part page already do. Leaving cost out on the strength of a table that is
  not there would change existing behaviour for no reason.
*/
export const OPEN: Disclosure = { level: null, cost: true, margin: true, modelPresent: false };

/** A level turned into the two answers this page needs. */
export function fromLevel(level: Level): Disclosure {
	return {
		level,
		cost: maySee(level, 'unit_cost'),
		margin: maySee(level, 'margin'),
		modelPresent: true
	};
}

/*
  nl.disclosure_for() comes from the roles migration. It cannot be named in a
  query that has to parse on a database without it, so the existence check is
  its own statement and the call is only made when it passes. to_regprocedure
  returns null rather than raising for a function that is not there.
*/
export async function readDisclosure(tx: Tx, userId: number): Promise<Disclosure> {
	const [present] = await tx.sql<{ ok: boolean }>`
		select pg_catalog.to_regprocedure('nl.disclosure_for(int)') is not null as ok`;
	if (!present?.ok) return OPEN;

	const [row] = await tx.sql<{ level: Level }>`
		select nl.disclosure_for(${userId}) as level`;
	return fromLevel(row.level);
}

/** The same question from outside a transaction, for a load function. */
export function disclosureFor(db: Db, userId: number): Promise<Disclosure> {
	return db.asUser(userId, (tx) => readDisclosure(tx, userId));
}
