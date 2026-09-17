// MCP tokens: minting one, revoking one, and checking the one a request sent.
//
// A token is a bearer secret, so the rules are the usual ones:
//   * it is 32 random bytes, shown once, and never stored. What is stored is
//     its SHA-256 (migration 0024);
//   * the presented token is hashed before anything is compared, and the
//     comparison is constant time, so neither the database nor the response
//     time can be used to feel out a token character by character;
//   * a wrong token, a made-up token and a revoked token all come back as the
//     same 401, so the answer says nothing about which tokens exist.
//
// A token acts as one named person. Everything it does afterwards runs as that
// person through db.asUser, under the same row-level security as their own
// session, so an outside agent can never see more than the person could.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { guarded } from '../errors.ts';
import type { Db } from '../db/types.ts';

export type McpScope = 'read' | 'propose';

export const SCOPES: McpScope[] = ['read', 'propose'];

/** So a leaked string is recognisable as one of ours in a log or a git diff. */
export const TOKEN_PREFIX = 'nlmcp_';

/** A new secret: the prefix and 32 random bytes as base64url. */
export function newToken(): string {
	return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** The 64 hex characters that go in the database. */
export function hashToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

function parseScopes(commaSeparated: string): McpScope[] {
	return commaSeparated
		.split(',')
		.map((part) => part.trim())
		.filter((part): part is McpScope => part === 'read' || part === 'propose');
}

/** Who a valid token is, once it has been checked. */
export interface TokenIdentity {
	tokenId: number;
	label: string;
	userId: number;
	scopes: McpScope[];
}

export type AuthResult =
	| { ok: true; token: TokenIdentity }
	| { ok: false; message: string };

/**
 * The Authorization header, or null. Only "Bearer <token>" counts, and the
 * scheme is compared without case so "bearer" works too.
 */
export function readBearer(authorization: string | null): string | null {
	if (!authorization) return null;
	const match = /^bearer\s+(\S+)$/i.exec(authorization.trim());
	return match ? match[1] : null;
}

interface AuthRow {
	result: {
		token_id: number;
		label: string;
		user_id: number;
		scopes: string;
		token_sha256: string;
		revoked: boolean;
		user_active: boolean;
	} | null;
}

/**
 * Check the token a request sent. Runs as nobody (db.asVisitor), because an
 * MCP request carries no session cookie: the token is the only thing that
 * says who is calling.
 */
export async function authenticate(db: Db, authorization: string | null): Promise<AuthResult> {
	const refused = { ok: false as const, message: 'That token is not valid. Mint one at /settings/mcp.' };

	const presented = readBearer(authorization);
	if (!presented) {
		return {
			ok: false,
			message: 'This endpoint needs a token: send "Authorization: Bearer <token>". Mint one at /settings/mcp.'
		};
	}

	const wanted = hashToken(presented);
	const [row] = await db.asVisitor((tx) =>
		tx.sql<AuthRow>`select nl.authenticate_mcp_token(${wanted}) as result`
	);
	const found = row?.result ?? null;
	if (!found) return refused;

	// The lookup above already matched on the hash. This is the comparison
	// that decides, and it is constant time: nothing about how many characters
	// were right can be read off the clock.
	const sent = Buffer.from(wanted, 'utf8');
	const stored = Buffer.from(found.token_sha256, 'utf8');
	if (sent.length !== stored.length || !timingSafeEqual(sent, stored)) return refused;

	// A revoked token, or one belonging to someone who has left, is refused
	// with the same words as a token that never existed.
	if (found.revoked || !found.user_active) return refused;

	const scopes = parseScopes(found.scopes);
	if (scopes.length === 0) return refused;

	return {
		ok: true,
		token: { tokenId: found.token_id, label: found.label, userId: found.user_id, scopes }
	};
}

export interface MintedToken {
	tokenId: number;
	label: string;
	actsAs: number;
	scopes: McpScope[];
	/** The secret, this once. It is not stored and cannot be read back. */
	secret: string;
}

/**
 * Mint a token. The secret is generated here, hashed here, and only the hash
 * is sent to the database, so the plain text never reaches Postgres, its logs
 * or a backup.
 */
export async function mintToken(
	db: Db,
	adminId: number,
	input: { label: string; actsAs: number; scopes: McpScope[]; requestId: string }
): Promise<MintedToken> {
	const secret = newToken();
	const scopes = SCOPES.filter((scope) => input.scopes.includes(scope));
	const [row] = await guarded(() =>
		db.asUser(adminId, (tx) =>
			tx.sql<{ result: { token_id: number; label: string; acts_as: number; scopes: string } }>`
				select nl.mint_mcp_token(${input.label}, ${input.actsAs},
				                         string_to_array(${scopes.join(',')}, ',')::text[],
				                         ${hashToken(secret)}, ${input.requestId}) as result`
		)
	);
	return {
		tokenId: row.result.token_id,
		label: row.result.label,
		actsAs: row.result.acts_as,
		scopes: parseScopes(row.result.scopes),
		secret
	};
}

export async function revokeToken(
	db: Db,
	adminId: number,
	input: { tokenId: number; requestId: string }
): Promise<{ tokenId: number; label: string }> {
	const [row] = await guarded(() =>
		db.asUser(adminId, (tx) =>
			tx.sql<{ result: { token_id: number; label: string } }>`
				select nl.revoke_mcp_token(${input.tokenId}, ${input.requestId}) as result`
		)
	);
	return { tokenId: row.result.token_id, label: row.result.label };
}

export interface TokenListItem {
	id: number;
	label: string;
	scopes: McpScope[];
	actsAsId: number;
	actsAsName: string;
	createdByName: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	calls: number;
	callsToday: number;
}

/** Every token, newest first, with how much it has been used. */
export async function listTokens(db: Db, userId: number): Promise<TokenListItem[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			id: number;
			label: string;
			scopes: string;
			acts_as_id: number;
			acts_as_name: string;
			created_by_name: string;
			created_at: Date;
			last_used_at: Date | null;
			revoked_at: Date | null;
			calls: number;
			calls_today: number;
		}>`
			select t.id, t.label, array_to_string(t.scopes, ',') as scopes,
			       t.user_id as acts_as_id, u.full_name as acts_as_name,
			       b.full_name as created_by_name,
			       t.created_at, t.last_used_at, t.revoked_at,
			       (select count(*) from nl.mcp_calls c where c.token_id = t.id)::int as calls,
			       coalesce((select n.calls from nl.mcp_counters n
			                 where n.token_id = t.id and n.on_day = nl.today()), 0)::int as calls_today
			from nl.mcp_tokens t
			join nl.users u on u.id = t.user_id
			join nl.users b on b.id = t.created_by
			order by t.revoked_at nulls first, t.created_at desc, t.id desc`
	);
	return rows.map((row) => ({
		id: row.id,
		label: row.label,
		scopes: parseScopes(row.scopes),
		actsAsId: row.acts_as_id,
		actsAsName: row.acts_as_name,
		createdByName: row.created_by_name,
		createdAt: row.created_at.toISOString(),
		lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
		revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
		calls: row.calls,
		callsToday: row.calls_today
	}));
}

/**
 * Claim one call against this token's day. Raises a 429 AppError when the day
 * is used up, before the tool runs.
 */
export async function claimCall(
	db: Db,
	token: TokenIdentity,
	limit: number
): Promise<{ used: number; limit: number }> {
	const [row] = await guarded(() =>
		db.asUser(token.userId, (tx) =>
			tx.sql<{ result: { used: number; limit: number } }>`
				select nl.claim_mcp_call(${token.tokenId}, ${limit}) as result`
		)
	);
	return row.result;
}

export type CallOutcome = 'ok' | 'refused' | 'capped' | 'failed';

export interface CallRecord {
	method: string;
	tool?: string;
	ms: number;
	rows?: number | null;
	outcome: CallOutcome;
	note?: string;
}

/** Record one call. Never throws: a missing log row must not fail an answer. */
export async function logCall(db: Db, token: TokenIdentity, entry: CallRecord): Promise<void> {
	try {
		await db.asUser(token.userId, (tx) =>
			tx.sql`select nl.log_mcp_call(${token.tokenId}, ${entry.method}, ${entry.tool ?? ''},
			                              ${Math.round(entry.ms)}, ${entry.rows ?? null},
			                              ${entry.outcome}, ${entry.note ?? ''})`
		);
	} catch {
		// Logging a call must never replace the answer to it.
	}
}
