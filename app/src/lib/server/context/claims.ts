// Writing claims, and nothing else.
//
// Every write goes through nl.record_claim, which is where the rules are:
// the attribute has to be in the dictionary, the locator and the snippet have
// to be there, the snippet has to appear in the source document's own text,
// and the value has to pass type, unit, domain, plausibility and the
// cross-check. A value that fails becomes a data-quality item with its
// snippet rather than disappearing.
//
// The request id is derived from the evidence (the document, the attribute,
// the locator and the scope), so exploring the same inbox twice writes the
// same claims once. That is also why nothing here needs its own idempotency
// bookkeeping.
import { createHash } from 'node:crypto';
import type { Tx } from '../db/types.ts';
import type { ProposedClaim, UnparsedProposal } from '$lib/context/types';

export interface RecordedClaim {
	claimId: number | null;
	reviewItemId: number | null;
	accepted: boolean;
	status: string | null;
	failures: { check: string; detail: string }[];
}

/**
 * A request id from the evidence itself. Stable across runs, unique per piece
 * of evidence, and inside nl.claim_request's 8 to 100 characters.
 */
export function claimRequestId(claim: {
	sourceDocumentId: number;
	attribute: string;
	locator: string;
	scope?: { itemNo?: string | null };
}): string {
	const key = `${claim.sourceDocumentId}|${claim.attribute}|${claim.locator}|${claim.scope?.itemNo ?? '*'}`;
	return `ctx-claim-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

export async function recordClaim(tx: Tx, claim: ProposedClaim): Promise<RecordedClaim> {
	const [row] = await tx.query<{ result: RecordedClaimJson }>(
		`select nl.record_claim(
		   $1, $2, $3, $4,
		   $5, $6, $7, $8, $9::jsonb, $10, $11,
		   $12, $13, $14, $15, $16,
		   $17::date, $18::date, $19::date,
		   $20, $21, $22, $23, $24,
		   $25, $26, $27, $28) as result`,
		[
			claim.subjectKind,
			claim.subjectId,
			claim.subjectRaw,
			claim.attribute,
			claim.value.text,
			claim.value.number,
			claim.value.date,
			claim.value.bool,
			claim.value.json === null ? null : JSON.stringify(claim.value.json),
			claim.value.unit,
			claim.value.display,
			claim.scope.customerNo ?? null,
			claim.scope.shipToNo ?? null,
			claim.scope.itemNo ?? null,
			claim.scope.itemFamily ?? null,
			claim.scope.vendorNo ?? null,
			claim.assertedAt,
			claim.validFrom,
			claim.validTo,
			claim.sourceDocumentId,
			claim.extractor,
			claim.extractorVersion,
			claim.locator,
			claim.snippet,
			claim.subjectConfidence,
			claim.attributeConfidence,
			claim.valueConfidence,
			claimRequestId(claim)
		]
	);
	const result = row.result;
	return {
		claimId: result.claim_id ?? null,
		reviewItemId: result.review_item_id ?? null,
		accepted: Boolean(result.accepted),
		status: result.status ?? null,
		failures: result.failures ?? []
	};
}

interface RecordedClaimJson {
	claim_id?: number | null;
	review_item_id?: number | null;
	accepted?: boolean;
	status?: string;
	failures?: { check: string; detail: string }[];
	replayed?: boolean;
}

/**
 * A person typing what they know. It registers its own source document, so
 * the entry is citable the moment it is written rather than the next time the
 * adapters run.
 */
export async function addContextEntry(
	tx: Tx,
	input: { subjectKind: string; subjectId: string; body: string; requestId: string }
): Promise<{ entryId: number; sourceDocumentId: number }> {
	const [row] = await tx.query<{ result: { entry_id: number; source_document_id: number } }>(
		'select nl.add_context_entry($1, $2, $3, $4) as result',
		[input.subjectKind, input.subjectId, input.body, input.requestId]
	);
	return { entryId: row.result.entry_id, sourceDocumentId: row.result.source_document_id };
}

/** "I could not tell what this means", which is a first-class outcome. */
export async function recordUnparsed(tx: Tx, item: UnparsedProposal): Promise<number> {
	const key = `${item.sourceDocumentId}|${item.locator}|${item.snippet}`;
	const requestId = `ctx-unparsed-${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
	const [row] = await tx.query<{ result: { review_item_id: number } }>(
		'select nl.record_unparsed($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) as result',
		[
			item.sourceDocumentId,
			item.subjectKind,
			item.subjectId,
			item.subjectRaw,
			item.proposedAttribute,
			item.locator,
			item.snippet,
			item.reason,
			item.extractor,
			item.extractorVersion,
			requestId
		]
	);
	return row.result.review_item_id;
}
