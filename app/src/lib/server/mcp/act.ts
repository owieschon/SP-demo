// Acting for real, when the token's rung says it may.
//
// This file adds no authority. It is the shortest honest path from "an outside
// agent asked for this" to "the same write a person's approve button makes",
// and it refuses before it writes rather than after.
//
// THE ORDER, AND WHY EACH STEP IS HERE
//
//   1. the pause switch. nl.agent_paused('mcp') stops a token at every rung,
//      including suggest: a brake that only works when the agent is trusted is
//      not a brake. It is asked first because it is the cheapest refusal and
//      the one a person pulled deliberately.
//   2. the person's authority. nl.mcp_may_act asks nl.may_approve for
//      'approve_agent_proposal' at the value at risk, which in one call reads
//      the grant, its effective dates and the policy engine's cap
//      (nl.authority_limit_override). Above the ceiling is a refusal that
//      names the ceiling. It is NEVER quietly downgraded to a proposal: the
//      agent asked to act, and the honest answer is that it may not.
//   3. the proposal. The change is still written down first, through the
//      assistant's own path, because that is what captures the row version and
//      validates the input against the gated tool's own schema.
//   4. the decision, through decideProposal, which is the identical function
//      the approve button on /ask calls. Not a copy of it, not a variant of
//      it: the same function, so there is no check the in-app path makes that
//      this path can skip.
//   5. the record. nl.record_agent_action stores the rung it acted at, the
//      person it acted as and the undo window, and re-checks the rung and the
//      pause in the database, so a caller that got step 1 wrong is refused
//      rather than trusted.
//
// The only difference between the two acting rungs is what step 5 stores:
// auto_review leaves an undo window open, auto does not and samples a share
// for review afterwards. That is exactly what those rungs mean everywhere else
// in this app, which is the point of reusing them.
import { randomUUID } from 'node:crypto';
import { decideProposal } from '../assistant/proposals.ts';
import { runTool } from '../assistant/gate.ts';
import { findTool, type ToolContext } from '../assistant/tools.ts';
import { recordActionAs } from '../harness/record.ts';
import { AppError, toAppError } from '../errors.ts';
import { proposeFromMcp } from './propose.ts';
import type { TokenAutonomy } from './tokens.ts';
import type { Db } from '../db/types.ts';

/** The entity an MCP action is recorded against, for the undo to dispatch on. */
export const MCP_ACTION_ENTITY = 'mcp_change';

export type ActOutcome =
	| { ok: true; payload: Record<string, unknown> }
	| { ok: false; message: string; code?: string };

export interface ActInput {
	/** The tool to run, by its exact name. Gated or additive. */
	tool: string;
	toolInput: Record<string, unknown>;
	/** Why, in the agent's own words. It is what a person reads afterwards. */
	summary: string;
	tokenLabel: string;
	autonomy: TokenAutonomy;
}

// ---------------------------------------------------------------------------
// The two refusals that come before any write
// ---------------------------------------------------------------------------

/**
 * Is the mcp agent stopped? Asked of the database rather than of the identity
 * read at the start of the request, because somebody may have pulled the brake
 * in the seconds since.
 */
async function pauseRefusal(db: Db, userId: number): Promise<string | null> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ result: { paused: boolean; reason?: string; paused_by_name?: string } }>`
			select nl.agent_paused('mcp') as result`
	);
	if (row?.result?.paused !== true) return null;
	const who = row.result.paused_by_name ? ` by ${row.result.paused_by_name}` : '';
	const why = row.result.reason ? `: ${row.result.reason}` : '.';
	return `Outside agents are stopped${who}${why} Nothing was written, at any level. Let it go on /agents first.`;
}

export interface MayActAnswer {
	allowed: boolean;
	reason: string;
	authority: string;
	amount: number;
	ceiling: number | null;
}

/**
 * May the person this token acts as let an agent make this change for them?
 *
 * One call, and it is the roles model's own. Exported because the test that
 * holds the ceiling promise asks it directly, and because tools/list has no
 * business claiming a tool is available if this would refuse every use of it.
 */
export async function mayAct(
	db: Db,
	userId: number,
	tool: string,
	toolInput: Record<string, unknown>
): Promise<MayActAnswer> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{
			result: { allowed: boolean; reason: string; authority: string; amount: string | number; ceiling: string | number | null };
		}>`
			select nl.mcp_may_act(${userId}, ${tool}, ${JSON.stringify(toolInput)}::jsonb) as result`
	);
	const r = row.result;
	return {
		allowed: r.allowed === true,
		reason: r.reason ?? '',
		authority: r.authority,
		amount: Number(r.amount ?? 0),
		ceiling: r.ceiling === null ? null : Number(r.ceiling)
	};
}

// ---------------------------------------------------------------------------
// Acting
// ---------------------------------------------------------------------------

/** A tool context of the shape the assistant's own tools expect. */
function toolContext(db: Db, userId: number, today: string, base: string): ToolContext {
	return {
		db,
		userId,
		today,
		round: 1,
		requestId: (suffix) => `mcp-act-${base}-${suffix}`
	};
}

/**
 * What the field was, before the change, so an undo has something to put back.
 *
 * Only for the tools an undo can actually reverse. The others say plainly that
 * they cannot be reversed by rule (harness/wake.ts), and recording a "before"
 * for them would suggest otherwise: a note cannot be unwritten, an outcome
 * settles a commitment, and an applied export snapshot has already replaced the
 * live open order lines.
 */
async function capturedBefore(
	db: Db,
	userId: number,
	tool: string,
	toolInput: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
	if (tool !== 'set_confidence') return null;
	const commitmentId = Number(toolInput.commitment_id);
	if (!Number.isInteger(commitmentId)) return null;
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ confidence: number }>`
			select confidence from nl.commitments where id = ${commitmentId}`
	);
	return row ? { confidence: row.confidence } : null;
}

/** The proposal's row version, which decideProposal is held to. */
async function proposalVersion(db: Db, userId: number, proposalId: number): Promise<string> {
	const [row] = await db.asUser(userId, (tx) =>
		tx.sql<{ updated_at: Date | string }>`
			select updated_at from nl.assistant_proposals where id = ${proposalId}`
	);
	if (!row) throw new AppError(404, 'NL404', `Proposal ${proposalId} disappeared before it could run.`);
	return typeof row.updated_at === 'string'
		? new Date(row.updated_at).toISOString()
		: row.updated_at.toISOString();
}

/**
 * Run a gated tool for real, as the person the token acts as.
 *
 * The change is proposed and then approved in the same breath, by the person
 * whose authority allows it, through the functions the app already uses. What
 * makes that legitimate rather than a loophole is step 2 above: the person has
 * granted an agent the authority to act for them up to a value, and this is
 * within it. What makes it auditable is that the proposal, the decision and
 * the action are all on the record afterwards, and say plainly that no human
 * clicked anything.
 */
async function actGated(
	db: Db,
	userId: number,
	today: string,
	input: ActInput
): Promise<ActOutcome> {
	const base = randomUUID();
	const ctx = toolContext(db, userId, today, base);

	// What the field was, read before anything changes it.
	const before = await capturedBefore(db, userId, input.tool, input.toolInput);

	// 3. Write the change down first. The gate inside proposeFromMcp validates
	//    the input against the gated tool's own schema and captures the row
	//    version the write will be held to.
	const proposed = await proposeFromMcp(ctx, {
		tool: input.tool,
		toolInput: input.toolInput,
		summary: input.summary,
		tokenLabel: input.tokenLabel
	});
	if (!proposed.ok) return { ok: false, message: proposed.message };

	const proposalId = Number(proposed.payload.proposal_id);
	const conversationId = Number(proposed.payload.conversation_id);

	// 4. The decision. The same function, not a variant of it.
	let written: Record<string, unknown> | null = null;
	try {
		const decided = await decideProposal(db, userId, {
			proposalId,
			conversationId,
			decision: 'approve',
			optionIndex: 0,
			reason: `Approved by the token "${input.tokenLabel}" acting at ${input.autonomy.level}.`,
			expectedUpdatedAt: await proposalVersion(db, userId, proposalId),
			requestId: `mcp-decide-${base}`
		});
		written = decided.result;
	} catch (error) {
		const refusal = toAppError(error);
		if (!refusal) throw error;
		// The proposal exists and is still a draft, so the person can decide it
		// themselves. Say so rather than leaving the agent guessing.
		return {
			ok: false,
			code: refusal.code,
			message:
				`${refusal.message} Nothing was written. It is still a proposal at /ask/${conversationId}, ` +
				`so it can be approved by hand.`
		};
	}

	// 5. The record: the rung, the person, the window.
	const recorded = await recordActionAs(db, userId, {
		agent: 'mcp',
		workKind: input.autonomy.workKind,
		runKey: `mcp:${proposalId}`,
		action: input.tool,
		entity: MCP_ACTION_ENTITY,
		entityId: String(proposalId),
		atLevel: input.autonomy.level === 'auto' ? 'auto' : 'auto_review',
		undoMinutes: input.autonomy.level === 'auto_review' ? input.autonomy.undoWindowMinutes : null,
		detail: {
			tool: input.tool,
			input: input.toolInput,
			summary: input.summary,
			token_label: input.tokenLabel,
			conversation_id: conversationId,
			// What it was, for the undo. Null when this tool has no reversal.
			before,
			result: written
		},
		requestId: `mcp-action-${base}`
	});

	return {
		ok: true,
		payload: {
			acted: true,
			tool: input.tool,
			level: input.autonomy.level,
			result: written,
			// Where a person reads what happened and, at auto_review, takes it
			// back. Both are real pages, so the agent can quote them.
			recorded_at: `/ask/${conversationId}`,
			undo_at: recorded.undoUntil ? '/agents' : null,
			action_id: recorded.actionId,
			undo_until: recorded.undoUntil,
			sampled: recorded.sampled,
			message: recorded.undoUntil
				? `Done, as ${input.tokenLabel}'s person. It is reversible on /agents until ${recorded.undoUntil}.`
				: 'Done, as this token\'s person, and audited. There was no queue step at this level.'
		}
	};
}

/**
 * Run an additive tool for real. add_note and add_next_step only ever insert a
 * row, which is why they were held back rather than gated: the reason they
 * were withheld from MCP entirely was the absence of a dial, and the dial is
 * now here.
 *
 * There is no proposal, because an additive tool is not a gated tool and
 * decideProposal would refuse one. It runs through the same gate the in-app
 * assistant runs it through, and the action is recorded the same way.
 */
async function actAdditive(
	db: Db,
	userId: number,
	today: string,
	input: ActInput
): Promise<ActOutcome> {
	const base = randomUUID();
	const ctx = toolContext(db, userId, today, base);

	const run = await runTool(
		ctx,
		{ id: `mcp-${base}`, name: input.tool, input: input.toolInput },
		{ proposalAllowed: false }
	);
	const payload = (run.payload ?? {}) as Record<string, unknown>;
	if (run.lookup.outcome !== 'ran' || typeof payload.error === 'string') {
		return {
			ok: false,
			message: typeof payload.error === 'string' ? payload.error : `${input.tool} did not run.`,
			code: typeof payload.code === 'string' ? payload.code : undefined
		};
	}

	/*
	  The row it wrote, for the run key and for the undo. An additive tool
	  answers with its own id (activity_id or next_step_id), so the key names
	  the row rather than a counter of our own.
	*/
	const writtenId = Number(payload.activity_id ?? payload.next_step_id ?? 0);
	const recorded = await recordActionAs(db, userId, {
		agent: 'mcp',
		workKind: input.autonomy.workKind,
		runKey: `mcp:${writtenId || 0}`,
		action: input.tool,
		entity: MCP_ACTION_ENTITY,
		entityId: String(writtenId || 0),
		atLevel: input.autonomy.level === 'auto' ? 'auto' : 'auto_review',
		undoMinutes: input.autonomy.level === 'auto_review' ? input.autonomy.undoWindowMinutes : null,
		detail: {
			tool: input.tool,
			input: input.toolInput,
			summary: input.summary,
			token_label: input.tokenLabel,
			wrote: payload.wrote ?? '',
			result: payload
		},
		requestId: `mcp-action-${base}`
	});

	return {
		ok: true,
		payload: {
			acted: true,
			tool: input.tool,
			level: input.autonomy.level,
			result: payload,
			action_id: recorded.actionId,
			undo_until: recorded.undoUntil,
			sampled: recorded.sampled,
			message: 'Done, as this token\'s person. A note or a next step only ever adds a row.'
		}
	};
}

/**
 * The one entry point. It decides nothing about whether the token MAY act:
 * that is the rung it was handed, read from the ladder at authentication. What
 * it decides is the two refusals that come before any write, and which of the
 * two shapes of tool this is.
 */
export async function actFromMcp(
	db: Db,
	userId: number,
	today: string,
	input: ActInput
): Promise<ActOutcome> {
	// 1. The brake.
	const paused = await pauseRefusal(db, userId);
	if (paused) return { ok: false, message: paused, code: 'NL403' };

	// 2. The person's authority and its ceiling.
	const may = await mayAct(db, userId, input.tool, input.toolInput);
	if (!may.allowed) return { ok: false, message: may.reason, code: 'NL403' };

	const tool = findTool(input.tool);
	if (!tool) return { ok: false, message: `There is no tool called "${input.tool}".` };

	return tool.risk === 'additive'
		? actAdditive(db, userId, today, input)
		: actGated(db, userId, today, input);
}
