// Approving and rejecting a proposal. This is where a gated tool finally runs.
//
// What approval is allowed to trust:
//   * the proposal id, the option number, the row version and a request id,
//     from the form;
//   * everything else from the stored proposal row.
// The values written never come from the request. The page does send back the
// input it displayed, and that is used as a check: if it does not match the
// stored option byte for byte (as canonical JSON, keys sorted), the approval
// is refused, because the person was looking at something else.
//
// The order, and why:
//   1. read the proposal as this person. Another person's proposal is simply
//      not there (the policies in migration 0017), so they get a 404.
//   2. it has to belong to the conversation the form came from.
//   3. the shown input has to match the stored one.
//   4. nl.decide_assistant_proposal records the decision: draft to approved,
//      or approved to approved for a retry. Rejected is final, executed is
//      final, and either one refuses here.
//   5. the stored input is validated against the tool's schema again.
//   6. the tool's own execute runs the SAME SQL function the pages use, as
//      this person, with a request id derived from the proposal id. A retry
//      claims the same request id and gets the first result back, so a
//      double approval can never write twice.
//   7. nl.finish_assistant_proposal marks it executed, or records the error
//      and leaves it approved so it can be tried again.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.ts';
import { askGuarded, toAskError } from './errors.ts';
import type { Db } from '../db/types.ts';
import { findTool, type ToolContext } from './tools.ts';

/** JSON with every object's keys in order, so two inputs can be compared. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		// An undefined value is not JSON and must not count as a key.
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(',')}}`;
}

export const decideInput = z
	.object({
		proposalId: z.coerce.number().int().positive(),
		conversationId: z.coerce.number().int().positive(),
		decision: z.enum(['approve', 'reject']),
		optionIndex: z.coerce.number().int().min(0).max(2).nullable().default(null),
		reason: z.string().trim().max(500).default(''),
		expectedUpdatedAt: z.iso.datetime({ offset: true }),
		requestId: z.string().min(8).max(100),
		/**
		 * The option the page showed, as JSON. Optional, and never used as the
		 * values to write: it only has to match what is stored.
		 */
		shownInput: z.string().max(20000).optional(),
		shownTool: z.string().max(60).optional()
	})
	.refine((input) => input.decision === 'reject' || input.optionIndex !== null, {
		path: ['optionIndex'],
		message: 'Approving needs the option you chose.'
	});

export type DecideInput = z.infer<typeof decideInput>;

export interface DecideResult {
	proposalId: number;
	status: 'approved' | 'rejected' | 'executed';
	/** What to tell the person. */
	message: string;
	/** What the write returned, when it ran. */
	result: Record<string, unknown> | null;
	replayed: boolean;
}

interface ProposalRow {
	id: number;
	conversation_id: number;
	status: 'draft' | 'approved' | 'rejected' | 'executed';
	options: { label: string; tool: string; input: Record<string, unknown>; version: string | null }[];
	chosen_index: number | null;
}

interface DecisionRow {
	result: {
		proposal_id: number;
		status: 'approved' | 'rejected';
		option: number | null;
		tool: string | null;
		input: Record<string, unknown> | null;
		version: string | null;
		updated_at: string;
		replayed?: boolean;
	};
}

export async function decideProposal(db: Db, userId: number, raw: unknown): Promise<DecideResult> {
	const parsed = decideInput.safeParse(raw);
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		throw new AppError(422, 'NL422', `That decision does not make sense (${first.path.join('.') || 'form'}: ${first.message}).`);
	}
	const input = parsed.data;

	// 1 and 2: it has to be this person's proposal, in this conversation.
	const [stored] = await db.asUser(userId, (tx) =>
		tx.sql<ProposalRow>`
			select p.id, p.conversation_id, p.status, p.options, p.chosen_index
			from nl.assistant_proposals p
			where p.id = ${input.proposalId}`
	);
	if (!stored) throw new AppError(404, 'NL404', `Proposal ${input.proposalId} does not exist.`);
	if (stored.conversation_id !== input.conversationId) {
		throw new AppError(404, 'NL404', `Proposal ${input.proposalId} is not part of this conversation.`);
	}

	// 3: the person approved what they were shown.
	if (input.decision === 'approve') {
		const option = stored.options[input.optionIndex!];
		if (!option) {
			throw new AppError(422, 'NL422', `Proposal ${input.proposalId} has no option ${input.optionIndex}.`);
		}
		if (input.shownTool !== undefined && input.shownTool !== option.tool) {
			throw new AppError(
				409,
				'NL409',
				'What this page shows is not what was proposed any more. Reload it and decide again.'
			);
		}
		if (input.shownInput !== undefined) {
			let shown: unknown;
			try {
				shown = JSON.parse(input.shownInput);
			} catch {
				throw new AppError(422, 'NL422', 'The form sent something that is not an option.');
			}
			if (canonicalJson(shown) !== canonicalJson(option.input)) {
				throw new AppError(
					409,
					'NL409',
					'What this page shows is not what was proposed any more. Reload it and decide again.'
				);
			}
		}
	}

	// 4: record the decision.
	const [decision] = await askGuarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql<DecisionRow>`
				select nl.decide_assistant_proposal(${input.proposalId}, ${input.decision},
				                                    ${input.optionIndex}::int, ${input.reason},
				                                    ${input.expectedUpdatedAt}::timestamptz,
				                                    ${input.requestId}) as result`
		)
	);
	const replayed = decision.result.replayed === true;

	if (input.decision === 'reject') {
		return {
			proposalId: input.proposalId,
			status: 'rejected',
			message: 'Rejected. Nothing was written, and a rejected proposal cannot be approved later.',
			result: null,
			replayed
		};
	}

	const option = stored.options[input.optionIndex!];
	const tool = findTool(option.tool);
	// 5: the stored option still has to be a gated tool with a valid input.
	if (!tool || tool.risk !== 'gated' || !tool.execute) {
		await recordFailure(db, userId, input.proposalId, `The tool "${option.tool}" is not one that can be run.`);
		throw new AppError(422, 'NL422', `The tool "${option.tool}" is not one that can be run.`);
	}
	const checked = tool.parse(option.input);
	if (!checked.ok) {
		await recordFailure(db, userId, input.proposalId, `The stored input no longer fits ${tool.name}: ${checked.message}`);
		throw new AppError(422, 'NL422', `The stored input no longer fits ${tool.name}: ${checked.message}`);
	}

	// 6: the write. The request id is derived from the proposal, so a second
	// attempt replays the first one instead of writing again.
	const executionId = `assistant-proposal-${input.proposalId}-run`;
	const ctx: ToolContext = {
		db,
		userId,
		today: '',
		round: 0,
		requestId: () => executionId
	};
	let written: Record<string, unknown>;
	try {
		written = await tool.execute(ctx, checked.value, option.version, executionId);
	} catch (error) {
		const refusal = toAskError(error);
		const message = refusal
			? refusal.message
			: `The write did not go through: ${error instanceof Error ? error.message : String(error)}`;
		// 7a: the proposal stays approved, so the person can try again.
		await recordFailure(db, userId, input.proposalId, message);
		if (refusal) throw refusal;
		throw error;
	}

	// 7b: done, and it cannot run again.
	await askGuarded(() =>
		db.asUser(userId, (tx) =>
			tx.sql`select nl.finish_assistant_proposal(${input.proposalId}, ${JSON.stringify(written)}::jsonb,
			                                           null, ${`assistant-proposal-${input.proposalId}-done`})`
		)
	);

	return {
		proposalId: input.proposalId,
		status: 'executed',
		message: `Done: ${option.label}.`,
		result: written,
		replayed
	};
}

/** Keep the error on the proposal without changing its status. */
async function recordFailure(db: Db, userId: number, proposalId: number, message: string): Promise<void> {
	try {
		await db.asUser(userId, (tx) =>
			tx.sql`select nl.finish_assistant_proposal(${proposalId}, null, ${message}, ${`assistant-fail-${randomUUID()}`})`
		);
	} catch {
		// Recording why it failed must never replace the failure itself.
	}
}
