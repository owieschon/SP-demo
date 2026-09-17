// The agent's lookups: everything it may read, and nothing it may write.
//
// Every lookup runs inside the same transaction as the signed-in reviewer
// (db.asUser), so row-level security decides what it can see, exactly as it
// would for a person on a page. There is no write here and no way to add one:
// the only write in the whole feature is nl.queue_mail_draft.
//
// Two rules the caller relies on:
//   * Every lookup is recorded on the run (name, input, rows, ms), and a run
//     may make at most nl.mail_lookup_cap() of them. The recorder counts.
//   * Every lookup is batched over all the parts in the message, so "three
//     parts" costs the same lookup budget as "one part". A reply about six
//     parts must not be six times as expensive to work out.
//
// Nothing here decides what may be said. The lookups return the truth,
// including cost and margin, which the agent needs to know that a price is
// below the floor. policy.ts decides what reaches a draft.
import type { Tx } from '../db/types.ts';

/** Bytes of JSON one lookup may hand back. Longer results are trimmed. */
export const MAX_LOOKUP_BYTES = 16 * 1024;

export interface LookupRecord {
	name: string;
	input: Record<string, unknown>;
	rows: number;
	ms: number;
	trimmed?: boolean;
}

/**
 * Counts and records lookups, and refuses the one past the cap. One recorder
 * per run, so the cap is per message the way the brief asks.
 */
export class LookupBudget {
	readonly cap: number;
	private readonly records: LookupRecord[] = [];

	constructor(cap: number) {
		this.cap = cap;
	}

	get used(): number {
		return this.records.length;
	}

	get left(): number {
		return Math.max(this.cap - this.records.length, 0);
	}

	list(): LookupRecord[] {
		return [...this.records];
	}

	/** Run one lookup, or return null when the budget is spent. */
	async run<T>(name: string, input: Record<string, unknown>, work: () => Promise<T[]>): Promise<T[] | null> {
		if (this.left === 0) return null;
		const started = Date.now();
		const rows = await work();
		// The model (or the page) never sees more than the cap allows. Trimming
		// the tail of the rows keeps the result honest: it is the first n rows,
		// not a summary that quietly dropped something.
		let kept = rows;
		let trimmed = false;
		while (kept.length > 1 && JSON.stringify(kept).length > MAX_LOOKUP_BYTES) {
			kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
			trimmed = true;
		}
		this.records.push({
			name,
			input,
			rows: kept.length,
			ms: Date.now() - started,
			...(trimmed ? { trimmed: true } : {})
		});
		return kept;
	}
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Which of the other teams' work is on this database. The desk degrades
 * rather than breaks: with no availability function it falls back to stock
 * less what is already promised, and says so.
 */
export interface DeskCapabilities {
	availableToPromise: boolean;
	openLineProjection: boolean;
	documentAttachments: boolean;
}

export async function readCapabilities(tx: Tx): Promise<DeskCapabilities> {
	const [row] = await tx.sql<{ atp: string | null; projection: string | null; attachments: string | null }>`
		select to_regprocedure('nl.available_to_promise(text,int,date)')::text as atp,
		       to_regclass('nl.open_line_projection')::text as projection,
		       to_regclass('nl.document_attachments')::text as attachments`;
	return {
		availableToPromise: row?.atp !== null,
		openLineProjection: row?.projection !== null,
		documentAttachments: row?.attachments !== null
	};
}

// ---------------------------------------------------------------------------
// Who wrote to us
// ---------------------------------------------------------------------------

export interface SenderMatch {
	customerNo: string | null;
	customerName: string | null;
	city: string | null;
	state: string | null;
	priceGroup: string | null;
	priceGroupLabel: string | null;
	discount: number | null;
	billToNo: string | null;
	blocked: boolean;
	closed: boolean;
	contactId: number | null;
	contactName: string | null;
	vendorNo: string | null;
	vendorName: string | null;
	ownerId: number | null;
	ownerName: string | null;
	/** How it was matched, in one sentence a person can check. */
	reason: string;
	/** Several accounts fit and nothing in the mail chose between them. */
	candidates: { customerNo: string; name: string; city: string; state: string }[];
}

const NO_MATCH: SenderMatch = {
	customerNo: null,
	customerName: null,
	city: null,
	state: null,
	priceGroup: null,
	priceGroupLabel: null,
	discount: null,
	billToNo: null,
	blocked: false,
	closed: false,
	contactId: null,
	contactName: null,
	vendorNo: null,
	vendorName: null,
	ownerId: null,
	ownerName: null,
	reason: '',
	candidates: []
};

interface AccountRow {
	customer_no: string;
	name: string;
	city: string;
	state: string;
	price_group: string;
	price_group_label: string;
	discount: number;
	bill_to_no: string | null;
	blocked: boolean;
	closed: boolean;
	owner_id: number | null;
	owner_name: string | null;
}

const ACCOUNT_COLUMNS = `
	c.customer_no, c.name, c.city, c.state, c.price_group, pg.label as price_group_label,
	pg.discount, c.bill_to_no, c.blocked, c.closed, c.owner_id, u.full_name as owner_name`;

function toMatch(row: AccountRow, reason: string, contact: { id: number; full_name: string } | null): SenderMatch {
	return {
		...NO_MATCH,
		customerNo: row.customer_no,
		customerName: row.name,
		city: row.city,
		state: row.state,
		priceGroup: row.price_group,
		priceGroupLabel: row.price_group_label,
		discount: row.discount,
		billToNo: row.bill_to_no,
		blocked: row.blocked,
		closed: row.closed,
		contactId: contact?.id ?? null,
		contactName: contact?.full_name ?? null,
		ownerId: row.owner_id,
		ownerName: row.owner_name,
		reason
	};
}

/** True when `needle` appears in `text` as whole words, ignoring case. */
function mentions(text: string, needle: string): boolean {
	const word = needle.trim();
	if (!word) return false;
	const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`(^|[^A-Za-z])${escaped}([^A-Za-z]|$)`, 'i').test(text);
}

/** The part after a dash in "Chain Name - Tulsa". */
function branchName(name: string): string {
	return name.match(/\s[-–]\s(.+)$/)?.[1] ?? '';
}

/**
 * Resolve the sender: the contact's address first, then the domain, then the
 * company name as written. Several branches of a chain share one domain, so
 * when the domain fits more than one account the text of the mail has to name
 * the city or the branch; if it does not, nothing is matched and a person is
 * asked, because quoting the wrong branch is a real mistake with real prices
 * attached.
 *
 * On the procurement desk a supplier is looked up the same way, by the domain
 * in their address against a slug of their name.
 */
export async function resolveSender(
	tx: Tx,
	input: { fromAddress: string; text: string; companyName: string | null; branchHint: string | null; kind: 'orders' | 'procurement' }
): Promise<SenderMatch> {
	const email = input.fromAddress.trim().toLowerCase();
	const domain = email.split('@')[1] ?? '';

	const accountsWhere = (where: string, params: (string | null)[]) =>
		tx.query<AccountRow>(
			`select ${ACCOUNT_COLUMNS}
			 from nl.customers c
			 join nl.price_groups pg on pg.code = c.price_group
			 left join nl.users u on u.id = c.owner_id
			 where ${where}
			 order by c.customer_no
			 limit 50`,
			params
		);

	// 1. The address belongs to a contact on file.
	const contacts = await tx.sql<{ id: number; full_name: string; customer_no: string }>`
		select id, full_name, customer_no from nl.contacts
		where lower(email) = ${email}
		order by is_primary desc, id`;
	const contactAccounts = [...new Set(contacts.map((c) => c.customer_no))];
	if (contactAccounts.length === 1) {
		const [row] = await accountsWhere('c.customer_no = $1', [contactAccounts[0]]);
		if (row) {
			return toMatch(row, `${email} is ${contacts[0].full_name} at ${row.name} (${row.customer_no}).`, contacts[0]);
		}
	}
	if (contactAccounts.length > 1) {
		const rows = await accountsWhere(
			'c.customer_no in (select value from jsonb_array_elements_text($1::jsonb))',
			[JSON.stringify(contactAccounts)]
		);
		const pick = pickBranch(rows, input.branchHint, input.text);
		if (pick) {
			const contact = contacts.find((c) => c.customer_no === pick.customer_no) ?? null;
			return toMatch(
				pick,
				`${email} is a contact at ${rows.length} accounts; the mail names ${pick.city}, which is ${pick.name} (${pick.customer_no}).`,
				contact
			);
		}
		return {
			...NO_MATCH,
			reason: `${email} is a contact at ${rows.length} accounts and the mail does not say which branch it is.`,
			candidates: rows.map((r) => ({ customerNo: r.customer_no, name: r.name, city: r.city, state: r.state }))
		};
	}

	// 2. A supplier, on the procurement desk.
	if (input.kind === 'procurement' && domain) {
		const vendors = await tx.sql<{ vendor_no: string; name: string }>`
			select vendor_no, name from nl.vendors
			where lower(regexp_replace(name, '[^A-Za-z0-9]', '', 'g')) = ${domain.split('.')[0]}
			order by vendor_no
			limit 5`;
		if (vendors.length === 1) {
			return {
				...NO_MATCH,
				vendorNo: vendors[0].vendor_no,
				vendorName: vendors[0].name,
				reason: `The sender's domain ${domain} matches ${vendors[0].name} (${vendors[0].vendor_no}).`
			};
		}
	}

	// 3. The sender's domain. Branches of a chain share it.
	if (domain) {
		const rows = await accountsWhere('lower(c.email_domain) = $1', [domain]);
		if (rows.length === 1) {
			return toMatch(
				rows[0],
				`${domain} belongs to ${rows[0].name} (${rows[0].customer_no}). The address itself is not on file.`,
				null
			);
		}
		if (rows.length > 1) {
			const pick = pickBranch(rows, input.branchHint, input.text);
			if (pick) {
				return toMatch(
					pick,
					`${rows.length} accounts share ${domain}; the mail names ${pick.city}, which is ${pick.name} (${pick.customer_no}).`,
					null
				);
			}
			return {
				...NO_MATCH,
				reason: `${rows.length} accounts share ${domain} and the mail does not say which branch it is.`,
				candidates: rows.map((r) => ({ customerNo: r.customer_no, name: r.name, city: r.city, state: r.state }))
			};
		}
	}

	// 4. The company name as written. Anyone can type a company name, so this
	// is only a suggestion for a person, never a match.
	const written = input.companyName?.trim() ?? '';
	if (written.length >= 4) {
		const key = written.toLowerCase().replace(/[^a-z0-9]/g, '');
		const rows = await accountsWhere(
			`regexp_replace(lower(c.name), '[^a-z0-9]', '', 'g') like $1 || '%'`,
			[key]
		);
		if (rows.length > 0) {
			return {
				...NO_MATCH,
				reason: `${email} is not on file; the mail is signed "${written}", which is like ${rows.length === 1 ? rows[0].name : `${rows.length} accounts`}.`,
				candidates: rows.map((r) => ({ customerNo: r.customer_no, name: r.name, city: r.city, state: r.state }))
			};
		}
	}

	return { ...NO_MATCH, reason: `${email} does not match any contact, domain or account name.` };
}

function pickBranch(rows: AccountRow[], hint: string | null, text: string): AccountRow | null {
	for (const haystack of [hint ?? '', text]) {
		if (!haystack) continue;
		const hits = rows.filter((r) => mentions(haystack, r.city) || mentions(haystack, branchName(r.name)));
		if (hits.length === 1) return hits[0];
	}
	return null;
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export interface DeskPrice {
	customerNo: string;
	itemNo: string;
	description: string;
	onDate: string;
	quantity: number;
	/** The price before any quantity break, and which rule set it. */
	price: number;
	rule: 'agreement' | 'last paid' | 'group discount' | 'list';
	detail: string;
	breakQuantity: number | null;
	breakDiscount: number | null;
	breakNote: string;
	unitPrice: number;
	extended: number;
	nextQuantity: number | null;
	nextPrice: number | null;
	listPrice: number;
	discount: number;
	/** Internal only: the policy never lets these three leave the building. */
	unitCost: number;
	floorPrice: number;
	marginPct: number | null;
	belowFloor: boolean;
}

interface PriceRow {
	customer_no: string;
	item_no: string;
	description: string;
	on_date: string;
	quantity: number;
	price: number;
	rule: DeskPrice['rule'];
	detail: string;
	break_quantity: number | null;
	break_discount: number | null;
	break_note: string;
	unit_price: number;
	extended: number;
	next_quantity: number | null;
	next_price: number | null;
	list_price: number;
	discount: number;
	unit_cost: number;
	floor_price: number;
	margin_pct: number | null;
	below_floor: boolean;
}

function toDeskPrice(r: PriceRow): DeskPrice {
	return {
		customerNo: r.customer_no,
		itemNo: r.item_no,
		description: r.description,
		onDate: r.on_date,
		quantity: r.quantity,
		price: r.price,
		rule: r.rule,
		detail: r.detail,
		breakQuantity: r.break_quantity,
		breakDiscount: r.break_discount,
		breakNote: r.break_note,
		unitPrice: r.unit_price,
		extended: r.extended,
		nextQuantity: r.next_quantity,
		nextPrice: r.next_price,
		listPrice: r.list_price,
		discount: r.discount,
		unitCost: r.unit_cost,
		floorPrice: r.floor_price,
		marginPct: r.margin_pct,
		belowFloor: r.below_floor
	};
}

/**
 * Price every line of the request in one lookup, at the quantity asked for,
 * through nl.desk_price_for. Nothing is worked out in JavaScript: a reply and
 * the quote behind it quote the same function.
 */
export async function priceLines(
	tx: Tx,
	budget: LookupBudget,
	input: { customerNo: string; lines: { itemNo: string; quantity: number }[]; onDate?: string | null }
): Promise<DeskPrice[]> {
	if (input.lines.length === 0) return [];
	const asked = input.lines.map((line, index) => ({
		line_no: index + 1,
		item_no: line.itemNo,
		quantity: Math.max(1, line.quantity)
	}));
	const rows = await budget.run<PriceRow>(
		'price_lines',
		{ customer_no: input.customerNo, lines: asked },
		() =>
			tx.query<PriceRow>(
				`select p.*, i.description
				 from jsonb_to_recordset($1::jsonb) as l (line_no int, item_no text, quantity int)
				 cross join lateral nl.desk_price_for($2, l.item_no, l.quantity, $3::date) p
				 join nl.items i on i.item_no = p.item_no
				 order by l.line_no`,
				[JSON.stringify(asked), input.customerNo, input.onDate ?? null]
			)
	);
	return (rows ?? []).map(toDeskPrice);
}

export interface AgreementRow {
	itemNo: string;
	netPrice: number;
	validFrom: string;
	validTo: string | null;
	note: string;
}

/** The account's price agreements in force today, for the parts in question. */
export async function agreementsFor(
	tx: Tx,
	budget: LookupBudget,
	input: { customerNo: string; itemNos: string[] }
): Promise<AgreementRow[]> {
	if (input.itemNos.length === 0) return [];
	const rows = await budget.run<{
		item_no: string;
		net_price: number;
		valid_from: string;
		valid_to: string | null;
		note: string;
	}>('agreements_for', { customer_no: input.customerNo, items: input.itemNos }, () =>
		tx.query(
			`select cp.item_no, cp.net_price, cp.valid_from, cp.valid_to, cp.note
			 from nl.customer_prices cp
			 where cp.customer_no = $1
			   and cp.item_no in (select value from jsonb_array_elements_text($2::jsonb))
			   and cp.valid_from <= nl.today()
			   and (cp.valid_to is null or cp.valid_to >= nl.today())
			 order by cp.item_no`,
			[input.customerNo, JSON.stringify(input.itemNos)]
		)
	);
	return (rows ?? []).map((r) => ({
		itemNo: r.item_no,
		netPrice: r.net_price,
		validFrom: r.valid_from,
		validTo: r.valid_to,
		note: r.note
	}));
}

export interface PastPriceRow {
	itemNo: string;
	unitPrice: number;
	quantity: number;
	postedOn: string;
	invoiceNo: string;
}

/** What this account last paid for each of these parts. Their own history only. */
export async function pastPricesFor(
	tx: Tx,
	budget: LookupBudget,
	input: { customerNo: string; itemNos: string[] }
): Promise<PastPriceRow[]> {
	if (input.itemNos.length === 0) return [];
	const rows = await budget.run<{
		item_no: string;
		unit_price: number;
		quantity: number;
		posted_on: string;
		invoice_no: string;
	}>('past_prices_for', { customer_no: input.customerNo, items: input.itemNos }, () =>
		tx.query(
			`select distinct on (il.item_no)
			        il.item_no, il.unit_price, il.quantity, il.posted_on, il.invoice_no
			 from nl.invoice_lines il
			 where il.customer_no = $1
			   and il.item_no in (select value from jsonb_array_elements_text($2::jsonb))
			   and il.quantity > 0
			 order by il.item_no, il.posted_on desc, il.invoice_no desc, il.line_no desc`,
			[input.customerNo, JSON.stringify(input.itemNos)]
		)
	);
	return (rows ?? []).map((r) => ({
		itemNo: r.item_no,
		unitPrice: r.unit_price,
		quantity: r.quantity,
		postedOn: r.posted_on,
		invoiceNo: r.invoice_no
	}));
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

export interface Availability {
	itemNo: string;
	description: string;
	quantity: number;
	/** How many could go out today, behind what is already promised. */
	freeNow: number;
	/** When the whole quantity can ship. */
	earliestDate: string;
	earliestBasis: 'stock' | 'supply' | 'lead_time';
	canMeet: boolean;
	leadDays: number;
	replenishment: string;
	/** The purchase or production order that decides the date, when there is one. */
	covering: { source: string; documentNo: string | null; dueDate: string | null } | null;
	/** True when this came from stock less open orders rather than the forecast. */
	estimated: boolean;
}

/**
 * When each part can ship. The supply work's nl.available_to_promise is the
 * real answer (it walks stock, purchase orders and production orders in date
 * order behind the promises already made). Without it the desk falls back to
 * stock less what open orders already claim, plus the part's lead time, and
 * every fact it makes is marked estimated so the reply can say so.
 */
export async function availabilityFor(
	tx: Tx,
	budget: LookupBudget,
	input: {
		lines: { itemNo: string; quantity: number }[];
		neededBy: string | null;
		capabilities: DeskCapabilities;
	}
): Promise<Availability[]> {
	if (input.lines.length === 0) return [];
	const asked = input.lines.map((line) => ({ item_no: line.itemNo, quantity: Math.max(1, line.quantity) }));

	if (input.capabilities.availableToPromise) {
		const rows = await budget.run<{ item_no: string; description: string; atp: Record<string, unknown> }>(
			'available_to_promise',
			{ lines: asked, needed_by: input.neededBy },
			() =>
				tx.query(
					`select l.item_no, i.description,
					        nl.available_to_promise(l.item_no, l.quantity, $2::date) as atp
					 from jsonb_to_recordset($1::jsonb) as l (item_no text, quantity int)
					 join nl.items i on i.item_no = l.item_no`,
					[JSON.stringify(asked), input.neededBy]
				)
		);
		return (rows ?? []).map((row) => {
			const atp = row.atp as {
				quantity: number;
				free_now: number;
				earliest_date: string;
				earliest_basis: Availability['earliestBasis'];
				can_meet: boolean;
				lead_days: number;
				replenishment: string;
				covering: { source: string; document_no: string | null; due_date: string | null } | null;
			};
			return {
				itemNo: row.item_no,
				description: row.description,
				quantity: atp.quantity,
				freeNow: atp.free_now,
				earliestDate: atp.earliest_date,
				earliestBasis: atp.earliest_basis,
				canMeet: atp.can_meet,
				leadDays: atp.lead_days,
				replenishment: atp.replenishment,
				covering: atp.covering
					? { source: atp.covering.source, documentNo: atp.covering.document_no, dueDate: atp.covering.due_date }
					: null,
				estimated: false
			};
		});
	}

	// The plain version: what is on the shelf, less what open orders claim.
	const rows = await budget.run<{
		item_no: string;
		description: string;
		quantity: number;
		free_now: number;
		lead_days: number;
		replenishment: string;
		earliest_date: string;
	}>('stock_less_open_orders', { lines: asked }, () =>
		tx.query(
			`select l.item_no, i.description, l.quantity,
			        greatest(coalesce(s.on_hand, 0) - coalesce(o.promised, 0), 0)::int as free_now,
			        -- No supply book to read, so the reply promises the
			        -- three weeks the desk quotes when it has nothing better.
			        21 as lead_days,
			        i.replenishment,
			        (nl.today() + 21)::text as earliest_date
			 from jsonb_to_recordset($1::jsonb) as l (item_no text, quantity int)
			 join nl.items i on i.item_no = l.item_no
			 left join nl.stock s on s.item_no = l.item_no
			 left join lateral (
			   select sum(ol.quantity)::int as promised
			   from nl.open_order_lines ol where ol.item_no = l.item_no
			 ) o on true`,
			[JSON.stringify(asked)]
		)
	);
	return (rows ?? []).map((r) => ({
		itemNo: r.item_no,
		description: r.description,
		quantity: r.quantity,
		freeNow: r.free_now,
		earliestDate: r.free_now >= r.quantity ? 'today' : r.earliest_date,
		earliestBasis: r.free_now >= r.quantity ? 'stock' : 'lead_time',
		canMeet: r.free_now >= r.quantity,
		leadDays: r.lead_days,
		replenishment: r.replenishment,
		covering: null,
		estimated: true
	}));
}

// ---------------------------------------------------------------------------
// Their orders, quotes and commitments
// ---------------------------------------------------------------------------

export interface OpenLine {
	documentNo: string;
	lineNo: number;
	itemNo: string;
	description: string;
	shipDate: string;
	quantity: number;
	lineAmount: number | null;
	/** From the supply forecast when it is there, else null. */
	projectedDate: string | null;
	bucket: string | null;
}

/**
 * The account's open order lines, their billing family included, because a
 * branch's buyer asks about "our order" and means the order their head office
 * placed. The forecast's projected ship date is joined in when the supply
 * work is on this database.
 */
export async function openOrdersFor(
	tx: Tx,
	budget: LookupBudget,
	input: { customerNo: string; capabilities: DeskCapabilities; limit?: number }
): Promise<OpenLine[]> {
	const limit = input.limit ?? 25;
	const projection = input.capabilities.openLineProjection;
	const rows = await budget.run<{
		document_no: string;
		line_no: number;
		item_no: string;
		description: string;
		ship_date: string;
		quantity: number;
		line_amount: number | null;
		projected_date: string | null;
		bucket: string | null;
	}>('open_orders_for', { customer_no: input.customerNo, limit }, () =>
		tx.query(
			`select l.document_no, l.line_no, l.item_no, coalesce(nullif(l.description, ''), i.description) as description,
			        l.ship_date, l.quantity, l.line_amount,
			        ${projection ? 'p.projected_ship_date::text' : 'null::text'} as projected_date,
			        ${projection ? 'p.status' : 'null::text'} as bucket
			 from nl.open_order_lines l
			 join nl.items i on i.item_no = l.item_no
			 ${projection
					? 'left join nl.open_line_projection p on p.document_no = l.document_no and p.line_no = l.line_no'
					: ''}
			 where l.customer_no in (
			   select f.customer_no from nl.customer_family($1) f
			   union
			   select a.customer_no from nl.customer_ancestors($1) a)
			 order by l.ship_date, l.document_no, l.line_no
			 limit $2`,
			[input.customerNo, limit]
		)
	);
	return (rows ?? []).map((r) => ({
		documentNo: r.document_no,
		lineNo: r.line_no,
		itemNo: r.item_no,
		description: r.description,
		shipDate: r.ship_date,
		quantity: r.quantity,
		lineAmount: r.line_amount,
		projectedDate: r.projected_date,
		bucket: r.bucket
	}));
}

export interface OpenQuote {
	quoteId: number;
	quotedOn: string;
	validUntil: string | null;
	lines: number;
	total: number;
	commitmentId: number | null;
	commitmentTitle: string | null;
	endsOn: string | null;
}

/** The account's live quotes, with the commitment each one was written for. */
export async function openQuotesFor(
	tx: Tx,
	budget: LookupBudget,
	input: { customerNo: string }
): Promise<OpenQuote[]> {
	const rows = await budget.run<{
		quote_id: number;
		quoted_on: string;
		valid_until: string | null;
		lines: number;
		total: number;
		commitment_id: number | null;
		commitment_title: string | null;
		ends_on: string | null;
	}>('open_quotes_for', { customer_no: input.customerNo }, () =>
		tx.query(
			`select q.id as quote_id, q.quoted_on, q.valid_until,
			        count(ql.line_no)::int as lines,
			        coalesce(sum(ql.quantity * ql.unit_price), 0) as total,
			        q.commitment_id, cm.title as commitment_title, cm.ends_on::text as ends_on
			 from nl.quotes q
			 left join nl.quote_lines ql on ql.quote_id = q.id
			 left join nl.commitments cm on cm.id = q.commitment_id
			 where q.customer_no in (
			   select f.customer_no from nl.customer_family($1) f
			   union
			   select a.customer_no from nl.customer_ancestors($1) a)
			   and (q.valid_until is null or q.valid_until >= nl.today())
			 group by q.id, q.quoted_on, q.valid_until, q.commitment_id, cm.title, cm.ends_on
			 order by q.quoted_on desc, q.id desc
			 limit 10`,
			[input.customerNo]
		)
	);
	return (rows ?? []).map((r) => ({
		quoteId: r.quote_id,
		quotedOn: r.quoted_on,
		validUntil: r.valid_until,
		lines: r.lines,
		total: r.total,
		commitmentId: r.commitment_id,
		commitmentTitle: r.commitment_title,
		endsOn: r.ends_on
	}));
}

export interface VendorLine {
	documentNo: string;
	itemNo: string;
	description: string;
	quantity: number;
	dueDate: string;
	promisedDate: string | null;
}

/** A supplier's own open purchase lines, for the procurement desk. */
export async function vendorLinesFor(
	tx: Tx,
	budget: LookupBudget,
	input: { vendorNo: string }
): Promise<VendorLine[]> {
	const rows = await budget.run<{
		document_no: string;
		item_no: string;
		description: string;
		quantity: number;
		due_date: string;
		promised_date: string | null;
	}>('vendor_lines_for', { vendor_no: input.vendorNo }, () =>
		tx.query(
			`select l.document_no, l.item_no,
			        coalesce(nullif(l.description, ''), i.description) as description,
			        l.quantity, l.due_date, l.promised_date
			 from nl.open_purchase_lines l
			 join nl.items i on i.item_no = l.item_no
			 where l.vendor_no = $1
			 order by l.due_date, l.document_no
			 limit 25`,
			[input.vendorNo]
		)
	);
	return (rows ?? []).map((r) => ({
		documentNo: r.document_no,
		itemNo: r.item_no,
		description: r.description,
		quantity: r.quantity,
		dueDate: r.due_date,
		promisedDate: r.promised_date
	}));
}

/** The freight the tariff would charge a shipment of this size. */
export async function freightFor(
	tx: Tx,
	budget: LookupBudget,
	subtotal: number
): Promise<{ freight: number; freeOver: number } | null> {
	const rows = await budget.run<{ freight: number; free_over: number }>('freight_for', { subtotal }, () =>
		tx.sql`select freight, free_over from nl.freight_for(${subtotal}, null::date)`
	);
	const row = rows?.[0];
	return row ? { freight: row.freight, freeOver: row.free_over } : null;
}
