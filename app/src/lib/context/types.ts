// The shapes the context engine passes around, shared by the server modules,
// the pages and the tests.
//
// Nothing here touches the database. The database's own shapes are in
// db/migrations/0027_context_engine.sql, and these mirror them.

/** What kind of thing a claim or a fact is about. */
export const SUBJECT_KINDS = ['customer', 'contact', 'vendor', 'item'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

/**
 * A piece of work an agent does. The dictionary says, per attribute, which of
 * these may consume it, which is the answer to "how should this context be
 * applied".
 */
export const SURFACES = [
	'internal_review',
	'buying',
	'quoting',
	'promising_date',
	'replying_external',
	'shipping_paperwork'
] as const;
export type Surface = (typeof SURFACES)[number];

/** True for the surfaces whose output can end up outside the company. */
export const EXTERNAL_SURFACES: readonly Surface[] = [
	'quoting',
	'promising_date',
	'replying_external',
	'shipping_paperwork'
];

export const SURFACE_LABEL: Record<Surface, string> = {
	internal_review: 'Internal review',
	buying: 'Buying',
	quoting: 'Quoting',
	promising_date: 'Promising a date',
	replying_external: 'Replying outside',
	shipping_paperwork: 'Shipping paperwork'
};

export type ValueType = 'text' | 'integer' | 'number' | 'money' | 'date' | 'bool' | 'enum' | 'range_days';

export type Disclosure = 'internal' | 'customer' | 'public';

/** One row of the data dictionary: where an attribute's meaning lives. */
export interface AttributeMeta {
	key: string;
	label: string;
	subjectKind: SubjectKind;
	valueType: ValueType;
	unit: string;
	allowedValues: string[];
	minNumber: number | null;
	maxNumber: number | null;
	freshnessDays: number | null;
	disclosure: Disclosure;
	surfaces: Surface[];
	needsItem: boolean;
	crossCheck: string;
	note: string;
}

/**
 * A value normalized onto the dictionary's type. Exactly one of the typed
 * fields is filled in, and `display` is the canonical string two claims that
 * agree both produce.
 */
export interface NormalizedValue {
	text: string | null;
	number: number | null;
	date: string | null;
	bool: boolean | null;
	json: Record<string, number> | null;
	unit: string;
	display: string;
}

/** Why a raw string could not be turned into a value of that type. */
export interface NormalizeFailure {
	failed: string;
}

export type NormalizeResult = NormalizedValue | NormalizeFailure;

export function normalizeFailed(result: NormalizeResult): result is NormalizeFailure {
	return 'failed' in result;
}

/** The scope tuple. Null means "all", which is what makes a fact applicable. */
export interface ClaimScope {
	customerNo?: string | null;
	shipToNo?: string | null;
	itemNo?: string | null;
	itemFamily?: string | null;
	vendorNo?: string | null;
}

/**
 * What a recognizer or a model found: the three parts of a parse, each with
 * its own confidence, plus the citation. A proposal, not a claim: the claim
 * is what nl.record_claim accepts.
 */
export interface ProposedClaim {
	subjectKind: SubjectKind;
	/** Null when entity resolution has not settled it yet. */
	subjectId: string | null;
	/** What the source actually wrote, kept whether or not it resolved. */
	subjectRaw: string;
	attribute: string;
	value: NormalizedValue;
	scope: ClaimScope;
	assertedAt: string;
	validFrom: string;
	validTo: string | null;
	sourceDocumentId: number;
	extractor: string;
	extractorVersion: string;
	locator: string;
	snippet: string;
	subjectConfidence: number;
	attributeConfidence: number;
	valueConfidence: number;
}

/** An extraction that did not land on a dictionary attribute. */
export interface UnparsedProposal {
	sourceDocumentId: number;
	subjectKind: SubjectKind | null;
	subjectId: string | null;
	subjectRaw: string;
	proposedAttribute: string | null;
	locator: string;
	snippet: string;
	reason: string;
	extractor: string;
	extractorVersion: string;
}

// ---------------------------------------------------------------------------
// What the read path hands back
// ---------------------------------------------------------------------------

export interface Citation {
	claim_id: number;
	source_key: string;
	source_name: string;
	trust_tier: number;
	locator: string;
	snippet: string;
	asserted_at: string;
	captured_at: string;
	extractor: string;
	extractor_version: string;
	ref_table: string;
	ref_id: string;
	document_title: string;
}

export interface BundleFact {
	attribute: string;
	label: string;
	value_display: string;
	value_text: string | null;
	value_number: number | null;
	value_date: string | null;
	value_bool: boolean | null;
	value_json: Record<string, number> | null;
	unit: string;
	value_type: ValueType;
	scope_key: string;
	scope_customer_no: string | null;
	scope_ship_to_no: string | null;
	scope_item_no: string | null;
	scope_item_family: string | null;
	scope_vendor_no: string | null;
	specificity: number;
	confidence: number;
	decided_via: 'rule' | 'person';
	disclosure: Disclosure;
	asserted_at: string;
	valid_from: string;
	valid_to: string | null;
	stale_after: string;
	fact_id: number;
	citations: Citation[];
}

export interface BundlePlaybook {
	key: string;
	title: string;
	body: string;
	version: number;
	reviewed_at: string | null;
}

/** nl.context_for's answer when it can serve. */
export interface ServedBundle {
	served: true;
	subject: { kind: SubjectKind; id: string; name: string | null };
	purpose: Surface;
	external: boolean;
	facts: BundleFact[];
	stale: { attribute: string; label: string; value_display: string; days_stale: number }[];
	expired: { attribute: string; label: string; value_display: string; valid_to: string }[];
	playbooks: BundlePlaybook[];
	policy: Record<string, number>;
	bundle_id: number;
	bundle_version: number;
	content_hash: string;
	built_at: string;
	age_hours?: number;
	bundle_stale?: boolean;
	frozen?: boolean;
}

/** nl.context_for's answer when it will not serve, and why. */
export interface RefusedBundle {
	served: false;
	reason: string;
	subject?: { kind: SubjectKind; id: string; name?: string | null };
	purpose: Surface | string;
	bundle_version?: number;
	content_hash?: string;
	built_at?: string;
	expired?: { attribute: string; label: string; value_display: string; valid_to: string }[];
}

export type ContextBundle = ServedBundle | RefusedBundle;

export function bundleServed(bundle: ContextBundle): bundle is ServedBundle {
	return bundle.served === true;
}

// ---------------------------------------------------------------------------
// Coverage and the queues
// ---------------------------------------------------------------------------

export interface CoverageRow {
	subject_kind: SubjectKind;
	attribute: string;
	label: string;
	disclosure: Disclosure;
	subjects: number;
	verified: number;
	stale: number;
	missing: number;
	coverage_pct: number;
}

export interface CoverageGap {
	subject_id: string;
	name: string;
	weight: number;
	state: 'missing' | 'stale' | 'expired' | 'verified';
	stale_days: number | null;
}

export interface ConflictRow {
	id: number;
	subject_kind: SubjectKind;
	subject_id: string;
	subject_name: string | null;
	attribute: string;
	attribute_label: string;
	scope_key: string;
	disagreement: number;
	reason: string;
	raised_at: string;
	row_version: string;
	winner: ConflictSide;
	rival: ConflictSide;
}

export interface ConflictSide {
	claim_id: number;
	value_display: string;
	source_key: string;
	source_name: string;
	trust_tier: number;
	asserted_at: string;
	captured_at: string;
	confidence: number;
	locator: string;
	snippet: string;
	extractor: string;
	extractor_version: string;
	ref_table: string;
	ref_id: string;
	document_title: string;
}

export interface ReviewItem {
	id: number;
	kind: 'unparsed' | 'failed_validation';
	subject_kind: SubjectKind | null;
	subject_id: string | null;
	subject_raw: string;
	subject_name: string | null;
	proposed_attribute: string | null;
	locator: string;
	snippet: string;
	reason: string;
	extractor: string;
	extractor_version: string;
	created_at: string;
	row_version: string;
	source_key: string;
	source_name: string;
	document_title: string;
	ref_table: string;
	ref_id: string;
}

/**
 * Where a citation's source document actually lives, as a link. Built in
 * $lib/context/links.ts so the page and a report agree.
 */
export interface SourceLink {
	href: string | null;
	label: string;
}
