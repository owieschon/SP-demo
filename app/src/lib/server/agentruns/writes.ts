// The one write the run trail makes.
//
// It calls nl.record_agent_trail (migration 0042), which claims the request
// id, checks who is asking, checks every step, drops the detail of a withheld
// one itself and writes the audit row. Nothing here decides anything; it
// exists so nothing above it writes SQL by hand or forgets a request id.
import type { Disclosure, FactKind } from '$lib/desk/types';
import type { StepKind, WokeBy } from '$lib/agentruns/types';
import type { Tx } from '../db/types.ts';

interface WriteRow<T> {
	result: T;
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
	/**
	 * Which kinds of fact this step's detail rests on. The write-time check
	 * uses the facts themselves; this is what the READ-time check uses, when
	 * somebody whose disclosure grant differs from the mailbox's opens the
	 * trail. Empty means the detail rests on no business fact, so there is
	 * nothing any level could withhold.
	 */
	fact_kinds?: FactKind[];
	withheld?: boolean;
	withheld_reason?: string;
}

export interface TrailInput {
	/** The harness's key for this run: '<agent>:<source_id>' (migration 0028). */
	runKey: string;
	agent: string;
	wokeBy: WokeBy;
	wokeNote: string;
	entity: string | null;
	entityId: number | null;
	reader: Disclosure;
	subjectNo: string | null;
	/** Only when the context engine is in this database. */
	bundleVersion: string | null;
	decision: string;
	/** What a replay would need to make the same decisions again. */
	inputs: unknown;
	steps: StepInput[];
}

export async function recordTrail(
	tx: Tx,
	input: TrailInput,
	request: string
): Promise<{ runKey: string; recorded: boolean; steps: number; refusals: number }> {
	const [row] = await tx.sql<WriteRow<{ run_key: string; recorded: boolean; steps?: number; refusals?: number }>>`
		select nl.record_agent_trail(
			${input.runKey}, ${input.agent}, ${input.wokeBy}, ${input.wokeNote},
			${input.entity}, ${input.entityId}, ${input.reader}, ${input.subjectNo},
			${input.bundleVersion}, ${input.decision},
			${JSON.stringify(input.inputs ?? {})}::jsonb,
			${JSON.stringify(input.steps)}::jsonb, ${request}) as result`;
	return {
		runKey: String(row.result.run_key),
		recorded: row.result.recorded === true,
		steps: Number(row.result.steps ?? 0),
		refusals: Number(row.result.refusals ?? 0)
	};
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
