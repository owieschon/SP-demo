// The turn loop: ask the model, run what it asks for, ask again, stop.
//
// Scripted demo mode and live mode both go through this file. The model is an
// interface with one method, so the scripted model is a real model as far as
// this loop is concerned: same gate, same proposal path, same record of what
// happened, same caps.
//
// The caps in one place:
//   * at most MAX_ROUNDS rounds of tools in one turn;
//   * one proposal per answer;
//   * every tool result wrapped and capped at 16 KB (wrap.ts).
import type { LookupView } from '$lib/assistant/types';
import { MAX_ROUNDS } from './caps.ts';
import { readToday, runTool, type ModelToolCall, type ProposedAction } from './gate.ts';
import { turnRequestId, TOOLS, type Tool, type ToolContext } from './tools.ts';
import { wrapToolResult } from './wrap.ts';
import type { Db } from '../db/types.ts';

/** What one entry of the transcript is. `kind` is there for the scripted model. */
export type TurnKind = 'question' | 'answer' | 'decision' | 'tool_results';

export interface ModelTurn {
	role: 'user' | 'assistant';
	kind: TurnKind;
	/** The words. For tool results, the wrapped data blocks joined together. */
	text: string;
	/** On an assistant turn that asked for tools. */
	toolCalls?: ModelToolCall[];
	/** On a user turn that carries the results of those calls. */
	toolResults?: { id: string; name: string; text: string }[];
}

export interface ModelUsage {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
}

export interface ModelReply {
	text: string;
	toolCalls: ModelToolCall[];
	usage: ModelUsage | null;
	stopReason: string;
}

/** The one thing the loop needs from a model, real or scripted. */
export interface AskModel {
	readonly mode: 'mock' | 'live';
	/** Shown in the page's badge. The scripted model never claims to be Claude. */
	readonly label: string;
	/** Stored with the usage row. */
	readonly model: string;
	next(history: ModelTurn[], tools: Tool[]): Promise<ModelReply>;
}

/** What one call to the real model cost. Scripted demo mode reports none. */
export interface CallUsage extends ModelUsage {
	model: string;
	/** Which call of the turn this was, from 1. */
	round: number;
}

export interface TurnResult {
	answer: string;
	lookups: LookupView[];
	proposal: ProposedAction | null;
	usage: CallUsage[];
	/** The turn ended because it ran out of rounds, not because it was done. */
	stoppedAtCap: boolean;
	/** Rounds of tools that actually ran. */
	rounds: number;
}

export interface RunTurnOptions {
	db: Db;
	userId: number;
	model: AskModel;
	question: string;
	/** The conversation so far, oldest first. */
	history: ModelTurn[];
	/** The turn's request id. Writes inside the turn derive theirs from it. */
	requestId: string;
	/** Pass a date to skip reading it (tests). */
	today?: string;
}

const CAP_ANSWER = `I stopped after ${MAX_ROUNDS} lookups for one question, which is the limit. Ask me something narrower and I will get there.`;

export async function runTurn(options: RunTurnOptions): Promise<TurnResult> {
	const { db, userId, model, question, requestId } = options;
	const today = options.today ?? (await readToday(db, userId));

	const history: ModelTurn[] = [...options.history, { role: 'user', kind: 'question', text: question }];
	const lookups: LookupView[] = [];
	const usage: CallUsage[] = [];
	let proposal: ProposedAction | null = null;
	let calls = 0;
	let rounds = 0;
	let answer = '';
	let stoppedAtCap = false;

	// Each pass is one model call. A pass that asks for no tools ends the turn.
	for (;;) {
		const reply = await model.next(history, TOOLS);
		calls += 1;
		if (reply.usage) usage.push({ ...reply.usage, model: model.model, round: calls });

		if (reply.toolCalls.length === 0) {
			answer = reply.text.trim();
			break;
		}

		// The round cap. The calls it asked for are recorded as refused, so the
		// page shows what it wanted to do next.
		if (rounds >= MAX_ROUNDS) {
			stoppedAtCap = true;
			for (const call of reply.toolCalls) {
				lookups.push({
					round: rounds + 1,
					name: call.name,
					risk: 'read',
					input: call.input,
					outcome: 'refused',
					rows: null,
					ms: 0,
					note: `Not run: the limit of ${MAX_ROUNDS} lookups for one question was reached.`
				});
			}
			answer = reply.text.trim() || CAP_ANSWER;
			break;
		}

		rounds += 1;
		const results: { id: string; name: string; text: string }[] = [];
		for (const call of reply.toolCalls) {
			const ctx: ToolContext = {
				db,
				userId,
				today,
				round: rounds,
				requestId: (suffix) => turnRequestId(requestId, rounds, suffix)
			};
			const run = await runTool(ctx, call, { proposalAllowed: proposal === null });
			lookups.push(run.lookup);
			if (run.proposal) proposal = run.proposal;
			const wrapped = wrapToolResult(call.name, rounds, run.payload);
			results.push({ id: call.id, name: call.name, text: wrapped.text });
		}

		history.push({ role: 'assistant', kind: 'answer', text: reply.text, toolCalls: reply.toolCalls });
		history.push({
			role: 'user',
			kind: 'tool_results',
			text: results.map((r) => r.text).join('\n'),
			toolResults: results
		});
	}

	if (!answer) {
		answer = proposal
			? 'The options are above. Nothing has run: approve one and I will do it.'
			: 'I could not put an answer together this time. Try asking it another way.';
	}

	return { answer, lookups, proposal, usage, stoppedAtCap, rounds };
}
