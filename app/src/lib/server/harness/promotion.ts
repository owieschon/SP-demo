// Raising or lowering an agent's autonomy: the one deliberate write on the
// trust page.
//
// There is no agent-shaped write here, and that is the point. An agent is a
// principal in nl.users, its autonomy level is a row in nl.authority_grants,
// and raising it is nl.grant_authority with a bigger number, which is the
// same call and the same table and the same audit row as raising a person's
// approval ceiling (migration 0031, docs/roles.md). So this file resolves
// which principal the agent is and then calls the roles model's own write.
//
// What that buys, for free, because the database already does it:
//
//   * the gate. nl.grant_authority calls nl.require_role_authority(), so a
//     person without change_policy is refused with NL403 whatever the page
//     drew;
//   * the audit row, in nl.audit_log, with the actor, the request id and the
//     before and after;
//   * effective dating. A raise can start tomorrow, today's answer is left
//     alone, and the old figure stays on the record rather than being edited
//     away;
//   * the shape checks. 0 to 3, never negative, and refused outright if the
//     target is a person rather than an agent.
//
// Sampling is automatic and demotion on a bad sample is automatic
// (nl.demote_agents_on_sample). Promotion is not. It is a person putting
// their name on a number, which is why it is a form and not a job.
import { z } from 'zod';
import type { Db } from '../db/types.ts';
import { grantAuthority, revokeAuthority, type RoleWriteResult } from '../roles/writes.ts';
import { AGENTS, type AgentId } from './scope.ts';
import { AGENT_PRINCIPAL_EMAIL } from './trust.ts';
import { LEVEL_ORDER, type Level } from './types.ts';

/**
 * The autonomy grant's number, 0 to 3, against the harness's four named
 * levels. Two vocabularies for one ladder is not ideal and it is not mine to
 * fix on the way past: the grant is 0-3 because a ceiling is a number like
 * every other ceiling in nl.authority_grants, and the harness's level is a
 * name because a plan branches on it. These two functions are the only place
 * the two meet, so there is one conversion and not five.
 */
export function levelToGrant(level: Level): number {
	return LEVEL_ORDER[level] - 1;
}

export function grantToLevel(grant: number | null): Level | null {
	if (grant === null) return null;
	const found = (Object.entries(LEVEL_ORDER) as [Level, number][]).find(
		([, order]) => order - 1 === grant
	);
	return found?.[0] ?? null;
}

export const autonomyGrantInput = z.object({
	agent: z.enum(AGENTS as unknown as [AgentId, ...AgentId[]]),
	/** 0 watches only, 1 drafts, 2 sends routine replies, 3 sends everything. */
	level: z.coerce.number().int().min(0).max(3),
	/** Blank means today. A date in future is the point of the field. */
	startsOn: z
		.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
		.transform((v) => (v === '' ? null : v))
		.nullable()
		.default(null),
	/** Why. It goes on the grant and into the audit row. */
	note: z.string().trim().max(300).default(''),
	requestId: z.string().min(8).max(100)
});
export type AutonomyGrant = z.infer<typeof autonomyGrantInput>;

export const autonomyRevokeInput = z.object({
	agent: z.enum(AGENTS as unknown as [AgentId, ...AgentId[]]),
	requestId: z.string().min(8).max(100)
});
export type AutonomyRevoke = z.infer<typeof autonomyRevokeInput>;

/** Thrown when an agent key has no row in nl.users, so there is nothing to grant. */
export class NotAPrincipal extends Error {
	constructor(agent: string) {
		super(
			`${agent} is not a principal in nl.users, so its autonomy is not a grant yet. Only the two desk agents are.`
		);
		this.name = 'NotAPrincipal';
	}
}

/**
 * Which row in nl.users an agent is. Resolved here rather than taken from the
 * form, so a posted id cannot aim the write at somebody else; the database
 * would refuse a person anyway, and a check the page makes as well is one
 * fewer surprise.
 */
export async function principalFor(db: Db, actorId: number, agent: AgentId): Promise<number> {
	const email = AGENT_PRINCIPAL_EMAIL[agent];
	if (!email) throw new NotAPrincipal(agent);
	const [row] = await db.asUser(actorId, (tx) =>
		tx.sql<{ id: number; kind: string }>`
			select id, kind from nl.users where email = ${email} limit 1`
	);
	if (!row || row.kind !== 'agent') throw new NotAPrincipal(agent);
	return Number(row.id);
}

/** Raise or lower an agent's granted autonomy. Gated and audited by the database. */
export async function setGrantedAutonomy(
	db: Db,
	actorId: number,
	input: AutonomyGrant
): Promise<RoleWriteResult> {
	const userId = await principalFor(db, actorId, input.agent);
	return grantAuthority(db, actorId, {
		userId,
		authority: 'agent_autonomy',
		limit: input.level,
		startsOn: input.startsOn,
		endsOn: null,
		note: input.note,
		requestId: input.requestId
	});
}

/**
 * Take the grant away from today, not from tomorrow. An autonomy grant is
 * withdrawn because the agent should not be using it now, which is exactly
 * what nl.revoke_authority already means.
 */
export async function revokeGrantedAutonomy(
	db: Db,
	actorId: number,
	input: AutonomyRevoke
): Promise<RoleWriteResult> {
	const userId = await principalFor(db, actorId, input.agent);
	return revokeAuthority(db, actorId, {
		userId,
		authority: 'agent_autonomy',
		requestId: input.requestId
	});
}

/** May the signed-in person change any of this? The database decides; this asks it. */
export async function mayPromote(db: Db, actorId: number): Promise<boolean> {
	const [row] = await db.asUser(actorId, (tx) =>
		tx.sql<{ may: boolean }>`select nl.may_change_roles() as may`
	);
	return row?.may === true;
}
