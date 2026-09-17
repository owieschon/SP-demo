// Counting and grouping the queue. Pure functions over rows already read, so
// the page and the tests both use them and neither needs the database.
import type { QueueItem, QueueSource } from './types.ts';

export interface QueueCounts {
	total: number;
	/** You are the reviewer, or the record is yours. */
	needsYou: number;
	needsSomeone: number;
	bySource: Record<QueueSource, number>;
}

export function countQueue(items: QueueItem[]): QueueCounts {
	const bySource: Record<QueueSource, number> = { rfq: 0, assistant: 0, mail: 0, purchase: 0 };
	let needsYou = 0;
	for (const item of items) {
		bySource[item.source] += 1;
		if (item.needsYou) needsYou += 1;
	}
	return { total: items.length, needsYou, needsSomeone: items.length - needsYou, bySource };
}

/** The accounts and vendors the current queue is about, for the filter. */
export function subjectsOf(items: QueueItem[]): { no: string; name: string }[] {
	const seen = new Map<string, string>();
	for (const item of items) {
		if (item.subjectNo && !seen.has(item.subjectNo)) {
			seen.set(item.subjectNo, item.subjectName ?? item.subjectNo);
		}
	}
	return [...seen].map(([no, name]) => ({ no, name })).sort((a, b) => a.name.localeCompare(b.name));
}
