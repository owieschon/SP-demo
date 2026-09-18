// The data dictionary: what every field a person or an agent reads actually
// means.
//
// nl.describe_data() is the one source, so the /dictionary page, the
// assistant and an MCP client all read the same sentences. It returns fields
// in the order the columns are in, which is the order somebody looking at the
// table would see them.
import type { Db } from '../db/types.ts';
import type { DictionaryEntity, DictionaryField } from '$lib/policy/types';

interface FieldDb {
	entity: string;
	field: string;
	label: string;
	meaning: string;
	unit: string;
	source: string;
	derivation: string;
	example: string;
	shareable: boolean;
}

function toField(r: FieldDb): DictionaryField {
	return {
		entity: r.entity,
		field: r.field,
		label: r.label,
		meaning: r.meaning,
		unit: r.unit,
		source: r.source as DictionaryField['source'],
		derivation: r.derivation,
		example: r.example,
		shareable: r.shareable
	};
}

/** Every documented field, or only one table when an entity is named. */
export async function readDictionary(
	db: Db,
	userId: number,
	entity?: string | null
): Promise<DictionaryField[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<FieldDb>(`select * from nl.describe_data($1)`, [entity && entity !== '' ? entity : null])
	);
	return rows.map(toField);
}

/** The same, grouped by table, which is how the page shows it. */
export async function readDictionaryByEntity(
	db: Db,
	userId: number
): Promise<DictionaryEntity[]> {
	const fields = await readDictionary(db, userId);
	const groups = new Map<string, DictionaryField[]>();
	for (const field of fields) {
		const list = groups.get(field.entity);
		if (list) list.push(field);
		else groups.set(field.entity, [field]);
	}
	return [...groups.entries()].map(([entity, list]) => ({
		entity,
		fields: list,
		shareableCount: list.filter((one) => one.shareable).length
	}));
}

/**
 * Anywhere the dictionary and the schema disagree. The tests require this to
 * be empty; a page shows it because a dictionary nobody checks is worse than
 * no dictionary.
 */
export async function dictionaryGaps(
	db: Db,
	userId: number
): Promise<{ entity: string; field: string; problem: string }[]> {
	return db.asUser(userId, (tx) =>
		tx.sql<{ entity: string; field: string; problem: string }>`
			select entity, field, problem from nl.data_dictionary_gaps
			order by entity, field`
	);
}
