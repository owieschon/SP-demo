// The three warehouse writes. Each one checks the form's shape here with zod
// and then calls the SQL function of the same name, which enforces the
// meaning: who may write, what the fields must look like, the row version,
// the audit row, the request id that makes a retry safe, and the rule this
// whole feature rests on: the ledger, the bins and nl.stock.on_hand move
// together or not at all.
import { z } from 'zod';
import { ADJUSTMENT_REASONS } from '$lib/components/warehouse/types';
import type { ShipmentStatus } from '$lib/components/warehouse/types';
import type { Db } from '../db/types.ts';
import { guarded } from '../errors.ts';

const requestId = z.string().min(8).max(100);
const rowVersion = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------
// Move a shipment one step along
// ---------------------------------------------------------------------------

export const advanceShipmentInput = z.object({
	shipmentNo: z.string().trim().min(1).max(30),
	toStatus: z.enum(['picking', 'packed', 'awaiting carrier', 'shipped']),
	tracking: z
		.string()
		.trim()
		.max(60)
		.default('')
		.transform((value) => (value === '' ? null : value)),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type AdvanceShipmentInput = z.infer<typeof advanceShipmentInput>;

export interface AdvanceShipmentResult {
	shipmentNo: string;
	status: ShipmentStatus;
	/** One stock move per line, and only when the shipment actually went. */
	moves: number;
	pieces: number;
	updatedAt: string;
	replayed: boolean;
}

export async function advanceShipment(
	db: Db,
	userId: number,
	input: AdvanceShipmentInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<AdvanceShipmentResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{
				result: {
					shipment_no: string;
					status: ShipmentStatus;
					moves: number;
					pieces: number;
					updated_at: string;
					replayed?: boolean;
				};
			}>`
				select nl.advance_shipment(${input.shipmentNo}, ${input.toStatus},
				                           ${input.expectedUpdatedAt}::timestamptz, ${input.requestId},
				                           ${input.tracking}, ${via}) as result`
		)
	);
	return {
		shipmentNo: row.result.shipment_no,
		status: row.result.status,
		moves: row.result.moves,
		pieces: row.result.pieces,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}

// ---------------------------------------------------------------------------
// Post a cycle count
// ---------------------------------------------------------------------------

export const postCountInput = z.object({
	sessionId: z.coerce.number().int().positive(),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type PostCountInput = z.infer<typeof postCountInput>;

export interface PostCountResult {
	sessionId: number;
	sessionNo: string;
	linesCounted: number;
	moves: number;
	netChange: number;
	updatedAt: string;
	replayed: boolean;
}

export async function postCountSession(
	db: Db,
	userId: number,
	input: PostCountInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<PostCountResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{
				result: {
					session_id: number;
					session_no: string;
					lines_counted: number;
					moves: number;
					net_change: number;
					updated_at: string;
					replayed?: boolean;
				};
			}>`
				select nl.post_count_session(${input.sessionId}, ${input.expectedUpdatedAt}::timestamptz,
				                             ${input.requestId}, ${via}) as result`
		)
	);
	return {
		sessionId: row.result.session_id,
		sessionNo: row.result.session_no,
		linesCounted: row.result.lines_counted,
		moves: row.result.moves,
		netChange: row.result.net_change,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}

// ---------------------------------------------------------------------------
// Book a transfer in at the destination
// ---------------------------------------------------------------------------

export const receiveTransferInput = z.object({
	transferNo: z.string().trim().min(1).max(30),
	expectedUpdatedAt: rowVersion,
	requestId
});

export type ReceiveTransferInput = z.infer<typeof receiveTransferInput>;

export interface ReceiveTransferResult {
	transferNo: string;
	status: 'received';
	lines: number;
	pieces: number;
	updatedAt: string;
	replayed: boolean;
}

/**
 * Receiving writes both halves of the move: out of the origin and into the
 * destination. nl.stock.on_hand does not change, because the stock never left
 * the company, only the building.
 */
export async function receiveTransfer(
	db: Db,
	userId: number,
	input: ReceiveTransferInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<ReceiveTransferResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{
				result: {
					transfer_no: string;
					status: 'received';
					lines: number;
					pieces: number;
					updated_at: string;
					replayed?: boolean;
				};
			}>`
				select nl.receive_transfer(${input.transferNo}, ${input.expectedUpdatedAt}::timestamptz,
				                           ${input.requestId}, ${via}) as result`
		)
	);
	return {
		transferNo: row.result.transfer_no,
		status: row.result.status,
		lines: row.result.lines,
		pieces: row.result.pieces,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}

// ---------------------------------------------------------------------------
// Correct one bin by hand
// ---------------------------------------------------------------------------

export const adjustStockInput = z.object({
	itemNo: z.string().trim().min(1).max(40),
	locationCode: z.string().trim().min(1).max(10),
	// Up or down, never zero. The database says the same thing.
	quantity: z.coerce.number().int().refine((n) => n !== 0, {
		message: 'An adjustment moves the count up or down, so it cannot be zero.'
	}),
	reason: z.enum(ADJUSTMENT_REASONS),
	note: z.string().trim().max(500).default(''),
	// Optional: when the form carries the bin's row version, a correction on a
	// bin somebody else has since touched is refused instead of piling on.
	expectedUpdatedAt: rowVersion.optional(),
	requestId
});

export type AdjustStockInput = z.infer<typeof adjustStockInput>;

export interface AdjustStockResult {
	moveId: number;
	itemNo: string;
	locationCode: string;
	quantity: number;
	binQuantity: number;
	onHand: number;
	updatedAt: string;
	replayed: boolean;
}

export async function postStockAdjustment(
	db: Db,
	userId: number,
	input: AdjustStockInput,
	via: 'ui' | 'assistant' = 'ui'
): Promise<AdjustStockResult> {
	const [row] = await guarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{
				result: {
					move_id: number;
					item_no: string;
					location_code: string;
					quantity: number;
					bin_quantity: number;
					on_hand: number;
					updated_at: string;
					replayed?: boolean;
				};
			}>`
				select nl.post_stock_adjustment(${input.itemNo}, ${input.locationCode}, ${input.quantity},
				                                ${input.reason}, ${input.requestId}, ${input.note},
				                                ${input.expectedUpdatedAt ?? null}::timestamptz, ${via}) as result`
		)
	);
	return {
		moveId: Number(row.result.move_id),
		itemNo: row.result.item_no,
		locationCode: row.result.location_code,
		quantity: row.result.quantity,
		binQuantity: row.result.bin_quantity,
		onHand: row.result.on_hand,
		updatedAt: row.result.updated_at,
		replayed: row.result.replayed === true
	};
}
