// Extraction in two stages, and a model is never alone.
//
// Stage one is recognize.ts: deterministic patterns over every document.
// Cheap, auditable, the same answer every run.
//
// Stage two is here, and it only runs on PROSE STAGE ONE FOUND NOTHING IN.
// It has to answer with a dictionary attribute AND the verbatim span it read
// it from, and then:
//
//   THE SPAN GUARD. If the quoted span is not literally present in the source
//   text, the claim is thrown away. Not lowered in confidence, not flagged:
//   thrown away. That is the anti-invention rule, and because the model is
//   injected it is testable with a fake one, which is what
//   context-extract.test.ts does.
//
// The guard is also in the database (nl.record_claim checks the snippet
// against nl.source_document_text), so a caller that skips this file gets
// caught anyway. Two checks, because this is the one that matters.
import { normalizeValue } from '$lib/context/normalize';
import { recognize, type Recognition } from '$lib/context/recognize';
import { normalizeFailed } from '$lib/context/types';
import type { ProposedClaim, SubjectKind, UnparsedProposal } from '$lib/context/types';
import type { Dictionary } from './dictionary.ts';

/** How the version is written on every claim this file makes. */
export const RECOGNIZER = { name: 'recognizer', version: '1' } as const;
export const PROSE_MODEL = { name: 'prose_model', version: '1' } as const;

/**
 * What stage two is asked for, and what it must answer.
 *
 * The contract is narrow on purpose. It gets the text and the attributes it
 * may choose from, and nothing else: no prices, no other accounts, no tools.
 * It answers with an attribute key, the value as written, and the span. Three
 * fields, all checkable.
 */
export interface ProseModel {
	readonly name: string;
	readonly version: string;
	extract(input: {
		text: string;
		/** key, label and note for each attribute it may use. */
		attributes: { key: string; label: string; valueType: string; note: string }[];
	}): Promise<ProseModelAnswer[]>;
}

export interface ProseModelAnswer {
	attribute: string;
	/** The value as the text writes it, for the normalizer to type. */
	value: string;
	/** The words it read it from. Must appear in `text`. */
	span: string;
	confidence: number;
}

/**
 * The scripted stage two used when no model is configured, and in every test
 * that is not about the guard itself. It finds nothing, which is the honest
 * default: no key, no prose extraction, and stage one still runs.
 */
export const NO_PROSE_MODEL: ProseModel = {
	name: 'prose_model',
	version: '1',
	extract: async () => []
};

/** Whitespace-insensitive containment, because readers disagree about spacing. */
export function spanIsPresent(text: string, span: string): boolean {
	const fold = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
	const needle = fold(span);
	if (needle.length < 4) return false;
	return fold(text).includes(needle);
}

/** Which line a span sits on, so the citation points somewhere. */
function locatorFor(text: string, span: string): string {
	const fold = (value: string) => value.replace(/\s+/g, ' ').trim().toLowerCase();
	const needle = fold(span);
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		if (fold(lines[i]).includes(needle)) return `line ${i + 1}`;
	}
	return 'line 1';
}

export interface ExtractInput {
	sourceDocumentId: number;
	text: string;
	/** Who the document is about, when entity resolution has settled it. */
	subject: { kind: SubjectKind; id: string | null; raw: string };
	/** How sure we are of THAT, which is a separate question from the value. */
	subjectConfidence: number;
	/** The day the source says it was true. */
	assertedAt: string;
	dictionary: Dictionary;
	ourParts?: Set<string>;
	/** Chase one gap rather than reading everything. */
	only?: string[];
	referenceDate: string;
}

export interface ExtractResult {
	claims: ProposedClaim[];
	unparsed: UnparsedProposal[];
	/** Spans the model returned that are not in the text. Counted, not kept. */
	inventedSpans: number;
	/** True when stage two was asked at all. */
	proseRan: boolean;
}

/**
 * Read one document. Stage one always; stage two only if stage one came back
 * empty and the document has enough prose in it to be worth a model call.
 */
export async function extractFrom(input: ExtractInput, model: ProseModel = NO_PROSE_MODEL): Promise<ExtractResult> {
	const claims: ProposedClaim[] = [];
	const unparsed: UnparsedProposal[] = [];
	let inventedSpans = 0;

	const hits = recognize(input.text, {
		referenceDate: input.referenceDate,
		dictionary: input.dictionary,
		ourParts: input.ourParts,
		only: input.only
	});
	for (const hit of hits) {
		claims.push(toClaim(input, hit, RECOGNIZER.name, RECOGNIZER.version));
	}

	// Stage two is for prose with no shape in it. A document stage one already
	// read is not worth a model call, and neither is one with three lines in
	// it: the cheapest thing a source can be is exact.
	const worthAsking = hits.length === 0 && input.text.replace(/\s+/g, ' ').trim().length >= 120;
	if (!worthAsking) {
		return { claims, unparsed, inventedSpans, proseRan: false };
	}

	const allowed = [...input.dictionary.values()].filter(
		(attribute) =>
			attribute.subjectKind === input.subject.kind &&
			(!input.only || input.only.includes(attribute.key))
	);
	if (allowed.length === 0) {
		return { claims, unparsed, inventedSpans, proseRan: false };
	}

	const answers = await model.extract({
		text: input.text,
		attributes: allowed.map((attribute) => ({
			key: attribute.key,
			label: attribute.label,
			valueType: attribute.valueType,
			note: attribute.note
		}))
	});

	for (const answer of answers) {
		const attribute = input.dictionary.get(answer.attribute);
		// An attribute that is not in the dictionary is not a claim. It is an
		// unparsed item with its span, because what it was trying to say may
		// well be worth adding to the dictionary.
		if (!attribute) {
			unparsed.push({
				sourceDocumentId: input.sourceDocumentId,
				subjectKind: input.subject.kind,
				subjectId: input.subject.id,
				subjectRaw: input.subject.raw,
				proposedAttribute: null,
				locator: locatorFor(input.text, answer.span) ?? 'line 1',
				snippet: answer.span.slice(0, 1000) || input.text.slice(0, 200),
				reason: `Nothing in the dictionary called "${answer.attribute}".`,
				extractor: model.name,
				extractorVersion: model.version
			});
			continue;
		}

		// THE SPAN GUARD. A quote that is not in the text is an invention, and
		// an invention with a citation on it is worse than one without, because
		// it looks checked.
		if (!spanIsPresent(input.text, answer.span)) {
			inventedSpans += 1;
			continue;
		}

		const value = normalizeValue(attribute, answer.value, { referenceDate: input.referenceDate });
		if (normalizeFailed(value)) {
			unparsed.push({
				sourceDocumentId: input.sourceDocumentId,
				subjectKind: input.subject.kind,
				subjectId: input.subject.id,
				subjectRaw: input.subject.raw,
				proposedAttribute: attribute.key,
				locator: locatorFor(input.text, answer.span),
				snippet: answer.span.slice(0, 1000),
				reason: value.failed,
				extractor: model.name,
				extractorVersion: model.version
			});
			continue;
		}

		claims.push({
			subjectKind: input.subject.kind,
			subjectId: input.subject.id,
			subjectRaw: input.subject.raw,
			attribute: attribute.key,
			value,
			scope: {},
			assertedAt: input.assertedAt,
			validFrom: input.assertedAt,
			validTo: null,
			sourceDocumentId: input.sourceDocumentId,
			extractor: model.name,
			extractorVersion: model.version,
			locator: locatorFor(input.text, answer.span),
			snippet: answer.span.slice(0, 1000),
			subjectConfidence: input.subjectConfidence,
			// A model choosing an attribute is less certain than a pattern
			// matching one, and its own confidence is capped to say so.
			attributeConfidence: Math.min(answer.confidence, 0.85),
			valueConfidence: Math.min(answer.confidence, 0.9)
		});
	}

	return { claims, unparsed, inventedSpans, proseRan: true };
}

function toClaim(
	input: ExtractInput,
	hit: Recognition,
	extractor: string,
	version: string
): ProposedClaim {
	return {
		subjectKind: input.subject.kind,
		subjectId: input.subject.id,
		subjectRaw: input.subject.raw,
		attribute: hit.attribute,
		value: hit.value,
		scope: hit.scope,
		assertedAt: hit.assertedAt ?? input.assertedAt,
		validFrom: hit.assertedAt ?? input.assertedAt,
		validTo: hit.validTo ?? null,
		sourceDocumentId: input.sourceDocumentId,
		extractor,
		extractorVersion: version,
		locator: hit.locator,
		snippet: hit.snippet,
		subjectConfidence: input.subjectConfidence,
		// A labelled pattern is a strong reason to believe the ATTRIBUTE; the
		// value carries the pattern's own confidence.
		attributeConfidence: 0.92,
		valueConfidence: hit.valueConfidence
	};
}
