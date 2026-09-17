// Parts, vendors and search, against the small world.
//
// The numbers are checked against a direct computation over the ledger, not
// against a figure copied from the view: if part_summary and the raw lines
// ever disagree, these fail.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { AppError } from '../errors.ts';
import {
	getPart,
	getPartDemand,
	getPartSales,
	getSiblings,
	listFamilies,
	listParts,
	readPartListQuery,
	resolveItemNo
} from './parts.ts';
import {
	addVendorContact,
	getVendor,
	getVendorParts,
	listVendors,
	VENDOR_PART_LIMIT,
	vendorContactInput
} from './vendors.ts';
import { cleanQuery, escapeLike, looksLikeNumber, searchAll } from './search.ts';

const ADMIN = 1;
const DANA = 2; // account manager
const PRIYA = 5; // operations
const TERRY = 7; // no longer active

const TODAY = '2026-09-17';

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

/** Item numbers that the small world's ledger sold the most of, to test against. */
async function bestSellers(howMany: number): Promise<string[]> {
	const rows = await db.asSystem((tx) =>
		tx.sql<{ item_no: string }>`
			select il.item_no
			from nl.invoice_lines il
			where il.posted_on > (select (nl.today() - interval '1 year')::date)
			group by il.item_no
			order by sum(il.amount) desc, il.item_no
			limit ${howMany}`
	);
	return rows.map((r) => r.item_no);
}

describe('nl.part_summary', () => {
	it('matches a direct computation of a part\'s last 12 months', async () => {
		const items = await bestSellers(4);
		expect(items).toHaveLength(4);

		for (const itemNo of items) {
			const part = await getPart(db, DANA, itemNo);
			expect(part, itemNo).not.toBeNull();

			// The same figures, worked out from the lines with no view involved.
			const [direct] = await db.asSystem((tx) =>
				tx.sql<{
					units: number;
					revenue: number;
					cost: number;
					buyers: number;
					prior_revenue: number;
					last_sold_on: string | null;
				}>`
					select
						coalesce(sum(il.quantity) filter (where il.posted_on > ${TODAY}::date - interval '1 year'), 0)::int as units,
						coalesce(sum(il.amount) filter (where il.posted_on > ${TODAY}::date - interval '1 year'), 0) as revenue,
						coalesce(sum(il.quantity * il.unit_cost) filter (where il.posted_on > ${TODAY}::date - interval '1 year'), 0) as cost,
						count(distinct il.customer_no) filter (
							where il.posted_on > ${TODAY}::date - interval '1 year' and il.quantity > 0)::int as buyers,
						coalesce(sum(il.amount) filter (
							where il.posted_on <= ${TODAY}::date - interval '1 year'
							  and il.posted_on > ${TODAY}::date - interval '2 years'), 0) as prior_revenue,
						max(il.posted_on) filter (where il.quantity > 0) as last_sold_on
					from nl.invoice_lines il
					where il.item_no = ${itemNo}
					  and il.posted_on <= ${TODAY}::date`
			);

			expect(part!.units12m, itemNo).toBe(direct.units);
			expect(part!.revenue12m, itemNo).toBeCloseTo(direct.revenue, 2);
			expect(part!.buyers12m, itemNo).toBe(direct.buyers);
			expect(part!.revenuePrior12m, itemNo).toBeCloseTo(direct.prior_revenue, 2);
			expect(part!.lastSoldOn, itemNo).toBe(direct.last_sold_on);
			// Gross margin: what was paid against what the lines say it cost.
			expect(part!.margin12m, itemNo).toBeCloseTo((direct.revenue - direct.cost) / direct.revenue, 3);
		}
	});

	it('adds stock, incoming and open orders into a projected available', async () => {
		const [itemNo] = await bestSellers(1);
		const part = await getPart(db, DANA, itemNo);
		expect(part).not.toBeNull();
		expect(part!.projectedAvailable).toBe(
			part!.onHand + part!.onProductionOrder + part!.onPurchaseOrder - part!.openQty
		);
		// Open lines come from whatever export the world has applied, so check
		// them against the live table rather than assuming there are none.
		const [live] = await db.asSystem(
			(tx) =>
				tx.sql<{ lines: number; qty: number }>`
					select count(*)::int as lines, coalesce(sum(quantity), 0)::int as qty
					from nl.open_order_lines where item_no = ${itemNo}`
		);
		expect(part!.openLines).toBe(live.lines);
		expect(part!.openQty).toBe(live.qty);
	});

	it('gives a stocked part a reorder point and leaves made-to-order parts alone', async () => {
		const [counts] = await db.asSystem((tx) =>
			tx.sql<{ stocked: number; mto_with_point: number }>`
				select count(*) filter (where reorder_point is not null)::int as stocked,
				       count(*) filter (where reorder_point is not null
				                          and (made_to_order or blocked or proprietary or family = 'custom'))::int
				         as mto_with_point
				from nl.items`
		);
		expect(counts.stocked).toBeGreaterThan(0);
		expect(counts.mto_with_point).toBe(0);
	});

	it('finds a part by number prefix or by words from its description, and caps the list', async () => {
		const [itemNo] = await bestSellers(1);
		const byNumber = await listParts(db, DANA, readPartListQuery(new URLSearchParams({ q: itemNo.toLowerCase() })));
		expect(byNumber.rows.map((r) => r.itemNo)).toContain(itemNo);

		const byWords = await listParts(db, DANA, readPartListQuery(new URLSearchParams({ q: 'chrome stack' })));
		expect(byWords.rows.length).toBeGreaterThan(0);
		for (const row of byWords.rows) {
			expect(row.description.toLowerCase()).toContain('chrome');
			expect(row.description.toLowerCase()).toContain('stack');
		}
		expect(byWords.rows.length).toBeLessThanOrEqual(byWords.limit);
		expect(byWords.total).toBeGreaterThanOrEqual(byWords.rows.length);

		// A family filter only returns that family, and it agrees with the count
		// the filter itself shows.
		const families = await listFamilies(db, DANA);
		const clamp = families.find((f) => f.family === 'clamp');
		expect(clamp?.items).toBeGreaterThan(0);
		const clamps = await listParts(db, DANA, readPartListQuery(new URLSearchParams({ family: 'clamp' })));
		expect(clamps.total).toBe(clamp!.items);
		expect(clamps.rows.every((r) => r.family === 'clamp')).toBe(true);
	});

	it('sorts by what was asked for, and reads an unknown sort as the default', async () => {
		const query = readPartListQuery(new URLSearchParams({ sort: 'sideways' }));
		expect(query.sort).toBe('revenue');

		const byMargin = await listParts(db, DANA, readPartListQuery(new URLSearchParams({ sort: 'margin' })));
		const margins = byMargin.rows.map((r) => r.margin12m).filter((m) => m !== null);
		expect(margins).toEqual([...margins].sort((a, b) => b - a));

		const byRevenue = await listParts(db, DANA, readPartListQuery(new URLSearchParams()));
		const revenues = byRevenue.rows.map((r) => r.revenue12m);
		expect(revenues).toEqual([...revenues].sort((a, b) => b - a));
	});

	it('only shows parts below the reorder point when asked', async () => {
		const below = await listParts(db, DANA, readPartListQuery(new URLSearchParams({ reorder: '1' })));
		expect(below.rows.every((r) => r.belowReorderPoint)).toBe(true);
		const [check] = await db.asSystem((tx) =>
			tx.sql<{ n: number }>`select count(*)::int as n from nl.part_summary where below_reorder_point`
		);
		expect(below.total).toBe(check.n);
	});
});

describe('the part page', () => {
	it('reads a lower-case item number as the real one', async () => {
		const [itemNo] = await bestSellers(1);
		expect(await resolveItemNo(db, DANA, itemNo.toLowerCase())).toBe(itemNo);
		expect(await resolveItemNo(db, DANA, 'NO-SUCH-PART')).toBeNull();
	});

	it('shows 24 months of units that add up to the ledger', async () => {
		const [itemNo] = await bestSellers(1);
		const sales = await getPartSales(db, DANA, itemNo);
		expect(sales.months).toHaveLength(24);
		// The months run forward and the last one is the current month.
		expect(sales.months.map((m) => m.month)).toEqual([...sales.months.map((m) => m.month)].sort());
		expect(sales.months.at(-1)!.month).toBe('2026-09-01');

		const [direct] = await db.asSystem((tx) =>
			tx.sql<{ units: number }>`
				select coalesce(sum(il.quantity), 0)::int as units
				from nl.invoice_lines il
				where il.item_no = ${itemNo}
				  and il.posted_on >= date_trunc('month', ${TODAY}::date)::date - interval '23 months'
				  and il.posted_on <= ${TODAY}::date`
		);
		const charted = sales.months.reduce((sum, m) => sum + m.units, 0);
		expect(charted).toBe(direct.units);
	});

	it('lists its buyers, biggest first, with the price on their latest order', async () => {
		const [itemNo] = await bestSellers(1);
		const sales = await getPartSales(db, DANA, itemNo);
		expect(sales.topBuyers.length).toBeGreaterThan(0);
		const revenues = sales.topBuyers.map((b) => b.revenue);
		expect(revenues).toEqual([...revenues].sort((a, b) => b - a));

		const top = sales.topBuyers[0];
		const [direct] = await db.asSystem((tx) =>
			tx.sql<{ unit_price: number; posted_on: string }>`
				select il.unit_price, il.posted_on
				from nl.invoice_lines il
				where il.item_no = ${itemNo}
				  and il.customer_no = ${top.customerNo}
				  and il.quantity > 0
				  and il.posted_on > ${TODAY}::date - interval '1 year'
				  and il.posted_on <= ${TODAY}::date
				order by il.posted_on desc, il.invoice_no desc, il.line_no desc
				limit 1`
		);
		expect(top.lastPrice).toBeCloseTo(direct.unit_price, 2);
		expect(top.lastOn).toBe(direct.posted_on);
		expect(sales.recentLines.length).toBeGreaterThan(0);
	});

	it('shows the commitments and open quotes that name the part', async () => {
		// A part that a commitment in the small world actually asks for.
		const [scoped] = await db.asSystem((tx) =>
			tx.sql<{ item_no: string; commitment_id: number }>`
				select ci.item_no, ci.commitment_id
				from nl.commitment_items ci
				order by ci.commitment_id, ci.item_no
				limit 1`
		);
		const demand = await getPartDemand(db, DANA, scoped.item_no);
		expect(demand.commitments.map((c) => c.id)).toContain(scoped.commitment_id);
		// Every quote it shows is still valid today.
		for (const quote of demand.quotes) {
			expect(quote.validUntil === null || quote.validUntil >= TODAY).toBe(true);
		}
	});

	it('offers siblings of the same family and size, and none for a custom part', async () => {
		const [stack] = await db.asSystem((tx) =>
			tx.sql<{ item_no: string }>`
				select item_no from nl.items
				where family = 'stack' and description like '8" %'
				order by item_no
				limit 1`
		);
		const siblings = await getSiblings(db, DANA, stack.item_no);
		expect(siblings.size).toBe('8"');
		expect(siblings.parts.length).toBeGreaterThan(0);
		expect(siblings.parts.map((p) => p.itemNo)).not.toContain(stack.item_no);
		for (const part of siblings.parts) {
			expect(part.description.startsWith('8" ')).toBe(true);
		}

		const [custom] = await db.asSystem((tx) =>
			tx.sql<{ item_no: string }>`select item_no from nl.items where family = 'custom' order by item_no limit 1`
		);
		expect(await getSiblings(db, DANA, custom.item_no)).toEqual({ size: null, parts: [] });
	});
});

describe('nl.vendor_summary', () => {
	it('counts the parts a vendor supplies and adds up their year', async () => {
		const list = await listVendors(db, DANA, { q: '', all: false });
		expect(list.rows.length).toBeGreaterThan(0);
		// Every vendor shown supplies something, best sellers first.
		const revenues = list.rows.map((r) => r.revenue12m);
		expect(revenues).toEqual([...revenues].sort((a, b) => b - a));

		const vendorNo = list.rows[0].vendorNo;
		const vendor = await getVendor(db, DANA, vendorNo);
		expect(vendor).not.toBeNull();

		const [direct] = await db.asSystem((tx) =>
			tx.sql<{ items: number; active_items: number; revenue: number }>`
				select count(*)::int as items,
				       count(*) filter (where not blocked)::int as active_items,
				       coalesce((
				         select sum(il.amount)
				         from nl.invoice_lines il
				         join nl.items i2 on i2.item_no = il.item_no
				         where i2.vendor_no = ${vendorNo}
				           and il.posted_on > ${TODAY}::date - interval '1 year'
				           and il.posted_on <= ${TODAY}::date), 0) as revenue
				from nl.items
				where vendor_no = ${vendorNo}`
		);
		expect(vendor!.items).toBe(direct.items);
		expect(vendor!.activeItems).toBe(direct.active_items);
		expect(vendor!.revenue12m).toBeCloseTo(direct.revenue, 2);

		// The parts it supplies are the same set, and each carries its own year.
		// `total` counts every part; `parts` is capped, so the sum only matches
		// the vendor's revenue while nothing was cut off.
		const supplied = await getVendorParts(db, DANA, vendorNo);
		expect(supplied.total).toBe(direct.items);
		expect(supplied.parts.length).toBe(Math.min(direct.items, VENDOR_PART_LIMIT));
		if (supplied.total <= VENDOR_PART_LIMIT) {
			const summed = supplied.parts.reduce((sum, p) => sum + p.revenue12m, 0);
			expect(summed).toBeCloseTo(vendor!.revenue12m, 2);
		}
	});

	it('hides vendors with no parts until they are asked for', async () => {
		const supplying = await listVendors(db, DANA, { q: '', all: false });
		const everyone = await listVendors(db, DANA, { q: '', all: true });
		expect(everyone.total).toBeGreaterThan(supplying.total);
	});
});

describe('nl.add_vendor_contact', () => {
	/** A vendor that supplies parts, so it has contacts to add to. */
	async function aVendor(): Promise<{ vendorNo: string; updatedAt: string }> {
		const list = await listVendors(db, DANA, { q: '', all: false });
		const vendor = await getVendor(db, DANA, list.rows[0].vendorNo);
		return { vendorNo: vendor!.vendorNo, updatedAt: vendor!.updatedAt };
	}

	function form(fields: Record<string, string>) {
		return vendorContactInput.parse(fields);
	}

	it('lets operations add a contact, and records who did it', async () => {
		const { vendorNo, updatedAt } = await aVendor();
		const result = await addVendorContact(
			db,
			PRIYA,
			form({
				vendorNo,
				fullName: '  Dale   Whitfield ',
				title: 'Quality',
				email: 'dale.whitfield@vendor.example',
				phone: '(216) 555-0142',
				expectedUpdatedAt: updatedAt,
				requestId: randomUUID()
			})
		);
		expect(result.contactId).toBeGreaterThan(0);

		const vendor = await getVendor(db, DANA, vendorNo);
		const added = vendor!.contacts.find((c) => c.id === result.contactId);
		// The extra spaces in the name are cleaned up by the database.
		expect(added?.fullName).toBe('Dale Whitfield');
		expect(added?.title).toBe('Quality');
		expect(added?.isPrimary).toBe(false);

		const [audit] = await db.asSystem((tx) =>
			tx.sql<{ actor_id: number; via: string; entity_id: string }>`
				select actor_id, via, entity_id from nl.audit_log
				where action = 'add_vendor_contact' order by id desc limit 1`
		);
		expect(audit.actor_id).toBe(PRIYA);
		expect(audit.via).toBe('ui');
		expect(audit.entity_id).toBe(vendorNo);
	});

	it('hands the primary over, so only one person is the one to call', async () => {
		const { vendorNo, updatedAt } = await aVendor();
		await addVendorContact(
			db,
			ADMIN,
			form({
				vendorNo,
				fullName: 'Quinn Alvarez',
				title: 'Inside Sales',
				phone: '(216) 555-0155',
				isPrimary: 'on',
				expectedUpdatedAt: updatedAt,
				requestId: randomUUID()
			})
		);
		const vendor = await getVendor(db, DANA, vendorNo);
		const primaries = vendor!.contacts.filter((c) => c.isPrimary && c.active);
		expect(primaries).toHaveLength(1);
		expect(primaries[0].fullName).toBe('Quinn Alvarez');
	});

	it('refuses an account manager, and anyone who is no longer active', async () => {
		const { vendorNo, updatedAt } = await aVendor();
		const attempt = (userId: number) =>
			addVendorContact(
				db,
				userId,
				form({
					vendorNo,
					fullName: 'Robin Keller',
					title: 'Customer Service',
					phone: '(216) 555-0160',
					expectedUpdatedAt: updatedAt,
					requestId: randomUUID()
				})
			);
		await expect(attempt(DANA)).rejects.toThrow(expect.objectContaining({ status: 403 }));
		await expect(attempt(TERRY)).rejects.toThrow(expect.objectContaining({ status: 401 }));
	});

	it('refuses a contact nobody could reach, a title off the list and an unknown vendor', async () => {
		const { vendorNo, updatedAt } = await aVendor();

		// The form catches both of these before the database does.
		expect(
			vendorContactInput.safeParse({
				vendorNo,
				fullName: 'Lee Navarro',
				title: 'Quality',
				expectedUpdatedAt: updatedAt,
				requestId: randomUUID()
			}).success
		).toBe(false);
		expect(
			vendorContactInput.safeParse({
				vendorNo,
				fullName: 'Lee Navarro',
				title: 'Chief Whistler',
				phone: '(216) 555-0161',
				expectedUpdatedAt: updatedAt,
				requestId: randomUUID()
			}).success
		).toBe(false);

		// And the database refuses them itself: a name of one character, and a
		// vendor that does not exist.
		const short = addVendorContact(db, PRIYA, {
			vendorNo,
			fullName: 'L',
			title: 'Quality',
			email: '',
			phone: '(216) 555-0162',
			isPrimary: false,
			expectedUpdatedAt: updatedAt,
			requestId: randomUUID()
		});
		await expect(short).rejects.toThrow(expect.objectContaining({ status: 422 }));

		const nobody = addVendorContact(
			db,
			PRIYA,
			form({
				vendorNo: 'V99999',
				fullName: 'Lee Navarro',
				title: 'Quality',
				phone: '(216) 555-0163',
				expectedUpdatedAt: updatedAt,
				requestId: randomUUID()
			})
		);
		await expect(nobody).rejects.toThrow(expect.objectContaining({ status: 404 }));
	});

	it('answers a resent form with the first result instead of adding twice', async () => {
		const { vendorNo, updatedAt } = await aVendor();
		const input = form({
			vendorNo,
			fullName: 'Avery Bautista',
			title: 'Accounts Receivable',
			email: 'avery.bautista@vendor.example',
			expectedUpdatedAt: updatedAt,
			requestId: randomUUID()
		});
		const first = await addVendorContact(db, PRIYA, input);
		const again = await addVendorContact(db, PRIYA, input);
		expect(again.replayed).toBe(true);
		expect(again.contactId).toBe(first.contactId);

		const vendor = await getVendor(db, DANA, vendorNo);
		expect(vendor!.contacts.filter((c) => c.fullName === 'Avery Bautista')).toHaveLength(1);
	});

	it('refuses a form sent from a page loaded before the last change', async () => {
		const { vendorNo, updatedAt } = await aVendor();
		await addVendorContact(
			db,
			PRIYA,
			form({
				vendorNo,
				fullName: 'Kim Delacroix',
				title: 'Quality',
				phone: '(216) 555-0164',
				expectedUpdatedAt: updatedAt,
				requestId: randomUUID()
			})
		);
		// The same (now stale) row version again.
		const stale = addVendorContact(
			db,
			PRIYA,
			form({
				vendorNo,
				fullName: 'Jesse Iverson',
				title: 'Quality',
				phone: '(216) 555-0165',
				expectedUpdatedAt: updatedAt,
				requestId: randomUUID()
			})
		);
		await expect(stale).rejects.toThrow(AppError);
		await expect(stale).rejects.toThrow(expect.objectContaining({ status: 409 }));
	});
});

describe('search', () => {
	it('reads a query the way the box sends it', () => {
		expect(cleanQuery('  two   words  ')).toBe('two words');
		expect(cleanQuery(null)).toBe('');
		expect(escapeLike('50%_x')).toBe('50\\%\\_x');
		expect(looksLikeNumber('10012')).toBe(true);
		expect(looksLikeNumber('V10010')).toBe(true);
		expect(looksLikeNumber('L3515-630SC')).toBe(true);
		expect(looksLikeNumber('harbor plating')).toBe(false);
	});

	it('finds an account by number, by name words and by city', async () => {
		const [account] = await db.asSystem((tx) =>
			tx.sql<{ customer_no: string; name: string; city: string }>`
				select customer_no, name, city from nl.customers
				where city <> '' order by customer_no limit 1`
		);

		const byNumber = await searchAll(db, DANA, account.customer_no);
		expect(byNumber.accounts.rows[0].customerNo).toBe(account.customer_no);

		// Two words from the middle of the name, in the wrong order.
		const words = account.name.split(' ').filter((w) => w.length > 2);
		const byWords = await searchAll(db, DANA, [...words].reverse().slice(0, 2).join(' '));
		expect(byWords.accounts.rows.map((r) => r.customerNo)).toContain(account.customer_no);

		const byCity = await searchAll(db, DANA, account.city);
		expect(byCity.accounts.rows.map((r) => r.city)).toContain(account.city);
	});

	it('finds a part by number prefix and by description words, and a vendor by name', async () => {
		const [part] = await db.asSystem((tx) =>
			tx.sql<{ item_no: string }>`select item_no from nl.items where family = 'clamp' order by item_no limit 1`
		);
		const byPrefix = await searchAll(db, DANA, part.item_no.slice(0, 4).toLowerCase());
		expect(byPrefix.parts.rows.map((r) => r.itemNo)).toContain(part.item_no);

		const byWords = await searchAll(db, DANA, 'v-band clamp');
		expect(byWords.parts.rows.length).toBeGreaterThan(0);
		for (const row of byWords.parts.rows) {
			expect(row.description.toLowerCase()).toContain('v-band');
		}

		const [vendor] = await db.asSystem((tx) =>
			tx.sql<{ vendor_no: string; name: string }>`select vendor_no, name from nl.vendors order by vendor_no limit 1`
		);
		const byNumber = await searchAll(db, DANA, vendor.vendor_no.toLowerCase());
		expect(byNumber.vendors.rows[0].vendorNo).toBe(vendor.vendor_no);
		const byName = await searchAll(db, DANA, vendor.name.split(' ')[0]);
		expect(byName.vendors.rows.map((r) => r.vendorNo)).toContain(vendor.vendor_no);
	});

	it('caps each group at ten and says how many matched', async () => {
		// A single letter matches far more than ten of everything.
		const results = await searchAll(db, DANA, 'a');
		expect(results.parts.rows.length).toBeLessThanOrEqual(10);
		expect(results.accounts.rows.length).toBeLessThanOrEqual(10);
		expect(results.parts.total).toBeGreaterThan(results.parts.rows.length);
	});

	it('treats % and _ in the query as characters, not wildcards', async () => {
		const wild = await searchAll(db, DANA, '%');
		expect(wild.accounts.rows).toHaveLength(0);
		expect(wild.parts.rows).toHaveLength(0);
		expect(wild.vendors.rows).toHaveLength(0);

		const underscore = await searchAll(db, DANA, 'c_amp');
		expect(underscore.parts.rows).toHaveLength(0);
		// The same query with the real character matches.
		const real = await searchAll(db, DANA, 'clamp');
		expect(real.parts.rows.length).toBeGreaterThan(0);
	});

	it('answers an empty query with empty groups and no query at all', async () => {
		const results = await searchAll(db, DANA, '   ');
		expect(results).toEqual({
			q: '',
			accounts: { rows: [], total: 0 },
			parts: { rows: [], total: 0 },
			vendors: { rows: [], total: 0 }
		});
	});
});

describe('the seed extra', () => {
	it('gives every vendor that supplies an active part one to three contacts', async () => {
		const rows = await db.asSystem((tx) =>
			tx.sql<{ vendor_no: string; contacts: number; primaries: number }>`
				select v.vendor_no,
				       -- created_by is null on the rows the seed wrote; the tests above
				       -- added a few of their own.
				       count(c.id) filter (where c.created_by is null)::int as contacts,
				       count(c.id) filter (where c.is_primary and c.active)::int as primaries
				from nl.vendors v
				left join nl.vendor_contacts c on c.vendor_no = v.vendor_no
				where exists (select 1 from nl.items i where i.vendor_no = v.vendor_no and not i.blocked)
				group by v.vendor_no`
		);
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row.contacts, row.vendor_no).toBeGreaterThanOrEqual(1);
			expect(row.contacts, row.vendor_no).toBeLessThanOrEqual(3);
			expect(row.primaries, row.vendor_no).toBe(1);
		}
	});

	it('writes contacts that look like people, on an invented domain', async () => {
		const contacts = await db.asSystem((tx) =>
			tx.sql<{ full_name: string; title: string; email: string; phone: string }>`
				select full_name, title, email, phone from nl.vendor_contacts
				where created_by is null
				order by id`
		);
		expect(contacts.length).toBeGreaterThan(5);
		const titles = new Set(contacts.map((c) => c.title));
		expect(titles.size).toBeGreaterThan(1);

		for (const contact of contacts) {
			expect(contact.full_name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]/);
			expect(contact.email).toMatch(/^[a-z.]+@[a-z0-9]+\.example$/);
			expect(contact.phone).toMatch(/^\(\d{3}\) 555-01\d\d( ext \d{3})?$/);
		}
		// Two people at one vendor never share an email address.
		const emails = contacts.map((c) => c.email);
		expect(new Set(emails).size).toBe(emails.length);
	});

	it('writes no em dash and nothing that reads like marketing', async () => {
		const [rows] = await db.asSystem((tx) =>
			tx.sql<{ dashes: number; banned: number }>`
				select
					count(*) filter (where full_name || title || coalesce(email, '') like '%' || chr(8212) || '%')::int as dashes,
					-- The word the name scan refuses, spelled in character codes so
					-- this file does not contain it either.
					count(*) filter (where position(chr(114) || chr(117) || chr(115) || chr(104)
					                           in lower(full_name || ' ' || title)) > 0)::int as banned
				from nl.vendor_contacts
				where created_by is null`
		);
		expect(rows.dashes).toBe(0);
		expect(rows.banned).toBe(0);

		const [vendorText] = await db.asSystem((tx) =>
			tx.sql<{ dashes: number }>`
				select count(*) filter (
					where terms || freight_terms || ships_from like '%' || chr(8212) || '%')::int as dashes
				from nl.vendors`
		);
		expect(vendorText.dashes).toBe(0);
	});
});
