// The gate: what happens when the model asks for a tool.
//
// One function, one branch order, and the order is the whole point:
//
//   1. Is there a tool with that name?          no  -> refused
//   2. Is it gated?                             yes -> gated, and the input is
//                                                      never even parsed,
//                                                      because nothing is
//                                                      going to run
//   3. Is it propose_action?                    yes -> validate the options
//                                                      against the gated tools
//                                                      and put them on screen
//   4. Otherwise (read or additive)                 -> parse the input, run it
//
// Nothing in a prompt can move a tool between branches: the risk class is a
// field on the tool in tools.ts.
import type { LookupOutcome, LookupView } from '$lib/assistant/types';
import type { Db } from '../db/types.ts';
import { toAskError } from './errors.ts';
import { findTool, gatedToolNames, toolNames, type Tool, type ToolContext } from './tools.ts';

/** One tool call as the model asked for it. */
export interface ModelToolCall {
	/** The API's id for this call, or one we made up in demo mode. */
	id: string;
	name: string;
	input: unknown;
}

/** One option on a proposal card, ready to store. */
export interface ProposedOption {
	/** Our words, built from the validated input, so a label cannot mislead. */
	label: string;
	tool: string;
	/** The validated input. Exactly this is what runs, if it is approved. */
	input: Record<string, unknown>;
	/** The row version when the proposal was made. Null when there is no row yet. */
	version: string | null;
	/** What the model called this option, kept for the record. */
	model_label: string;
}

export interface ProposedAction {
	summary: string;
	options: ProposedOption[];
}

export interface ToolRun {
	lookup: LookupView;
	/** What goes back to the model, before wrapping. */
	payload: unknown;
	/** Set only when propose_action produced a card. */
	proposal: ProposedAction | null;
}

export interface GateOptions {
	/** False once this turn already has a proposal: one per answer. */
	proposalAllowed: boolean;
}

function gatedPayload(tool: Tool) {
	return {
		gated: true,
		tool: tool.name,
		ran: false,
		message: `${tool.name} is gated, so it did not run and cannot be run by asking. To do this, call propose_action with an option naming ${tool.name} and its exact input. A person then approves or rejects it, and only then does it run.`
	};
}

function lookupOf(
	call: ModelToolCall,
	risk: LookupView['risk'],
	outcome: LookupOutcome,
	round: number,
	ms: number,
	note = '',
	rows: number | null = null
): LookupView {
	return { round, name: call.name, risk, input: call.input, outcome, rows, ms, note };
}

/** How many rows a payload carries, when it carries rows. */
function rowsIn(payload: unknown): number | null {
	if (!payload || typeof payload !== 'object') return null;
	const shape = payload as Record<string, unknown>;
	if (Array.isArray(shape.rows)) return shape.rows.length;
	if (typeof shape.row_count === 'number') return shape.row_count;
	if (Array.isArray(shape.open_commitments)) return (shape.open_commitments as unknown[]).length;
	return null;
}

/**
 * Check one option of a proposal: the tool has to exist, it has to be gated,
 * and its input has to validate. Then read the row version the write will be
 * held to.
 */
async function checkOption(
	ctx: ToolContext,
	option: { label: string; tool: string; input: Record<string, unknown> }
): Promise<{ ok: true; option: ProposedOption } | { ok: false; message: string }> {
	const tool = findTool(option.tool);
	if (!tool) {
		return { ok: false, message: `There is no tool called "${option.tool}". The gated ones are ${gatedToolNames().join(', ')}.` };
	}
	if (tool.risk !== 'gated') {
		return {
			ok: false,
			message: `${tool.name} is a ${tool.risk} tool, so there is nothing to propose: call it directly. Propose one of ${gatedToolNames().join(', ')}.`
		};
	}
	const parsed = tool.parse(option.input);
	if (!parsed.ok) {
		return { ok: false, message: `The input for ${tool.name} does not fit: ${parsed.message}` };
	}
	const input = parsed.value as Record<string, unknown>;

	let version: string | null = null;
	try {
		const captured = tool.capture ? await tool.capture(ctx, input) : { version: null };
		// The row the write would change is gone, so there is nothing to propose.
		if ('missing' in captured) return { ok: false, message: captured.missing };
		version = captured.version;
	} catch (error) {
		const refusal = toAskError(error);
		if (refusal) return { ok: false, message: refusal.message };
		throw error;
	}

	return {
		ok: true,
		option: {
			label: tool.label ? tool.label(input) : option.label,
			tool: tool.name,
			input,
			version,
			model_label: option.label
		}
	};
}

/**
 * Run one tool call, or refuse it. Never throws for anything the model did
 * wrong: the model gets a result it can read and try again from.
 */
export async function runTool(ctx: ToolContext, call: ModelToolCall, options: GateOptions): Promise<ToolRun> {
	const started = Date.now();
	const since = () => Date.now() - started;

	// 1. A tool we have?
	const tool = findTool(call.name);
	if (!tool) {
		return {
			lookup: lookupOf(call, 'read', 'refused', ctx.round, since(), 'No tool of that name.'),
			payload: { error: `There is no tool called "${call.name}". The tools are ${toolNames().join(', ')}.` },
			proposal: null
		};
	}

	// 2. Gated: stop here. The input is not even parsed.
	if (tool.risk === 'gated') {
		return {
			lookup: lookupOf(call, 'gated', 'gated', ctx.round, since(), 'Gated: it needs a person to approve it.'),
			payload: gatedPayload(tool),
			proposal: null
		};
	}

	// 3. A proposal.
	if (tool.risk === 'propose') {
		if (!options.proposalAllowed) {
			return {
				lookup: lookupOf(call, 'propose', 'refused', ctx.round, since(), 'One proposal per answer.'),
				payload: { error: 'You have already proposed something in this answer. Write your answer now.' },
				proposal: null
			};
		}
		const parsed = tool.parse(call.input);
		if (!parsed.ok) {
			return {
				lookup: lookupOf(call, 'propose', 'refused', ctx.round, since(), parsed.message),
				payload: { error: `The proposal does not fit: ${parsed.message}` },
				proposal: null
			};
		}
		const asked = parsed.value as { summary: string; options: { label: string; tool: string; input: Record<string, unknown> }[] };

		const checked: ProposedOption[] = [];
		for (const option of asked.options) {
			const result = await checkOption(ctx, option);
			if (!result.ok) {
				return {
					lookup: lookupOf(call, 'propose', 'refused', ctx.round, since(), result.message),
					payload: { error: result.message, proposed: false },
					proposal: null
				};
			}
			checked.push(result.option);
		}

		return {
			lookup: lookupOf(call, 'propose', 'ran', ctx.round, since(), `${checked.length} option(s) put to the person.`, checked.length),
			payload: {
				proposed: true,
				message:
					'The person now sees these options and has to approve one before anything runs. Write your answer: what you found, and what you are asking for. Do not call any more tools.',
				options: checked.map((option, index) => ({ index, label: option.label, tool: option.tool }))
			},
			proposal: { summary: asked.summary, options: checked }
		};
	}

	// 4. read or additive: parse, then run.
	const parsed = tool.parse(call.input);
	if (!parsed.ok) {
		return {
			lookup: lookupOf(call, tool.risk, 'refused', ctx.round, since(), parsed.message),
			payload: { error: `The input for ${tool.name} does not fit: ${parsed.message}` },
			proposal: null
		};
	}
	try {
		const payload = await tool.run!(ctx, parsed.value);
		return {
			lookup: lookupOf(call, tool.risk, 'ran', ctx.round, since(), '', rowsIn(payload)),
			payload,
			proposal: null
		};
	} catch (error) {
		// A refusal from the database (a customer that does not exist, a rule
		// the catalog does not allow) is something the model can act on. A real
		// failure is not, and is thrown on.
		const refusal = toAskError(error);
		if (!refusal) throw error;
		return {
			lookup: lookupOf(call, tool.risk, 'failed', ctx.round, since(), refusal.message),
			// The code as well as the sentence: NL403 and NL409 need different
			// answers, and telling them apart from prose is guesswork.
			payload: { error: refusal.message, code: refusal.code },
			proposal: null
		};
	}
}

/** Read today's date once, at the start of a turn. */
export async function readToday(db: Db, userId: number): Promise<string> {
	const [row] = await db.asUser(userId, (tx) => tx.sql<{ today: string }>`select nl.today() as today`);
	return row.today;
}
