// Setting and ending a policy.
//
// Two checks matter and neither of them is here: who may change a policy is
// decided by nl.set_policy() against the type's own edit_role, and whether a
// value fits its type is decided by the trigger on nl.policies. This file
// checks the shape of the form, turns the typed text into JSON, and hands the
// refusal back with the sentence the database wrote.
import { z } from 'zod';
import { guarded } from '../errors.ts';
import type { Db } from '../db/types.ts';

const dateText = z
	.string()
	.trim()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'A date reads as 2026-09-17.');

export const setPolicyInput = z.object({
	policyId: z.coerce.number().int().positive().nullable().optional(),
	policyType: z.string().trim().min(3).max(80),
	scopeKind: z.enum([
		'global',
		'customer_segment',
		'customer',
		'vendor',
		'item',
		'item_family',
		'location',
		'mailbox',
		'order',
		'order_line'
	]),
	scopeId: z.string().trim().max(60).default(''),
	/** Already JSON: the page turned the typed text into it (lib/policy/value.ts). */
	value: z.string().min(1).max(4000),
	effectiveFrom: dateText,
	effectiveTo: dateText.nullable().optional(),
	priority: z.coerce.number().int().min(-100).max(100).default(0),
	note: z.string().trim().max(300).default(''),
	expectedUpdatedAt: z.string().trim().min(1).nullable().optional(),
	requestId: z.string().trim().min(8).max(100)
});

export type SetPolicyInput = z.infer<typeof setPolicyInput>;

export const endPolicyInput = z.object({
	policyId: z.coerce.number().int().positive(),
	effectiveTo: dateText.nullable().optional(),
	expectedUpdatedAt: z.string().trim().min(1),
	requestId: z.string().trim().min(8).max(100)
});

export type EndPolicyInput = z.infer<typeof endPolicyInput>;

export interface PolicyWriteResult {
	policyId: number;
	updatedAt: string;
	replayed: boolean;
}

/** Create a policy, or change one that is already there. */
export async function setPolicy(
	db: Db,
	userId: number,
	input: SetPolicyInput
): Promise<PolicyWriteResult> {
	return guarded(async () => {
		const [row] = await db.asUser(userId, (tx) =>
			tx.query<{ result: Record<string, unknown> }>(
				`select nl.set_policy($1::bigint, $2, $3, $4, $5::jsonb, $6::date, $7::date, $8::int, $9, $10::timestamptz, $11) as result`,
				[
					input.policyId ?? null,
					input.policyType,
					input.scopeKind,
					input.scopeKind === 'global' ? '' : input.scopeId,
					input.value,
					input.effectiveFrom,
					input.effectiveTo ?? null,
					input.priority,
					input.note,
					input.expectedUpdatedAt ?? null,
					input.requestId
				]
			)
		);
		const result = row.result;
		return {
			policyId: Number(result.policy_id),
			updatedAt: String(result.updated_at),
			replayed: result.replayed === true
		};
	});
}

/** Stop a policy applying, keeping what it used to say. */
export async function endPolicy(
	db: Db,
	userId: number,
	input: EndPolicyInput
): Promise<PolicyWriteResult & { effectiveTo: string }> {
	return guarded(async () => {
		const [row] = await db.asUser(userId, (tx) =>
			tx.query<{ result: Record<string, unknown> }>(
				`select nl.end_policy($1::bigint, $2::date, $3::timestamptz, $4) as result`,
				[input.policyId, input.effectiveTo ?? null, input.expectedUpdatedAt, input.requestId]
			)
		);
		const result = row.result;
		return {
			policyId: Number(result.policy_id),
			effectiveTo: String(result.effective_to),
			updatedAt: String(result.updated_at),
			replayed: result.replayed === true
		};
	});
}
