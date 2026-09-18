// Entity resolution as its own step.
//
// The matcher is the order desk's (app/src/lib/server/desk/tools.ts,
// resolveSender). It is imported, not copied and not edited: it already
// handles the address on file, the shared domain that fits several branches
// of a chain, and the company name as written, and it already refuses to
// guess when the mail does not say which branch it is. A second matcher would
// be a second set of answers.
//
// What this file adds is the RECORD: a candidate with its score and its
// evidence, and a decision that is accepted or rejected by a rule or by a
// person. An unresolved subject becomes work for a person rather than a fact
// on the wrong account.
import { resolveSender, type SenderMatch } from '../desk/tools.ts';
import type { Tx } from '../db/types.ts';
import type { SubjectKind } from '$lib/context/types';

/** The score above which a rule may accept a match without asking anybody. */
export const ACCEPT_SCORE = 0.9;
/** Below this a candidate is not even recorded: it is noise. */
export const RECORD_SCORE = 0.25;

export interface ResolvedSubject {
	kind: SubjectKind;
	id: string | null;
	raw: string;
	/** How sure we are of WHO, which is one third of a parse. */
	confidence: number;
	reason: string;
	/** Several accounts fit and nothing chose between them. */
	candidates: { customerNo: string; name: string; city: string; state: string }[];
}

/** A score for a match, from the reason the desk's matcher gives for it. */
export function scoreOf(match: SenderMatch): number {
	if (!match.customerNo && !match.vendorNo) return match.candidates.length > 0 ? 0.3 : 0;
	// The address belongs to a contact on file: as good as it gets.
	if (match.contactId) return 0.98;
	// The domain fits one account and only one.
	if (/belongs to/.test(match.reason)) return 0.92;
	// The domain fits several and the text named the branch.
	if (/the mail names/.test(match.reason)) return 0.88;
	if (match.vendorNo) return 0.9;
	return 0.6;
}

/**
 * Who a document is about. The email address first, then the domain, then the
 * name as written, which is the desk's order and the right one.
 *
 * Whatever it decides, the candidate and the decision are recorded, so
 * "why did it think that" is a query rather than a re-run.
 */
export async function resolveDocumentSubject(
	tx: Tx,
	input: {
		fromAddress: string | null;
		text: string;
		companyName: string | null;
		kind: 'orders' | 'procurement';
		/** What the store itself says, which beats any matching. */
		statedCustomerNo?: string | null;
		statedVendorNo?: string | null;
	}
): Promise<ResolvedSubject> {
	// A store that names the account outright is the end of the question. The
	// ERP export and the archive both do, often, and matching a name when the
	// row already carries a number would be inventing an uncertainty.
	if (input.statedCustomerNo) {
		return {
			kind: 'customer',
			id: input.statedCustomerNo,
			raw: input.statedCustomerNo,
			confidence: 1,
			reason: 'The source names the account number itself.',
			candidates: []
		};
	}
	if (input.statedVendorNo) {
		return {
			kind: 'vendor',
			id: input.statedVendorNo,
			raw: input.statedVendorNo,
			confidence: 1,
			reason: 'The source names the supplier number itself.',
			candidates: []
		};
	}

	if (!input.fromAddress) {
		return {
			kind: input.kind === 'procurement' ? 'vendor' : 'customer',
			id: null,
			raw: input.companyName ?? '',
			confidence: 0,
			reason: 'Nothing in the document says who it is about.',
			candidates: []
		};
	}

	const match = await resolveSender(tx, {
		fromAddress: input.fromAddress,
		text: input.text,
		companyName: input.companyName,
		branchHint: null,
		kind: input.kind
	});
	const score = scoreOf(match);

	if (match.vendorNo) {
		return {
			kind: 'vendor',
			id: match.vendorNo,
			raw: match.vendorName ?? input.companyName ?? input.fromAddress,
			confidence: score,
			reason: match.reason,
			candidates: []
		};
	}
	return {
		kind: 'customer',
		id: match.customerNo,
		raw: match.customerName ?? input.companyName ?? input.fromAddress,
		confidence: match.customerNo ? score : Math.min(score, 0.3),
		reason: match.reason,
		candidates: match.candidates
	};
}

/**
 * Record what a match found: the candidate with its score and its evidence,
 * and, when the score is decisive, the accepted link. Anything less decisive
 * is left as a candidate for a person, which is exactly what the desk does
 * when a chain's branches share a domain.
 */
export async function recordResolution(
	tx: Tx,
	input: {
		rawKind: 'name' | 'email' | 'email_domain' | 'phone' | 'part_number';
		rawValue: string;
		sourceDocumentId: number | null;
		resolved: ResolvedSubject;
		requestId: string;
	}
): Promise<{ accepted: boolean; candidates: number }> {
	const raw = input.rawValue.trim();
	if (!raw) return { accepted: false, candidates: 0 };

	let candidates = 0;

	if (input.resolved.id && input.resolved.confidence >= RECORD_SCORE) {
		await tx.query('select nl.record_entity_candidate($1, $2, $3, $4, $5, $6::jsonb, $7, $8)', [
			input.rawKind,
			raw,
			input.resolved.kind,
			input.resolved.id,
			input.resolved.confidence,
			JSON.stringify({ rule: 'desk_sender_match', detail: input.resolved.reason }),
			input.sourceDocumentId,
			`${input.requestId}-cand`
		]);
		candidates += 1;
	}

	// The branches of a chain that all fit one domain. Each one is a candidate
	// and none of them is a decision, because quoting the wrong branch is a
	// real mistake with real prices on it.
	for (const [index, option] of input.resolved.candidates.entries()) {
		await tx.query('select nl.record_entity_candidate($1, $2, $3, $4, $5, $6::jsonb, $7, $8)', [
			input.rawKind,
			raw,
			'customer',
			option.customerNo,
			0.4,
			JSON.stringify({
				rule: 'shared_domain',
				detail: `${option.name}, ${option.city} ${option.state}. The document does not say which branch.`
			}),
			input.sourceDocumentId,
			`${input.requestId}-alt-${index}`
		]);
		candidates += 1;
	}

	if (input.resolved.id && input.resolved.confidence >= ACCEPT_SCORE) {
		await tx.query('select nl.decide_entity_link($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)', [
			input.rawKind,
			raw,
			input.resolved.kind,
			input.resolved.id,
			'accepted',
			'rule',
			input.resolved.confidence,
			JSON.stringify({ rule: 'desk_sender_match', detail: input.resolved.reason }),
			'',
			`${input.requestId}-link`
		]);
		return { accepted: true, candidates };
	}

	return { accepted: false, candidates };
}

export interface UnresolvedSubjectRow {
	subject_kind: SubjectKind;
	subject_raw: string;
	claims: number;
	attributes: string[];
	first_seen: string;
	candidates: { target_kind: string; target_id: string; name: string | null; score: number; detail: string }[];
}

/** The raw subjects nothing has been decided about. This is a work list. */
export async function readUnresolved(tx: Tx, limit = 25): Promise<UnresolvedSubjectRow[]> {
	const rows = await tx.query<Omit<UnresolvedSubjectRow, 'first_seen'> & { first_seen: Date }>(
		`select c.subject_kind, c.subject_raw,
		        count(*)::int as claims,
		        array_agg(distinct c.attribute) as attributes,
		        min(c.captured_at) as first_seen,
		        coalesce((
		          select jsonb_agg(jsonb_build_object(
		                   'target_kind', e.target_kind, 'target_id', e.target_id,
		                   'name', coalesce(cu.name, ve.name),
		                   'score', e.score, 'detail', e.evidence ->> 'detail')
		                 order by e.score desc)
		          from nl.entity_candidates e
		          left join nl.customers cu on e.target_kind = 'customer' and cu.customer_no = e.target_id
		          left join nl.vendors ve on e.target_kind = 'vendor' and ve.vendor_no = e.target_id
		          where lower(btrim(e.raw_value)) = lower(btrim(c.subject_raw))
		             or e.raw_value in (
		                  select d.external_ref from nl.source_documents d
		                  where d.id = c.source_document_id)
		        ), '[]'::jsonb) as candidates
		 from nl.claims c
		 where c.status = 'unresolved'
		 group by c.subject_kind, c.subject_raw
		 order by claims desc, first_seen desc
		 limit $1`,
		[limit]
	);
	return rows.map((row) => ({ ...row, first_seen: row.first_seen.toISOString() }));
}
