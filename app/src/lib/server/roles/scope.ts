// "Mine" and "everyone" on a list.
//
// Every list starts at the signed-in person's own scope. The switch to
// everyone stays, and it is honest about what it would show: it carries the
// count of the wider view, so "Everyone 3,412" tells you before you click
// that you are about to ask for the whole book.
//
// This replaces seesEveryoneByDefault(user), which read the old role column
// and said "an account manager sees their own, everybody else sees all". That
// was a guess about a role; this is the person's actual scope. Somebody who
// holds the whole dimension has no narrower view to offer, so their list
// opens on everyone and the switch is not drawn at all.
import type { Db, Tx } from '../db/types.ts';
import type { ScopeDimension } from '$lib/roles/types';

export type Who = 'mine' | 'all';

/** What a list page hands to the layout so the switch can draw itself. */
export interface WhoChoice {
	who: Who;
	/** False when this person holds the whole dimension: there is no "mine". */
	canNarrow: boolean;
	/** How many rows the wider view holds, so the switch can say so. */
	allCount: number | null;
	/** How many rows their own slice holds. */
	mineCount: number | null;
}

/** Does this person hold every value in the dimension? */
export async function holdsWholeDimension(
	db: Db,
	userId: number,
	dimension: ScopeDimension
): Promise<boolean> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ all: boolean }>`select nl.scope_is_all(${userId}, ${dimension}) as all`
	);
	return row.all;
}

/** The same question inside a transaction the caller already opened. */
export async function holdsWholeDimensionIn(
	tx: Tx,
	userId: number,
	dimension: ScopeDimension
): Promise<boolean> {
	const [row] = await tx.sql<{ all: boolean }>`
		select nl.scope_is_all(${userId}, ${dimension}) as all`;
	return row.all;
}

/**
 * Read `who` from the address bar, defaulting to the person's own slice.
 * A person who holds the whole dimension is put on 'all' whatever the URL
 * says, because "mine" would be the same list and the switch would lie.
 */
export function readWho(
	params: URLSearchParams,
	options: { holdsAll: boolean; key?: string }
): Who {
	if (options.holdsAll) return 'all';
	const asked = params.get(options.key ?? 'who');
	return asked === 'all' ? 'all' : 'mine';
}

/**
 * How many accounts are in this person's own slice, and how many exist.
 *
 * This is what makes the Mine / Everyone switch honest. Before it, both sides
 * looked the same until you clicked, so "Everyone" was a dare rather than a
 * choice. The numbers count accounts, not filtered rows: the switch says what
 * the two slices of the book are, and the list's own row count says what the
 * filters then left.
 *
 * It counts nl.customers rather than nl.account_list, which is one row per
 * customer as well but aggregates a year of invoices to get there.
 */
export async function accountCounts(
	db: Db,
	userId: number
): Promise<{ mine: number; everyone: number }> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ mine: number; everyone: number }>`
			with me as (select nl.scope_is_all(${userId}, 'account') as all_accounts)
			select
				count(*)::int as everyone,
				count(*) filter (
					where (select all_accounts from me)
					   or exists (select 1 from nl.user_scope sc
					              where sc.user_id = ${userId}
					                and sc.dimension = 'account'
					                and sc.value = c.customer_no))::int as mine
			from nl.customers c`
	);
	return { mine: row.mine, everyone: row.everyone };
}

/** The customer numbers in somebody's account scope, for a list's WHERE clause. */
export async function myAccountsIn(tx: Tx, userId: number): Promise<string[]> {
	const rows = await tx.sql<{ value: string }>`
		select value from nl.user_scope
		where user_id = ${userId} and dimension = 'account' and value is not null`;
	return rows.map((r) => r.value);
}
