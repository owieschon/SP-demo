// Global search: one box, three kinds of record.
//
//   accounts  starts the number, the name or the city; or name words
//   parts     starts the number; or description words
//   vendors   starts the number or the name; or name words
//
// Each group returns at most SEARCH_GROUP_LIMIT rows plus how many matched.
//
// Speed: a number, a name start or a city is matched as a prefix,
// lower(column) like 'abc%', which the text_pattern_ops indexes in migration
// 0015 answer as range scans. Words inside a name or description ('%abc%')
// cannot use a btree, so that condition means reading the table (a few
// thousand rows: milliseconds, and no database extension needed). A query
// that looks like a number ('10012', 'V1003') skips the name words for
// accounts and vendors: the words condition becomes `false and ...`, which
// Postgres drops when it plans the query with the values filled in, leaving
// only indexed prefix conditions.
//
// What the person typed is always data: it travels as a query parameter,
// and % and _ in it are escaped, so "50%" looks for the text "50%", not
// "50 followed by anything".
import type { Db } from '../db/types.ts';
import type { SearchAccount, SearchPart, SearchResults, SearchVendor } from '$lib/components/catalog/types';

export const SEARCH_GROUP_LIMIT = 10;

/** Longest query we look at, and how many words of it. */
const MAX_QUERY_LENGTH = 80;
const MAX_WORDS = 6;

/**
 * Escape the characters LIKE treats specially, so they match themselves.
 * Postgres's default escape character for LIKE is the backslash.
 */
export function escapeLike(text: string): string {
	return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 'Abc' -> 'abc%': matches values that start with the text (compare with lower(column)). */
export function prefixPattern(text: string): string {
	return `${escapeLike(text.toLowerCase())}%`;
}

/** 'abc' -> '%abc%': matches values that contain the text (use with ilike). */
export function containsPattern(text: string): string {
	return `%${escapeLike(text)}%`;
}

/** The query cleaned up: trimmed, spaces collapsed, capped. */
export function cleanQuery(raw: string | null | undefined): string {
	return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH);
}

/**
 * One token with a digit in its first four characters: 10012, V10010, L3515-630SC.
 * Names are not searched for these (see the note at the top).
 */
export function looksLikeNumber(q: string): boolean {
	return /^[A-Za-z]{0,3}[0-9][A-Za-z0-9.-]*$/.test(q);
}

/** The words of a cleaned query, each as a "contains" pattern (JSON for the SQL below). */
export function wordPatterns(q: string): string {
	const words = q.split(' ').filter(Boolean).slice(0, MAX_WORDS);
	return JSON.stringify(words.map(containsPattern));
}

export async function searchAll(db: Db, userId: number, raw: string): Promise<SearchResults> {
	const q = cleanQuery(raw);
	if (!q) {
		const empty = { rows: [], total: 0 };
		return { q, accounts: empty, parts: empty, vendors: empty };
	}
	const prefix = prefixPattern(q);
	const words = wordPatterns(q);
	const byName = !looksLikeNumber(q);

	return db.asUser(userId, async (tx) => {
		// The whole query starts the number, the name or the city, or every
		// word of it appears in the name (in any order). Exact number first, then
		// names that start with the query, then the rest by name.
		const accounts = await tx.sql<SearchAccount & { total: number }>`
			select c.customer_no as "customerNo", c.name, c.city, c.state, c.country, c.closed,
			       count(*) over ()::int as total
			from nl.customers c
			where lower(c.customer_no) like ${prefix}
			   or lower(c.city) like ${prefix}
			   or lower(c.name) like ${prefix}
			   or (${byName}::boolean and c.name ilike all (array(select jsonb_array_elements_text(${words}::jsonb))))
			order by lower(c.customer_no) = ${q.toLowerCase()} desc,
			         lower(c.name) like ${prefix} desc,
			         c.closed,
			         c.name,
			         c.customer_no
			limit ${SEARCH_GROUP_LIMIT}`;

		// Descriptions are always searched by word: '8 chrome' and '144' are
		// both ways people look for a part.
		const parts = await tx.sql<SearchPart & { total: number }>`
			select i.item_no as "itemNo", i.description, i.blocked,
			       count(*) over ()::int as total
			from nl.items i
			where lower(i.item_no) like ${prefix}
			   or i.description ilike all (array(select jsonb_array_elements_text(${words}::jsonb)))
			order by lower(i.item_no) = ${q.toLowerCase()} desc,
			         lower(i.item_no) like ${prefix} desc,
			         i.blocked,
			         i.item_no
			limit ${SEARCH_GROUP_LIMIT}`;

		const vendors = await tx.sql<SearchVendor & { total: number }>`
			select v.vendor_no as "vendorNo", v.name, v.city, v.state,
			       count(*) over ()::int as total
			from nl.vendors v
			where lower(v.vendor_no) like ${prefix}
			   or lower(v.name) like ${prefix}
			   or (${byName}::boolean and v.name ilike all (array(select jsonb_array_elements_text(${words}::jsonb))))
			order by lower(v.vendor_no) = ${q.toLowerCase()} desc,
			         lower(v.name) like ${prefix} desc,
			         v.name
			limit ${SEARCH_GROUP_LIMIT}`;

		return {
			q,
			accounts: group(accounts),
			parts: group(parts),
			vendors: group(vendors)
		};
	});
}

/** Split the window count off the rows. */
function group<T extends { total: number }>(rows: T[]): { rows: Omit<T, 'total'>[]; total: number } {
	return {
		total: rows[0]?.total ?? 0,
		rows: rows.map(({ total: _total, ...row }) => row)
	};
}
