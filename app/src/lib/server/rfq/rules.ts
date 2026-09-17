// The rules extractor: regular expressions and plain heuristics, no API key.
//
// It is the default everywhere a live model is not switched on (tests, CI,
// public visitors, the demo video), and it is the baseline the evals compare
// the model against. It does not try to be clever. What it reads:
//   * part numbers that follow Northline's numbering (any case, dash or not),
//   * tables with a header row (pipes, tabs or wide spaces), in any column order,
//   * free text: "4 x S6-96BC", "S6-96BC x 4", "S6-96BC - 4 pcs", "(2) S6-96BC",
//     "two dozen CL6SZ", "2 pair S6-96BC", "a box of 10 CL6SZ",
//   * prices ("@ $201.75", "= $807.00") and a stated subtotal,
//   * the needed-by date (see dates.ts), the sender, and the company and
//     branch from the signature.
// A line only counts when it holds a part number, so phone numbers and
// street addresses in a signature are never read as quantities.
import { findNeededBy } from './dates.ts';
import { parseEmail } from './email.ts';
import { emptyDraft, type DraftLine, type RfqDraft } from './schema.ts';

// One part number, in any of Northline's families. Lowercase and a missing
// dash still match; normalizing happens in validation.
const ITEM_PATTERN =
	'(?<![A-Za-z0-9])(?:' +
	[
		'FL\\d{1,2}-?\\d{2,3}[A-Za-z]{2}',
		'CL\\d{1,2}[A-Za-z]{2,3}',
		'HS\\d{1,2}-?\\d{2}[A-Za-z]',
		'RB[A-Za-z]{2}\\d{1,2}[A-Za-z]\\d',
		'(?:CU|PR|RW|M|K)-?\\d{3,5}',
		'L\\d{2,4}-?\\d{2,4}[A-Za-z]{1,2}',
		'S\\d{1,2}-?\\d{2,3}[A-Za-z]{2}',
		'P\\d{1,2}-?\\d{2,3}[A-Za-z]{2}'
	].join('|') +
	// A part number ends at anything that is not a letter or digit, or at a
	// glued-on "x4".
	')(?=$|[^A-Za-z0-9]|[xX]\\d)';

const itemRegex = () => new RegExp(ITEM_PATTERN, 'gi');

const WORD_NUMBERS: Record<string, number> = {
	a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
	ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50
};
const WORD = Object.keys(WORD_NUMBERS).join('|');

function numberOf(text: string): number {
	const lower = text.toLowerCase();
	return lower in WORD_NUMBERS ? WORD_NUMBERS[lower] : Number(lower.replace(/,/g, ''));
}

function money(text: string | undefined): number | null {
	if (!text) return null;
	const value = Number(text.replace(/[$,\s]/g, ''));
	return Number.isFinite(value) ? value : null;
}

// Units as people write them, mapped to the few the validator understands.
function unitOf(text: string | undefined): string | null {
	if (!text) return null;
	const t = text.toLowerCase().replace(/\.$/, '');
	if (/^(pcs?|pieces?|ea|each|units?)$/.test(t)) return t;
	if (/^(pairs?|prs?)$/.test(t)) return 'pair';
	if (/^(sets?)$/.test(t)) return 'set';
	if (/^dozen$/.test(t)) return 'dozen';
	return t;
}

interface Quantity {
	value: number;
	unit: string | null;
	confidence: number;
}

const UNIT_WORDS = 'pcs|pc|pieces|piece|ea|each|units|unit|pairs|pair|prs|pr|sets|set';
// A number followed by inches or "x 96" is a size, not a quantity.
const NOT_A_SIZE = `(?!\\s*(?:"|''|in\\b|inch|x\\s*\\d|×\\s*\\d|\\d))`;

/** A quantity written just before a part number. */
function quantityBefore(before: string): Quantity | null {
	const t = before.replace(/\s+$/, ' ');
	let m: RegExpMatchArray | null;
	if ((m = t.match(/\((\d{1,5})\)\s*$/))) return { value: Number(m[1]), unit: null, confidence: 0.85 };
	if ((m = t.match(new RegExp(`\\b(\\d{1,4}|${WORD})\\s+(?:boxes|box|bx|cases|case|packs|pack)\\s+of\\s+(\\d{1,4})\\s*(?:of\\s+)?$`, 'i')))) {
		return { value: numberOf(m[1]), unit: `box of ${m[2]}`, confidence: 0.8 };
	}
	if ((m = t.match(/\bhalf\s+(?:a\s+)?dozen\s*(?:of\s+)?$/i))) return { value: 6, unit: 'ea', confidence: 0.7 };
	if ((m = t.match(new RegExp(`\\b(\\d{1,4}|${WORD})\\s+dozen\\s*(?:of\\s+)?$`, 'i')))) {
		return { value: numberOf(m[1]), unit: 'dozen', confidence: 0.75 };
	}
	if ((m = t.match(new RegExp(`\\b(\\d{1,5})\\s*(${UNIT_WORDS})\\.?\\s*(?:of\\s+)?(?:[-:x×]\\s*)?$`, 'i')))) {
		return { value: Number(m[1]), unit: unitOf(m[2]), confidence: 0.85 };
	}
	if ((m = t.match(/\b(?:qty|quantity)\.?\s*[:#-]?\s*(\d{1,5})\s*[-:,]?\s*$/i))) {
		return { value: Number(m[1]), unit: null, confidence: 0.85 };
	}
	if ((m = t.match(/(?:^|[\s(])(\d{1,5})\s*(?:[x×*]|ea\.?|-|:|of(?:\s+the)?)?\s*$/i))) {
		return { value: Number(m[1]), unit: null, confidence: 0.75 };
	}
	if ((m = t.match(new RegExp(`\\b(${WORD})\\s*(?:x\\s*)?(?:(?:more\\s+)?of\\s+(?:the\\s+|your\\s+)?)?$`, 'i')))) {
		// "a" alone ("need a S6-96BC") is weak evidence of one.
		return { value: numberOf(m[1]), unit: null, confidence: /^an?$/i.test(m[1]) ? 0.5 : 0.7 };
	}
	return null;
}

/** A quantity written just after a part number. Needs an explicit marker. */
function quantityAfter(after: string): Quantity | null {
	let m: RegExpMatchArray | null;
	if ((m = after.match(/^\s*\(?\s*(?:boxes|box|case|pack)\s+of\s+(\d{1,4})\s*\)?\s*[x×*]\s*(\d{1,4})/i))) {
		return { value: Number(m[2]), unit: `box of ${m[1]}`, confidence: 0.8 };
	}
	if ((m = after.match(new RegExp(`^\\s*[,:;-]?\\s*\\(?\\s*(?:qty|quantity)\\.?\\s*[:#=-]?\\s*(\\d{1,5})\\s*(${UNIT_WORDS})?\\b`, 'i')))) {
		return { value: Number(m[1]), unit: unitOf(m[2]), confidence: 0.85 };
	}
	if ((m = after.match(new RegExp(`^\\s*[x×*]\\s*(\\d{1,5})${NOT_A_SIZE}\\s*(${UNIT_WORDS})?`, 'i')))) {
		return { value: Number(m[1]), unit: unitOf(m[2]), confidence: 0.85 };
	}
	if ((m = after.match(new RegExp(`^\\s*[-–:=,]?\\s*(\\d{1,4}|${WORD})\\s+dozen\\b`, 'i')))) {
		return { value: numberOf(m[1]), unit: 'dozen', confidence: 0.75 };
	}
	if ((m = after.match(new RegExp(`^\\s*[-–:=,]?\\s*(\\d{1,5})\\s*(${UNIT_WORDS})\\b\\.?`, 'i')))) {
		return { value: Number(m[1]), unit: unitOf(m[2]), confidence: 0.8 };
	}
	if ((m = after.match(new RegExp(`^\\s*[-–:=]\\s*(\\d{1,5})${NOT_A_SIZE}(?:\\s|$|[,;.)])`, 'i')))) {
		return { value: Number(m[1]), unit: null, confidence: 0.7 };
	}
	return null;
}

/** "@ $201.75", "$201.75 ea" -> unit price; "= $807.00", "ext $807.00" -> line total. */
function pricesIn(text: string): { unitPrice: number | null; lineTotal: number | null } {
	const unit =
		text.match(/@\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/) ??
		text.match(/\$\s*([\d,]+\.\d{2})\s*(?:\/\s*)?(?:ea\b|each\b|per\b)/i) ??
		text.match(/(?:unit\s+price|price)\s*:?\s*\$\s*([\d,]+(?:\.\d{1,2})?)/i);
	const total = text.match(/(?:=|\btotal\b|\bext\.?|\bextended\b)\s*:?\s*\$?\s*([\d,]+\.\d{2})/i);
	return { unitPrice: money(unit?.[1]), lineTotal: money(total?.[1]) };
}

function field<T>(value: T | null, confidence: number): { value: T | null; confidence: number } {
	return value === null ? { value: null, confidence: 0 } : { value, confidence };
}

function makeLine(
	raw: string,
	itemNo: string | null,
	quantity: Quantity | null,
	unit: string | null,
	unitPrice: number | null,
	lineTotal: number | null
): DraftLine {
	return {
		raw_text: raw.trim(),
		item_no: field(itemNo, itemNo && new RegExp(`^${ITEM_PATTERN}$`, 'i').test(itemNo) ? 0.9 : 0.5),
		quantity: field(quantity?.value ?? null, quantity?.confidence ?? 0),
		unit: field(unit ?? quantity?.unit ?? null, 0.8),
		unit_price: field(unitPrice, 0.8),
		line_total: field(lineTotal, 0.8)
	};
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

type Column = 'item' | 'qty' | 'unit' | 'price' | 'total' | 'description';

function headerColumn(cell: string): Column | null {
	const c = cell.toLowerCase().replace(/[.:]/g, '').trim();
	if (/^(qty|quantity|qty req(uested)?|order qty|count)$/.test(c)) return 'qty';
	if (/^(item|item ?#|item ?no|item number|part|part ?#|part ?no|part number|sku|p\/n|pn|mfr part|northline ?#)$/.test(c)) return 'item';
	if (/^(uom|unit|units|u\/m)$/.test(c)) return 'unit';
	if (/^(price|unit price|price ea|each|unit cost|cost|your price|net)$/.test(c)) return 'price';
	if (/^(total|ext|ext price|extended|extension|amount|line total)$/.test(c)) return 'total';
	if (/^(description|desc|item description|part description)$/.test(c)) return 'description';
	return null;
}

function cellsOf(line: string, style: 'pipe' | 'tab' | 'space'): string[] {
	if (style === 'pipe') {
		return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
	}
	if (style === 'tab') return line.split('\t').map((c) => c.trim());
	return line.trim().split(/\s{2,}/).map((c) => c.trim());
}

function styleOf(line: string): 'pipe' | 'tab' | 'space' {
	if (line.includes('|')) return 'pipe';
	if (line.includes('\t')) return 'tab';
	return 'space';
}

/** Read table rows under a header row. Returns the lines and which text lines they used. */
function readTables(lines: string[]): { lines: DraftLine[]; used: Set<number>; subtotal: number | null } {
	const found: DraftLine[] = [];
	const used = new Set<number>();
	let subtotal: number | null = null;

	for (let h = 0; h < lines.length; h++) {
		const style = styleOf(lines[h]);
		const header = cellsOf(lines[h], style).map(headerColumn);
		if (!header.includes('item') || !header.includes('qty')) continue;
		used.add(h);

		for (let r = h + 1; r < lines.length; r++) {
			const line = lines[r];
			if (line.trim() === '') break;
			if (/^[\s|:+-]+$/.test(line)) {
				used.add(r); // a markdown divider row
				continue;
			}
			const cells = cellsOf(line, style);
			const cell = (column: Column) => {
				const i = header.indexOf(column);
				return i === -1 ? undefined : cells[i];
			};
			const itemCell = cell('item') ?? '';
			const item = itemCell.match(itemRegex())?.[0] ?? (/\d/.test(itemCell) ? itemCell : null);

			if (!item) {
				// A totals row under the table.
				if (/total/i.test(line)) {
					used.add(r);
					subtotal = money(line.match(/\$?\s*([\d,]+\.\d{2})\s*\|?\s*$/)?.[1]) ?? subtotal;
					continue;
				}
				break; // the table ended
			}
			used.add(r);

			const qtyText = cell('qty') ?? '';
			const qm = qtyText.match(new RegExp(`(\\d{1,5}|${WORD})\\s*(dozen|${UNIT_WORDS}|(?:box|case|pack)\\s+of\\s+\\d+)?`, 'i'));
			const quantity: Quantity | null = qm
				? { value: numberOf(qm[1]), unit: qm[2] ? unitOf(qm[2].replace(/^(case|pack)/i, 'box')) : null, confidence: 0.9 }
				: null;
			found.push(
				makeLine(line, item, quantity, unitOf(cell('unit')) ?? quantity?.unit ?? null, money(cell('price')), money(cell('total')))
			);
		}
	}
	return { lines: found, used, subtotal };
}

// ---------------------------------------------------------------------------
// Free text
// ---------------------------------------------------------------------------

function readFreeText(lines: string[], used: Set<number>): DraftLine[] {
	const found: DraftLine[] = [];
	lines.forEach((line, index) => {
		if (used.has(index)) return;
		const matches = [...line.matchAll(itemRegex())];
		matches.forEach((match, i) => {
			const start = match.index ?? 0;
			const end = start + match[0].length;
			const previousEnd = i === 0 ? 0 : (matches[i - 1].index ?? 0) + matches[i - 1][0].length;
			const nextStart = i === matches.length - 1 ? line.length : (matches[i + 1].index ?? line.length);
			const before = line.slice(previousEnd, start);
			const after = line.slice(end, nextStart);

			const quantity = quantityBefore(before) ?? quantityAfter(after);
			// With one part on the line, prices anywhere on it belong to it.
			const prices = pricesIn(matches.length === 1 ? line.slice(end) : after);
			const raw = matches.length === 1 ? line : line.slice(previousEnd, nextStart);
			found.push(makeLine(raw.replace(/^[\s,;]+/, ''), match[0], quantity, null, prices.unitPrice, prices.lineTotal));
		});
	});
	return found;
}

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

const COMPANY_WORDS =
	/\b(inc|llc|co|corp|company|truck|trucks|fleet|parts|diesel|repair|supply|fab|shop|center|centers|centre|depot|warehouse|service|services|muffler|lube|tire|machine|heavy duty|equipment|transport|logistics|ag)\b/i;
const CITY_STATE = /^\s*([A-Z][A-Za-z.' ]+?),\s*([A-Z]{2})\b/;
// Job titles use the same words as company names ("Parts Counter", "Service Manager").
const JOB_TITLE =
	/\b(manager|counter|buyer|purchasing|advisor|director|coordinator|specialist|desk|owner|president|agent|rep|representative|writer|foreman|lead|supervisor)\b/i;

function companyAndBranch(signature: string, request: string): { company: string | null; branch: string | null } {
	const lines = signature
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	let company: string | null = null;
	let branch: string | null = null;

	for (const line of lines) {
		if (/@|https?:|www\.|\d{3}[\s.-]\d{4}/.test(line)) continue; // email, web, phone
		const looksLikeTitle = JOB_TITLE.test(line) && !/\s[-–|]\s|\b(inc|llc|corp)\b/i.test(line);
		if (!company && COMPANY_WORDS.test(line) && !looksLikeTitle && line.length <= 80) {
			// "Bulldog Truck Centers - Tucson" names the branch after the dash.
			const dash = line.match(/^(.*?)\s+[-–|]\s+(.+)$/);
			company = (dash ? dash[1] : line).trim();
			if (dash) branch = dash[2].trim();
			continue;
		}
		const city = line.match(CITY_STATE);
		if (!branch && city) branch = city[1].trim();
	}

	// "our Tucson branch", "the Waco store"
	if (!branch) {
		const named = request.match(/\b(?:our|the|at)\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)\s+(?:branch|location|store|shop|yard)\b/);
		if (named) branch = named[1];
	}
	return { company, branch };
}

const NOTE_WORDS =
	/\b(ship|shipping|freight|deliver|delivery|pick ?up|will call|drop ?ship|liftgate|p\.?o\.?\b|purchase order|call me|expedite|asap|blind ship|carrier|ups|fedex|ltl|account)\b/i;

function notesOf(lines: string[], used: Set<number>): string {
	const notes = lines
		.filter((line, i) => !used.has(i) && NOTE_WORDS.test(line) && !itemRegex().test(line))
		.map((l) => l.trim())
		.filter(Boolean);
	return notes.join(' / ').slice(0, 400);
}

const REQUEST_WORDS = /\b(quote|quoting|pricing|price|rfq|need|needs|order|send|looking for|request)\b/i;

/**
 * Extract a draft from an email. `today` is the fallback anchor for relative
 * dates when the email has no readable Date header.
 */
export function extractWithRules(source: string, today: string): RfqDraft {
	const email = parseEmail(source);
	const draft = emptyDraft();
	const lines = email.request.split('\n');

	const tables = readTables(lines);
	const free = readFreeText(lines, tables.used);
	draft.lines = [...tables.lines, ...free];

	// A stated subtotal outside a table.
	if (tables.subtotal !== null) {
		draft.stated_subtotal = { value: tables.subtotal, confidence: 0.8 };
	} else {
		lines.forEach((line, i) => {
			if (tables.used.has(i) || itemRegex().test(line)) return;
			const m = line.match(/\b(sub-?total|grand total|total)\b[^$\d\n]*\$\s*([\d,]+\.\d{2})/i);
			if (m) draft.stated_subtotal = { value: money(m[2]), confidence: 0.7 };
		});
	}

	draft.sender_email = field(email.headers.fromEmail, 0.95);
	draft.sender_name = field(email.headers.fromName, 0.8);

	const who = companyAndBranch(email.signature, email.request);
	draft.customer_name = field(who.company, 0.6);
	draft.branch_hint = field(who.branch, 0.6);

	// Relative dates count from when the customer wrote, unless that date is
	// unreadable or later than today.
	const anchor = email.headers.date && email.headers.date <= today ? email.headers.date : today;
	const needed = findNeededBy(email.request, anchor) ?? findNeededBy(email.headers.subject ?? '', anchor);
	if (needed) {
		draft.needed_by_text = { value: needed.text, confidence: needed.confidence };
		draft.needed_by = field(needed.date, needed.confidence);
	}

	draft.notes = notesOf(lines, tables.used);
	draft.is_request = draft.lines.length > 0 || REQUEST_WORDS.test(`${email.headers.subject ?? ''} ${email.request}`);
	return draft;
}
