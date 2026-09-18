/*
  The one-click connect flow against a real database (PGlite).

  What these hold: a provider button mints exactly one token and labels it
  with the provider it was made for; a non-admin cannot mint and is told why;
  the block that comes back has the endpoint and the token in it, with the
  token appearing exactly once; and the secret cannot be read back out of the
  database afterwards, from the token table, the audit log or the call log.

  Today is pinned to 2026-09-17, the same day the rest of the MCP tests use.
*/
import { beforeAll, describe, expect, it } from 'vitest';
import { connectProvider } from './connect.ts';
import { listTokens } from './tokens.ts';
import { SERVER_NAME } from './server.ts';
import { toAppError } from '../errors.ts';
import { createTestDb } from '../db/pglite.ts';
import { MCP_PROVIDERS, MCP_SERVER_KEY } from '$lib/mcp/providers';
import type { Db } from '../db/types.ts';

const TODAY = '2026-09-17';
const ADMIN = { id: 1, fullName: 'Elena Brooks' };
const NOT_ADMIN = { id: 2, fullName: 'Dana Whitlock' };
const ENDPOINT = 'https://northline.example/api/mcp';

let db: Db;
let nextId = 1;

/** A fresh request id per attempt, so no test replays another's answer. */
function requestId(): string {
	return `connect-test-${nextId++}-0000000000`;
}

async function tokenCount(): Promise<number> {
	const [row] = await db.asSystem((tx) =>
		tx.sql<{ n: number }>`select count(*)::int as n from nl.mcp_tokens`
	);
	return row.n;
}

beforeAll(async () => {
	db = await createTestDb({ size: 'small', today: TODAY });
}, 180_000);

describe('pressing a provider button', () => {
	it('mints exactly one token, labelled with the provider it was made for', async () => {
		const before = await tokenCount();
		const connected = await connectProvider(db, ADMIN, {
			provider: 'cursor',
			endpoint: ENDPOINT,
			requestId: requestId()
		});

		expect(await tokenCount()).toBe(before + 1);
		// The label says where the token went, so the list below it can be read
		// without guessing which laptop is which.
		expect(connected.label).toBe('Cursor for Elena Brooks');
		expect(connected.provider).toBe('cursor');

		const listed = await listTokens(db, ADMIN.id);
		const mine = listed.filter((token) => token.id === connected.tokenId);
		expect(mine).toHaveLength(1);
		expect(mine[0].label).toBe('Cursor for Elena Brooks');
		// It acts as the person who pressed it, not as somebody chosen from a list.
		expect(mine[0].actsAsId).toBe(ADMIN.id);
	});

	it('mints once when the same click arrives twice, and says so rather than handing back a dead secret', async () => {
		/*
		  Every write in this app claims a request id, so a double submit is one
		  token. The wrinkle is that the second call still generates a secret
		  locally before the database replays the first answer, and that second
		  secret was never stored. Returning it would be a block that cannot
		  authenticate, so the second attempt is refused by name.
		*/
		const id = requestId();
		const before = await tokenCount();
		const first = await connectProvider(db, ADMIN, {
			provider: 'claude-code',
			endpoint: ENDPOINT,
			requestId: id
		});
		expect(first.tokenId).toBeGreaterThan(0);

		await expect(
			connectProvider(db, ADMIN, {
				provider: 'claude-code',
				endpoint: ENDPOINT,
				requestId: id
			})
		).rejects.toThrow(/already used once/);

		expect(await tokenCount()).toBe(before + 1);
	});

	it('mints with the smallest scope, so a connected agent reads and proposes nothing more', async () => {
		const connected = await connectProvider(db, ADMIN, {
			provider: 'codex',
			endpoint: ENDPOINT,
			requestId: requestId()
		});
		const listed = await listTokens(db, ADMIN.id);
		const mine = listed.find((token) => token.id === connected.tokenId);
		expect(mine?.scopes).toEqual(['read']);
	});

	it('refuses a provider it does not have, before anything is minted', async () => {
		const before = await tokenCount();
		await expect(
			connectProvider(db, ADMIN, {
				provider: 'notepad',
				endpoint: ENDPOINT,
				requestId: requestId()
			})
		).rejects.toThrow(/Claude Code, Cursor or Codex/);
		expect(await tokenCount()).toBe(before);
	});

	it('refuses a stale form, before anything is minted', async () => {
		const before = await tokenCount();
		await expect(
			connectProvider(db, ADMIN, { provider: 'cursor', endpoint: ENDPOINT, requestId: 'short' })
		).rejects.toThrow(/Reload the page/);
		expect(await tokenCount()).toBe(before);
	});
});

describe('somebody who is not an admin', () => {
	it('cannot mint, is told why, and leaves no token behind', async () => {
		const before = await tokenCount();
		let refusal: unknown = null;
		try {
			await connectProvider(db, NOT_ADMIN, {
				provider: 'cursor',
				endpoint: ENDPOINT,
				requestId: requestId()
			});
		} catch (error) {
			refusal = error;
		}

		const appError = toAppError(refusal);
		// 403 from nl.mint_mcp_token, not from a check on the page: a non-admin
		// who posts the form by hand is refused by the same rule that greys the
		// buttons out.
		expect(appError?.status).toBe(403);
		expect(appError?.message).toMatch(/admin/i);
		expect(await tokenCount()).toBe(before);
	});
});

describe('the block that comes back', () => {
	it('has this deployment\'s endpoint and the token in it, with the token exactly once', async () => {
		for (const provider of MCP_PROVIDERS) {
			const connected = await connectProvider(db, ADMIN, {
				provider: provider.id,
				endpoint: ENDPOINT,
				requestId: requestId()
			});

			// Nothing left to fill in by hand: the endpoint, the bearer header and
			// the server's key are all already there.
			expect(connected.config).toContain(ENDPOINT);
			expect(connected.config).toContain(MCP_SERVER_KEY);
			expect(connected.config).toContain(`Bearer ${connected.secret}`);
			expect(connected.config).not.toContain('<token>');

			// Exactly once. Twice would mean a person pastes a block with a stale
			// copy of the secret in half of it.
			const appearances = connected.config.split(connected.secret).length - 1;
			expect(appearances, `${provider.id} config`).toBe(1);
		}
	});

	it('carries an install link only for the provider that has one', async () => {
		const cursor = await connectProvider(db, ADMIN, {
			provider: 'cursor',
			endpoint: ENDPOINT,
			requestId: requestId()
		});
		const claude = await connectProvider(db, ADMIN, {
			provider: 'claude-code',
			endpoint: ENDPOINT,
			requestId: requestId()
		});

		expect(cursor.link).toMatch(/^cursor:\/\//);
		// Claude Code reads a CLI command, not a URL scheme. A link here would
		// be an invented consent screen.
		expect(claude.link).toBeNull();
	});

	it('names the same server key the MCP server answers to', () => {
		// The page cannot import the server module, so the two are held together
		// here instead of drifting into a config that connects to nothing.
		expect(MCP_SERVER_KEY).toBe(SERVER_NAME);
	});
});

describe('the secret', () => {
	it('cannot be read back anywhere after the click', async () => {
		const connected = await connectProvider(db, ADMIN, {
			provider: 'cursor',
			endpoint: ENDPOINT,
			requestId: requestId()
		});

		// The token table holds a hash and nothing else that could rebuild it.
		const [stored] = await db.asSystem((tx) =>
			tx.sql<{ token_sha256: string; row: string }>`
				select token_sha256, t::text as row from nl.mcp_tokens t where t.id = ${connected.tokenId}`
		);
		expect(stored.token_sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(stored.row).not.toContain(connected.secret);

		// Nor the audit row the mint wrote, nor the call log.
		const audit = await db.asSystem((tx) =>
			tx.sql<{ row: string }>`select a::text as row from nl.audit_log a where a.action = 'mint_mcp_token'`
		);
		for (const row of audit) expect(row.row).not.toContain(connected.secret);

		const calls = await db.asSystem((tx) =>
			tx.sql<{ row: string }>`select c::text as row from nl.mcp_calls c`
		);
		for (const row of calls) expect(row.row).not.toContain(connected.secret);

		// And the list the page renders has no field for it at all.
		const listed = await listTokens(db, ADMIN.id);
		const mine = listed.find((token) => token.id === connected.tokenId);
		expect(mine).toBeDefined();
		expect(JSON.stringify(mine)).not.toContain(connected.secret);
	});
});
