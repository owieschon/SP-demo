// MCP tokens: minting one, revoking one, moving its dial, and checking the one
// a request sent.
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
//
// THERE ARE NO SCOPES. There used to be two, 'read' and 'propose', and they
// were a second permission system: they decided the same question the autonomy
// level now answers, and because every gated tool was only ever exposed as
// propose_<name>, the scope that mattered was always the smaller one. Migration
// 0044 dropped the column. What a token may do is what its person may do; how
// far it goes without asking is its rung on the harness's autonomy ladder, and
// that rung is an ordinary authority grant on the token's own principal.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { guarded } from '../errors.ts';
import type { Level } from '../harness/types.ts';
import type { Db } from '../db/types.ts';

/** The rungs a token can stand on. 'shadow' is not one: see migration 0044. */
export const TOKEN_LEVELS: Level[] = ['suggest', 'auto_review', 'auto'];

export type TokenLevel = 'suggest' | 'auto_review' | 'auto';

export function isTokenLevel(value: unknown): value is TokenLevel {
	return value === 'suggest' || value === 'auto_review' || value === 'auto';
}

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

/**
 * How far this token may go without asking, as the ladder answers it. Read in
 * the same call that authenticates, so the endpoint never has to guess and
 * never has to remember.
 */
export interface TokenAutonomy {
	level: TokenLevel;
	/** Which kind of MCP work this rung is, for the harness's own records. */
	workKind: string;
	/** True only at auto_review and auto, and never while mcp is paused. */
	mayAct: boolean;
	/** Minutes a person has to take an action back. Nonzero at auto_review. */
	undoWindowMinutes: number;
	paused: boolean;
	pauseReason: string;
}

/** Who a valid token is, once it has been checked. */
export interface TokenIdentity {
	tokenId: number;
	label: string;
	/** The person it acts as. Every query and every write is theirs. */
	userId: number;
	/** The agent principal holding its autonomy grant, null on an old token. */
	principalId: number | null;
	autonomy: TokenAutonomy;
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

interface AutonomyJson {
	level: string;
	work_kind: string;
	may_act: boolean;
	undo_window_minutes: number;
	paused: boolean;
	pause?: { reason?: string };
}

interface AuthRow {
	result: {
		token_id: number;
		label: string;
		user_id: number;
		principal_id: number | null;
		autonomy: AutonomyJson | null;
		token_sha256: string;
		revoked: boolean;
		user_active: boolean;
	} | null;
}

/**
 * The database's answer turned into ours. An unreadable or missing answer
 * reads as the floor, which proposes and writes nothing: a token must never
 * gain autonomy because something failed to parse.
 */
function toAutonomy(json: AutonomyJson | null): TokenAutonomy {
	const level = isTokenLevel(json?.level) ? json.level : 'suggest';
	const paused = json?.paused === true;
	return {
		level,
		workKind: json?.work_kind ?? 'propose',
		mayAct: json?.may_act === true && !paused && level !== 'suggest',
		undoWindowMinutes: Number(json?.undo_window_minutes ?? 0),
		paused,
		pauseReason: json?.pause?.reason ?? ''
	};
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

	return {
		ok: true,
		token: {
			tokenId: found.token_id,
			label: found.label,
			userId: found.user_id,
			principalId: found.principal_id === null ? null : Number(found.principal_id),
			autonomy: toAutonomy(found.autonomy)
		}
	};
}

export interface MintedToken {
	tokenId: number;
	label: string;
	actsAs: number;
	principalId: number;
	level: TokenLevel;
	/** The secret, this once. It is not stored and cannot be read back. */
	secret: string;
}

/**
 * Mint a token. The secret is generated here, hashed here, and only the hash
 * is sent to the database, so the plain text never reaches Postgres, its logs
 * or a backup.
 *
 * It starts at 'suggest', which is exactly what every token did before there
 * was a dial at all: it proposes, and a person approves in the app.
 */
export async function mintToken(
	db: Db,
	adminId: number,
	input: { label: string; actsAs: number; requestId: string }
): Promise<MintedToken> {
	const secret = newToken();
	const [row] = await guarded(() =>
		db.asUser(adminId, (tx) =>
			tx.sql<{
				result: { token_id: number; label: string; acts_as: number; principal_id: number; level: string };
			}>`
				select nl.mint_mcp_token(${input.label}, ${input.actsAs},
				                         ${hashToken(secret)}, ${input.requestId}) as result`
		)
	);
	return {
		tokenId: row.result.token_id,
		label: row.result.label,
		actsAs: row.result.acts_as,
		principalId: Number(row.result.principal_id),
		level: isTokenLevel(row.result.level) ? row.result.level : 'suggest',
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

/**
 * Raise or lower a token's rung.
 *
 * This is nl.grant_authority, which is the same call, the same table and the
 * same audit row as raising a person's approval ceiling: a token is a
 * principal like any other. There is deliberately no MCP-shaped write, and the
 * gate (the change_policy authority) is the database's, not this function's.
 */
export async function setTokenLevel(
	db: Db,
	actorId: number,
	input: { tokenId: number; level: TokenLevel; startsOn?: string | null; note?: string; requestId: string }
): Promise<{ tokenId: number; level: TokenLevel; fromLevel: TokenLevel }> {
	const [row] = await guarded(() =>
		db.asUser(actorId, (tx) =>
			tx.sql<{ result: { token_id: number; level: string; from_level: string } }>`
				select nl.set_mcp_token_autonomy(${input.tokenId}, ${input.level},
				                                 ${input.startsOn ?? null}::date,
				                                 ${input.note ?? ''}, ${input.requestId}) as result`
		)
	);
	return {
		tokenId: Number(row.result.token_id),
		level: isTokenLevel(row.result.level) ? row.result.level : 'suggest',
		fromLevel: isTokenLevel(row.result.from_level) ? row.result.from_level : 'suggest'
	};
}

export interface TokenListItem {
	id: number;
	label: string;
	level: TokenLevel;
	actsAsId: number;
	actsAsName: string;
	principalId: number | null;
	createdByName: string;
	createdAt: string;
	lastUsedAt: string | null;
	revokedAt: string | null;
	calls: number;
	callsToday: number;
}

/** Every token, newest first, with its rung and how much it has been used. */
export async function listTokens(db: Db, userId: number): Promise<TokenListItem[]> {
	const rows = await db.asUser(userId, (tx) =>
		tx.sql<{
			id: number;
			label: string;
			level: string;
			acts_as_id: number;
			acts_as_name: string;
			principal_id: number | null;
			created_by_name: string;
			created_at: Date;
			last_used_at: Date | null;
			revoked_at: Date | null;
			calls: number;
			calls_today: number;
		}>`
			select t.id, t.label,
			       nl.mcp_token_level(t.id) as level,
			       t.user_id as acts_as_id, u.full_name as acts_as_name,
			       t.principal_id,
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
		level: isTokenLevel(row.level) ? row.level : 'suggest',
		actsAsId: row.acts_as_id,
		actsAsName: row.acts_as_name,
		principalId: row.principal_id === null ? null : Number(row.principal_id),
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
