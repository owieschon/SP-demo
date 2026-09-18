// The data dictionary, read out of the database.
//
// Nothing in this feature invents an attribute. The extractors, the
// recognizers and the exploration tool all look one up here first, and an
// extraction that does not land on a row becomes an unparsed item rather
// than a claim. That is the single rule that makes a claim MEAN something.
//
// The dictionary may also belong to the policy engine, which is being built
// on another branch. Either way it is the same table under the same name with
// the same columns, so this reads it without caring which migration created
// it. If it is not there at all, loadDictionary answers with an empty map and
// every caller does nothing rather than guessing.
import type { Db, Tx } from '../db/types.ts';
import type { AttributeMeta, Surface, SubjectKind, ValueType, Disclosure } from '$lib/context/types';

interface AttributeRow {
	key: string;
	label: string;
	subject_kind: SubjectKind;
	value_type: ValueType;
	unit: string;
	allowed_values: string[];
	min_number: number | null;
	max_number: number | null;
	freshness_days: number | null;
	disclosure: Disclosure;
	surfaces: string[];
	needs_item: boolean;
	cross_check: string;
	note: string;
}

function toMeta(row: AttributeRow): AttributeMeta {
	return {
		key: row.key,
		label: row.label,
		subjectKind: row.subject_kind,
		valueType: row.value_type,
		unit: row.unit,
		allowedValues: row.allowed_values ?? [],
		minNumber: row.min_number,
		maxNumber: row.max_number,
		freshnessDays: row.freshness_days,
		disclosure: row.disclosure,
		surfaces: (row.surfaces ?? []) as Surface[],
		needsItem: row.needs_item,
		crossCheck: row.cross_check,
		note: row.note
	};
}

export type Dictionary = Map<string, AttributeMeta>;

/** Every active attribute, keyed by its own key. */
export async function loadDictionary(tx: Tx): Promise<Dictionary> {
	const present = await tx.sql<{ there: boolean }>`
		select pg_catalog.to_regclass('nl.context_attributes') is not null as there`;
	if (!present[0]?.there) return new Map();

	const rows = await tx.sql<AttributeRow>`
		select key, label, subject_kind, value_type, unit, allowed_values, min_number, max_number,
		       freshness_days, disclosure, surfaces, needs_item, cross_check, note
		from nl.context_attributes
		where active
		order by subject_kind, key`;
	return new Map(rows.map((row) => [row.key, toMeta(row)]));
}

/** The same, for a caller that has a Db rather than a transaction. */
export async function readDictionary(db: Db, userId: number): Promise<Dictionary> {
	return db.asUser(userId, (tx) => loadDictionary(tx));
}

/** The attributes for one kind of subject, in the order the screens show them. */
export function attributesFor(dictionary: Dictionary, subjectKind: SubjectKind): AttributeMeta[] {
	return [...dictionary.values()].filter((attribute) => attribute.subjectKind === subjectKind);
}

/** Our own part numbers, for the cross-reference recognizer. Capped. */
export async function loadPartNumbers(tx: Tx, limit = 5000): Promise<Set<string>> {
	const rows = await tx.query<{ item_no: string }>(
		'select item_no from nl.items order by item_no limit $1',
		[limit]
	);
	return new Set(rows.map((row) => row.item_no));
}

/** Whether the policy engine is answering, for the page to say so honestly. */
export async function policyEnginePresent(tx: Tx): Promise<boolean> {
	const rows = await tx.sql<{ there: boolean }>`
		select pg_catalog.to_regprocedure('nl.resolve_policy(text)') is not null as there`;
	return rows[0]?.there ?? false;
}
