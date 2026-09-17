import { randomUUID } from 'node:crypto';
import { error, fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { getPartLedger, getWarehouseBoard } from '$lib/server/warehouse/read';
import {
	adjustStockInput,
	advanceShipment,
	advanceShipmentInput,
	postCountSession,
	postCountInput,
	postStockAdjustment
} from '$lib/server/warehouse/writes';
import type { Actions, PageServerLoad } from './$types';

// The warehouse floor: what is on the dock, what is being counted, what moved
// and why. ?part=<item_no> opens the "explain this number" panel for one
// part, which is what /parts/<item> links to.
export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();

	const part = url.searchParams.get('part');
	// Awaited, because a bad part number should be a 404 and not a broken panel.
	const ledger = part ? await getPartLedger(db, user.id, part) : null;
	if (part && !ledger) error(404, `Part ${part} does not exist.`);

	return {
		// Not awaited on purpose: the page arrives first, the floor streams in.
		board: getWarehouseBoard(db, user.id),
		ledger,
		// Operations and admins press the buttons; everybody else reads.
		canRun: user.role !== 'account_manager',
		// Fresh ids for each form on this page load. Sending the same form
		// twice sends the same id, so the database writes once.
		requestIds: { advance: randomUUID(), count: randomUUID(), adjust: randomUUID() },
		year: new Date().getFullYear()
	};
};

/** Each action says which form it answered, so the message lands next to it. */
export type WarehouseFormSource = 'advance' | 'count' | 'adjust';

export interface WarehouseFormAnswer {
	from: WarehouseFormSource;
	message: string;
	failed: boolean;
	conflict: boolean;
}

function refuse(from: WarehouseFormSource, status: number, message: string) {
	return fail(status, { from, message, failed: true, conflict: status === 409 } satisfies WarehouseFormAnswer);
}

async function run(from: WarehouseFormSource, work: () => Promise<string>) {
	try {
		return { from, message: await work(), failed: false, conflict: false } satisfies WarehouseFormAnswer;
	} catch (err) {
		const refusal = toAppError(err);
		if (!refusal) throw err;
		return refuse(from, refusal.status, refusal.message);
	}
}

export const actions: Actions = {
	advance: async ({ locals, request }) => {
		const parsed = advanceShipmentInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return refuse('advance', 400, 'The form is out of date. Reload the page and try again.');
		}
		const input = parsed.data;
		return run('advance', async () => {
			const result = await advanceShipment(await getDb(), locals.user!.id, input);
			if (result.status === 'shipped') {
				return `${result.shipmentNo} shipped: ${result.pieces} pieces off the shelf on ${result.moves} stock ${result.moves === 1 ? 'move' : 'moves'}.`;
			}
			return `${result.shipmentNo} is now ${result.status}.`;
		});
	},

	count: async ({ locals, request }) => {
		const parsed = postCountInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return refuse('count', 400, 'The form is out of date. Reload the page and try again.');
		}
		const input = parsed.data;
		return run('count', async () => {
			const result = await postCountSession(await getDb(), locals.user!.id, input);
			if (result.moves === 0) {
				return `Posted ${result.sessionNo}: ${result.linesCounted} lines counted, nothing to correct.`;
			}
			const sign = result.netChange > 0 ? '+' : '';
			return `Posted ${result.sessionNo}: ${result.moves} ${result.moves === 1 ? 'correction' : 'corrections'}, on hand ${sign}${result.netChange} pieces.`;
		});
	},

	adjust: async ({ locals, request }) => {
		const parsed = adjustStockInput.safeParse(Object.fromEntries(await request.formData()));
		if (!parsed.success) {
			return refuse('adjust', 400, parsed.error.issues[0]?.message ?? 'Check the correction.');
		}
		const input = parsed.data;
		return run('adjust', async () => {
			const result = await postStockAdjustment(await getDb(), locals.user!.id, input);
			const sign = result.quantity > 0 ? '+' : '';
			return `${sign}${result.quantity} on ${result.itemNo} at ${result.locationCode}: the bin holds ${result.binQuantity}, on hand is ${result.onHand}.`;
		});
	}
};
