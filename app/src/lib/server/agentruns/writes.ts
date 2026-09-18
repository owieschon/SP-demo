// Every write the run trail makes, and there are only four of them.
//
// Each one calls the SQL function of the same name in migration 0027, which
// claims the request id, checks who is asking, checks the rules and writes
// the audit row. Nothing in this file decides anything; it exists so nothing
// above it writes SQL by hand or forgets a request id.
import type { Tx } from '../db/types.ts';
import type { Disclosure } from '$lib/desk/types';
import type { ReplayDiffKind, RunOutcome, StepKind } from '$lib/agentruns/types';

interface WriteRow<T> {
	result: T;
}

export interface StartRun {
	agent: string;
	wokeBy: 'mail' | 'signal' | 'schedule' | 'person' | 'replay';
	wokeNote: string;
	entity: string | null;
	entityId: number | null;
	reader: Disclosure;
	subjectNo: string | null;
	mode: 'mock' | 'live';
	model: string | null;
	/** Only when the context engine is in this database. */
	bundleVersion: string | null;
	/** What a replay would need to make the same decisions again. */
	inputs: unknown;
	replayOf: number | null;
	/**
	 * The agent's own record this trail is taken from, for example
	 * `mail_run` and a row id. Set, it makes the write idempotent: asking
	 * twice gives the same run back with `existing` true.
	 */
	sourceKind: string | null;
	sourceId: number | null;
	/** When the work really began, for a trail written after the fact. */
	startedAt?: string | null;
}

export async function startRun(
	tx: Tx,
	input: StartRun,
	request: string
): Promise<{ runId: number; existing: boolean }> {
	const [row] = await tx.sql<WriteRow<{ run_id: number; existing: boolean }>>`
		select nl.start_agent_run(
			${input.agent}, ${input.wokeBy}, ${input.wokeNote}, ${input.entity}, ${input.entityId},
			${input.reader}, ${input.subjectNo}, ${input.mode}, ${input.model},
			${input.bundleVersion}, ${JSON.stringify(input.inputs ?? {})}::jsonb,
			${input.replayOf}, ${input.sourceKind}, ${input.sourceId},
			${input.startedAt ?? null}::timestamptz, ${request}) as result`;
	return { runId: Number(row.result.run_id), existing: row.result.existing === true };
}

/** One step, as it goes into the database. */
export interface StepInput {
	kind: StepKind;
	label: string;
	tool?: string | null;
	args?: Record<string, unknown> | null;
	/** What it returned, in summary. Never the rows themselves. */
	result?: string;
	rows?: number | null;
	ms?: number | null;
	/** Required on a refusal: which rule, and what it says. */
	rule?: string | null;
	rule_note?: string;
	withheld?: boolean;
	withheld_reason?: string;
}

export async function appendSteps(
	tx: Tx,
	runId: number,
	steps: StepInput[],
	request: string
): Promise<{ added: number; steps: number }> {
	const [row] = await tx.sql<WriteRow<{ added: number; steps: number }>>`
		select nl.append_agent_steps(${runId}, ${JSON.stringify(steps)}::jsonb, ${request}) as result`;
	return { added: Number(row.result.added), steps: Number(row.result.steps) };
}

export interface FinishRun {
	runId: number;
	outcome: Exclude<RunOutcome, 'running'>;
	decision: string;
	durationMs: number;
	inputTokens: number;
	outputTokens: number;
	producedKind: string | null;
	producedId: number | null;
	produced: Record<string, unknown>;
	/** Only on a replay. */
	diff: ReplayDiffKind | null;
	error: string | null;
	/** When the work really ended, for a trail written after the fact. */
	finishedAt?: string | null;
}

export async function finishRun(tx: Tx, input: FinishRun, request: string): Promise<void> {
	await tx.sql`
		select nl.finish_agent_run(
			${input.runId}, ${input.outcome}, ${input.decision}, ${input.durationMs},
			${input.inputTokens}, ${input.outputTokens},
			${input.producedKind}, ${input.producedId}, ${JSON.stringify(input.produced)}::jsonb,
			${input.diff}, ${input.error}, ${input.finishedAt ?? null}::timestamptz, ${request})`;
}

/** One hand-typed quote request, as a desk item with a person as its source. */
export async function recordDeskRequest(
	tx: Tx,
	input: {
		mailboxId: number;
		from: string;
		fromName: string;
		subject: string;
		body: string;
		bodyStripped: string;
	},
	request: string
): Promise<{ messageId: number; duplicate: boolean }> {
	const [row] = await tx.sql<WriteRow<{ message_id: number; duplicate: boolean }>>`
		select nl.record_desk_request(
			${input.mailboxId}, ${input.from}, ${input.fromName}, ${input.subject},
			${input.body}, ${input.bodyStripped}, ${request}) as result`;
	return { messageId: Number(row.result.message_id), duplicate: row.result.duplicate === true };
}
