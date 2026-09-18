/*
  The three coding agents Northline knows how to connect to, and the exact
  thing each one needs pasted in.

  This lives outside `$lib/server` on purpose: the connect page renders the
  provider buttons and the finished panels, and the form action assembles the
  config, and both need the same list. Nothing here touches the database or a
  secret store, so it is safe on both sides.

  What "connect" can honestly mean today
  --------------------------------------
  None of these three read their MCP server list from a hosted account. Claude
  Code takes a CLI command, Cursor reads `mcp.json`, Codex reads
  `config.toml`. So there is no consent screen of theirs for us to redirect a
  person to, and inventing one would be a lie with a spinner on it.

  What the app can do is everything up to the paste: mint the token in the
  click, assemble the provider's own config around it, and hand back one
  finished block. Cursor is the only one of the three with an install deep
  link, so it is the only one that gets a real second click. The end state for
  a customer who does not want a shared secret in a config file at all is a
  hosted OAuth flow; that is written down in docs/mcp.md rather than mocked
  here.
*/

/** The providers the connect flow offers. */
export type McpProviderId = 'claude-code' | 'cursor' | 'codex';

/** What the assembled block is, so the panel can say so and colour it. */
export type ConfigFormat = 'sh' | 'json' | 'toml';

export interface McpProvider {
	id: McpProviderId;
	/** The product's own name, spelled the way they spell it. */
	name: string;
	format: ConfigFormat;
	/** One sentence saying where the block goes. */
	pasteWhere: string;
	/** True when the provider has an install link we can hand the person. */
	hasDeepLink: boolean;
}

/*
  The server's key in a client's config. It is the same string as
  SERVER_NAME in $lib/server/mcp/server.ts, which cannot be imported here
  because that module is server-only; mcp.test.ts holds the two together.
*/
export const MCP_SERVER_KEY = 'northline';

/** What stands in for the secret in a panel nobody has connected yet. */
export const PLACEHOLDER_SECRET = '<token>';

/*
  The scopes a one-click connect mints with: the smallest thing that works.
  A connected agent reads, and anything that would change a record comes back
  as a proposal a person approves.

  The mcp-autonomy branch is replacing scopes with an autonomy level on the
  token. When that lands, this constant and the `scopes` argument below it go
  away together and the level takes over; nothing else in this flow has an
  opinion about permissions, which is the point of keeping it one line.
*/
export const CONNECT_SCOPES = ['read'] as const;

export const MCP_PROVIDERS: McpProvider[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		format: 'sh',
		pasteWhere: 'Run this once in a terminal, in any directory.',
		hasDeepLink: false
	},
	{
		id: 'cursor',
		name: 'Cursor',
		format: 'json',
		pasteWhere: "Put this in ~/.cursor/mcp.json, or in the project's .cursor/mcp.json.",
		hasDeepLink: true
	},
	{
		id: 'codex',
		name: 'Codex',
		format: 'toml',
		pasteWhere: 'Put this in ~/.codex/config.toml.',
		hasDeepLink: false
	}
];

export function isMcpProviderId(value: unknown): value is McpProviderId {
	return typeof value === 'string' && MCP_PROVIDERS.some((provider) => provider.id === value);
}

/** The provider, or null when the id is not one of ours. */
export function findProvider(id: unknown): McpProvider | null {
	return MCP_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export interface ConnectDetails {
	/** The full MCP endpoint, e.g. https://host/api/mcp. */
	endpoint: string;
	/** The secret, or PLACEHOLDER_SECRET before anything is minted. */
	secret: string;
}

/**
 * The finished thing for one provider: a command for Claude Code, a
 * `mcpServers` block for Cursor, an `mcp_servers` table for Codex. The
 * endpoint and the bearer header are already in it, so there is nothing left
 * to fill in by hand.
 */
export function assembleConfig(id: McpProviderId, details: ConnectDetails): string {
	const { endpoint, secret } = details;
	const bearer = `Bearer ${secret}`;

	if (id === 'claude-code') {
		return `claude mcp add --transport http ${MCP_SERVER_KEY} ${endpoint} --header "Authorization: ${bearer}"`;
	}

	if (id === 'cursor') {
		return JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: serverBlock(details) } }, null, 2);
	}

	// Codex, in TOML. Its inline table is the shape Codex documents for HTTP
	// servers; it has moved between versions, which the page says out loud.
	return [
		`[mcp_servers.${MCP_SERVER_KEY}]`,
		`url = "${endpoint}"`,
		`http_headers = { Authorization = "${bearer}" }`
	].join('\n');
}

/** The one server entry, shared by the Cursor config and its deep link. */
function serverBlock(details: ConnectDetails): { url: string; headers: Record<string, string> } {
	return { url: details.endpoint, headers: { Authorization: `Bearer ${details.secret}` } };
}

/**
 * An install link for the providers that have one, or null. Cursor is the
 * only one of the three: the link opens the app on this machine and offers to
 * add the server, so the token never leaves the computer it was copied to.
 *
 * Null before a token exists, because a link carrying `<token>` would install
 * a server that cannot authenticate and look like the app's fault.
 */
export function deepLink(id: McpProviderId, details: ConnectDetails): string | null {
	if (id !== 'cursor') return null;
	if (details.secret === PLACEHOLDER_SECRET) return null;
	const config = base64(JSON.stringify(serverBlock(details)));
	return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_SERVER_KEY}&config=${encodeURIComponent(config)}`;
}

/*
  btoa is in Node and in every browser this app supports. It only accepts
  Latin-1, and an endpoint and a base64url token are ASCII, so there is no
  encoding dance to do here.
*/
function base64(text: string): string {
	return btoa(text);
}

/**
 * The label the token is stored under, so the token list says which provider
 * it went to and who asked for it. Capped at the 60 characters
 * `nl.mint_mcp_token` accepts, cutting the person's name rather than the
 * provider, because the provider is the part being answered for here.
 */
export function connectLabel(id: McpProviderId, personName: string): string {
	const provider = findProvider(id);
	const name = provider ? provider.name : String(id);
	const trimmed = personName.trim();
	if (trimmed.length === 0) return name.slice(0, 60);
	const label = `${name} for ${trimmed}`;
	return label.length <= 60 ? label : label.slice(0, 59).trimEnd() + '…';
}
