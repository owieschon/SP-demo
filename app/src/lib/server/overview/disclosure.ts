/*
  What this reader may be shown.

  A roles branch is landing separately with scope, authority and disclosure.
  Disclosure is the part that matters here: it decides, per person, whether
  unit cost and margin may appear at all. That model may or may not be in the
  database this code is running against, so this file asks Postgres rather
  than assuming, and the overview behaves sensibly either way.

  When the model is absent, the answer is yes, which is what every other
  screen in this app does today: /parts shows margin, the part page shows
  cost. Leaving it out instead would change existing behaviour on the strength
  of a table that does not exist.

  When the model is present and the answer is no, the figures are left out of
  the payload entirely. Hiding them in the markup would still put cost on the
  wire and in the page source, which is not the same thing as not showing it.
*/
import type { Db, Tx } from '../db/types.ts';

export interface Disclosure {
	/** True when this reader may be shown unit cost. */
	cost: boolean;
	/** True when this reader may be shown gross margin. */
	margin: boolean;
	/** False when the roles model is not in this database at all. */
	modelPresent: boolean;
}

export const OPEN: Disclosure = { cost: true, margin: true, modelPresent: false };

/*
  nl.may_see(user_id, fact_kind) comes from the roles migration. It cannot be
  named in a query that has to parse on a database without it, so the
  existence check is its own statement and the call is only made when it
  passes. to_regprocedure returns null rather than raising for a function that
  is not there.
*/
export async function readDisclosure(tx: Tx, userId: number): Promise<Disclosure> {
	const [present] = await tx.sql<{ ok: boolean }>`
		select pg_catalog.to_regprocedure('nl.may_see(int,text)') is not null as ok`;
	if (!present?.ok) return OPEN;

	const [row] = await tx.sql<{ cost: boolean; margin: boolean }>`
		select nl.may_see(${userId}, 'unit_cost') as cost,
		       nl.may_see(${userId}, 'margin')    as margin`;
	return {
		cost: row?.cost === true,
		margin: row?.margin === true,
		modelPresent: true
	};
}

/** The same question from outside a transaction, for a load function. */
export function disclosureFor(db: Db, userId: number): Promise<Disclosure> {
	return db.asUser(userId, (tx) => readDisclosure(tx, userId));
}
