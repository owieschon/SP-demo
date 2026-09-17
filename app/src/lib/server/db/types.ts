// The one database interface the app uses.
//
// Two implementations sit behind it: Supabase Postgres through the `postgres`
// package (postgres.ts), and PGlite, which is Postgres compiled to
// WebAssembly running inside this Node process (pglite.ts). Both run the
// same SQL, so nothing above this folder knows which one it is talking to.

/**
 * A value that can be passed as a query parameter. Anything structured is
 * sent as JSON text and cast in SQL (`$1::jsonb`), which both drivers treat
 * the same way.
 */
export type Param = string | number | boolean | null;

export type Row = Record<string, unknown>;

/** A transaction in progress. */
export interface Tx {
	/** Run one statement with $1, $2 ... placeholders and return its rows. */
	query<T extends object = Row>(text: string, params?: readonly Param[]): Promise<T[]>;
	/**
	 * The same thing, written as a tagged template:
	 *
	 *   tx.sql`select * from nl.users where id = ${id}`
	 *
	 * Every ${...} becomes a numbered parameter. Values are never pasted into
	 * the SQL text, so a value can never change what the statement does.
	 */
	sql<T extends object = Row>(strings: TemplateStringsArray, ...values: Param[]): Promise<T[]>;
}

export interface Db {
	readonly kind: 'postgres' | 'pglite';
	/**
	 * A transaction as a signed-in user. It runs as role nl_app with
	 * nl.user_id set, so row-level security decides what it may touch.
	 */
	asUser<T>(userId: number, work: (tx: Tx) => Promise<T>): Promise<T>;
	/** A transaction as nobody yet (the sign-in page): role nl_app, no user. */
	asVisitor<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
	/**
	 * A transaction as the connection's own role, which is not subject to
	 * row-level security. Only for jobs, rebuilding the world and test setup.
	 */
	asSystem<T>(work: (tx: Tx) => Promise<T>): Promise<T>;
	close(): Promise<void>;
}

/** Turn a tagged template into SQL text with $n placeholders and a parameter list. */
export function fromTemplate(
	strings: TemplateStringsArray,
	values: readonly Param[]
): { text: string; params: Param[] } {
	let text = strings[0];
	for (let i = 1; i < strings.length; i++) {
		text += `$${i}${strings[i]}`;
	}
	return { text, params: [...values] };
}

/**
 * The statements that start every user or visitor transaction. `set local`
 * lasts until the transaction ends, which is what makes this safe behind a
 * connection pooler that hands the same connection to someone else next.
 */
export function roleSetup(userId: number | null): { text: string; params: Param[] }[] {
	return [
		{ text: 'set local role nl_app', params: [] },
		{
			text: "select set_config('nl.user_id', $1, true)",
			params: [userId === null ? '' : String(userId)]
		}
	];
}
