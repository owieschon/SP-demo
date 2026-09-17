// The limits, in one place, and the daily call counter.
//
// Four of them are per turn or per conversation and are enforced in this
// process. The two daily ones are enforced in the database (migration 0017),
// because a restarted server must not forget how many calls today has had.
import type { CapsView } from '$lib/assistant/types';
import type { Db } from '../db/types.ts';
import { askGuarded } from './errors.ts';

/** Tool rounds in one turn. The ninth is never asked for. */
export const MAX_ROUNDS = 8;
/** Bytes of JSON the model gets back from one tool. */
export const MAX_TOOL_RESULT_BYTES = 16 * 1024;
/** Messages in one conversation, matching nl.assistant_message_cap(). */
export const MAX_CONVERSATION_MESSAGES = 40;
/** Rows the SQL tool returns. */
export const MAX_SQL_ROWS = 1000;

export interface DailyLimits {
	perUser: number;
	global: number;
}

export const DEFAULT_LIMITS: DailyLimits = { perUser: 25, global: 300 };

/** Read the caps from the environment, falling back to the defaults. */
export function readLimits(env: Record<string, string | undefined>): DailyLimits {
	const number = (value: string | undefined, fallback: number) => {
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
	};
	return {
		perUser: number(env.ASSISTANT_DAILY_PER_USER, DEFAULT_LIMITS.perUser),
		global: number(env.ASSISTANT_DAILY_TOTAL, DEFAULT_LIMITS.global)
	};
}

interface CountsRow {
	result: { user_used: number; user_limit: number; global_used: number; global_limit: number };
}

function toCaps(counts: CountsRow['result']): CapsView {
	return {
		rounds: MAX_ROUNDS,
		toolResultBytes: MAX_TOOL_RESULT_BYTES,
		conversationMessages: MAX_CONVERSATION_MESSAGES,
		userUsed: counts.user_used,
		userLimit: counts.user_limit,
		globalUsed: counts.global_used,
		globalLimit: counts.global_limit
	};
}

/** What the page shows. Claims nothing. */
export async function readCaps(db: Db, userId: number, limits: DailyLimits): Promise<CapsView> {
	const [row] = await askGuarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<CountsRow>`select nl.assistant_calls_left(${limits.perUser}, ${limits.global}) as result`
		)
	);
	return toCaps(row.result);
}

/**
 * Claim one call for today. Raises a 429 AppError when this person, or the
 * whole server, has used up the day. Claimed before the model is called, so a
 * turn that cannot be finished is never started.
 */
export async function claimCall(db: Db, userId: number, limits: DailyLimits): Promise<CapsView> {
	const [row] = await askGuarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<CountsRow>`select nl.claim_assistant_call(${limits.perUser}, ${limits.global}) as result`
		)
	);
	return toCaps(row.result);
}
