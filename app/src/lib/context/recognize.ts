// Stage one of extraction: recognizers for the shapes that have a shape.
//
// Extraction here is two stages, and a model is never alone.
//
//   Stage one, this file. Deterministic patterns over everything: payment
//   terms, freight terms, carriers, certificates, packaging and marking
//   requirements, a customer's own part number, a price hold, a lead time, a
//   buyer's replacement. Cheap, auditable, the same answer every run.
//
//   Stage two, extract.ts. Runs ONLY on prose that stage one found nothing in
//   ("they agreed to hold pricing through year end"), must answer with a
//   dictionary attribute AND the verbatim span it came from, and the span has
//   to be literally present in the source text or the claim is thrown away.
//
// Each hit carries its locator (which line), the verbatim snippet (the whole
// line, so a person reading it sees the sentence and not a fragment) and a
// value confidence. It does NOT carry a subject: who the text is about is
// entity resolution's answer, and pretending otherwise is how a fact ends up
// on the wrong account.
import { normalizeValue } from './normalize';
import { normalizeFailed } from './types';
import type { AttributeMeta, ClaimScope, NormalizedValue } from './types';

/** One thing a recognizer found, before a subject is attached to it. */
export interface Recognition {
	attribute: string;
	/** The exact text the value was read from, for the record. */
	raw: string;
	value: NormalizedValue;
	scope: ClaimScope;
	/** "line 14", so a person can find it. */
	locator: string;
	/** The whole line, verbatim. Checked against the source before it counts. */
	snippet: string;
	/** How sure the pattern is, which is not how sure we are of the subject. */
	valueConfidence: number;
	/** The date the text itself asserts, when it says one. */
	assertedAt?: string;
	validTo?: string | null;
}

/** An item number written in one of our shapes: L760-128B, CU-41545, M-1007. */
const PART_PATTERN = /\b([A-Z]{1,3}\d{1,4}[A-Z]?-\d{2,5}[A-Z]{0,3}|[A-Z]{1,2}-\d{3,5})\b/g;

/*
  Anything SHAPED like a part number, ours or theirs.

  A customer's own numbering follows nobody's rules, so the cross-reference
  recognizer has to cast wider than PART_PATTERN and then work out which of
  the codes on the line is one of ours. Requiring a digit is what keeps
  ordinary capitalised words out of it.
*/
const CODE_PATTERN = /\b([A-Z]{1,4}\d[A-Z0-9]*(?:-[A-Z0-9]+)*|[A-Z]{1,4}-[A-Z0-9]*\d[A-Z0-9]*)\b/g;

/**
 * One pattern: what to look for, which attribute it lands on, and how sure
 * that is. The pattern decides the attribute; the dictionary decides the
 * meaning. Confidence is about the PATTERN, not the subject.
 */
interface Pattern {
	attribute: string;
	/** Must match the line for the attribute to be considered at all. */
	trigger: RegExp;
	/**
	 * What to hand the normalizer. When it is missing, the whole line goes in,
	 * which is right for an enum reader that scans for its own words.
	 */
	capture?: RegExp;
	confidence: number;
	/** Lines a trigger would match but which are not a statement of fact. */
	notWhen?: RegExp;
}

// The order does not matter: every pattern is tried against every line, so a
// line can produce two claims about two different attributes, which happens
// often ("Net 45, freight collect").
const PATTERNS: Pattern[] = [
	{
		attribute: 'payment_terms_days',
		trigger: /\b(net\s*\d{1,3}|terms?\s*:?\s*net|due on receipt)\b/i,
		capture: /\b(net\s*\d{1,3}|due on receipt)\b/i,
		confidence: 0.95,
		// A question is not an agreement.
		notWhen: /\?\s*$|can we (get|have)|could we|would you consider|we would like/i
	},
	{
		attribute: 'freight_terms',
		trigger: /\b(freight|f\.?o\.?b\.?)\b/i,
		confidence: 0.88,
		notWhen: /\?\s*$|how much (is|would) (the )?freight|what (is|does) (the )?freight/i
	},
	{
		attribute: 'freight_payer',
		trigger: /(their own (carrier|account)|on their (carrier )?account|we pay the freight|freight allowed|freight collect)/i,
		confidence: 0.85
	},
	{
		attribute: 'preferred_carrier',
		trigger: /\b(route (it |them |us )?via|ship (it |them )?via|please use|we use|our carrier is|carrier of choice)\b/i,
		capture: /\b(?:route(?: it| them| us)? via|ship(?: it| them)? via|please use|we use|our carrier is|carrier of choice(?: is)?)\s+([A-Z][A-Za-z&.' -]{2,40}?)(?:\s+(?:for|on|when|and)\b|[,.;]|$)/,
		confidence: 0.8
	},
	{
		attribute: 'certificate_required',
		trigger: /(certificate of conformance|\bc of c\b|\bcoc\b|mill test report|mill cert|\bmtr\b)/i,
		confidence: 0.9,
		notWhen: /\?\s*$|do you (have|provide|supply)|can you (send|provide)/i
	},
	{
		attribute: 'packaging_requirement',
		trigger: /\b(pack(ed|aging|age)?|palleti[sz]ed|crate[ds]?|banded|shrink ?wrap|box(ed|es)?)\b/i,
		capture: /((?:pack|palleti|crate|band|shrink|box)[A-Za-z]*\b[^.;]{4,140})/i,
		confidence: 0.75,
		notWhen: /\?\s*$|packing (list|slip)|when (will|can) (it|they) (ship|be packed)/i
	},
	{
		attribute: 'marking_requirement',
		trigger: /\b(mark(ed|ing)?|label(led|ed|ling|ing)?|stencil(l?ed)?|tag(ged)?)\b/i,
		capture: /((?:mark|label|stencil|tag)[A-Za-z]*\b[^.;]{4,140})/i,
		confidence: 0.75,
		notWhen: /\?\s*$|labor|labour/i
	},
	{
		attribute: 'purchase_order_required',
		trigger: /\b(purchase order (number )?(is )?(required|must)|no (shipment|delivery) without (a )?(po|purchase order)|we (always )?need (a|our) (po|purchase order))\b/i,
		confidence: 0.85
	},
	{
		attribute: 'price_hold_until',
		trigger: /\b(hold(ing)? (the |that )?pric(e|ing)|price (is )?(good|held|firm)|pricing (is )?(good|held|firm)|quote (is )?(good|valid))\b/i,
		capture: /\b(?:through|until|to|thru)\s+([A-Za-z]{3,9}\s+\d{1,2}(?:,?\s*\d{4})?|\d{4}-\d{2}-\d{2}|end of (?:the )?year)/i,
		confidence: 0.82
	},
	{
		attribute: 'vendor_lead_time_days',
		trigger: /\b(lead ?time|running|takes about|allow|ships? in|delivery in)\b/i,
		capture: /((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:to|-|through|and)?\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)?\s*(?:day|week|month)s?)/i,
		confidence: 0.85
	},
	{
		attribute: 'vendor_minimum_order_value',
		trigger: /\b(minimum (order|purchase)|order minimum|we cannot ship under|min order)\b/i,
		capture: /(\$\s?[\d,]+(?:\.\d{2})?)/,
		confidence: 0.85
	},
	{
		attribute: 'primary_buyer_name',
		trigger: /\b(is (now )?(taking over|handling|our new)|has (taken over|replaced)|will be (handling|taking over)|new buyer is|now our buyer)\b/i,
		capture: /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b(?=[^.]*(?:is (?:now )?(?:taking over|handling|our new)|has (?:taken over|replaced)|will be (?:handling|taking over)))/,
		confidence: 0.7
	},
	{
		attribute: 'primary_buyer_email',
		trigger: /\b(copy|cc|write to|send (it |them )?to|reach (me |him |her )?at)\b[^@]*@/i,
		capture: /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/,
		confidence: 0.72
	},
	{
		attribute: 'credit_status_note',
		trigger: /\b(credit hold|past due|on hold (for|with) accounts|accounts receivable has|paying (late|slowly)|cheque|check is in the post)\b/i,
		confidence: 0.7
	}
];

/**
 * The customer's own part number for one of ours, which is the one attribute
 * that needs a part in its scope. It is its own recognizer because it needs
 * to pair two part numbers on the same line, and their order is written both
 * ways in real mail.
 */
function recognizeCustomerPartNo(line: string, lineNo: number, ourParts: Set<string>): Recognition[] {
	if (!/\b(your|our|their) (part|item|number|sku)|cross ?reference|we call (it|that|this)|shows (up )?as|refer(red)? to (it|this) as/i.test(line)) {
		return [];
	}
	const codes = [...line.matchAll(CODE_PATTERN)].map((m) => m[1]);
	const ours = codes.filter((code) => ourParts.has(code));
	const theirs = codes.filter((code) => !ourParts.has(code));
	if (ours.length !== 1 || theirs.length !== 1) return [];
	return [
		{
			attribute: 'customer_part_no',
			raw: theirs[0],
			value: { text: theirs[0], number: null, date: null, bool: null, json: null, unit: '', display: theirs[0] },
			scope: { itemNo: ours[0] },
			locator: `line ${lineNo}`,
			snippet: line.trim(),
			valueConfidence: 0.88
		}
	];
}

export interface RecognizeOptions {
	/** Today, for a date with no year on it. */
	referenceDate: string;
	/** The dictionary, so a recognizer cannot invent an attribute. */
	dictionary: Map<string, AttributeMeta>;
	/** Our own part numbers, for the cross-reference recognizer. */
	ourParts?: Set<string>;
	/** Only these attributes, when an exploration is chasing one gap. */
	only?: string[];
}

/**
 * Run every recognizer over a document's text. Returns what landed on a
 * dictionary attribute with a typed value; a trigger that matched and whose
 * value would not normalize is left out here and surfaced as an unparsed item
 * by the caller, which has the source document id it needs to record one.
 */
export function recognize(text: string, options: RecognizeOptions): Recognition[] {
	const lines = text.split(/\r?\n/);
	const ourParts = options.ourParts ?? new Set<string>();
	const wanted = options.only ? new Set(options.only) : null;
	const hits: Recognition[] = [];

	lines.forEach((line, index) => {
		const lineNo = index + 1;
		const trimmed = line.trim();
		if (trimmed.length < 4) return;

		for (const pattern of PATTERNS) {
			if (wanted && !wanted.has(pattern.attribute)) continue;
			const attribute = options.dictionary.get(pattern.attribute);
			// A pattern for an attribute this database's dictionary does not
			// have is skipped, not guessed at.
			if (!attribute) continue;
			if (!pattern.trigger.test(trimmed)) continue;
			if (pattern.notWhen?.test(trimmed)) continue;

			const raw = pattern.capture ? (trimmed.match(pattern.capture)?.[1] ?? '') : trimmed;
			if (!raw) continue;
			const value = normalizeValue(attribute, raw, { referenceDate: options.referenceDate });
			if (normalizeFailed(value)) continue;

			hits.push({
				attribute: pattern.attribute,
				raw,
				value,
				scope: {},
				locator: `line ${lineNo}`,
				snippet: trimmed,
				valueConfidence: pattern.confidence
			});
		}

		if (!wanted || wanted.has('customer_part_no')) {
			if (options.dictionary.has('customer_part_no')) {
				hits.push(...recognizeCustomerPartNo(trimmed, lineNo, ourParts));
			}
		}
	});

	// One claim per attribute and scope per document: the first, most
	// confident hit. A mail that says "net 45" twice says it once.
	const best = new Map<string, Recognition>();
	for (const hit of hits) {
		const key = `${hit.attribute}|${hit.scope.itemNo ?? '*'}`;
		const current = best.get(key);
		if (!current || hit.valueConfidence > current.valueConfidence) best.set(key, hit);
	}
	return [...best.values()];
}

/** Part numbers of ours mentioned anywhere in a document. */
export function partsMentioned(text: string, ourParts: Set<string>): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(PART_PATTERN)) {
		if (ourParts.has(match[1])) found.add(match[1]);
	}
	return [...found];
}
