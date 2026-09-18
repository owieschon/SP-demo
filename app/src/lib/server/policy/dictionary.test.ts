// The data dictionary, against the small world.
//
// The test that matters most is the boring one: nl.data_dictionary_gaps has
// to be empty. It fails when somebody adds a column to a table the dictionary
// claims to cover, which is exactly when a dictionary starts to rot, and it
// fails again if anybody "fixes" that by deleting the row instead of writing
// the sentence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '../db/pglite.ts';
import type { Db } from '../db/types.ts';
import { dictionaryGaps, readDictionary, readDictionaryByEntity } from './dictionary.ts';

const DANA = 2;

/**
 * The tables and views the dictionary promises to cover. Listed here as well
 * as in the migration on purpose: the gaps view proves every column of these
 * is documented, and this list proves nobody quietly stopped covering one.
 */
const COVERED = [
	'nl.commitment_progress',
	'nl.commitments',
	'nl.customer_prices',
	'nl.customers',
	'nl.data_dictionary',
	'nl.invoice_lines',
	'nl.invoices',
	'nl.item_costs',
	'nl.items',
	'nl.open_line_allocation',
	'nl.open_line_projection',
	'nl.open_order_lines',
	'nl.policies',
	'nl.policy_types',
	'nl.quote_lines',
	'nl.quotes',
	'nl.stock',
	'nl.stock_moves'
];

let db: Db;

beforeAll(async () => {
	db = await createTestDb();
});

afterAll(async () => {
	await db?.close();
});

describe('coverage', () => {
	it('documents every column of every table it claims, and claims nothing that is gone', async () => {
		const gaps = await dictionaryGaps(db, DANA);
		// The message is the useful part of a failure here, so build it.
		const said = gaps.map((gap) => `${gap.entity}.${gap.field}: ${gap.problem}`).join('\n');
		expect(said).toBe('');
	});

	it('still covers every table it set out to cover', async () => {
		const entities = (await readDictionaryByEntity(db, DANA)).map((one) => one.entity).sort();
		expect(entities).toEqual(COVERED);
	});

	it('has a label, a meaning and a source for every field', async () => {
		const fields = await readDictionary(db, DANA);
		expect(fields.length).toBeGreaterThan(200);
		for (const field of fields) {
			expect(field.label.length, `${field.entity}.${field.field} label`).toBeGreaterThan(1);
			// A sentence, not a restatement of the column name.
			expect(field.meaning.length, `${field.entity}.${field.field} meaning`).toBeGreaterThan(20);
			expect(field.meaning.toLowerCase(), `${field.entity}.${field.field} meaning`).not.toBe(
				field.field.replace(/_/g, ' ')
			);
			expect(['erp export', 'app', 'derived', 'policy engine']).toContain(field.source);
			// No em dashes anywhere in this project, generated text included.
			expect(field.meaning, `${field.entity}.${field.field} meaning`).not.toContain('—');
		}
	});

	it('says how every derived field is worked out', async () => {
		const fields = await readDictionary(db, DANA);
		const derived = fields.filter((field) => field.source === 'derived');
		expect(derived.length).toBeGreaterThan(20);
		for (const field of derived) {
			expect(field.derivation.length, `${field.entity}.${field.field}`).toBeGreaterThan(10);
		}
	});

	it('returns fields in the order the columns are in', async () => {
		const items = await readDictionary(db, DANA, 'nl.items');
		expect(items.map((field) => field.field).slice(0, 5)).toEqual([
			'item_no',
			'description',
			'category',
			'family',
			'product_group'
		]);
		// The short name works too, so an agent can ask for "items".
		const short = await readDictionary(db, DANA, 'items');
		expect(short.map((field) => field.field)).toEqual(items.map((field) => field.field));
	});
});

describe('what may leave the building', () => {
	it('keeps cost, margin and stock inside', async () => {
		const fields = await readDictionary(db, DANA);
		const inside = [
			['nl.items', 'unit_cost'],
			['nl.invoice_lines', 'unit_cost'],
			['nl.item_costs', 'unit_cost'],
			['nl.stock', 'on_hand'],
			['nl.open_line_allocation', 'on_hand'],
			['nl.open_line_allocation', 'allocated'],
			['nl.customers', 'owner_id'],
			['nl.commitments', 'notes'],
			['nl.policies', 'set_by']
		];
		for (const [entity, field] of inside) {
			const found = fields.find((one) => one.entity === entity && one.field === field);
			expect(found, `${entity}.${field}`).toBeDefined();
			expect(found!.shareable, `${entity}.${field}`).toBe(false);
		}
	});

	it('lets a customer hear their own commercial position', async () => {
		const fields = await readDictionary(db, DANA);
		const outside = [
			['nl.items', 'description'],
			['nl.items', 'list_price'],
			['nl.invoices', 'customer_po'],
			['nl.quotes', 'valid_until'],
			['nl.customer_prices', 'net_price'],
			['nl.open_order_lines', 'ship_date'],
			['nl.open_line_projection', 'projected_ship_date']
		];
		for (const [entity, field] of outside) {
			const found = fields.find((one) => one.entity === entity && one.field === field);
			expect(found, `${entity}.${field}`).toBeDefined();
			expect(found!.shareable, `${entity}.${field}`).toBe(true);
		}
	});
});

describe('the views that carry columns through', () => {
	it('say the same thing as the table underneath, in one place', async () => {
		const fields = await readDictionary(db, DANA);
		const pairs: [string, string, string][] = [
			['nl.commitments', 'nl.commitment_progress', 'customer_no'],
			['nl.commitments', 'nl.commitment_progress', 'committed_value'],
			['nl.open_order_lines', 'nl.open_line_allocation', 'ship_date'],
			['nl.open_order_lines', 'nl.open_line_projection', 'quantity']
		];
		for (const [table, view, field] of pairs) {
			const onTable = fields.find((one) => one.entity === table && one.field === field);
			const onView = fields.find((one) => one.entity === view && one.field === field);
			expect(onView, `${view}.${field}`).toBeDefined();
			expect(onView!.meaning).toBe(onTable!.meaning);
			expect(onView!.shareable).toBe(onTable!.shareable);
			// And it says where the wording came from.
			expect(onView!.derivation).toContain(table);
		}
	});

	it('does not carry through a column the view does not have', async () => {
		const allocation = await readDictionary(db, DANA, 'nl.open_line_allocation');
		// nl.open_order_lines has these; the allocation view does not.
		expect(allocation.some((field) => field.field === 'line_amount')).toBe(false);
		expect(allocation.some((field) => field.field === 'location_code')).toBe(false);
	});
});

describe('the read-only role', () => {
	it('can describe the data, which is what an agent needs', async () => {
		const rows = await db.asReadonly((tx) =>
			tx.sql<{ entity: string; field: string; meaning: string; shareable: boolean }>`
				select entity, field, meaning, shareable from nl.describe_data('nl.items')`
		);
		expect(rows.length).toBeGreaterThan(10);
		expect(rows.every((row) => row.meaning.length > 10)).toBe(true);
		// And the whole thing in one call, the way the MCP server would ask.
		const all = await db.asReadonly((tx) =>
			tx.sql<{ rows: number }>`select count(*)::int as rows from nl.describe_data(null)`
		);
		expect(all[0].rows).toBeGreaterThan(200);
	});
});
