// The SQL tool: one read-only SELECT, checked here and refused again by
// Postgres.
//
// Three fences, in order of how much they are trusted:
//   1. Postgres. The query runs through db.asReadonly, which is a READ ONLY
//      transaction as role nl_readonly: it has SELECT on the business tables
//      and no grant at all on the tables about people (nl.users, nl.contacts,
//      nl.activities, and every table in migration 0017). Any write is
//      refused by the server itself, and statements time out after ten
//      seconds. This is the fence that actually holds.
//   2. This file. One statement, and it has to be a SELECT or a WITH ... SELECT.
//      Not because the model is expected to try something else, but because a
//      clear refusal is more useful than a Postgres error, and because a
//      second statement smuggled after a semicolon should never reach the
//      driver at all.
//   3. The wrapper. Rows come back as JSON data (wrap.ts), capped in rows and
//      in bytes.
import { MAX_SQL_ROWS } from './caps.ts';
import type { Db, Row } from '../db/types.ts';

/**
 * Words that start a statement that is not a SELECT, or that reach outside
 * the query. Checked with word boundaries anywhere in the text, so a write
 * hidden inside a CTE (`with x as (insert ...)`) is refused too.
 *
 * A column named `updated_at` is fine: \b requires a non-word character after
 * the word, and `updated_at` continues with "d".
 */
const FORBIDDEN = [
	'insert',
	'update',
	'delete',
	'merge',
	'truncate',
	'create',
	'alter',
	'drop',
	'grant',
	'revoke',
	'comment',
	'copy',
	'vacuum',
	'analyze',
	'reindex',
	'refresh',
	'cluster',
	'checkpoint',
	'call',
	'do',
	'set',
	'reset',
	'begin',
	'start',
	'commit',
	'rollback',
	'savepoint',
	'lock',
	'listen',
	'notify',
	'unlisten',
	'prepare',
	'execute',
	'deallocate',
	'declare',
	'fetch',
	'move',
	'close',
	'discard',
	'explain',
	'import',
	'load',
	'security'
];

/** Functions that write, wait, or read the machine the database runs on. */
const FORBIDDEN_CALLS = [
	'pg_sleep',
	'pg_sleep_for',
	'pg_sleep_until',
	'pg_read_file',
	'pg_read_binary_file',
	'pg_ls_dir',
	'pg_stat_file',
	'pg_terminate_backend',
	'pg_cancel_backend',
	'pg_advisory_lock',
	'pg_advisory_xact_lock',
	'pg_logical_emit_message',
	'pg_create_restore_point',
	'set_config',
	'current_setting', // the app's own settings are not the model's business
	'nextval',
	'setval',
	'lo_import',
	'lo_export',
	'dblink',
	'query_to_xml'
];

/**
 * The only functions in schema nl a query may call. Postgres lets anyone
 * execute some of them, and a read-only transaction would refuse whatever
 * they tried to write, but a query has no business calling a write function
 * at all, so the check is here as well as in the database.
 */
const ALLOWED_NL_FUNCTIONS = [
	'today',
	'kept_ratio',
	'customer_family',
	'customer_ancestors',
	'at_risk_days',
	'partial_export_ratio'
];

export type SqlCheck = { ok: true; sql: string } | { ok: false; reason: string };

/**
 * Is this one read-only SELECT? Returns the statement with any trailing
 * semicolon removed, ready to be wrapped.
 */
export function checkReadOnlySql(input: unknown): SqlCheck {
	if (typeof input !== 'string') return { ok: false, reason: 'A query is text.' };

	let sql = input.trim();
	if (sql.length === 0) return { ok: false, reason: 'The query is empty.' };
	if (sql.length > 4000) return { ok: false, reason: 'Keep a query under 4,000 characters.' };

	// Comments could hide a second statement from a reader, and no query this
	// tool needs to run has one.
	if (sql.includes('--') || sql.includes('/*')) {
		return { ok: false, reason: 'Comments are not allowed in a query here. Send the SELECT on its own.' };
	}

	// One trailing semicolon is fine. Any other one means a second statement.
	if (sql.endsWith(';')) sql = sql.slice(0, -1).trim();
	if (sql.includes(';')) {
		return { ok: false, reason: 'Send one statement. A semicolon inside the query is not allowed.' };
	}

	const lower = sql.toLowerCase();
	if (!/^(select|with)\b/.test(lower)) {
		return { ok: false, reason: 'Only a SELECT, or a WITH that ends in a SELECT, can run here.' };
	}

	for (const word of FORBIDDEN) {
		if (new RegExp(`\\b${word}\\b`).test(lower)) {
			return {
				ok: false,
				reason: `"${word}" is not allowed: this tool only reads. Nothing about this query ran.`
			};
		}
	}
	for (const call of FORBIDDEN_CALLS) {
		if (lower.includes(call)) {
			return { ok: false, reason: `"${call}" is not allowed here. Nothing about this query ran.` };
		}
	}
	// A WITH has to end in a SELECT, not in a data-changing statement. The
	// forbidden words above already cover that; this is the readable version
	// of the same rule for anything else that slipped through.
	if (/\breturning\b/.test(lower)) {
		return { ok: false, reason: 'RETURNING belongs to a write. This tool only reads.' };
	}

	// Calling one of the app's own write functions from inside a SELECT is
	// still a write. Only the handful of read helpers are allowed.
	for (const [, called] of lower.matchAll(/\bnl\.([a-z_][a-z0-9_]*)\s*\(/g)) {
		if (!ALLOWED_NL_FUNCTIONS.includes(called)) {
			return {
				ok: false,
				reason: `nl.${called}() cannot be called from a query. The ones you can call are ${ALLOWED_NL_FUNCTIONS.map((f) => `nl.${f}()`).join(', ')}.`
			};
		}
	}

	return { ok: true, sql };
}

/** The query as it is really run: theirs, inside ours, with a row cap. */
export function wrapQuery(sql: string): string {
	return `select * from (${sql}) q limit ${MAX_SQL_ROWS}`;
}

export interface SqlResult {
	rows: Row[];
	row_count: number;
	/** The row cap was reached, so there may be more. */
	capped: boolean;
	note?: string;
}

/**
 * Run one checked SELECT as nl_readonly. A refusal from Postgres (no grant on
 * a table, a write attempted anyway) comes back as a message, not a crash:
 * the model should see why and try something else.
 */
export async function runReadOnlySql(db: Db, sql: string): Promise<SqlResult | { error: string }> {
	const checked = checkReadOnlySql(sql);
	if (!checked.ok) return { error: checked.reason };
	try {
		const rows = await db.asReadonly((tx) => tx.query<Row>(wrapQuery(checked.sql)));
		return {
			rows,
			row_count: rows.length,
			capped: rows.length >= MAX_SQL_ROWS,
			...(rows.length >= MAX_SQL_ROWS
				? { note: `Stopped at ${MAX_SQL_ROWS} rows. Add a narrower condition or aggregate instead.` }
				: {})
		};
	} catch (error) {
		// Postgres says things like: permission denied for table users.
		const message = error instanceof Error ? error.message : String(error);
		return { error: `The database refused that query: ${message}` };
	}
}
