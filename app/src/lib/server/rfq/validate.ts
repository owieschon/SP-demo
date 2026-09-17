// Validation: deterministic code decides what an extracted draft means.
//
// The extractor (rules or Claude) only proposes. Everything here is plain
// code reading the book as the signed-in user, and every field ends as ok,
// corrected or needs_review with a reason a person can read. Nothing that
// needs review can be approved (the approval function checks again).
//
// Money is worked in whole cents, and the quote price comes from the database
// (round(list_price * (1 - discount), 2)), so the page, this file and the
// approval function can never disagree about a price by a rounding cent.
import type { Tx } from '../db/types.ts';
import { rankSiblings, normalizePart, parsePart, familyOfPrefix, type CatalogItem } from './parts.ts';
import {
	reviewFlags,
	type Check,
	type CustomerCandidate,
	type CustomerResult,
	type Overrides,
	type RfqDraft,
	type ValidatedLine,
	type Validation
} from './schema.ts';

/** Northline's own address: a forward from a colleague is not the customer. */
export const COMPANY_DOMAIN = 'northline.example';

/** A stated price further than this from ours needs a person. */
export const PRICE_TOLERANCE = 0.02;

/** Quantities above this are almost always a misread (a phone number, a zip code). */
export const MAX_QUANTITY = 10_000;

const ok = (reason: string): Check => ({ status: 'ok', reason });
const corrected = (reason: string): Check => ({ status: 'corrected', reason });
const review = (reason: string): Check => ({ status: 'needs_review', reason });

const cents = (value: number) => Math.round(value * 100);
const dollars = (value: number) =>
	`$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const percent = (ratio: number) => `${Math.round(ratio * 1000) / 10}%`;

function day(iso: string): string {
	return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
		timeZone: 'UTC',
		weekday: 'short',
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `needle` appears in `text` as whole words, ignoring case. */
function mentions(text: string, needle: string): boolean {
	if (!needle.trim()) return false;
	return new RegExp(`(^|[^A-Za-z])${escapeRegex(needle.trim())}([^A-Za-z]|$)`, 'i').test(text);
}

const PROMPT_INJECTION =
	/\b(ignore|disregard|forget)\b.{0,30}\b(instructions|prompts?|rules)\b|\bsystem prompt\b|\b(auto-?)?approve (this|the|it)\b|\byou are (now )?an? (ai|assistant|language model)\b/i;

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

interface CustomerRow extends CustomerCandidate {
	price_group: string;
	price_group_label: string;
	discount: number;
	bill_to_no: string | null;
}

const CUSTOMER_COLUMNS = `
	c.customer_no, c.name, c.city, c.state, c.blocked, c.closed, c.bill_to_no,
	c.price_group, pg.label as price_group_label, pg.discount`;

async function customersWhere(tx: Tx, where: string, params: (string | null)[]): Promise<CustomerRow[]> {
	return tx.query<CustomerRow>(
		`select ${CUSTOMER_COLUMNS}
		 from nl.customers c
		 join nl.price_groups pg on pg.code = c.price_group
		 where ${where}
		 order by c.customer_no
		 limit 50`,
		params
	);
}

function candidate(row: CustomerRow): CustomerCandidate {
	return {
		customer_no: row.customer_no,
		name: row.name,
		city: row.city,
		state: row.state,
		blocked: row.blocked,
		closed: row.closed
	};
}

function resolved(
	row: CustomerRow,
	check: Check,
	contact: { id: number; full_name: string } | null,
	candidates: CustomerRow[] = []
): CustomerResult {
	// A blocked or closed account can never be quoted, however it was found.
	const final =
		row.blocked || row.closed
			? review(`${row.name} (${row.customer_no}) is ${row.blocked ? 'blocked' : 'closed'}. ${check.reason}`)
			: check;
	return {
		customer_no: row.customer_no,
		name: row.name,
		city: row.city,
		state: row.state,
		price_group: row.price_group,
		price_group_label: row.price_group_label,
		discount: row.discount,
		contact_id: contact?.id ?? null,
		contact_name: contact?.full_name ?? null,
		candidates: candidates.map(candidate),
		check: final
	};
}

function unresolved(check: Check, candidates: CustomerRow[]): CustomerResult {
	return {
		customer_no: null,
		name: null,
		city: null,
		state: null,
		price_group: null,
		price_group_label: null,
		discount: null,
		contact_id: null,
		contact_name: null,
		candidates: candidates.slice(0, 8).map(candidate),
		check
	};
}

/**
 * Several accounts share a domain (a chain's branches). Pick the one whose
 * city or branch name the email mentions: the branch hint first, then the
 * email text. Only a single clear winner counts.
 */
function pickBranch(candidates: CustomerRow[], hint: string | null, text: string): { row: CustomerRow; where: string } | null {
	const branchName = (row: CustomerRow) => row.name.match(/\s[-–]\s(.+)$/)?.[1] ?? '';
	for (const [where, haystack] of [
		['the signature', hint ?? ''],
		['the email', text]
	] as const) {
		if (!haystack) continue;
		const hits = candidates.filter((row) => mentions(haystack, row.city) || mentions(haystack, branchName(row)));
		if (hits.length === 1) return { row: hits[0], where };
	}
	return null;
}

async function contactFor(tx: Tx, email: string | null, customerNo: string) {
	if (!email) return null;
	const [row] = await tx.sql<{ id: number; full_name: string }>`
		select id, full_name from nl.contacts
		where lower(email) = ${email} and customer_no = ${customerNo}
		order by is_primary desc, id
		limit 1`;
	return row ?? null;
}

async function resolveCustomer(tx: Tx, draft: RfqDraft, overrides: Overrides, text: string): Promise<CustomerResult> {
	const email = draft.sender_email.value?.trim().toLowerCase() || null;
	const domain = email?.split('@')[1] ?? null;
	const writtenName = draft.customer_name.value?.trim() || null;
	const hint = draft.branch_hint.value?.trim() || null;

	// A person chose the account.
	if (overrides.customer_no) {
		const [row] = await customersWhere(tx, 'c.customer_no = $1', [overrides.customer_no]);
		if (!row) return unresolved(review(`Account ${overrides.customer_no} does not exist.`), []);
		return resolved(row, corrected(`Chosen by a person: ${row.name}.`), await contactFor(tx, email, row.customer_no));
	}

	// 1. The sender is a contact on file.
	if (email) {
		const contacts = await tx.sql<{ id: number; full_name: string; customer_no: string }>`
			select id, full_name, customer_no from nl.contacts
			where lower(email) = ${email}
			order by is_primary desc, id`;
		const accounts = [...new Set(contacts.map((c) => c.customer_no))];
		if (accounts.length === 1) {
			const [row] = await customersWhere(tx, 'c.customer_no = $1', [accounts[0]]);
			const contact = contacts[0];
			return resolved(row, ok(`${email} is ${contact.full_name}, a contact at ${row.name}.`), contact);
		}
		if (accounts.length > 1) {
			const rows = await customersWhere(tx, `c.customer_no in (select value from jsonb_array_elements_text($1::jsonb))`, [
				JSON.stringify(accounts)
			]);
			const pick = pickBranch(rows, hint, text);
			if (pick) {
				const contact = contacts.find((c) => c.customer_no === pick.row.customer_no) ?? null;
				return resolved(
					pick.row,
					ok(`${email} is a contact at ${rows.length} accounts; ${pick.where} names ${pick.row.city}.`),
					contact,
					rows
				);
			}
			return unresolved(review(`${email} is a contact at ${rows.length} accounts. Pick the one this request is for.`), rows);
		}
	}

	// 2. The sender's domain.
	if (domain && domain !== COMPANY_DOMAIN) {
		const rows = await customersWhere(tx, 'lower(c.email_domain) = $1', [domain]);
		if (rows.length === 1) {
			return resolved(rows[0], ok(`The sender's domain ${domain} belongs to ${rows[0].name}. The address itself is not on file.`), null);
		}
		if (rows.length > 1) {
			const pick = pickBranch(rows, hint, text);
			if (pick) {
				return resolved(
					pick.row,
					ok(`${rows.length} accounts share ${domain}; ${pick.where} names ${pick.row.city}, which is ${pick.row.name}.`),
					null,
					rows
				);
			}
			return unresolved(
				review(`${rows.length} accounts share ${domain} and the email does not say which branch it is. Pick one.`),
				rows
			);
		}
	}

	// 3. The company name as written. Anyone can type a company name, so a
	// match is only a suggestion: a person confirms it.
	if (writtenName) {
		const key = writtenName.toLowerCase().replace(/[^a-z0-9]/g, '');
		const rows =
			key.length >= 4
				? await customersWhere(
						tx,
						`regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g') like $1 || '%'`,
						[key]
					)
				: [];
		const pick = rows.length > 1 ? pickBranch(rows, hint, text) : null;
		const suggestions = pick ? [pick.row] : rows;
		const from = email ? `${email} is not on file` : 'The sender is unknown';
		if (suggestions.length > 0) {
			return unresolved(
				review(`${from}; the email is signed "${writtenName}", which matches ${suggestions.length === 1 ? suggestions[0].name : `${suggestions.length} accounts`}. Confirm the account.`),
				suggestions
			);
		}
		return unresolved(review(`${from}, and no account is named like "${writtenName}".`), []);
	}

	return unresolved(review(email ? `${email} does not match any contact or account.` : 'The email has no sender to match.'), []);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

interface ItemRow {
	item_no: string;
	key: string;
	description: string;
	list_price: number;
	blocked: boolean;
	net_price: number | null;
}

async function loadItems(tx: Tx, keys: string[], priceGroup: string | null): Promise<Map<string, ItemRow[]>> {
	const byKey = new Map<string, ItemRow[]>();
	if (keys.length === 0) return byKey;
	// Exact item numbers first (uses the primary key), then the normalized
	// form for the ones written with odd case, spaces or dashes.
	const rows = await tx.query<ItemRow>(
		`with wanted as (select value as key from jsonb_array_elements_text($1::jsonb))
		 select i.item_no, w.key, i.description, i.list_price, i.blocked,
		        round(i.list_price * (1 - pg.discount), 2) as net_price
		 from wanted w
		 join nl.items i
		   on upper(regexp_replace(i.item_no, '[^A-Za-z0-9]', '', 'g')) = w.key
		 left join nl.price_groups pg on pg.code = $2`,
		[JSON.stringify(keys), priceGroup]
	);
	for (const row of rows) {
		byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
	}
	return byKey;
}

async function siblingsFor(tx: Tx, written: string, cache: Map<string, CatalogItem[]>) {
	const family = parsePart(written)?.family ?? familyOfPrefix(written);
	const cacheKey = family ?? `letter:${normalizePart(written).slice(0, 1)}`;
	let catalog = cache.get(cacheKey);
	if (!catalog) {
		catalog = family
			? await tx.sql<CatalogItem>`
				select item_no, description, list_price from nl.items where family = ${family} and not blocked`
			: await tx.sql<CatalogItem>`
				select item_no, description, list_price from nl.items
				where not blocked and upper(left(item_no, 1)) = ${normalizePart(written).slice(0, 1)}`;
		cache.set(cacheKey, catalog);
	}
	return rankSiblings(written, catalog, 3).map((s) => ({
		item_no: s.item_no,
		description: s.description,
		list_price: s.list_price,
		why: s.why
	}));
}

// ---------------------------------------------------------------------------
// Quantities
// ---------------------------------------------------------------------------

/** How many pieces one of the written unit is, or null when we cannot say. */
export function piecesPerUnit(unit: string | null): number | null {
	if (unit === null) return 1;
	const u = unit.trim().toLowerCase().replace(/\.$/, '');
	if (/^(ea|each|pcs?|pieces?|units?|qty|x)$/.test(u) || u === '') return 1;
	if (/^(pairs?|prs?)$/.test(u)) return 2;
	if (/^(dozen|doz|dz)$/.test(u)) return 12;
	const box = u.match(/^(?:box(?:es)?|bx|case|cases|pack|packs|pk)\s*(?:of\s*)?(\d{1,4})$/);
	if (box) return Number(box[1]);
	return null;
}

function checkQuantity(value: number | null, unit: string | null): { quantity: number | null; check: Check } {
	if (value === null) return { quantity: null, check: review('No quantity found on this line.') };
	if (!Number.isInteger(value) || value <= 0) {
		return { quantity: null, check: review(`A quantity is a whole number above zero; this line says ${value}.`) };
	}
	const per = piecesPerUnit(unit);
	if (per === null) {
		return { quantity: null, check: review(`"${unit}" is not a unit this part is sold in (it is sold each). How many pieces?`) };
	}
	const pieces = value * per;
	if (pieces > MAX_QUANTITY) {
		return { quantity: null, check: review(`${pieces.toLocaleString('en-US')} pieces is far more than any order; check the number.`) };
	}
	if (per === 1) return { quantity: pieces, check: ok(`${pieces} each.`) };
	return { quantity: pieces, check: corrected(`${value} ${unit} of a part sold each is ${pieces} pieces.`) };
}

// ---------------------------------------------------------------------------
// The whole draft
// ---------------------------------------------------------------------------

export interface ValidateInput {
	draft: RfqDraft;
	overrides: Overrides;
	/** The email text, for finding a branch name the extractor did not pick out. */
	source: string;
}

export async function validateDraft(tx: Tx, input: ValidateInput): Promise<Validation> {
	const { draft, overrides, source } = input;
	const [{ today }] = await tx.sql<{ today: string }>`select nl.today() as today`;

	const customer = await resolveCustomer(tx, draft, overrides, source);
	const discount = customer.discount;

	// What each line asks for, after a person's changes.
	const asked = draft.lines.map((line, index) => {
		const override = overrides.lines?.[String(index)] ?? {};
		return { line, index, override, written: override.item_no ?? line.item_no.value };
	});
	const items = await loadItems(
		tx,
		[...new Set(asked.map((a) => (a.written ? normalizePart(a.written) : '')).filter(Boolean))],
		customer.price_group
	);
	const siblingCache = new Map<string, CatalogItem[]>();

	const lines: ValidatedLine[] = [];
	for (const { line, index, override, written } of asked) {
		const base: ValidatedLine = {
			index,
			raw_text: line.raw_text,
			item_as_written: line.item_no.value,
			item_no: null,
			description: null,
			suggestions: [],
			item_check: ok(''),
			quantity_as_written: line.quantity.value,
			unit_as_written: line.unit.value,
			quantity: null,
			quantity_check: ok(''),
			list_price: null,
			unit_price: null,
			stated_unit_price: line.unit_price.value,
			stated_line_total: line.line_total.value,
			line_total: null,
			price_check: ok(''),
			supply: null,
			removed: override.removed === true
		};

		if (base.removed) {
			const removed = corrected('Removed by a person; it will not be quoted.');
			lines.push({ ...base, item_check: removed, quantity_check: removed, price_check: removed });
			continue;
		}

		// The part.
		let item: ItemRow | null = null;
		if (!written) {
			base.item_check = review('No part number on this line. Pick one or remove the line.');
		} else {
			const matches = items.get(normalizePart(written)) ?? [];
			const exact = matches.find((m) => m.item_no === written.trim());
			item = exact ?? (matches.length === 1 ? matches[0] : null);
			if (matches.length > 1 && !exact) {
				base.item_check = review(`"${written}" matches ${matches.map((m) => m.item_no).join(' and ')}. Pick one.`);
			} else if (!item) {
				base.suggestions = await siblingsFor(tx, written, siblingCache);
				base.item_check = review(
					base.suggestions.length > 0
						? `${written} is not in the catalog. Closest: ${base.suggestions.map((s) => s.item_no).join(', ')}.`
						: `${written} is not in the catalog, and nothing close was found.`
				);
			} else if (item.blocked) {
				base.suggestions = await siblingsFor(tx, item.item_no, siblingCache);
				base.item_check = review(`${item.item_no} is blocked in the catalog and cannot be quoted. Pick another part.`);
				item = null;
			} else if (override.item_no) {
				base.item_check = corrected(`Chosen by a person: ${item.item_no}.`);
			} else if (exact) {
				base.item_check = ok('In the catalog.');
			} else {
				base.item_check = corrected(`Written as "${written}"; the catalog number is ${item.item_no}.`);
			}
		}
		if (item) {
			base.item_no = item.item_no;
			base.description = item.description;
			base.list_price = item.list_price;
		}

		// The quantity.
		if (override.quantity !== undefined) {
			const q = checkQuantity(override.quantity, null);
			base.quantity = q.quantity;
			base.quantity_check = q.check.status === 'ok' ? corrected(`Set by a person to ${q.quantity}.`) : q.check;
		} else {
			const q = checkQuantity(line.quantity.value, line.unit.value);
			base.quantity = q.quantity;
			base.quantity_check = q.check;
		}

		// The price.
		const stated = line.unit_price.value;
		const statedTotal = line.line_total.value;
		const writtenQty = line.quantity.value;
		const arithmeticWrong =
			stated !== null && statedTotal !== null && writtenQty !== null && cents(stated) * writtenQty !== cents(statedTotal);

		if (!item) {
			base.price_check = ok('Priced once the part is settled.');
		} else if (discount === null || item.net_price === null) {
			base.price_check = ok('Priced once the customer is settled.');
		} else {
			base.unit_price = item.net_price;
			if (base.quantity !== null) base.line_total = (cents(item.net_price) * base.quantity) / 100;
			const ours = `our price is ${dollars(item.net_price)} (list ${dollars(item.list_price)} less ${percent(discount)}, ${customer.price_group_label})`;

			if (arithmeticWrong) {
				const expected = (cents(stated!) * writtenQty!) / 100;
				base.price_check = override.accept_price
					? corrected(`Their line total did not add up; quoting ${ours}.`)
					: review(
							`Their line says ${writtenQty} x ${dollars(stated!)} = ${dollars(statedTotal!)}, but that comes to ${dollars(expected)}. ${ours[0].toUpperCase()}${ours.slice(1)}.`
						);
			} else if (stated !== null) {
				const gap = Math.abs(stated - item.net_price) / item.net_price;
				if (gap <= PRICE_TOLERANCE) {
					base.price_check = ok(`They wrote ${dollars(stated)}; ${ours}, within 2%.`);
				} else if (override.accept_price) {
					base.price_check = corrected(`They wrote ${dollars(stated)}; quoting ${ours}.`);
				} else {
					base.price_check = review(`They wrote ${dollars(stated)} each, but ${ours}: ${percent(gap)} apart.`);
				}
			} else {
				base.price_check = ok(`${ours[0].toUpperCase()}${ours.slice(1)}.`);
			}
		}
		lines.push(base);
	}

	const active = lines.filter((l) => !l.removed);

	// Is there anything to quote at all?
	const lines_check =
		active.length > 0
			? ok(`${active.length} ${active.length === 1 ? 'line' : 'lines'} requested.`)
			: review(
					draft.is_request
						? 'No requested parts were found. Add them in a new draft, or reject this one.'
						: 'This email does not ask for parts. Reject it, or paste the right email.'
				);

	// Totals: our subtotal, and whether theirs adds up.
	const priced = active.every((l) => l.line_total !== null);
	const subtotal = active.length > 0 && priced ? active.reduce((sum, l) => sum + cents(l.line_total!), 0) / 100 : null;
	const statedSubtotal = draft.stated_subtotal.value;
	let totalsCheck = ok('');
	if (statedSubtotal !== null) {
		// Add up their own figures: stated line totals, or quantity x stated price.
		const theirLines = active.map((l) =>
			l.stated_line_total !== null
				? cents(l.stated_line_total)
				: l.stated_unit_price !== null && l.quantity_as_written !== null
					? cents(l.stated_unit_price) * l.quantity_as_written
					: null
		);
		const theirSum = theirLines.every((v) => v !== null) ? theirLines.reduce((a, b) => a! + b!, 0)! : null;
		if (theirSum !== null && active.length > 0 && theirSum !== cents(statedSubtotal)) {
			totalsCheck = overrides.accept_totals
				? corrected(`Their subtotal did not add up; the quote uses the lines.`)
				: review(`Their subtotal is ${dollars(statedSubtotal)}, but their lines add up to ${dollars(theirSum / 100)}.`);
		} else if (theirSum !== null) {
			totalsCheck = ok(`Their subtotal of ${dollars(statedSubtotal)} adds up.`);
		} else {
			totalsCheck = ok(`They state a total of ${dollars(statedSubtotal)} without line prices to check it against.`);
		}
	}

	// The needed-by date.
	let neededDate: string | null;
	let neededCheck: Check;
	const neededText = draft.needed_by_text.value;
	if (overrides.needed_by !== undefined) {
		neededDate = overrides.needed_by;
		neededCheck =
			neededDate === null
				? corrected('No date: the commitment window will run 90 days.')
				: neededDate < today
					? review(`${day(neededDate)} is in the past (today is ${day(today)}).`)
					: corrected(`Set by a person to ${day(neededDate)}.`);
	} else {
		const value = draft.needed_by.value;
		neededDate = value && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
		if (value && !neededDate) {
			neededCheck = review(`"${value}" is not a date. Pick one, or choose no date.`);
		} else if (neededDate && neededDate < today) {
			neededCheck = review(`${neededText ? `"${neededText}" is` : 'The needed-by date is'} ${day(neededDate)}, which has passed (today is ${day(today)}).`);
		} else if (neededDate) {
			neededCheck = ok(neededText ? `Read "${neededText}" as ${day(neededDate)}.` : `Needed by ${day(neededDate)}.`);
		} else if (neededText) {
			neededCheck = review(`"${neededText}" does not name a date. Pick one, or choose no date.`);
		} else {
			neededCheck = ok('No date given: the commitment window will run 90 days.');
		}
	}

	// Can we ship it? The same netting the late-order forecast does
	// (nl.available_to_promise, migration 0016), asked per line against the
	// needed-by date. It is information, not a check: nothing here can make a
	// draft need review, because a person may well quote a longer lead time.
	await addSupplyNotes(tx, lines, neededDate ?? today);

	const warnings: string[] = [];
	if (PROMPT_INJECTION.test(source)) {
		warnings.push(
			'This email contains text that reads like instructions to an AI system. It was treated as plain text; nothing happens without your approval.'
		);
	}
	const validation: Validation = {
		today,
		customer,
		lines,
		lines_check,
		needed_by: { text: neededText, date: neededDate, check: neededCheck },
		totals: { subtotal, stated_subtotal: statedSubtotal, check: totalsCheck },
		warnings,
		needs_review: 0
	};
	validation.needs_review = reviewFlags(validation).length;
	return validation;
}

// ---------------------------------------------------------------------------
// What the supply side says about each line
// ---------------------------------------------------------------------------

/** The part of nl.available_to_promise's answer this note needs. */
interface AtpNote {
	can_meet: boolean;
	on_hand: number;
	promised_earlier: number;
	earliest_date: string;
	earliest_basis: 'stock' | 'supply' | 'lead_time';
	lead_days: number;
	covering: { source: string; document_no: string | null; party: string | null; due_date: string | null; quantity: number } | null;
}

/**
 * Add a plain-English supply note to every line that resolved to a part and a
 * quantity. One round trip: the function is called once per line inside one
 * statement.
 */
async function addSupplyNotes(tx: Tx, lines: ValidatedLine[], neededBy: string): Promise<void> {
	const asking = lines
		.filter((l) => !l.removed && l.item_no !== null && l.quantity !== null && l.quantity > 0)
		.map((l) => ({ index: l.index, item_no: l.item_no, quantity: l.quantity }));
	if (asking.length === 0) return;

	const rows = await tx.sql<{ index: number; answer: AtpNote | null }>`
		select (ask ->> 'index')::int as index,
		       nl.available_to_promise(ask ->> 'item_no', (ask ->> 'quantity')::int, ${neededBy}::date) as answer
		from jsonb_array_elements(${JSON.stringify(asking)}::jsonb) as ask`;

	for (const row of rows) {
		const line = lines.find((l) => l.index === row.index);
		if (!line || !row.answer) continue;
		line.supply = supplyNote(row.answer, line.quantity!, neededBy);
	}
}

/** "8 on hand, 4 due Sep 28 on PO-104471: can ship by Oct 3". */
function supplyNote(a: AtpNote, quantity: number, neededBy: string): string {
	const free = Math.max(a.on_hand - a.promised_earlier, 0);
	const have = `${free} of ${quantity} free on the shelf`;
	const from =
		a.covering && a.covering.source !== 'stock'
			? `, ${a.covering.quantity} on ${a.covering.document_no}${a.covering.party ? ` (${a.covering.party})` : ''}${
					a.covering.due_date ? ` due ${day(a.covering.due_date)}` : ''
				}`
			: '';
	if (a.can_meet) return `${have}${from}: can ship by ${day(neededBy)}.`;
	const because =
		a.earliest_basis === 'lead_time'
			? `nothing on order, so ${a.lead_days} days to buy or make it`
			: 'the supply that covers it lands later';
	return `${have}${from}: cannot ship ${quantity} by ${day(neededBy)}; earliest ${day(a.earliest_date)} (${because}).`;
}
