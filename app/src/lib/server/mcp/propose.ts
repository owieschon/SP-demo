// How an outside agent asks for a change: it proposes, and a person approves.
//
// This is deliberately not a second approval system. It goes down the same
// path the in-app assistant uses (migration 0017):
//
//   1. the gate (assistant/gate.ts) is handed a propose_action call naming one
//      gated tool and its input. The gate is what refuses to run a gated tool,
//      validates the input against that tool's own schema, reads the row
//      version the write will be held to, and builds the label from the
//      validated input rather than from anything the agent wrote;
//   2. a conversation is started with mode 'mcp', so the proposal has somewhere
//      to live and a person has a page to open;
//   3. nl.save_assistant_turn stores the question, the answer, the tool call
//      and the proposal, and writes an audit row.
//
// After that the proposal is an ordinary proposal: the person approves it on
// /ask/<id> and assistant/proposals.ts does the write. Nothing here can
// approve, and there is no MCP tool that could.
import { randomUUID } from 'node:crypto';
import { saveTurn, titleFor } from '../assistant/conversation.ts';
import { askGuarded } from '../assistant/errors.ts';
import { runTool, type ProposedAction } from '../assistant/gate.ts';
import type { ToolContext } from '../assistant/tools.ts';

export interface ProposeInput {
	/** The gated tool the agent wants run, by its exact name. */
	tool: string;
	/** That tool's input, already checked against its schema by the caller. */
	toolInput: Record<string, unknown>;
	/** Why, in the agent's own words. It becomes the question on the page. */
	summary: string;
	/** Which token asked, for the line a person reads. */
	tokenLabel: string;
}

export type ProposeOutcome =
	| { ok: true; payload: Record<string, unknown> }
	| { ok: false; message: string };

/**
 * Start a conversation with mode 'mcp'.
 *
 * nl.start_assistant_conversation checks for mode 'mock' or 'live' inside its
 * own body, and it belongs to migration 0017, so migration 0024 added
 * nl.start_mcp_conversation beside it rather than replacing someone else's
 * function. Everything after this point is the assistant's own path.
 */
async function startConversation(
	ctx: ToolContext,
	title: string,
	requestId: string
): Promise<{ conversationId: number }> {
	const [row] = await askGuarded(() =>
		ctx.db.asUser(ctx.userId, (tx) =>
			tx.sql<{ result: { conversation_id: number } }>`
				select nl.start_mcp_conversation(${titleFor(title)}, ${requestId}) as result`
		)
	);
	return { conversationId: row.result.conversation_id };
}

/**
 * Turn one propose_* tool call into a stored proposal. Returns the proposal's
 * id and the page a person opens to decide, or the gate's own refusal (for
 * example a commitment that does not exist), which the agent can read and act
 * on.
 */
export async function proposeFromMcp(ctx: ToolContext, input: ProposeInput): Promise<ProposeOutcome> {
	// 1. The gate. It never runs a gated tool; the most it does is build a
	//    validated option and read the row version.
	const run = await runTool(
		ctx,
		{
			id: `mcp-${randomUUID()}`,
			name: 'propose_action',
			input: {
				summary: input.summary,
				options: [{ label: input.summary, tool: input.tool, input: input.toolInput }]
			}
		},
		{ proposalAllowed: true }
	);

	const proposal: ProposedAction | null = run.proposal;
	if (!proposal) {
		const payload = run.payload as { error?: unknown };
		const message =
			typeof payload?.error === 'string'
				? payload.error
				: `${input.tool} cannot be proposed with that input.`;
		return { ok: false, message };
	}

	// 2. A conversation to hold it, so the proposal has a page.
	const base = randomUUID();
	const started = await startConversation(ctx, `Via MCP: ${proposal.options[0].label}`, `mcp-conv-${base}`);

	// 3. The turn. The question is what the agent asked for and which token
	//    asked; the answer says plainly that nothing has been written yet.
	const option = proposal.options[0];
	const saved = await saveTurn(ctx.db, ctx.userId, {
		conversationId: started.conversationId,
		question: `An outside agent asked for this through MCP, with the token "${input.tokenLabel}". ${input.summary}`,
		answer: `Proposed: ${option.label}. Nothing has been written. Approve or reject it on this page.`,
		lookups: [run.lookup],
		proposal,
		usage: [],
		requestId: `mcp-turn-${base}`
	});

	return {
		ok: true,
		payload: {
			proposed: true,
			proposal_id: saved.proposalId,
			conversation_id: saved.conversationId,
			// The page a person opens to approve or reject it.
			approve_at: `/ask/${saved.conversationId}`,
			tool: option.tool,
			// Our words, built from the validated input, not the agent's prose.
			label: option.label,
			input: option.input,
			status: 'draft',
			message:
				'Nothing has been written. A person has to approve this proposal in the app before it runs, and nothing an agent can call will approve it.'
		}
	};
}
