// Where a number comes from: a policy a person can change, or the code.
//
// The harness has two kinds of number in it.
//
//   POLICY   a person should be able to change it without a deploy: the
//            autonomy level, the undo window, the sample rate, the promotion
//            thresholds, the pause. Those live in the database already, in
//            nl.agent_autonomy and nl.agent_promotion_rules, which is why this
//            file is short.
//   CODE     changing it changes what the system IS, not how far it is
//            trusted: the disclosure policy's allowed fact kinds, the risk
//            class of a tool, "a proposal never approves itself", the request
//            id, the row version. Those are not policies and must not become
//            editable values.
//
// A policy engine with typed, scoped, effective-dated values is being built on
// another branch. This file is how the harness will read from it without
// depending on it existing yet: it feature-detects the resolver, and falls
// back to the harness's own tables, which are the values today.
//
// The contract this asks of that engine, so the two can meet:
//
//   nl.policy_number(p_key text, p_scope text) returns numeric
//     the value in force today, or null when the key is unknown
//
// Keys the harness would read, all numbers:
//
//   agent.undo_window_minutes         scope '<agent>:<work_kind>'
//   agent.sample_rate                 scope '<agent>:<work_kind>'
//   agent.promotion.min_reviewed      scope '<from_level>:<to_level>'
//   agent.promotion.min_approval_rate scope '<from_level>:<to_level>'
//   agent.promotion.max_edit_rate     scope '<from_level>:<to_level>'
//   agent.demotion.min_reviewed       scope 'all'
//   agent.demotion.min_pass_rate      scope 'all'
import type { Db, Tx } from '../db/types.ts';

export interface PolicySource {
	/** True when a policy engine answered, false when these are the harness's own values. */
	engine: boolean;
	name: string;
}

/** Is there a policy resolver in this database? Feature-detected, once per call. */
export async function policyEngine(tx: Tx): Promise<PolicySource> {
	const [row] = await tx.sql<{ found: string | null }>`
		select to_regprocedure('nl.policy_number(text, text)')::text as found`;
	return row?.found
		? { engine: true, name: 'nl.policy_number' }
		: { engine: false, name: 'the harness\'s own tables' };
}

/**
 * One number, from the policy engine when it is there and from the fallback
 * when it is not. The fallback is not a default in the usual sense: it is the
 * value the harness holds in its own table, which is authoritative until the
 * engine exists.
 */
export async function policyNumber(
	tx: Tx,
	key: string,
	scope: string,
	fallback: number
): Promise<{ value: number; fromEngine: boolean }> {
	const source = await policyEngine(tx);
	if (!source.engine) return { value: fallback, fromEngine: false };
	const [row] = await tx.sql<{ value: number | null }>`
		select nl.policy_number(${key}, ${scope}) as value`;
	return row?.value === null || row?.value === undefined
		? { value: fallback, fromEngine: false }
		: { value: Number(row.value), fromEngine: true };
}

/** What the page says about where the numbers come from. */
export async function policyStatus(db: Db, userId: number): Promise<PolicySource> {
	return db.asUser(userId, (tx) => policyEngine(tx));
}

/**
 * Which of the harness's numbers are policies and which are code. The page
 * shows this, and docs/agent-harness.md says the same thing in prose. Keeping
 * it as data means the list cannot quietly stop matching the code.
 */
export const POLICY_MAP: { name: string; kind: 'policy' | 'code'; where: string; why: string }[] = [
	{
		name: 'Autonomy level per agent and kind of work',
		kind: 'policy',
		where: 'nl.agent_autonomy.level',
		why: 'How far an agent is trusted is exactly the decision a person should keep.'
	},
	{
		name: 'Undo window',
		kind: 'policy',
		where: 'nl.agent_autonomy.undo_window_minutes',
		why: 'How long a person wants to be able to change their mind is theirs.'
	},
	{
		name: 'Review sample rate',
		kind: 'policy',
		where: 'nl.agent_autonomy.sample_rate',
		why: 'How much checking is enough is a judgement about risk, not a fact.'
	},
	{
		name: 'Promotion thresholds',
		kind: 'policy',
		where: 'nl.agent_promotion_rules',
		why: 'The bar for trusting an agent more should move without a deploy.'
	},
	{
		name: 'Pause, per agent and globally',
		kind: 'policy',
		where: 'nl.agent_pauses',
		why: 'The brake has to work in seconds and belongs to whoever is watching.'
	},
	{
		name: 'Daily caps on model calls and desk runs',
		kind: 'policy',
		where: 'nl.assistant_counters, nl.mail_daily_cap(), ASSISTANT_DAILY_* in the environment',
		why: 'A spend limit is a policy. Today half of it is a function and half is an environment variable, which is the gap.'
	},
	{
		name: 'The disclosure policy: which fact kinds a customer may hear',
		kind: 'code',
		where: 'app/src/lib/server/desk/policy.ts',
		why: 'It is not a threshold. Making "our margin" an editable value is how a leak happens.'
	},
	{
		name: 'The risk class of every tool',
		kind: 'code',
		where: 'app/src/lib/server/assistant/tools.ts',
		why: 'A tool that writes must not become readable-as-safe by editing a row.'
	},
	{
		name: 'A proposal never approves itself; approval reads the stored option',
		kind: 'code',
		where: 'app/src/lib/server/assistant/proposals.ts',
		why: 'This is the shape of the system. There is no setting that should turn it off.'
	},
	{
		name: 'Request ids, row versions and audit rows on every write',
		kind: 'code',
		where: 'the SQL write functions',
		why: 'Correctness, not trust. A policy that switched these off would only ever be a bug.'
	}
];
