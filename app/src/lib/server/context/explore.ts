// explore_sources: go and look.
//
// This is the tool an agent reaches for when the coverage list says it does
// not know something. It searches the raw material ALREADY IN THE DATABASE
// (mail bodies, the archive, attachment text, staged export rows, activity
// notes, legacy CRM rows) for evidence about one subject, and proposes claims
// with citations.
//
// Three things it deliberately does NOT do:
//
//   * It does not write a fact. It writes CLAIMS. Promotion is a separate
//     step with its own written rule (nl.promote_claims), and keeping the two
//     apart is what stops an exploration from deciding what is true.
//   * It does not send anything, anywhere. There is no mail client in this
//     file and no way to reach one.
//   * It does not invent. Stage one is patterns; stage two must quote, and a
//     quote that is not in the text is thrown away.
//
// What it returns is a report a person or an agent can read: what it looked
// at, what it proposed, what it could not parse, and what WOULD promote if
// the rules were run. Whether to run them is the caller's call.
import type { Db, Tx } from '../db/types.ts';
import type { SubjectKind } from '$lib/context/types';
import { loadDictionary, loadPartNumbers, type Dictionary } from './dictionary.ts';
import { recordClaim, recordUnparsed } from './claims.ts';
import { extractFrom, NO_PROSE_MODEL, type ProseModel } from './extract.ts';
import { documentsAbout, type SourceDocumentRow } from './sources.ts';
import { recordResolution, resolveDocumentSubject } from './resolve.ts';

export interface ExploreOptions {
	/** Chase one gap rather than reading everything. */
	attribute?: string | null;
	/** Documents to read at most. Keeps one call bounded. */
	limit?: number;
	/** Stage two. The default finds nothing, which needs no key. */
	model?: ProseModel;
	/** Today, for a date written without a year. */
	today?: string;
}

export interface ExploreReport {
	subject: { kind: SubjectKind; id: string; name: string | null };
	attribute: string | null;
	documentsRead: number;
	documentsWithText: number;
	claimsWritten: number;
	claimsUpdated: number;
	unparsed: number;
	failedValidation: number;
	inventedSpansRefused: number;
	unresolvedSubjects: number;
	/** Facts written. Always zero: this tool does not promote. */
	factsWritten: 0;
	found: {
		attribute: string;
		value: string;
		sourceName: string;
		trustTier: number;
		locator: string;
		snippet: string;
		assertedAt: string;
		accepted: boolean;
		reason: string;
	}[];
	/** What promotion would do with this, without doing it. */
	wouldPromote: { attribute: string; value: string; blocked: string | null }[];
}

/**
 * The company's date, asked once. nl.today() is pinned in tests and in the
 * nightly job, so nothing here reads the wall clock.
 */
async function today(tx: Tx): Promise<string> {
	const [row] = await tx.sql<{ today: string }>`select nl.today() as today`;
	return row.today;
}

/** The name of the thing we are exploring, so the report says who. */
async function subjectName(tx: Tx, subject: { kind: SubjectKind; id: string }): Promise<string | null> {
	const [row] = await tx.sql<{ name: string | null }>`
		select case ${subject.kind}
		         when 'customer' then (select c.name from nl.customers c where c.customer_no = ${subject.id})
		         when 'vendor'   then (select v.name from nl.vendors v where v.vendor_no = ${subject.id})
		         when 'item'     then (select i.description from nl.items i where i.item_no = ${subject.id})
		         when 'contact'  then (select ct.full_name from nl.contacts ct where ct.id::text = ${subject.id})
		       end as name`;
	return row?.name ?? null;
}

/** Who a document is about, from what the store says and then from matching. */
async function subjectOfDocument(
	tx: Tx,
	document: SourceDocumentRow,
	wanted: { kind: SubjectKind; id: string },
	requestId: string
) {
	const resolved = await resolveDocumentSubject(tx, {
		fromAddress: document.from_address,
		text: document.text ?? '',
		companyName: null,
		kind: wanted.kind === 'vendor' ? 'procurement' : 'orders',
		statedCustomerNo: document.customer_no,
		statedVendorNo: document.vendor_no
	});
	// Record the candidate and, when it is decisive, the accepted link. Done
	// whichever way it went, so "why did it think that" is a query.
	if (document.from_address) {
		await recordResolution(tx, {
			rawKind: 'email',
			rawValue: document.from_address,
			sourceDocumentId: document.id,
			resolved,
			requestId
		});
	}
	// An exploration was asked about ONE subject. A document that resolves to
	// somebody else is skipped rather than quietly credited to the subject we
	// happened to be looking at, which is how a fact lands on the wrong
	// account.
	if (resolved.id && resolved.id !== wanted.id) return null;
	if (!resolved.id) {
		return { ...resolved, kind: wanted.kind, id: null };
	}
	return { ...resolved, kind: wanted.kind, id: wanted.id };
}

/**
 * Explore for one subject. Optionally for one attribute, which is how the
 * scheduled build works through a coverage gap without reading everything
 * every night.
 */
export async function exploreSources(
	db: Db,
	userId: number,
	subject: { kind: SubjectKind; id: string },
	options: ExploreOptions = {}
): Promise<ExploreReport> {
	return db.asUser(userId, (tx) => exploreIn(tx, subject, options));
}

/** The same, inside a transaction a caller already has. */
export async function exploreIn(
	tx: Tx,
	subject: { kind: SubjectKind; id: string },
	options: ExploreOptions = {}
): Promise<ExploreReport> {
	const dictionary: Dictionary = await loadDictionary(tx);
	const referenceDate = options.today ?? (await today(tx));
	const name = await subjectName(tx, subject);
	const model = options.model ?? NO_PROSE_MODEL;
	const only = options.attribute ? [options.attribute] : undefined;

	const report: ExploreReport = {
		subject: { ...subject, name },
		attribute: options.attribute ?? null,
		documentsRead: 0,
		documentsWithText: 0,
		claimsWritten: 0,
		claimsUpdated: 0,
		unparsed: 0,
		failedValidation: 0,
		inventedSpansRefused: 0,
		unresolvedSubjects: 0,
		factsWritten: 0,
		found: [],
		wouldPromote: []
	};

	// An attribute that is not in this database's dictionary is not something
	// to go looking for. Saying so beats searching for nothing.
	if (options.attribute && !dictionary.has(options.attribute)) {
		return report;
	}

	const documents = await documentsAbout(tx, subject, { limit: options.limit ?? 40 });
	const ourParts = dictionary.has('customer_part_no') ? await loadPartNumbers(tx) : new Set<string>();
	const seenClaimIds = new Set<number>();

	for (const document of documents) {
		report.documentsRead += 1;
		if (!document.text || document.text.trim().length === 0) continue;
		report.documentsWithText += 1;

		const who = await subjectOfDocument(tx, document, subject, `ctx-explore-${document.id}`);
		if (who === null) continue;
		if (who.id === null) report.unresolvedSubjects += 1;

		const extracted = await extractFrom(
			{
				sourceDocumentId: document.id,
				text: document.text,
				subject: { kind: subject.kind, id: who.id, raw: who.raw || (name ?? subject.id) },
				subjectConfidence: who.confidence,
				// The day the document was received is the day it asserts,
				// unless a recognizer read a date out of the text itself.
				assertedAt: document.received_at.toISOString().slice(0, 10),
				dictionary,
				ourParts,
				only,
				referenceDate
			},
			model
		);
		report.inventedSpansRefused += extracted.inventedSpans;

		for (const claim of extracted.claims) {
			const written = await recordClaim(tx, claim);
			if (written.accepted && written.claimId !== null) {
				if (seenClaimIds.has(written.claimId)) report.claimsUpdated += 1;
				else report.claimsWritten += 1;
				seenClaimIds.add(written.claimId);
			} else if (written.reviewItemId !== null) {
				report.failedValidation += 1;
			}
			report.found.push({
				attribute: claim.attribute,
				value: claim.value.display,
				sourceName: document.source_name,
				trustTier: document.trust_tier,
				locator: claim.locator,
				snippet: claim.snippet,
				assertedAt: claim.assertedAt,
				accepted: written.accepted,
				reason: written.accepted
					? written.status === 'unresolved'
						? 'Kept, waiting for somebody to say which account this is.'
						: 'Recorded as a claim.'
					: written.failures.map((failure) => failure.detail).join(' ')
			});
		}

		for (const item of extracted.unparsed) {
			await recordUnparsed(tx, item);
			report.unparsed += 1;
		}
	}

	// What the rules WOULD do, worked out without doing it. The point of
	// telling an agent this is that it can say "I found a freight term and it
	// needs a person" instead of either promoting it or staying quiet.
	report.wouldPromote = await previewPromotion(tx, subject, options.attribute ?? null);
	return report;
}

/**
 * A dry run of the promotion rule for one subject: which attributes have a
 * clear winner and which would go to a person. Reads nothing that
 * nl.promote_claims does not read, and writes nothing at all.
 */
async function previewPromotion(
	tx: Tx,
	subject: { kind: SubjectKind; id: string },
	attribute: string | null
): Promise<{ attribute: string; value: string; blocked: string | null }[]> {
	return tx.query<{ attribute: string; value: string; blocked: string | null }>(
		`with settings as (
		   select nl.context_number('promotion.min_confidence') as min_conf,
		          nl.context_number('promotion.trust_gap_min') as gap,
		          nl.context_number('promotion.conflict_threshold') as threshold
		 ),
		 live as (
		   select c.*, s.min_conf, s.gap, s.threshold
		   from nl.claim_candidates c
		   cross join settings s
		   where c.subject_kind = $1 and c.subject_id = $2
		     and ($3::text is null or c.attribute = $3)
		     and c.confidence >= s.min_conf
		     and c.valid_from <= nl.today()
		     and (c.valid_to is null or c.valid_to >= nl.today())
		 ),
		 ranked as (
		   select l.*, row_number() over (
		            partition by l.attribute, l.scope_key
		            order by l.trust_tier desc, l.asserted_at desc, l.confidence desc, l.id desc) as rank
		   from live l
		 ),
		 winners as (select * from ranked where rank = 1)
		 select w.attribute,
		        w.value_display as value,
		        case when exists (
		               select 1 from live r
		               where r.attribute = w.attribute and r.scope_key = w.scope_key
		                 and r.id <> w.id
		                 and lower(btrim(r.value_display)) <> lower(btrim(w.value_display))
		                 and (w.trust_tier - r.trust_tier) < w.gap)
		             then 'a disagreement no source outranks, so a person decides'
		        end as blocked
		 from winners w
		 order by w.attribute`,
		[subject.kind, subject.id, attribute]
	);
}
