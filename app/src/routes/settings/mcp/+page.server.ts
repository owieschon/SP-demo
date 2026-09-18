// The connect page: how to point a coding agent at this app, and (for an
// admin) the tokens that let it in.
//
// The secret is shown exactly once, in the answer to the form that minted it.
// It is not stored anywhere it could be read back: the database has only its
// SHA-256, so a lost token is replaced rather than recovered.
import { randomUUID } from 'node:crypto';
import { fail } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { toAppError } from '$lib/server/errors';
import { readMcpLimits } from '$lib/server/mcp/caps';
import { connectProvider } from '$lib/server/mcp/connect';
import { mcpToolNames, MCP_TOOLS } from '$lib/server/mcp/tools';
import { listTokens, mintToken, revokeToken, SCOPES, type McpScope } from '$lib/server/mcp/tokens';
import { listUsers } from '$lib/server/users';
import { MCP_PROVIDERS, type McpProviderId } from '$lib/mcp/providers';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';

type MintResult = {
	from: 'mint';
	message: string;
	/** Only ever set on success, and only in this one answer. */
	secret?: string;
	label?: string;
	tokenId?: number;
};

type RevokeResult = { from: 'revoke'; message: string };

/**
 * The answer to a provider button. It carries the finished config, assembled
 * on the server, so the browser never has to put an endpoint and a secret
 * together itself.
 */
type ConnectResult = {
	from: 'connect';
	message: string;
	provider?: McpProviderId;
	providerName?: string;
	/** Only ever set on success, and only in this one answer. */
	secret?: string;
	config?: string;
	link?: string | null;
	label?: string;
	tokenId?: number;
};

export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	const isAdmin = user.role === 'admin';
	const tokens = isAdmin ? await listTokens(db, user.id) : [];

	return {
		isAdmin,
		/** Whose name goes on a token minted by a provider button. */
		personName: user.fullName,
		endpoint: `${url.origin}/api/mcp`,
		// The three coding agents the connect row offers, in one place so the
		// page and the form action cannot disagree about the list.
		providers: MCP_PROVIDERS,
		limits: readMcpLimits(env),
		// What the server exposes, so the page can say it without a second list.
		tools: MCP_TOOLS.map((tool) => ({
			name: tool.name,
			title: tool.title,
			scope: tool.scope,
			readOnly: tool.readOnly
		})),
		toolCount: mcpToolNames().length,
		// Only an admin sees or manages tokens.
		tokens,
		people: isAdmin ? (await listUsers(db)).filter((person) => person.active) : [],
		scopes: SCOPES,
		// Fresh ids for the forms on this page load. Sending the same form twice
		// sends the same id, so the database writes once. Revoke needs one per
		// token, because two revokes on one page load are two different writes.
		mintId: randomUUID(),
		// One id for the connect row. A successful connect re-renders the page
		// and brings a new one, so two connects in a row are two writes.
		connectId: randomUUID(),
		revokeIds: Object.fromEntries(tokens.map((token) => [token.id, randomUUID()]))
	};
};

export const actions: Actions = {
	/*
	  A provider button. The token is minted here, in the click, and the
	  provider's finished config comes back with it, so nobody types a secret
	  by hand or assembles a JSON block around one.

	  Admin-only is enforced in nl.mint_mcp_token. The check here is so a
	  non-admin gets a sentence rather than a database error; the page greys
	  the buttons out and says the same thing before the click.
	*/
	connect: async ({ locals, request, url }) => {
		const user = locals.user!;
		if (user.role !== 'admin') {
			return fail(403, {
				from: 'connect',
				message: 'Only an admin can mint a token, so only an admin can connect an agent.'
			} satisfies ConnectResult);
		}

		const form = await request.formData();
		try {
			const connected = await connectProvider(
				await getDb(),
				{ id: user.id, fullName: user.fullName },
				{
					provider: form.get('provider'),
					endpoint: `${url.origin}/api/mcp`,
					requestId: String(form.get('requestId') ?? '')
				}
			);
			return {
				from: 'connect',
				message: `${connected.providerName} is ready. Copy the block below now: the token is not stored and cannot be shown again.`,
				provider: connected.provider,
				providerName: connected.providerName,
				secret: connected.secret,
				config: connected.config,
				link: connected.link,
				label: connected.label,
				tokenId: connected.tokenId
			} satisfies ConnectResult;
		} catch (error) {
			const refusal = toAppError(error);
			if (!refusal) throw error;
			return fail(refusal.status, { from: 'connect', message: refusal.message } satisfies ConnectResult);
		}
	},

	mint: async ({ locals, request }) => {
		const user = locals.user!;
		if (user.role !== 'admin') {
			return fail(403, { from: 'mint', message: 'Only an admin can mint a token.' } satisfies MintResult);
		}

		const form = await request.formData();
		const label = String(form.get('label') ?? '').trim();
		const actsAs = Number(form.get('actsAs'));
		const requestId = String(form.get('requestId') ?? '');
		const scopes = form.getAll('scopes').map(String).filter((scope): scope is McpScope => scope === 'read' || scope === 'propose');

		if (requestId.length < 8 || requestId.length > 100) {
			return fail(400, { from: 'mint', message: 'The form is out of date. Reload the page and try again.' } satisfies MintResult);
		}
		if (label.length < 1 || label.length > 60) {
			return fail(400, {
				from: 'mint',
				message: 'Give the token a label of 1 to 60 characters, so you can recognise it later.'
			} satisfies MintResult);
		}
		if (!Number.isInteger(actsAs) || actsAs <= 0) {
			return fail(400, { from: 'mint', message: 'Choose the person this token acts as.' } satisfies MintResult);
		}
		if (scopes.length === 0) {
			return fail(400, { from: 'mint', message: 'Choose at least one scope.' } satisfies MintResult);
		}

		try {
			const minted = await mintToken(await getDb(), user.id, { label, actsAs, scopes, requestId });
			return {
				from: 'mint',
				message: 'Copy this token now. It is not stored and cannot be shown again.',
				secret: minted.secret,
				label: minted.label,
				tokenId: minted.tokenId
			} satisfies MintResult;
		} catch (error) {
			const refusal = toAppError(error);
			if (!refusal) throw error;
			return fail(refusal.status, { from: 'mint', message: refusal.message } satisfies MintResult);
		}
	},

	revoke: async ({ locals, request }) => {
		const user = locals.user!;
		if (user.role !== 'admin') {
			return fail(403, { from: 'revoke', message: 'Only an admin can revoke a token.' } satisfies RevokeResult);
		}

		const form = await request.formData();
		const tokenId = Number(form.get('tokenId'));
		const requestId = String(form.get('requestId') ?? '');

		if (!Number.isInteger(tokenId) || tokenId <= 0 || requestId.length < 8) {
			return fail(400, { from: 'revoke', message: 'The form is out of date. Reload the page and try again.' } satisfies RevokeResult);
		}

		try {
			const revoked = await revokeToken(await getDb(), user.id, { tokenId, requestId });
			return {
				from: 'revoke',
				message: `"${revoked.label}" is revoked. It stops working on its next call.`
			} satisfies RevokeResult;
		} catch (error) {
			const refusal = toAppError(error);
			if (!refusal) throw error;
			return fail(refusal.status, { from: 'revoke', message: refusal.message } satisfies RevokeResult);
		}
	}
};
