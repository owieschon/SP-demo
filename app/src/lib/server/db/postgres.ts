// Supabase Postgres, through the `postgres` package.
import postgres from 'postgres';
import { fromTemplate, roleSetup, type Db, type Param, type Row, type Tx } from './types.ts';

// What the custom type parsers below turn each Postgres type into.
type ParsedTypes = { dateText: string; numericNumber: number; bigintNumber: number; jsonText: unknown };

export function createPostgresDb(url: string): Db {
	const client = postgres(url, {
		// Supabase's transaction pooler hands every transaction to whichever
		// server connection is free, so a prepared statement cannot be reused.
		prepare: false,
		max: 4,
		idle_timeout: 20,
		connect_timeout: 15,
		onnotice: () => {},
		// Both database drivers return the same JavaScript types (see pglite.ts).
		types: {
			// Plain dates stay 'YYYY-MM-DD' text. A Date object would shift them by the time zone.
			dateText: {
				to: 1082,
				from: [1082],
				serialize: (value: string) => value,
				parse: (raw: string) => raw
			},
			// Money comes back as a number. Every amount in this app fits a double exactly enough.
			numericNumber: {
				to: 1700,
				from: [1700],
				serialize: (value: number) => String(value),
				parse: (raw: string) => Number(raw)
			},
			// JSON goes in as text the app already encoded (see Param in types.ts).
			// Left to itself, the driver sees `$1::jsonb`, JSON-encodes that
			// text a second time, and Postgres receives a string instead of an
			// array or object. PGlite does not do this, so only Supabase showed it.
			jsonText: {
				to: 3802,
				from: [114, 3802],
				serialize: (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)),
				parse: (raw: string) => JSON.parse(raw)
			},
			// So do counts and ids.
			bigintNumber: {
				to: 20,
				from: [20],
				serialize: (value: number) => String(value),
				parse: (raw: string) => Number(raw)
			}
		}
	});

	function wrap(sql: postgres.TransactionSql<ParsedTypes>): Tx {
		async function query<T extends object = Row>(text: string, params: readonly Param[] = []) {
			const rows = await sql.unsafe(text, params as Param[]);
			return rows as unknown as T[];
		}
		return {
			query,
			sql: <T extends object = Row>(strings: TemplateStringsArray, ...values: Param[]) => {
				const q = fromTemplate(strings, values);
				return query<T>(q.text, q.params);
			}
		};
	}

	async function transaction<T>(
		setup: { text: string; params: Param[] }[],
		work: (tx: Tx) => Promise<T>
	): Promise<T> {
		const result = await client.begin(async (sql) => {
			for (const step of setup) {
				await sql.unsafe(step.text, step.params);
			}
			// Wrapped in an object so postgres.js does not try to unwrap an array result.
			return { value: await work(wrap(sql)) };
		});
		return (result as { value: T }).value;
	}

	return {
		kind: 'postgres',
		asUser: (userId, work) => transaction(roleSetup(userId), work),
		asVisitor: (work) => transaction(roleSetup(null), work),
		asSystem: (work) => transaction([], work),
		close: () => client.end({ timeout: 5 })
	};
}
