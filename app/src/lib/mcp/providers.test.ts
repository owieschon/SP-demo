/*
  The provider registry: what each panel puts in front of a person, and the
  promise that a connect panel needs nothing off the network to draw itself.

  No database here. The one thing these functions do is put an endpoint and a
  secret into the shape one coding agent reads, which is arithmetic, so it is
  tested as arithmetic. The database side of the flow is in
  $lib/server/mcp/connect.test.ts.
*/
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	assembleConfig,
	connectLabel,
	CONNECT_SCOPES,
	deepLink,
	findProvider,
	isMcpProviderId,
	MCP_PROVIDERS,
	MCP_SERVER_KEY,
	PLACEHOLDER_SECRET
} from './providers';

const ENDPOINT = 'https://northline.example/api/mcp';
const SECRET = 'nlmcp_wZK3sample_not_a_real_token_00';

describe('the provider list', () => {
	it('offers the three agents, each with somewhere to paste', () => {
		expect(MCP_PROVIDERS.map((provider) => provider.id)).toEqual(['claude-code', 'cursor', 'codex']);
		for (const provider of MCP_PROVIDERS) {
			expect(provider.name.length, provider.id).toBeGreaterThan(0);
			// Every panel says where its block goes. A finished block with no
			// destination is still a puzzle.
			expect(provider.pasteWhere, provider.id).toMatch(/\.$/);
		}
	});

	it('knows its own ids and refuses anything else', () => {
		expect(isMcpProviderId('cursor')).toBe(true);
		expect(isMcpProviderId('notepad')).toBe(false);
		expect(isMcpProviderId(null)).toBe(false);
		expect(findProvider('codex')?.name).toBe('Codex');
		expect(findProvider('notepad')).toBeNull();
	});

	it('connects with the smallest scope', () => {
		// The lowest setting there is today. The mcp-autonomy branch replaces
		// scopes with a level, and this is the line that becomes that level.
		expect([...CONNECT_SCOPES]).toEqual(['read']);
	});
});

describe('the assembled block', () => {
	it('is a one line command for Claude Code', () => {
		const block = assembleConfig('claude-code', { endpoint: ENDPOINT, secret: SECRET });
		expect(block).toBe(
			`claude mcp add --transport http ${MCP_SERVER_KEY} ${ENDPOINT} --header "Authorization: Bearer ${SECRET}"`
		);
		expect(block.split('\n')).toHaveLength(1);
	});

	it('is a ready mcpServers object for Cursor', () => {
		const block = assembleConfig('cursor', { endpoint: ENDPOINT, secret: SECRET });
		const parsed = JSON.parse(block);
		expect(parsed).toEqual({
			mcpServers: {
				[MCP_SERVER_KEY]: {
					url: ENDPOINT,
					headers: { Authorization: `Bearer ${SECRET}` }
				}
			}
		});
	});

	it('is a mcp_servers table for Codex', () => {
		const block = assembleConfig('codex', { endpoint: ENDPOINT, secret: SECRET });
		expect(block).toContain(`[mcp_servers.${MCP_SERVER_KEY}]`);
		expect(block).toContain(`url = "${ENDPOINT}"`);
		expect(block).toContain(`http_headers = { Authorization = "Bearer ${SECRET}" }`);
	});

	it('carries the endpoint and the token, with the token exactly once', () => {
		for (const provider of MCP_PROVIDERS) {
			const block = assembleConfig(provider.id, { endpoint: ENDPOINT, secret: SECRET });
			expect(block, provider.id).toContain(ENDPOINT);
			expect(block.split(SECRET).length - 1, provider.id).toBe(1);
		}
	});

	it('shows the placeholder before anything is minted, so nothing looks connected', () => {
		const block = assembleConfig('cursor', { endpoint: ENDPOINT, secret: PLACEHOLDER_SECRET });
		expect(block).toContain('<token>');
	});
});

describe('the install link', () => {
	it('is Cursor only, and only once a real token exists', () => {
		const link = deepLink('cursor', { endpoint: ENDPOINT, secret: SECRET });
		expect(link).toMatch(/^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=northline&config=/);

		// The other two read a command and a file. A link for them would be an
		// invented consent screen, which is the one thing this flow must not do.
		expect(deepLink('claude-code', { endpoint: ENDPOINT, secret: SECRET })).toBeNull();
		expect(deepLink('codex', { endpoint: ENDPOINT, secret: SECRET })).toBeNull();

		// And no link at all while the panel is still showing <token>: it would
		// install a server that cannot authenticate.
		expect(deepLink('cursor', { endpoint: ENDPOINT, secret: PLACEHOLDER_SECRET })).toBeNull();
	});

	it('carries the same server block the Cursor panel shows', () => {
		const link = deepLink('cursor', { endpoint: ENDPOINT, secret: SECRET }) ?? '';
		const encoded = new URL(link).searchParams.get('config') ?? '';
		const parsed = JSON.parse(atob(encoded));
		expect(parsed).toEqual({ url: ENDPOINT, headers: { Authorization: `Bearer ${SECRET}` } });
	});
});

describe('the label a token is stored under', () => {
	it('says which provider it went to and who asked for it', () => {
		expect(connectLabel('claude-code', 'Elena Brooks')).toBe('Claude Code for Elena Brooks');
		expect(connectLabel('cursor', 'Dana Whitlock')).toBe('Cursor for Dana Whitlock');
	});

	it('fits the 60 characters the database accepts', () => {
		const long = connectLabel('claude-code', 'A Person With A Very Long Name Indeed Who Keeps Going');
		expect(long.length).toBeLessThanOrEqual(60);
		// The provider survives the cut, because that is the part the token
		// list is read for.
		expect(long.startsWith('Claude Code for ')).toBe(true);
	});

	it('still names the provider when a name is missing', () => {
		expect(connectLabel('codex', '   ')).toBe('Codex');
	});
});

/*
  A connect panel has to draw itself with nothing but the page. The marks are
  inline SVG for that reason: no <img>, no icon package, no CDN and no fetch,
  so the panel looks the same offline, and which coding agent somebody uses
  never leaves the page as a request to somebody else's server.
*/
describe('a provider panel, drawn with nothing off the network', () => {
	const mark = readFileSync(new URL('../components/settings/ProviderMark.svelte', import.meta.url), 'utf8');
	const buttons = readFileSync(
		new URL('../components/settings/ConnectButtons.svelte', import.meta.url),
		'utf8'
	);
	const page = readFileSync(new URL('../../routes/settings/mcp/+page.svelte', import.meta.url), 'utf8');
	const sources = [
		['ProviderMark.svelte', mark],
		['ConnectButtons.svelte', buttons],
		['+page.svelte', page]
	] as const;

	it('fetches nothing', () => {
		for (const [name, source] of sources) {
			expect(source, name).not.toMatch(/<img\b/);
			expect(source, name).not.toMatch(/\bfetch\s*\(/);
			expect(source, name).not.toMatch(/@import\b/);
			expect(source, name).not.toMatch(/https?:\/\//);
			expect(source, name).not.toMatch(/url\(\s*['"]?\/\//);
		}
	});

	it('draws a mark for every provider, inline', () => {
		expect(mark).toMatch(/<svg\b/);
		for (const provider of MCP_PROVIDERS) {
			expect(mark, provider.id).toContain(provider.id);
		}
	});

	it('draws them in currentColor, so one copy works in light and dark', () => {
		expect(mark).toContain('stroke="currentColor"');
		// No literal hex anywhere: a fixed colour is the thing that goes
		// invisible when the theme flips.
		expect(mark).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
	});

	it('gives every provider a real button rather than a clickable div', () => {
		// Keyboard reachable is not a style choice: a div with an onclick is
		// unreachable by Tab and invisible to a screen reader.
		expect(buttons).toMatch(/<button[^>]*type="submit"/);
		expect(buttons).not.toMatch(/<div[^>]*onclick/);
	});
});
