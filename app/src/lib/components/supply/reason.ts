// Why a line will ship when it will, in words a person can act on.
//
// The projection already names the supply order that decides each line
// (nl.open_line_projection), so this only reads its columns; it never works
// anything out for itself.
import { day } from '$lib/format';
import type { ForecastLine } from './types';

/** "waiting on PO-104471 from Beacon Plating, due Oct 3" */
function waitingOn(line: ForecastLine, year?: number): string {
	const due = line.supplyDueDate ? `, due ${day(line.supplyDueDate, year)}` : '';
	if (line.supplySource === 'purchase') {
		const from = line.supplyVendorName ?? line.supplyVendorNo ?? 'a vendor';
		return `waiting on ${line.supplyDocument} from ${from}${due}`;
	}
	if (line.supplySource === 'production') {
		return `made on ${line.supplyWorkCenter || 'the shop floor'}, order ${line.supplyDocument}${due}`;
	}
	return 'covered by stock on the shelf';
}

/** The whole reason, as the table's status column reads it. */
export function reasonFor(line: ForecastLine, year?: number): string {
	switch (line.status) {
		case 'on_time':
			return line.supplySource === 'stock'
				? 'stock covers it'
				: `covered in time: ${waitingOn(line, year)}`;
		case 'late_waiting_supply':
			return waitingOn(line, year);
		case 'late_supply_overdue':
			return `${waitingOn(line, year)}, itself past due`;
		case 'no_supply':
			return `nothing on order; earliest if ordered today is ${day(line.earliestIfOrderedToday, year)}`;
		case 'past_due':
			if (line.coveredNow) return 'ship date has passed, and the stock is on the shelf now';
			return line.supplyDocument
				? `ship date has passed, ${waitingOn(line, year)}`
				: `ship date has passed, nothing on order; earliest if ordered today is ${day(line.earliestIfOrderedToday, year)}`;
	}
}
