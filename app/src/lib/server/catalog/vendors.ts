// Vendors: the list, the vendor page, and adding a contact.
//
// The figures come from nl.vendor_summary and nl.part_summary (migration
// 0015). The one write goes through nl.add_vendor_contact, which checks the
// user, the role, the fields and the vendor's row version, and writes the
// audit trail.
import { z } from 'zod';
import type { Db } from '../db/types.ts';
import { guarded } from '../errors.ts';
import {
	VENDOR_CONTACT_TITLES,
	type VendorContact,
	type VendorDetail,
	type VendorList,
	type VendorPart,
	type VendorRow
} from '$lib/components/catalog/types';
import { cleanQuery, containsPattern, prefixPattern } from './search.ts';

export const VENDOR_LIST_LIMIT = 100;

interface VendorRowDb {
	vendor_no: string;
	name: string;
	city: string;
	state: string;
	lead_time: string;
	terms: string;
	active_items: number;
	items_short: number;
	items_below_reorder: number;
	revenue_12m: number;
}

function toVendorRow(r: VendorRowDb): VendorRow {
	return {
		vendorNo: r.vendor_no,
		name: r.name,
		city: r.city,
		state: r.state,
		leadTime: r.lead_time,
		terms: r.terms,
		activeItems: r.active_items,
		itemsShort: r.items_short,
		itemsBelowReorder: r.items_below_reorder,
		revenue12m: r.revenue_12m
	};
}

/**
 * The vendor list. The vendor master is long and mostly history, so by
 * default it shows only vendors that supply at least one part; `all` shows
 * every vendor.
 */
export async function listVendors(
	db: Db,
	userId: number,
	options: { q: string; all: boolean }
): Promise<VendorList> {
	const q = cleanQuery(options.q);
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<VendorRowDb & { total: number }>`
			select v.vendor_no, v.name, v.city, v.state, v.lead_time, v.terms,
			       v.active_items, v.items_short, v.items_below_reorder, v.revenue_12m,
			       count(*) over ()::int as total
			from nl.vendor_summary v
			where (${q} = '' or lower(v.vendor_no) like ${prefixPattern(q)} or v.name ilike ${containsPattern(q)})
			  and (${options.all}::boolean or v.items > 0)
			order by v.revenue_12m desc, v.name
			limit ${VENDOR_LIST_LIMIT}`
	);
	return {
		rows: rows.map(toVendorRow),
		total: rows[0]?.total ?? 0,
		limit: VENDOR_LIST_LIMIT
	};
}

/** Vendor numbers are upper case; a lower-case link finds the vendor too. */
export async function resolveVendorNo(db: Db, userId: number, asked: string): Promise<string | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ vendor_no: string }>`
			select vendor_no from nl.vendors
			where vendor_no = ${asked} or vendor_no = ${asked.toUpperCase()}
			order by vendor_no = ${asked} desc
			limit 1`
	);
	return row?.vendor_no ?? null;
}

export async function getVendor(db: Db, userId: number, vendorNo: string): Promise<VendorDetail | null> {
	return db.asUser(userId, async (tx) => {
		const [v] = await tx.sql<
			VendorRowDb & {
				freight_terms: string;
				min_order: number | null;
				ships_from: string;
				items: number;
				short_qty: number;
				units_12m: number;
				updated_at: Date;
			}
		>`
			select * from nl.vendor_summary where vendor_no = ${vendorNo}`;
		if (!v) return null;

		// Active people first, the primary contact at the top.
		const contacts = await tx.sql<{
			id: number;
			full_name: string;
			title: VendorContact['title'];
			email: string | null;
			phone: string | null;
			is_primary: boolean;
			active: boolean;
		}>`
			select id, full_name, title, email, phone, is_primary, active
			from nl.vendor_contacts
			where vendor_no = ${vendorNo}
			order by active desc, is_primary desc, full_name`;

		return {
			...toVendorRow(v),
			freightTerms: v.freight_terms,
			minOrder: v.min_order,
			shipsFrom: v.ships_from,
			items: v.items,
			shortQty: v.short_qty,
			units12m: v.units_12m,
			// ISO text keeps the millisecond the database stored; it goes back as the row version.
			updatedAt: v.updated_at.toISOString(),
			contacts: contacts.map((c) => ({
				id: c.id,
				fullName: c.full_name,
				title: c.title,
				email: c.email,
				phone: c.phone,
				isPrimary: c.is_primary,
				active: c.active
			}))
		};
	});
}

/** The parts a vendor supplies, best sellers first, with the flags purchasing acts on. */
export async function getVendorParts(db: Db, userId: number, vendorNo: string): Promise<VendorPart[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			item_no: string;
			description: string;
			family: string;
			lead_time: string;
			unit_cost: number;
			on_hand: number;
			on_purchase_order: number;
			reorder_point: number | null;
			units_12m: number;
			revenue_12m: number;
			made_to_order: boolean;
			proprietary: boolean;
			blocked: boolean;
			below_reorder_point: boolean;
			short_qty: number;
		}>`
			select item_no, description, family, lead_time, unit_cost, on_hand, on_purchase_order,
			       reorder_point, units_12m, revenue_12m, made_to_order, proprietary, blocked,
			       below_reorder_point, short_qty
			from nl.part_summary
			where vendor_no = ${vendorNo}
			order by blocked, short_qty > 0 desc, below_reorder_point desc, revenue_12m desc, item_no`
	);
	return rows.map((r) => ({
		itemNo: r.item_no,
		description: r.description,
		family: r.family,
		leadTime: r.lead_time,
		unitCost: r.unit_cost,
		onHand: r.on_hand,
		onPurchaseOrder: r.on_purchase_order,
		reorderPoint: r.reorder_point,
		units12m: r.units_12m,
		revenue12m: r.revenue_12m,
		madeToOrder: r.made_to_order,
		proprietary: r.proprietary,
		blocked: r.blocked,
		belowReorderPoint: r.below_reorder_point,
		shortQty: r.short_qty
	}));
}

// ---------------------------------------------------------------------------
// Add a contact
// ---------------------------------------------------------------------------

/**
 * The Add contact form. The page checks the shape here; the database checks
 * the same rules again (and the role), because it is the one that writes.
 */
export const vendorContactInput = z
	.object({
		vendorNo: z.string().trim().min(1).max(20),
		fullName: z.string().trim().min(2, 'Give the contact a name.').max(80, 'Keep the name under 80 characters.'),
		title: z.enum(VENDOR_CONTACT_TITLES, { message: 'Pick a title from the list.' }),
		email: z
			.string()
			.trim()
			.max(120)
			.refine((v) => v === '' || /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v), 'That does not look like an email address.')
			.default(''),
		phone: z
			.string()
			.trim()
			.max(30)
			.refine((v) => v === '' || /^[0-9()+. -]{7,30}$/.test(v), 'That does not look like a phone number.')
			.default(''),
		// A checkbox sends "on" when ticked and nothing when not.
		isPrimary: z
			.string()
			.optional()
			.transform((v) => v === 'on' || v === 'true'),
		expectedUpdatedAt: z.iso.datetime({ offset: true }),
		requestId: z.string().min(8).max(100)
	})
	.refine((v) => v.email !== '' || v.phone !== '', {
		message: 'Give an email address or a phone number, so someone can reach them.',
		path: ['email']
	});

export type VendorContactInput = z.infer<typeof vendorContactInput>;

export interface AddContactResult {
	contactId: number;
	vendorNo: string;
	updatedAt: string;
	replayed: boolean;
}

export async function addVendorContact(
	db: Db,
	userId: number,
	input: VendorContactInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<AddContactResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { contact_id: number; vendor_no: string; updated_at: string; replayed?: boolean } }>`
				select nl.add_vendor_contact(
					${input.vendorNo}, ${input.fullName}, ${input.title},
					${input.email || null}, ${input.phone || null}, ${input.isPrimary},
					${input.expectedUpdatedAt}::timestamptz, ${input.requestId}, ${via}) as result`
		)
	);
	return {
		contactId: row.result.contact_id,
		vendorNo: row.result.vendor_no,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}
