// Changing what somebody is responsible for.
//
// Four writes, each a thin wrapper over a database function that claims the
// request id, checks the caller's own authority, and writes an audit row. The
// checks are not repeated here: a check in TypeScript that the database does
// not also make is a check an agent, the MCP server or a stray query can walk
// past.
//
// The one thing worth saying twice: raising an agent's autonomy and raising a
// person's approval limit are the SAME call, grantAuthority. There is no
// agent-shaped variant, and a test asserts it.
import { z } from 'zod';
import type { Db } from '../db/types.ts';
import { guarded } from '../errors.ts';
import {
	AUTHORITIES,
	PRESETS,
	SCOPE_DIMENSIONS,
	type Authority,
	type Preset,
	type ScopeDimension
} from '$lib/roles/types';

/** What a write hands back: the database function's own result object. */
export type RoleWriteResult = Record<string, unknown> & { replayed?: boolean };

const requestId = z.string().min(8).max(100);

export const setPresetInput = z.object({
	userId: z.coerce.number().int().positive(),
	preset: z.enum(PRESETS as [Preset, ...Preset[]]),
	responsibility: z.string().max(200).default(''),
	requestId
});

export const setScopeInput = z.object({
	userId: z.coerce.number().int().positive(),
	dimension: z.enum(SCOPE_DIMENSIONS as [ScopeDimension, ...ScopeDimension[]]),
	/**
	 * The "everything in this dimension" checkbox. A browser sends a ticked
	 * checkbox as "on" and an unticked one as nothing at all, so this reads
	 * the presence of the field rather than coercing whatever arrived.
	 */
	all: z
		.string()
		.optional()
		.transform((v) => v === 'on' || v === 'true'),
	values: z.string().default(''),
	requestId
});

export const grantAuthorityInput = z.object({
	userId: z.coerce.number().int().positive(),
	authority: z.enum(AUTHORITIES as [Authority, ...Authority[]]),
	/** Empty means "no ceiling" on an amount authority, and nothing at all on a yes or no. */
	limit: z
		.union([z.literal(''), z.coerce.number().nonnegative()])
		.transform((v) => (v === '' ? null : v))
		.nullable()
		.default(null),
	/** Blank means today. A date in future is the point of the field. */
	startsOn: z
		.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
		.transform((v) => (v === '' ? null : v))
		.nullable()
		.default(null),
	endsOn: z
		.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
		.transform((v) => (v === '' ? null : v))
		.nullable()
		.default(null),
	note: z.string().max(300).default(''),
	requestId
});

export const revokeAuthorityInput = z.object({
	userId: z.coerce.number().int().positive(),
	authority: z.enum(AUTHORITIES as [Authority, ...Authority[]]),
	requestId
});

export const setDisclosureInput = z.object({
	userId: z.coerce.number().int().positive(),
	level: z.enum(['customer', 'vendor', 'internal']),
	note: z.string().max(300).default(''),
	requestId
});

export type SetPreset = z.infer<typeof setPresetInput>;
export type SetScope = z.infer<typeof setScopeInput>;
export type GrantAuthority = z.infer<typeof grantAuthorityInput>;
export type RevokeAuthority = z.infer<typeof revokeAuthorityInput>;
export type SetDisclosure = z.infer<typeof setDisclosureInput>;

/** A textarea of values, one per line or comma separated, into an array. */
export function splitValues(text: string): string[] {
	return [...new Set(text.split(/[\n,]/).map((v) => v.trim()).filter(Boolean))];
}

async function one(db: Db, actorId: number, sql: string, params: (string | number | boolean | null)[]) {
	const [row] = await guarded(() =>
		db.asUser(actorId, (tx) => tx.query<{ result: RoleWriteResult }>(sql, params))
	);
	return row.result;
}

export function setPreset(db: Db, actorId: number, input: SetPreset): Promise<RoleWriteResult> {
	return one(db, actorId, 'select nl.set_user_preset($1, $2, $3, $4, $5) as result', [
		input.userId,
		input.preset,
		input.responsibility,
		input.requestId,
		'ui'
	]);
}

export function setScope(db: Db, actorId: number, input: SetScope): Promise<RoleWriteResult> {
	// The values go over as a JSON array of strings and are turned into a
	// text[] in SQL. Every other write in this project sends structured input
	// the same way (see Param in db/types.ts), and it keeps the list out of
	// the statement text.
	const values = splitValues(input.values);
	return one(
		db,
		actorId,
		`select nl.set_user_scope(
			$1, $2, $3,
			(select coalesce(array_agg(v), array[]::text[]) from jsonb_array_elements_text($4::jsonb) as v),
			$5, $6) as result`,
		[input.userId, input.dimension, input.all, JSON.stringify(values), input.requestId, 'ui']
	);
}

export function grantAuthority(
	db: Db,
	actorId: number,
	input: GrantAuthority
): Promise<RoleWriteResult> {
	return one(db, actorId, 'select nl.grant_authority($1, $2, $3, $4, $5, $6, $7, $8) as result', [
		input.userId,
		input.authority,
		input.limit,
		input.startsOn,
		input.endsOn,
		input.note,
		input.requestId,
		'ui'
	]);
}

export function revokeAuthority(
	db: Db,
	actorId: number,
	input: RevokeAuthority
): Promise<RoleWriteResult> {
	return one(db, actorId, 'select nl.revoke_authority($1, $2, $3, $4) as result', [
		input.userId,
		input.authority,
		input.requestId,
		'ui'
	]);
}

export function setDisclosure(
	db: Db,
	actorId: number,
	input: SetDisclosure
): Promise<RoleWriteResult> {
	return one(db, actorId, 'select nl.set_disclosure($1, $2, $3, $4, $5) as result', [
		input.userId,
		input.level,
		input.note,
		input.requestId,
		'ui'
	]);
}
