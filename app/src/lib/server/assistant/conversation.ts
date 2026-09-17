// Conversations: reading them for the page, and storing one finished turn.
//
// A conversation is a list of messages (question, answer, decision), the tool
// calls each answer made, and the proposals it put on the screen. It is
// private to the person who had it (the policies in migration 0017), so every
// read here runs as that person and simply comes back empty for anyone else.
import type {
	ConversationListItem,
	ConversationView,
	LookupView,
	MessageView,
	ProposalView
} from '$lib/assistant/types';
import { MAX_CONVERSATION_MESSAGES } from './caps.ts';
import { askGuarded } from './errors.ts';
import type { ProposedAction } from './gate.ts';
import type { CallUsage, ModelTurn } from './loop.ts';
import type { Db } from '../db/types.ts';

/** The first line of the first question, as the conversation's name. */
export function titleFor(question: string): string {
	const oneLine = question.replace(/\s+/g, ' ').trim();
	return (oneLine.length > 90 ? `${oneLine.slice(0, 89)}...` : oneLine) || 'A question';
}

export interface StartResult {
	conversationId: number;
	updatedAt: string;
	replayed: boolean;
}

export async function startConversation(
	db: Db,
	userId: number,
	input: { title: string; mode: 'mock' | 'live'; requestId: string }
): Promise<StartResult> {
	const [row] = await askGuarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{ result: { conversation_id: number; updated_at: string; replayed?: boolean } }>`
				select nl.start_assistant_conversation(${titleFor(input.title)}, ${input.mode}, ${input.requestId}) as result`
		)
	);
	return {
		conversationId: row.result.conversation_id,
		updatedAt: new Date(row.result.updated_at).toISOString(),
		replayed: row.result.replayed === true
	};
}

export async function listConversations(db: Db, userId: number, limit = 12): Promise<ConversationListItem[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			id: number;
			title: string;
			mode: 'mock' | 'live';
			message_count: number;
			updated_at: Date;
			open_proposals: number;
		}>`
			select c.id, c.title, c.mode, c.message_count, c.updated_at,
			       (select count(*) from nl.assistant_proposals p
			        where p.conversation_id = c.id and p.status = 'draft')::int as open_proposals
			from nl.assistant_conversations c
			order by c.updated_at desc, c.id desc
			limit ${limit}`
	);
	return rows.map((row) => ({
		id: row.id,
		title: row.title,
		mode: row.mode,
		messageCount: row.message_count,
		updatedAt: row.updated_at.toISOString(),
		openProposals: row.open_proposals
	}));
}

interface ProposalRow {
	id: number;
	message_id: number | null;
	summary: string;
	options: { label: string; tool: string; input: Record<string, unknown> }[];
	status: ProposalView['status'];
	chosen_index: number | null;
	reason: string;
	error: string | null;
	result: Record<string, unknown> | null;
	updated_at: Date;
	decided_at: Date | null;
}

function toProposal(row: ProposalRow): ProposalView {
	return {
		id: row.id,
		summary: row.summary,
		status: row.status,
		// The stored version is not shown: it is a database timestamp, and the
		// card is about what would be written.
		options: row.options.map((option) => ({ label: option.label, tool: option.tool, input: option.input })),
		chosenIndex: row.chosen_index,
		reason: row.reason,
		error: row.error,
		result: row.result,
		updatedAt: row.updated_at.toISOString(),
		decidedAt: row.decided_at?.toISOString() ?? null
	};
}

export async function getConversation(db: Db, userId: number, id: number): Promise<ConversationView | null> {
	return db.asUser(userId, async (tx) => {
		const [head] = await tx.sql<{
			id: number;
			title: string;
			mode: 'mock' | 'live';
			message_count: number;
			created_at: Date;
			updated_at: Date;
		}>`
			select c.id, c.title, c.mode, c.message_count, c.created_at, c.updated_at
			from nl.assistant_conversations c
			where c.id = ${id}`;
		if (!head) return null;

		const messages = await tx.sql<{
			id: number;
			seq: number;
			role: MessageView['role'];
			body: string;
			created_at: Date;
		}>`
			select m.id, m.seq, m.role, m.body, m.created_at
			from nl.assistant_messages m
			where m.conversation_id = ${id}
			order by m.seq`;

		const calls = await tx.sql<{
			message_id: number | null;
			round: number;
			name: string;
			risk: LookupView['risk'];
			input: unknown;
			outcome: LookupView['outcome'];
			rows: number | null;
			ms: number;
			note: string;
		}>`
			select t.message_id, t.round, t.name, t.risk, t.input, t.outcome, t.rows, t.ms, t.note
			from nl.assistant_tool_calls t
			where t.conversation_id = ${id}
			order by t.id`;

		const proposals = await tx.sql<ProposalRow>`
			select p.id, p.message_id, p.summary, p.options, p.status, p.chosen_index,
			       p.reason, p.error, p.result, p.updated_at, p.decided_at
			from nl.assistant_proposals p
			where p.conversation_id = ${id}
			order by p.id`;

		const lookupsByMessage = new Map<number, LookupView[]>();
		for (const call of calls) {
			if (call.message_id === null) continue;
			const list = lookupsByMessage.get(call.message_id) ?? [];
			list.push({
				round: call.round,
				name: call.name,
				risk: call.risk,
				input: call.input,
				outcome: call.outcome,
				rows: call.rows,
				ms: call.ms,
				note: call.note
			});
			lookupsByMessage.set(call.message_id, list);
		}
		const proposalByMessage = new Map<number, ProposalView>();
		for (const proposal of proposals) {
			if (proposal.message_id !== null) proposalByMessage.set(proposal.message_id, toProposal(proposal));
		}

		return {
			id: head.id,
			title: head.title,
			mode: head.mode,
			messageCount: head.message_count,
			messagesLeft: Math.max(MAX_CONVERSATION_MESSAGES - head.message_count, 0),
			createdAt: head.created_at.toISOString(),
			updatedAt: head.updated_at.toISOString(),
			messages: messages.map((message) => ({
				id: message.id,
				seq: message.seq,
				role: message.role,
				body: message.body,
				createdAt: message.created_at.toISOString(),
				lookups: lookupsByMessage.get(message.id) ?? [],
				proposal: proposalByMessage.get(message.id) ?? null
			}))
		};
	});
}

/**
 * The conversation as the model sees it on the next question.
 *
 * Only the words are replayed: questions, answers and decisions. The tool
 * calls of earlier turns are not, which keeps the request small and means a
 * stale tool_use id can never be sent back to the API. The decisions matter
 * most: they are how the model knows a proposal was approved or rejected and
 * does not offer the same thing again.
 */
export function historyFrom(conversation: ConversationView): ModelTurn[] {
	return conversation.messages.map((message): ModelTurn => {
		if (message.role === 'answer') return { role: 'assistant', kind: 'answer', text: message.body };
		if (message.role === 'decision') {
			return { role: 'user', kind: 'decision', text: `The person decided on your proposal. ${message.body}` };
		}
		return { role: 'user', kind: 'question', text: message.body };
	});
}

export interface SaveTurnResult {
	conversationId: number;
	answerId: number;
	proposalId: number | null;
	messageCount: number;
	replayed: boolean;
}

export async function saveTurn(
	db: Db,
	userId: number,
	input: {
		conversationId: number;
		question: string;
		answer: string;
		lookups: LookupView[];
		proposal: ProposedAction | null;
		usage: CallUsage[];
		requestId: string;
	}
): Promise<SaveTurnResult> {
	const lookups = JSON.stringify(
		input.lookups.map((lookup) => ({
			round: lookup.round,
			name: lookup.name,
			risk: lookup.risk,
			input: lookup.input ?? {},
			outcome: lookup.outcome,
			rows: lookup.rows,
			ms: lookup.ms,
			note: lookup.note
		}))
	);
	const proposal = input.proposal === null ? null : JSON.stringify(input.proposal);
	const usage = input.usage.length === 0 ? null : JSON.stringify(input.usage);

	const [row] = await askGuarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<{
				result: {
					conversation_id: number;
					answer_id: number;
					proposal_id: number | null;
					message_count: number;
					replayed?: boolean;
				};
			}>`
				select nl.save_assistant_turn(${input.conversationId}, ${input.question}, ${input.answer},
				                              ${lookups}::jsonb, ${proposal}::jsonb, ${usage}::jsonb,
				                              ${input.requestId}) as result`
		)
	);
	return {
		conversationId: row.result.conversation_id,
		answerId: row.result.answer_id,
		proposalId: row.result.proposal_id ?? null,
		messageCount: row.result.message_count,
		replayed: row.result.replayed === true
	};
}
