// One question, start to finish. The page and the tests both call this.
//
// The order matters:
//   1. the question has to be a question;
//   2. a call is claimed against today's caps, in the database, before the
//      model is touched, so a turn that cannot be paid for never starts;
//   3. the turn runs (loop.ts), which is where the gate and the proposal live;
//   4. only then is anything stored: a new conversation if this is the first
//      question, then the turn itself, in one write.
// A model that refuses or fails leaves nothing behind except the claimed call,
// which is honest: a live call that failed still cost something.
import { z } from 'zod';
import type { CapsView, LookupView } from '$lib/assistant/types';
import { AppError } from '../errors.ts';
import type { Db } from '../db/types.ts';
import { claimCall, MAX_CONVERSATION_MESSAGES, type DailyLimits } from './caps.ts';
import { getConversation, historyFrom, saveTurn, startConversation } from './conversation.ts';
import { runTurn, type AskModel, type ModelTurn } from './loop.ts';

export const askInput = z.object({
	question: z.string().trim().min(2).max(2000),
	conversationId: z.coerce.number().int().positive().nullable().default(null),
	requestId: z.string().min(8).max(100)
});

export type AskInput = z.infer<typeof askInput>;

export interface AskResult {
	conversationId: number;
	answer: string;
	lookups: LookupView[];
	proposalId: number | null;
	/** The turn ran out of tool rounds. */
	stoppedAtCap: boolean;
	caps: CapsView;
	/** This exact question was already answered (a double submit). */
	replayed: boolean;
}

export interface AskOptions {
	db: Db;
	userId: number;
	model: AskModel;
	limits: DailyLimits;
	/** Pass a date to skip reading it (tests). */
	today?: string;
}

export async function askQuestion(options: AskOptions, raw: unknown): Promise<AskResult> {
	const parsed = askInput.safeParse(raw);
	if (!parsed.success) {
		throw new AppError(422, 'NL422', 'Write a question of at least two characters.');
	}
	const { question, conversationId, requestId } = parsed.data;
	const { db, userId, model, limits } = options;

	// 2. Claim the call. This throws a 429 AppError when the day is used up.
	const caps = await claimCall(db, userId, limits);

	// The conversation so far, so the model sees earlier questions, its own
	// answers, and what was approved or rejected.
	let history: ModelTurn[] = [];
	if (conversationId !== null) {
		const existing = await getConversation(db, userId, conversationId);
		if (!existing) throw new AppError(404, 'NL404', `Conversation ${conversationId} does not exist.`);
		if (existing.messagesLeft < 2) {
			throw new AppError(
				422,
				'NL422',
				`This conversation has reached ${MAX_CONVERSATION_MESSAGES} messages. Start a new one and I will keep up.`
			);
		}
		history = historyFrom(existing);
	}

	// 3. The turn.
	const turn = await runTurn({
		db,
		userId,
		model,
		question,
		history,
		requestId,
		today: options.today
	});

	// 4. Store it. A new conversation is only created once the turn worked.
	const id =
		conversationId ??
		(await startConversation(db, userId, { title: question, mode: model.mode, requestId: `${requestId}-conv` }))
			.conversationId;

	const saved = await saveTurn(db, userId, {
		conversationId: id,
		question,
		answer: turn.answer,
		lookups: turn.lookups,
		proposal: turn.proposal,
		usage: turn.usage,
		requestId: `${requestId}-turn`
	});

	return {
		conversationId: id,
		answer: turn.answer,
		lookups: turn.lookups,
		proposalId: saved.proposalId,
		stoppedAtCap: turn.stoppedAtCap,
		caps,
		replayed: saved.replayed
	};
}
