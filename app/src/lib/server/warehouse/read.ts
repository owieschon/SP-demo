// What the warehouse page reads.
//
// Three groups of queries:
//   * the board: the six buckets, the pick queue, the open count, transfers
//     on the road and the last few stock moves. The page streams it.
//   * the ledger for one part: opening balance, everything since, closing.
//     This is the "explain this number" panel, linked from /parts/<item>.
//   * the bins for one part, which the adjustment form needs.
//
// Nothing here writes. The writes live in writes.ts and go through the SQL
// functions in migration 0019.
import type {
	BinRow,
	Bucket,
	BucketTotal,
	CountLine,
	KindTotal,
	MoveKind,
	MoveRow,
	OpenCount,
	PartLedger,
	PickLine,
	PickShipment,
	ShipmentStatus,
	TransitTransfer,
	WarehouseBoard
} from '$lib/components/warehouse/types';
import { BUCKET_ORDER } from '$lib/components/warehouse/types';
import type { Db, Tx } from '../db/types.ts';

/** How many shipments the pick queue lists. */
export const PICK_QUEUE_LIMIT = 20;

/** How many stock moves the board's "recent" panel shows. */
export const RECENT_MOVE_LIMIT = 25;

/** How many moves the part ledger lists before it stops. */
export const PART_MOVE_LIMIT = 40;

export async function getWarehouseBoard(db: Db, userId: number): Promise<WarehouseBoard> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{ today: string }>`select nl.today() as today`;

		const bucketRows = await tx.sql<{
			bucket: Bucket;
			documents: number;
			lines: number;
			quantity: number;
			value: number;
		}>`
			select bucket, documents, lines, quantity, value
			from nl.warehouse_today
			order by sort`;
		// The view always returns all six, but the page should not depend on that.
		const buckets: BucketTotal[] = BUCKET_ORDER.map(
			(bucket) =>
				bucketRows.find((r) => r.bucket === bucket) ?? {
					bucket,
					documents: 0,
					lines: 0,
					quantity: 0,
					value: 0
				}
		);

		const [pickQueue, pickQueueTotal] = await readPickQueue(tx);

		return {
			today: head.today,
			buckets,
			pickQueue,
			pickQueueTotal,
			openCount: await readOpenCount(tx),
			transit: await readTransit(tx),
			recentMoves: await readRecentMoves(tx)
		};
	});
}

/**
 * The shipments still on the floor, oldest promised date first, each with its
 * pick lines in bin order. Two queries: the headers, then every line for the
 * headers that came back.
 */
async function readPickQueue(tx: Tx): Promise<[PickShipment[], number]> {
	const heads = await tx.sql<{
		shipment_no: string;
		customer_no: string;
		customer_name: string;
		location_code: string;
		location_name: string;
		carrier: string;
		status: ShipmentStatus;
		promised_on: string | null;
		packed_by: string | null;
		packed_at: Date | null;
		tracking: string;
		note: string;
		updated_at: Date;
		total: number;
	}>`
		select s.shipment_no, s.customer_no, c.name as customer_name,
		       s.location_code, loc.name as location_name,
		       s.carrier, s.status, s.promised_on,
		       u.full_name as packed_by, s.packed_at, s.tracking, s.note, s.updated_at,
		       count(*) over () as total
		from nl.shipments s
		join nl.customers c on c.customer_no = s.customer_no
		join nl.locations loc on loc.code = s.location_code
		left join nl.users u on u.id = s.packed_by
		where s.status <> 'shipped'
		order by s.promised_on nulls last, s.shipment_no
		limit ${PICK_QUEUE_LIMIT}`;
	if (heads.length === 0) return [[], 0];

	const numbers = JSON.stringify(heads.map((h) => h.shipment_no));
	const lines = await tx.sql<{
		shipment_no: string;
		line_no: number;
		item_no: string;
		description: string;
		quantity: number;
		bin: string;
		document_no: string;
		order_line_no: number | null;
	}>`
		select l.shipment_no, l.line_no, l.item_no, i.description, l.quantity, l.bin,
		       l.document_no, l.order_line_no
		from nl.shipment_lines l
		join nl.items i on i.item_no = l.item_no
		where l.shipment_no in (select jsonb_array_elements_text(${numbers}::jsonb))
		order by l.shipment_no, l.line_no`;

	const byShipment = new Map<string, PickLine[]>();
	for (const l of lines) {
		const list = byShipment.get(l.shipment_no) ?? [];
		list.push({
			lineNo: l.line_no,
			itemNo: l.item_no,
			description: l.description,
			quantity: l.quantity,
			bin: l.bin,
			documentNo: l.document_no,
			orderLineNo: l.order_line_no
		});
		byShipment.set(l.shipment_no, list);
	}

	const queue = heads.map((h): PickShipment => {
		const own = byShipment.get(h.shipment_no) ?? [];
		return {
			shipmentNo: h.shipment_no,
			customerNo: h.customer_no,
			customerName: h.customer_name,
			locationCode: h.location_code,
			locationName: h.location_name,
			carrier: h.carrier,
			status: h.status,
			promisedOn: h.promised_on,
			packedBy: h.packed_by,
			packedAt: h.packed_at?.toISOString() ?? null,
			tracking: h.tracking,
			note: h.note,
			// ISO text keeps the millisecond, so it matches when it goes back.
			updatedAt: h.updated_at.toISOString(),
			pieces: own.reduce((sum, l) => sum + l.quantity, 0),
			lines: own
		};
	});
	return [queue, Number(heads[0].total)];
}

/** The count session on the clipboard: the one due soonest, with its sheet. */
async function readOpenCount(tx: Tx): Promise<OpenCount | null> {
	const [session] = await tx.sql<{
		id: number;
		session_no: string;
		location_code: string;
		location_name: string;
		zone: string;
		due_on: string;
		counted_on: string | null;
		counted_by: string | null;
		note: string;
		updated_at: Date;
	}>`
		select c.id, c.session_no, c.location_code, loc.name as location_name, c.zone,
		       c.due_on, c.counted_on, u.full_name as counted_by, c.note, c.updated_at
		from nl.count_sessions c
		join nl.locations loc on loc.code = c.location_code
		left join nl.users u on u.id = c.counted_by
		where c.status = 'open'
		order by c.due_on, c.id
		limit 1`;
	if (!session) return null;

	const rows = await tx.sql<{
		line_no: number;
		item_no: string;
		description: string;
		bin: string;
		expected_qty: number;
		counted_qty: number | null;
		variance: number | null;
		reason: string | null;
		note: string;
	}>`
		select l.line_no, l.item_no, i.description, l.bin, l.expected_qty, l.counted_qty,
		       l.variance, l.reason, l.note
		from nl.count_lines l
		join nl.items i on i.item_no = l.item_no
		where l.session_id = ${session.id}
		order by l.line_no`;

	const lines = rows.map(
		(r): CountLine => ({
			lineNo: r.line_no,
			itemNo: r.item_no,
			description: r.description,
			bin: r.bin,
			expectedQty: r.expected_qty,
			countedQty: r.counted_qty,
			variance: r.variance,
			reason: r.reason,
			note: r.note
		})
	);
	const counted = lines.filter((l) => l.countedQty !== null);

	return {
		id: session.id,
		sessionNo: session.session_no,
		locationCode: session.location_code,
		locationName: session.location_name,
		zone: session.zone,
		dueOn: session.due_on,
		countedOn: session.counted_on,
		countedBy: session.counted_by,
		note: session.note,
		updatedAt: session.updated_at.toISOString(),
		lines,
		counted: counted.length,
		notCounted: lines.length - counted.length,
		withVariance: counted.filter((l) => (l.variance ?? 0) !== 0).length,
		netChange: counted.reduce((sum, l) => sum + (l.variance ?? 0), 0)
	};
}

/** Transfers on the road, with how many pieces are on the truck. */
async function readTransit(tx: Tx): Promise<TransitTransfer[]> {
	const rows = await tx.sql<{
		transfer_no: string;
		from_location: string;
		from_name: string;
		to_location: string;
		to_name: string;
		sent_on: string;
		expected_on: string;
		sent_by: string | null;
		note: string;
		lines: number;
		pieces: number;
		late: boolean;
		updated_at: Date;
	}>`
		select t.transfer_no,
		       t.from_location, f.name as from_name,
		       t.to_location, d.name as to_name,
		       t.sent_on, t.expected_on, u.full_name as sent_by, t.note,
		       coalesce(x.lines, 0) as lines, coalesce(x.pieces, 0) as pieces,
		       t.expected_on < (select nl.today()) as late,
		       t.updated_at
		from nl.transfers t
		join nl.locations f on f.code = t.from_location
		join nl.locations d on d.code = t.to_location
		left join nl.users u on u.id = t.sent_by
		left join (
		  select transfer_no, count(*) as lines, sum(quantity) as pieces
		  from nl.transfer_lines
		  group by transfer_no
		) x on x.transfer_no = t.transfer_no
		where t.status = 'in transit'
		order by t.expected_on, t.transfer_no`;

	return rows.map(
		(r): TransitTransfer => ({
			transferNo: r.transfer_no,
			fromLocation: r.from_location,
			fromName: r.from_name,
			toLocation: r.to_location,
			toName: r.to_name,
			sentOn: r.sent_on,
			expectedOn: r.expected_on,
			sentBy: r.sent_by,
			note: r.note,
			lines: Number(r.lines),
			pieces: Number(r.pieces),
			late: r.late,
			updatedAt: r.updated_at.toISOString()
		})
	);
}

async function readRecentMoves(tx: Tx): Promise<MoveRow[]> {
	const rows = await tx.sql<MoveRowSql>`
		select m.id, m.item_no, m.description, m.location_code, m.location_name,
		       m.moved_at, m.kind, m.quantity, m.reference, m.reason, m.actor_name, m.note
		from nl.stock_moves_recent m
		order by m.moved_at desc, m.id desc
		limit ${RECENT_MOVE_LIMIT}`;
	return rows.map(toMoveRow);
}

interface MoveRowSql {
	id: number;
	item_no: string;
	description: string;
	location_code: string;
	location_name: string;
	moved_at: Date;
	kind: MoveKind;
	quantity: number;
	reference: string;
	reason: string | null;
	actor_name: string | null;
	note: string;
}

function toMoveRow(r: MoveRowSql): MoveRow {
	return {
		id: Number(r.id),
		itemNo: r.item_no,
		description: r.description,
		locationCode: r.location_code,
		locationName: r.location_name,
		movedAt: r.moved_at.toISOString(),
		kind: r.kind,
		quantity: r.quantity,
		reference: r.reference,
		reason: r.reason,
		actorName: r.actor_name,
		note: r.note
	};
}

// ---------------------------------------------------------------------------
// One part: explain the number
// ---------------------------------------------------------------------------

/**
 * Opening balance ninety days ago, everything that has happened since, and
 * the closing figure, which has to equal the item master's on-hand. Null when
 * the part does not exist.
 */
export async function getPartLedger(db: Db, userId: number, itemNo: string): Promise<PartLedger | null> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{
			item_no: string;
			description: string;
			on_hand: number;
			allocated: number;
			available: number;
		}>`
			select i.item_no, i.description, p.on_hand, p.allocated, p.available
			from nl.items i
			join nl.stock_position p on p.item_no = i.item_no
			where i.item_no = ${itemNo}`;
		if (!head) return null;

		const [opening] = await tx.sql<{ opened_on: string | null; opening: number }>`
			select min(o.opened_on) as opened_on, coalesce(sum(o.quantity), 0)::int as opening
			from nl.stock_opening o
			where o.item_no = ${itemNo}`;

		const [totals] = await tx.sql<{ moves: number; moved: number }>`
			select count(*)::int as moves, coalesce(sum(m.quantity), 0)::int as moved
			from nl.stock_moves m
			where m.item_no = ${itemNo}`;

		const kinds = await tx.sql<{ kind: MoveKind; moves: number; quantity: number }>`
			select m.kind, count(*)::int as moves, sum(m.quantity)::int as quantity
			from nl.stock_moves m
			where m.item_no = ${itemNo}
			group by m.kind
			order by m.kind`;

		const bins = await tx.sql<{
			location_code: string;
			location_name: string;
			zone: string;
			aisle: string;
			shelf: string;
			bin: string;
			quantity: number;
			counted_on: string | null;
			updated_at: Date;
		}>`
			select b.location_code, loc.name as location_name, b.zone, b.aisle, b.shelf, b.bin,
			       b.quantity, b.counted_on, b.updated_at
			from nl.stock_bins b
			join nl.locations loc on loc.code = b.location_code
			where b.item_no = ${itemNo}
			order by (loc.is_default) desc, b.location_code`;

		const moves = await tx.sql<MoveRowSql>`
			select m.id, m.item_no, i.description, m.location_code, loc.name as location_name,
			       m.moved_at, m.kind, m.quantity, m.reference, m.reason,
			       u.full_name as actor_name, m.note
			from nl.stock_moves m
			join nl.items i on i.item_no = m.item_no
			join nl.locations loc on loc.code = m.location_code
			left join nl.users u on u.id = m.actor
			where m.item_no = ${itemNo}
			order by m.moved_at desc, m.id desc
			limit ${PART_MOVE_LIMIT}`;

		const closing = opening.opening + totals.moved;
		return {
			itemNo: head.item_no,
			description: head.description,
			openedOn: opening.opened_on,
			opening: opening.opening,
			byKind: kinds.map((k): KindTotal => ({ kind: k.kind, moves: k.moves, quantity: k.quantity })),
			moveCount: totals.moves,
			moved: totals.moved,
			closing,
			onHand: head.on_hand,
			allocated: head.allocated,
			available: head.available,
			agrees: closing === head.on_hand,
			bins: bins.map(
				(b): BinRow => ({
					locationCode: b.location_code,
					locationName: b.location_name,
					zone: b.zone,
					aisle: b.aisle,
					shelf: b.shelf,
					bin: b.bin,
					quantity: b.quantity,
					countedOn: b.counted_on,
					updatedAt: b.updated_at.toISOString()
				})
			),
			moves: moves.map(toMoveRow)
		};
	});
}
