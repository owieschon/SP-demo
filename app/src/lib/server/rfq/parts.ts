// Northline part numbers: normalizing them, reading what they encode, and
// ranking close siblings when a requested number does not exist.
//
// The numbering, by family (see docs for the full list):
//   elbow    L{dia}{angle}-{leg1}{leg2}{finish}   L3515-630SC  3.5" 15 deg, 6" x 30", chrome slip
//   stack    S{dia}-{len}{style}{finish}          S6-96BC      6" x 96" bull hauler, chrome
//   pipe     P{dia}-{len}{finish}{ends}           P4-18CP      4" x 18" chrome, plain ends
//   flex     FL{dia}-{len}{type}                  FL6-36SS     6" x 36" stainless
//   clamp    CL{dia}{type}{finish}                CL6SZ        6" saddle, zinc
//   shield   HS{dia}-{len}{finish}                HS6-30S
//   bracket  RB{type}{dia}{finish}{style}         RBSB5S3
//   muffler M-NNNN, kit K-NNNN, custom CU-NNNNN, proprietary PR-NNNN, raw RW-NNN(N)
// Diameters are written without the point: 35 is 3.5", 45 is 4.5", 25 is 2.5".

export type Family =
	| 'elbow'
	| 'stack'
	| 'pipe'
	| 'flex'
	| 'clamp'
	| 'shield'
	| 'bracket'
	| 'muffler'
	| 'kit'
	| 'custom'
	| 'proprietary'
	| 'raw';

export interface PartShape {
	family: Family;
	/** Inches (3.5, not 35). */
	diameter: number | null;
	angle: number | null;
	/** Stack, pipe, flex and shield length, or an elbow's two legs added up. */
	length: number | null;
	legs: [number, number] | null;
	/** Stack style, clamp type, flex type, bracket type. */
	style: string | null;
	finish: string | null;
}

/** Upper case, no spaces, dashes, dots or slashes: "l3515 630-sc" -> "L3515630SC". */
export function normalizePart(value: string): string {
	return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const DIAMETERS: Record<string, number> = {
	'25': 2.5, '3': 3, '35': 3.5, '4': 4, '45': 4.5, '5': 5, '55': 5.5, '6': 6, '7': 7, '8': 8, '10': 10
};
const ANGLES = new Set([15, 22, 30, 45, 60, 90]);

/** "25" -> 2.5, "6" -> 6. Null when it is not a diameter Northline makes. */
function diameter(code: string): number | null {
	return DIAMETERS[code] ?? null;
}

/**
 * An elbow's legs are written back to back ("1018" is 10" x 18", "630" is
 * 6" x 30"). Pick the split where both legs are plausible (4" to 36"),
 * preferring the first leg short.
 */
function splitLegs(digits: string): [number, number] | null {
	for (let cut = 1; cut < digits.length; cut++) {
		const a = Number(digits.slice(0, cut));
		const b = Number(digits.slice(cut));
		if (digits[cut] === '0') continue; // a leg never starts with 0
		if (a >= 4 && a <= 36 && b >= 4 && b <= 36) return [a, b];
	}
	return null;
}

/**
 * Split "696" into diameter 6 and length 96. The dash in the original tells
 * where the diameter ends; without it, a one-digit diameter is tried first,
 * then a two-digit one (25 is 2.5").
 */
function diameterAndLength(original: string, prefix: string, digits: string): [number, number] | null {
	const dashed = original.toUpperCase().match(new RegExp(`^\\s*${prefix}\\s*(\\d{1,2})\\s*-`));
	const cuts = dashed ? [dashed[1].length] : [1, 2];
	for (const cut of cuts) {
		const dia = diameter(digits.slice(0, cut));
		const length = digits.slice(cut);
		if (dia !== null && length.length >= 2) return [dia, Number(length)];
	}
	return null;
}

/** Read what a part number encodes. Null when it does not follow any family's pattern. */
export function parsePart(value: string): PartShape | null {
	const n = normalizePart(value);
	const blank = { diameter: null, angle: null, length: null, legs: null, style: null, finish: null };
	let m: RegExpMatchArray | null;

	if ((m = n.match(/^FL(\d{3,5})(SS|GA|IL)$/))) {
		const size = diameterAndLength(value, 'FL', m[1]);
		return size && { ...blank, family: 'flex', diameter: size[0], length: size[1], style: m[2] };
	}
	if ((m = n.match(/^CL(\d{1,2})([SWBLUV])(Z|SS)$/))) {
		return { ...blank, family: 'clamp', diameter: diameter(m[1]), style: m[2], finish: m[3] };
	}
	if ((m = n.match(/^HS(\d{3,4})([CPS])$/))) {
		const size = diameterAndLength(value, 'HS', m[1]);
		return size && { ...blank, family: 'shield', diameter: size[0], length: size[1], finish: m[2] };
	}
	if ((m = n.match(/^RB([A-Z]{2})(\d{1,2})([A-Z])(\d)$/))) {
		return { ...blank, family: 'bracket', diameter: diameter(m[2]), style: m[1], finish: m[3] };
	}
	if ((m = n.match(/^(M|K|CU|PR|RW)(\d{3,5})$/))) {
		const family = ({ M: 'muffler', K: 'kit', CU: 'custom', PR: 'proprietary', RW: 'raw' } as const)[
			m[1] as 'M' | 'K' | 'CU' | 'PR' | 'RW'
		];
		return { ...blank, family };
	}
	if ((m = n.match(/^L(\d{2,4})(\d{2,4})(SA|SC|A|B|C|S)$/))) {
		// The dash is gone after normalizing, so try each diameter and angle split.
		const head = value.toUpperCase().match(/^\s*L(\d{2,4})\s*-/);
		const candidates = head ? [[head[1], n.slice(1 + head[1].length, n.length - m[3].length)]] : [];
		if (!head) {
			const digits = m[1] + m[2];
			for (let cut = 2; cut <= 4; cut++) candidates.push([digits.slice(0, cut), digits.slice(cut)]);
		}
		for (const [front, legs] of candidates) {
			for (let d = 1; d <= 2; d++) {
				const dia = diameter(front.slice(0, d));
				const angle = Number(front.slice(d));
				const split = splitLegs(legs);
				if (dia !== null && ANGLES.has(angle) && split) {
					return {
						...blank,
						family: 'elbow',
						diameter: dia,
						angle,
						legs: split,
						length: split[0] + split[1],
						finish: m[3]
					};
				}
			}
		}
		return null;
	}
	if ((m = n.match(/^S(\d{3,5})([SBKMRW])([ABCS])$/))) {
		const size = diameterAndLength(value, 'S', m[1]);
		return size && { ...blank, family: 'stack', diameter: size[0], length: size[1], style: m[2], finish: m[3] };
	}
	if ((m = n.match(/^P(\d{3,5})([ABCS])([PEX])$/))) {
		const size = diameterAndLength(value, 'P', m[1]);
		return size && { ...blank, family: 'pipe', diameter: size[0], length: size[1], finish: m[2], style: m[3] };
	}
	return null;
}

/** The family a part number's prefix points at, even when the rest is garbled. */
export function familyOfPrefix(value: string): Family | null {
	const n = normalizePart(value);
	if (n.startsWith('FL')) return 'flex';
	if (n.startsWith('CL')) return 'clamp';
	if (n.startsWith('HS')) return 'shield';
	if (n.startsWith('RB')) return 'bracket';
	if (n.startsWith('CU')) return 'custom';
	if (n.startsWith('PR')) return 'proprietary';
	if (n.startsWith('RW')) return 'raw';
	if (/^M\d/.test(n)) return 'muffler';
	if (/^K\d/.test(n)) return 'kit';
	if (/^L\d/.test(n)) return 'elbow';
	if (/^S\d/.test(n)) return 'stack';
	if (/^P\d/.test(n)) return 'pipe';
	return null;
}

/** Edit distance (insert, delete, change one character) between two strings. */
export function editDistance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = row[0];
		row[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = row[j];
			row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return row[b.length];
}

export interface CatalogItem {
	item_no: string;
	description: string;
	list_price: number;
}

const FINISH_WORDS: Record<string, string> = {
	A: 'aluminized', SA: 'aluminized slip', B: 'black', C: 'chrome', SC: 'chrome slip', S: 'stainless',
	Z: 'zinc', SS: 'stainless', P: 'perforated'
};

function finishWord(code: string | null): string {
	return code ? (FINISH_WORDS[code] ?? code) : '?';
}

function inches(value: number): string {
	return `${value}"`;
}

/** A short, plain reason for a suggestion, comparing it with what was asked for. */
function whySuggested(asked: PartShape | null, candidate: PartShape | null, distance: number): string {
	if (!asked) return distance <= 1 ? 'one character away from what was written' : 'similar part number';
	if (!candidate) return 'similar part number';
	const differences: string[] = [];
	if (asked.diameter !== candidate.diameter && candidate.diameter !== null) {
		differences.push(`${inches(candidate.diameter)} instead of ${asked.diameter === null ? '?' : inches(asked.diameter)}`);
	}
	if (asked.style !== candidate.style && candidate.style !== null) differences.push('different style');
	if (asked.length !== candidate.length && candidate.length !== null) {
		differences.push(`${asked.family === 'elbow' ? 'legs' : 'length'} ${candidate.legs ? candidate.legs.join('" x ') + '"' : inches(candidate.length)}`);
	}
	if (asked.angle !== candidate.angle && candidate.angle !== null) differences.push(`${candidate.angle} deg`);
	if (asked.finish !== candidate.finish && candidate.finish !== null) {
		differences.push(`${finishWord(candidate.finish)} instead of ${finishWord(asked.finish)}`);
	}
	return differences.length === 0 ? 'same size and finish' : `same family, ${differences.join(', ')}`;
}

/**
 * Up to `limit` catalog items most like a part number that does not exist.
 * Ranked, in order:
 *   1. when the asked number cannot be read at all: one character away
 *      (the most likely slip of the keyboard),
 *   2. same family,
 *   3. nearest diameter,
 *   4. same style (a bull hauler stack is not a curved one),
 *   5. nearest length or legs,
 *   6. nearest angle,
 *   7. same finish,
 *   8. fewest characters different.
 */
export function rankSiblings(asked: string, catalog: CatalogItem[], limit = 3): (CatalogItem & { why: string })[] {
	const askedKey = normalizePart(asked);
	const askedShape = parsePart(asked);
	const askedFamily = askedShape?.family ?? familyOfPrefix(asked);

	const scored = catalog.map((item) => {
		const key = normalizePart(item.item_no);
		const shape = parsePart(item.item_no);
		const distance = editDistance(askedKey, key);
		const gap = (a: number | null | undefined, b: number | null | undefined) =>
			a == null || b == null ? 1000 : Math.abs(a - b);
		const score = [
			!askedShape && distance <= 1 ? 0 : 1,
			(shape?.family ?? familyOfPrefix(item.item_no)) === askedFamily ? 0 : 1,
			gap(askedShape?.diameter, shape?.diameter),
			askedShape && shape && askedShape.style !== shape.style ? 1 : 0,
			gap(askedShape?.length, shape?.length),
			gap(askedShape?.angle, shape?.angle),
			askedShape && shape && askedShape.finish !== shape.finish ? 1 : 0,
			distance
		];
		return { item, shape, distance, score };
	});

	scored.sort((a, b) => {
		for (let i = 0; i < a.score.length; i++) {
			if (a.score[i] !== b.score[i]) return a.score[i] - b.score[i];
		}
		return a.item.item_no.localeCompare(b.item.item_no);
	});

	return scored
		.slice(0, limit)
		.map(({ item, shape, distance }) => ({ ...item, why: whySuggested(askedShape, shape, distance) }));
}
