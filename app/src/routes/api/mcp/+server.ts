// The MCP endpoint. An outside coding agent (Claude Code, Cursor, Codex)
// talks to Northline here.
//
// Nobody is signed in on these requests: there is no session cookie, and the
// bearer token is the only thing that says who is calling. That means
// /api/mcp has to be a public path in hooks.server.ts, and the token is the
// only thing protecting it. See docs/mcp.md.
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { readMcpLimits } from '$lib/server/mcp/caps';
import { handleMcpPost, mcpGetResponse } from '$lib/server/mcp/server';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	return handleMcpPost(request, { db: await getDb(), limits: readMcpLimits(env) });
};

// This server is stateless, so there is no stream for a client to open. GET
// answers 405 with the server's metadata and the exact command to connect.
export const GET: RequestHandler = async ({ url }) => {
	return mcpGetResponse(`${url.origin}/api/mcp`);
};
