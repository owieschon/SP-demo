// What each column on a part row is FOR, and which kind of value it is.
//
// The same query answers a salesperson and a buyer. What differs is the
// declared purpose of the screen they are on, and what their disclosure level
// lets them be shown. So a buyer's part row carries landed cost and the
// supplier's lead time, and a salesperson's carries price and availability,
// out of one row shape and one query.
//
// THIS FILE IS A STAND-IN. The intention is that these declarations live in
// the data dictionary, beside the column itself, so the dictionary is the one
// place that says what a column means. The dictionary has not landed on main
// yet (app/src/lib/server/roles/dictionary.ts feature-detects it and reports
// on /people which source is in use), so the declarations are here, in one
// map, and they move as a block when it does.
//
// `kind` is a desk FactKind, not a new vocabulary. That is what makes the
// disclosure check on a screen and the disclosure check on an agent's
// outgoing draft the same check.

import type { FactKind } from '$lib/desk/types';

/** Why somebody is looking at a part. */
export type Purpose = 'sell' | 'buy' | 'plan' | 'move';

export const PURPOSE_LABEL: Record<Purpose, string> = {
	sell: 'Selling it',
	buy: 'Buying it',
	plan: 'Planning it',
	move: 'Moving it'
};

export interface ColumnPurpose {
	/** The key on the row object the server assembles. */
	key: string;
	label: string;
	/** The kind of value it is, in the desk agent's vocabulary. */
	kind: FactKind;
	/** The purposes it belongs to. */
	purposes: Purpose[];
	/** Right-aligned money or count, for the table. */
	numeric?: true;
}

export const PART_COLUMNS: ColumnPurpose[] = [
	{ key: 'itemNo', label: 'Part', kind: 'part_description', purposes: ['sell', 'buy', 'plan', 'move'] },
	{
		key: 'description',
		label: 'Description',
		kind: 'part_description',
		purposes: ['sell', 'buy', 'plan', 'move']
	},
	{ key: 'family', label: 'Family', kind: 'part_description', purposes: ['buy', 'plan'] },
	{ key: 'listPrice', label: 'List', kind: 'own_price', purposes: ['sell'], numeric: true },
	{
		key: 'availability',
		label: 'Available',
		kind: 'availability',
		purposes: ['sell', 'plan', 'move']
	},
	{ key: 'leadTime', label: 'Lead time', kind: 'lead_time', purposes: ['sell', 'plan'] },
	{ key: 'onHand', label: 'On hand', kind: 'stock_quantity', purposes: ['plan', 'move'], numeric: true },
	{ key: 'unitCost', label: 'Landed cost', kind: 'unit_cost', purposes: ['buy', 'plan'], numeric: true },
	{ key: 'vendorName', label: 'Supplier', kind: 'vendor_supply', purposes: ['buy'] },
	{ key: 'vendorLeadTime', label: 'Supplier lead time', kind: 'vendor_lead_time', purposes: ['buy', 'plan'] },
	{ key: 'marginPct', label: 'Margin', kind: 'margin', purposes: ['buy'], numeric: true },
	{ key: 'floorPrice', label: 'Floor', kind: 'floor_price', purposes: ['sell', 'buy'], numeric: true }
];

/**
 * The columns for one purpose, narrowed to what this disclosure level allows.
 * The order is the order they are declared in, so two screens showing the
 * same purpose cannot disagree about it.
 */
export function columnsFor(purpose: Purpose, allowedKinds: readonly string[]): ColumnPurpose[] {
	return PART_COLUMNS.filter(
		(column) => column.purposes.includes(purpose) && allowedKinds.includes(column.kind)
	);
}
