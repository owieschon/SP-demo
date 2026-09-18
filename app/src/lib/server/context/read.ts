// The read path: what the screens and the agents ask for.
//
// The important one is contextFor, which serves a COMPILED bundle. It does no
// assembling: one index lookup and a jsonb read, which is why it answers in
// single-digit milliseconds whatever size the world is. Everything the agents
// need is in that one payload, including the citations, so there is no second
// round trip to find out where a fact came from.
//
// The rest is for the three screens: coverage, conflicts and one entity's
// context.
import type { Db, Tx } from '../db/types.ts';
import type {
	ContextBundle,
	ConflictRow,
	ConflictSide,
	CoverageGap,
	CoverageRow,
	ReviewItem,
	SubjectKind,
	Surface
} from '$lib/context/types';

/**
 * The compiled context bundle for one subject and purpose. This is what the
 * desk agent and the assistant should call instead of assembling context
 * themselves.
 *
 * It can answer three ways, and they are different things: served, served
 * but labelled stale (the mill is behind and this is the last good context),
 * or refused with a reason (nothing was ever compiled, or everything this
 * purpose needs has expired). It never hands back an empty object that reads
 * like "nothing is required here".
 */
export async function contextFor(
	db: Db,
	userId: number,
	subject: { kind: SubjectKind; id: string },
	purpose: Surface = 'internal_review'
): Promise<ContextBundle> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{ bundle: ContextBundle }>`
			select nl.context_for(${subject.kind}, ${subject.id}, ${purpose}) as bundle`
	);
	return rows[0].bundle;
}

/** One frozen version, so an eval replays against a bundle and not a database. */
export async function contextVersion(
	db: Db,
	userId: number,
	subject: { kind: SubjectKind; id: string },
	purpose: Surface,
	version: number
): Promise<ContextBundle | null> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{ bundle: ContextBundle | null }>`
			select nl.context_bundle_version(${subject.kind}, ${subject.id}, ${purpose}, ${version}) as bundle`
	);
	return rows[0]?.bundle ?? null;
}

/**
 * The value in force for one attribute, given the part and the ship-to the
 * question is about. Most specific scope wins, which is what makes a
 * customer-wide requirement and a customer-plus-part requirement both
 * correct and only one of them the answer.
 */
export async function contextValue(
	db: Db,
	userId: number,
	subject: { kind: SubjectKind; id: string },
	attribute: string,
	scope: { itemNo?: string | null; shipToNo?: string | null } = {}
) {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			fact_id: number;
			value_display: string;
			value_text: string | null;
			value_number: number | null;
			value_date: string | null;
			value_bool: boolean | null;
			value_json: Record<string, number> | null;
			unit: string;
			scope_key: string;
			specificity: number;
			confidence: number;
			decided_via: 'rule' | 'person';
			asserted_at: string;
			stale_after: string;
			citations: unknown;
		}>`
			select * from nl.context_value(${subject.kind}, ${subject.id}, ${attribute},
			                               ${scope.itemNo ?? null}, ${scope.shipToNo ?? null})`
	);
	return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Coverage: the work list
// ---------------------------------------------------------------------------

/** What we know, what is stale and what is missing. Worst rows first. */
export async function readCoverage(db: Db, userId: number, limit = 200): Promise<CoverageRow[]> {
	return db.asUser(userId, (tx) =>
		tx.query<CoverageRow>('select * from nl.context_coverage($1)', [limit])
	);
}

/** The subjects that matter most and have no fresh answer for one attribute. */
export async function readGaps(
	db: Db,
	userId: number,
	subjectKind: SubjectKind,
	attribute: string,
	limit = 12
): Promise<CoverageGap[]> {
	return db.asUser(userId, (tx) =>
		tx.query<CoverageGap>('select * from nl.context_gaps($1, $2, $3)', [subjectKind, attribute, limit])
	);
}

export interface SourceSummary {
	key: string;
	kind: string;
	name: string;
	trust_tier: number;
	refresh_cadence: string;
	authoritative_for: string;
	last_seen_at: string | null;
	documents: number;
	claims: number;
	facts: number;
}

/** The sources, with how much of what we believe came from each one. */
export async function readSources(db: Db, userId: number): Promise<SourceSummary[]> {
	return db.asUser(userId, (tx) =>
		tx.sql<SourceSummary>`
			select s.key, s.kind, s.name, s.trust_tier, s.refresh_cadence, s.authoritative_for,
			       s.last_seen_at,
			       (select count(*) from nl.source_documents d where d.source_key = s.key)::int as documents,
			       (select count(*) from nl.claims c
			        join nl.source_documents d on d.id = c.source_document_id
			        where d.source_key = s.key)::int as claims,
			       (select count(*) from nl.facts f
			        join nl.claims c on c.id = f.claim_ids[1]
			        join nl.source_documents d on d.id = c.source_document_id
			        where d.source_key = s.key and f.status = 'current')::int as facts
			from nl.sources s
			where s.active
			order by s.trust_tier desc, s.key`
	);
}

// ---------------------------------------------------------------------------
// Conflicts, and the "could not tell" queue
// ---------------------------------------------------------------------------

/**
 * One claim as the shape the conflict card reads. Built here rather than in
 * SQL so the column list lives in one place; the join to the source is what
 * carries the trust tier a person is really judging.
 */
async function claimSides(tx: Tx, ids: number[]): Promise<Map<number, ConflictSide>> {
	if (ids.length === 0) return new Map();
	const rows = await tx.query<ConflictSide & { claim_id: number }>(
		`select c.id as claim_id, c.value_display, s.key as source_key, s.name as source_name,
		        s.trust_tier, c.asserted_at, c.captured_at, c.confidence, c.locator, c.snippet,
		        c.extractor, c.extractor_version, d.ref_table, d.ref_id, d.title as document_title
		 from nl.claims c
		 join nl.source_documents d on d.id = c.source_document_id
		 join nl.sources s on s.key = d.source_key
		 where c.id = any ($1::bigint[])`,
		[`{${ids.join(',')}}`]
	);
	return new Map(rows.map((row) => [row.claim_id, row]));
}

export async function readConflicts(db: Db, userId: number, limit = 50): Promise<ConflictRow[]> {
	return db.asUser(userId, async (tx) => {
		const rows = await tx.query<{
			id: number;
			subject_kind: SubjectKind;
			subject_id: string;
			subject_name: string | null;
			attribute: string;
			attribute_label: string;
			scope_key: string;
			disagreement: number;
			reason: string;
			raised_at: Date;
			row_version: Date;
			winner_claim_id: number;
			rival_claim_id: number;
		}>(
			`select k.id, k.subject_kind, k.subject_id,
			        coalesce(cu.name, ve.name, it.description, ct.full_name) as subject_name,
			        k.attribute, a.label as attribute_label, k.scope_key, k.disagreement, k.reason,
			        k.raised_at, k.updated_at as row_version, k.winner_claim_id, k.rival_claim_id
			 from nl.context_conflicts k
			 join nl.context_attributes a on a.key = k.attribute
			 left join nl.customers cu on k.subject_kind = 'customer' and cu.customer_no = k.subject_id
			 left join nl.vendors ve on k.subject_kind = 'vendor' and ve.vendor_no = k.subject_id
			 left join nl.items it on k.subject_kind = 'item' and it.item_no = k.subject_id
			 left join nl.contacts ct on k.subject_kind = 'contact' and ct.id::text = k.subject_id
			 where k.status = 'open'
			 order by k.disagreement desc, k.raised_at desc
			 limit $1`,
			[limit]
		);
		const sides = await claimSides(
			tx,
			rows.flatMap((row) => [row.winner_claim_id, row.rival_claim_id])
		);
		return rows
			.map((row) => {
				const winner = sides.get(row.winner_claim_id);
				const rival = sides.get(row.rival_claim_id);
				if (!winner || !rival) return null;
				return {
					id: row.id,
					subject_kind: row.subject_kind,
					subject_id: row.subject_id,
					subject_name: row.subject_name,
					attribute: row.attribute,
					attribute_label: row.attribute_label,
					scope_key: row.scope_key,
					disagreement: row.disagreement,
					reason: row.reason,
					raised_at: row.raised_at.toISOString(),
					row_version: row.row_version.toISOString(),
					winner,
					rival
				} satisfies ConflictRow;
			})
			.filter((row): row is ConflictRow => row !== null);
	});
}

/** The "I could not tell what this means" queue, and failed validations. */
export async function readReviewItems(db: Db, userId: number, limit = 50): Promise<ReviewItem[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.query<Omit<ReviewItem, 'created_at' | 'row_version'> & { created_at: Date; row_version: Date }>(
			`select i.id, i.kind, i.subject_kind, i.subject_id, i.subject_raw,
			        coalesce(cu.name, ve.name, it.description, ct.full_name) as subject_name,
			        i.proposed_attribute, i.locator, i.snippet, i.reason,
			        i.extractor, i.extractor_version, i.created_at, i.updated_at as row_version,
			        s.key as source_key, s.name as source_name, d.title as document_title,
			        d.ref_table, d.ref_id
			 from nl.context_review_items i
			 join nl.source_documents d on d.id = i.source_document_id
			 join nl.sources s on s.key = d.source_key
			 left join nl.customers cu on i.subject_kind = 'customer' and cu.customer_no = i.subject_id
			 left join nl.vendors ve on i.subject_kind = 'vendor' and ve.vendor_no = i.subject_id
			 left join nl.items it on i.subject_kind = 'item' and it.item_no = i.subject_id
			 left join nl.contacts ct on i.subject_kind = 'contact' and ct.id::text = i.subject_id
			 where i.status = 'open'
			 order by i.created_at desc, i.id desc
			 limit $1`,
			[limit]
		)
	);
	return rows.map((row) => ({
		...row,
		created_at: row.created_at.toISOString(),
		row_version: row.row_version.toISOString()
	}));
}

// ---------------------------------------------------------------------------
// One entity's context, for the third screen
// ---------------------------------------------------------------------------

export interface EntityFactRow {
	fact_id: number;
	attribute: string;
	attribute_label: string;
	value_display: string;
	unit: string;
	scope_key: string;
	scope_item_no: string | null;
	scope_ship_to_no: string | null;
	scope_item_family: string | null;
	specificity: number;
	confidence: number;
	decided_via: 'rule' | 'person';
	decided_rule: string;
	decided_by_name: string | null;
	disclosure: string;
	surfaces: string[];
	asserted_at: string;
	valid_to: string | null;
	stale_after: string;
	stale: boolean;
	expired: boolean;
	days_stale: number;
	citations: unknown;
	claim_count: number;
}

export interface EntityContext {
	subject: { kind: SubjectKind; id: string; name: string | null };
	facts: EntityFactRow[];
	/** Attributes in the dictionary for this kind that we know nothing about. */
	missing: { attribute: string; label: string; disclosure: string }[];
	openConflicts: number;
	/** The current bundle per purpose, so the page can show its age. */
	bundles: {
		purpose: Surface;
		version: number;
		content_hash: string;
		built_at: string;
		facts: number;
		playbooks: number;
	}[];
	/** Which agent actions read which bundle version. The honesty mechanism. */
	reads: {
		action: string;
		entity: string;
		entity_id: string;
		purpose: string;
		bundle_version: number;
		read_at: string;
		actor_name: string | null;
	}[];
	playbooks: { key: string; title: string; version: number; reviewed_at: string | null }[];
}

export async function readEntityContext(
	db: Db,
	userId: number,
	subject: { kind: SubjectKind; id: string }
): Promise<EntityContext | null> {
	return db.asUser(userId, async (tx) => {
		const [name] = await tx.sql<{ name: string | null }>`
			select case ${subject.kind}
			         when 'customer' then (select c.name from nl.customers c where c.customer_no = ${subject.id})
			         when 'vendor'   then (select v.name from nl.vendors v where v.vendor_no = ${subject.id})
			         when 'item'     then (select i.description from nl.items i where i.item_no = ${subject.id})
			         when 'contact'  then (select ct.full_name from nl.contacts ct where ct.id::text = ${subject.id})
			       end as name`;
		// A subject that is not in the book at all has no context page: that is
		// a 404, not an empty one.
		if (!name || name.name === null) return null;

		const facts = await tx.sql<
			Omit<EntityFactRow, 'asserted_at' | 'stale_after' | 'valid_to'> & {
				asserted_at: string;
				stale_after: string;
				valid_to: string | null;
			}
		>`
			select f.id as fact_id, f.attribute, f.attribute_label, f.value_display, f.unit,
			       f.scope_key, f.scope_item_no, f.scope_ship_to_no, f.scope_item_family,
			       f.scope_specificity as specificity, f.confidence, f.decided_via, f.decided_rule,
			       u.full_name as decided_by_name, f.disclosure, f.surfaces,
			       f.asserted_at, f.valid_to, f.stale_after, f.stale, f.expired,
			       greatest(f.days_stale, 0) as days_stale, f.citations,
			       cardinality(f.claim_ids) as claim_count
			from nl.fact_state f
			left join nl.users u on u.id = f.decided_by
			where f.subject_kind = ${subject.kind} and f.subject_id = ${subject.id}
			order by f.stale desc, f.attribute, f.scope_specificity desc`;

		const missing = await tx.sql<{ attribute: string; label: string; disclosure: string }>`
			select a.key as attribute, a.label, a.disclosure
			from nl.context_attributes a
			where a.active and a.subject_kind = ${subject.kind}
			  and not exists (select 1 from nl.facts f
			                  where f.subject_kind = ${subject.kind} and f.subject_id = ${subject.id}
			                    and f.attribute = a.key and f.status = 'current')
			order by a.key`;

		const [conflicts] = await tx.sql<{ n: number }>`
			select count(*)::int as n from nl.context_conflicts
			where subject_kind = ${subject.kind} and subject_id = ${subject.id} and status = 'open'`;

		const bundles = await tx.sql<{
			purpose: Surface;
			version: number;
			content_hash: string;
			built_at: Date;
			facts: number;
			playbooks: number;
		}>`
			select b.purpose, b.version, b.content_hash, b.built_at,
			       coalesce((b.inputs ->> 'facts')::int, 0) as facts,
			       coalesce((b.inputs ->> 'playbooks')::int, 0) as playbooks
			from nl.context_bundles b
			where b.subject_kind = ${subject.kind} and b.subject_id = ${subject.id} and b.is_current
			order by b.purpose`;

		const reads = await tx.sql<{
			action: string;
			entity: string;
			entity_id: string;
			purpose: string;
			bundle_version: number;
			read_at: Date;
			actor_name: string | null;
		}>`
			select r.action, r.entity, r.entity_id, r.purpose, r.bundle_version, r.read_at,
			       u.full_name as actor_name
			from nl.context_reads r
			left join nl.users u on u.id = r.actor_id
			where r.subject_kind = ${subject.kind} and r.subject_id = ${subject.id}
			order by r.read_at desc, r.id desc
			limit 12`;

		const playbooks = await tx.sql<{
			key: string;
			title: string;
			version: number;
			reviewed_at: string | null;
		}>`
			select p.key, p.title, p.version, p.reviewed_at
			from nl.playbooks_for(${subject.kind}, ${subject.id}, 'internal_review') p
			order by p.key`;

		return {
			subject: { kind: subject.kind, id: subject.id, name: name.name },
			facts: facts.map((row) => ({ ...row })),
			missing,
			openConflicts: conflicts.n,
			bundles: bundles.map((row) => ({ ...row, built_at: row.built_at.toISOString() })),
			reads: reads.map((row) => ({ ...row, read_at: row.read_at.toISOString() })),
			playbooks
		} satisfies EntityContext;
	});
}

/** The subjects that already have context, for the coverage page's shortcuts. */
export async function readCoveredSubjects(
	db: Db,
	userId: number,
	limit = 12
): Promise<{ subject_kind: SubjectKind; subject_id: string; name: string | null; facts: number }[]> {
	return db.asUser(userId, (tx) =>
		tx.query(
			`select f.subject_kind, f.subject_id,
			        coalesce(cu.name, ve.name, it.description, ct.full_name) as name,
			        count(*)::int as facts
			 from nl.facts f
			 left join nl.customers cu on f.subject_kind = 'customer' and cu.customer_no = f.subject_id
			 left join nl.vendors ve on f.subject_kind = 'vendor' and ve.vendor_no = f.subject_id
			 left join nl.items it on f.subject_kind = 'item' and it.item_no = f.subject_id
			 left join nl.contacts ct on f.subject_kind = 'contact' and ct.id::text = f.subject_id
			 where f.status = 'current'
			 group by 1, 2, 3
			 order by facts desc, f.subject_id
			 limit $1`,
			[limit]
		)
	);
}
