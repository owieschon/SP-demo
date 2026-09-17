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
import { mcpToolNames, MCP_TOOLS } from '$lib/server/mcp/tools';
import { listTokens, mintToken, revokeToken, SCOPES, type McpScope } from '$lib/server/mcp/tokens';
import { listUsers } from '$lib/server/users';
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

export const load: PageServerLoad = async ({ locals, url }) => {
	// hooks.server.ts guarantees a signed-in user on this page.
	const user = locals.user!;
	const db = await getDb();
	const isAdmin = user.role === 'admin';
	const tokens = isAdmin ? await listTokens(db, user.id) : [];

	return {
		isAdmin,
		endpoint: `${url.origin}/api/mcp`,
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
		revokeIds: Object.fromEntries(tokens.map((token) => [token.id, randomUUID()]))
	};
};

export const actions: Actions = {
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
