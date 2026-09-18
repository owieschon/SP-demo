/*
  One click on a provider button: mint a token for the person who clicked it,
  and hand back that provider's finished config with the token already in it.

  This is deliberately thin. It does no permission arithmetic of its own: it
  calls `mintToken`, which calls `nl.mint_mcp_token`, which is where admin-only
  lives and where the audit row is written. If minting is ever allowed for
  somebody else, this file does not need to change.

  There is one minting path in the app and this is not a second one. The
  difference between this and the mint form beside it is only which fields a
  person fills in: the form asks who the token acts as, and a connect button
  answers "you" and names the provider for you.
*/
import { AppError } from '../errors.ts';
import { hashToken, mintToken } from './tokens.ts';
import {
	assembleConfig,
	CONNECT_SCOPES,
	connectLabel,
	deepLink,
	findProvider,
	type McpProviderId
} from '$lib/mcp/providers';
import type { McpScope } from './tokens.ts';
import type { Db } from '../db/types.ts';

export interface ConnectRequest {
	/** The provider whose button was pressed, straight off the form. */
	provider: unknown;
	/** The MCP endpoint this deployment answers on. */
	endpoint: string;
	/** One id per form, so a double submit writes one token. */
	requestId: string;
}

export interface ConnectResult {
	provider: McpProviderId;
	providerName: string;
	tokenId: number;
	label: string;
	/** The secret, this once. Only its SHA-256 is stored. */
	secret: string;
	/** The provider's own config, finished: endpoint and bearer header in it. */
	config: string;
	/** An install link, for the providers that have one. Null otherwise. */
	link: string | null;
}

/**
 * Mint one token for `person` and assemble `provider`'s config around it.
 *
 * Throws AppError for anything a person can fix (an unknown provider, a stale
 * form, not being an admin). The 403 comes from the database, so a non-admin
 * who posts the form by hand is refused by the same rule that greys the
 * buttons out.
 */
export async function connectProvider(
	db: Db,
	person: { id: number; fullName: string },
	input: ConnectRequest
): Promise<ConnectResult> {
	const provider = findProvider(input.provider);
	if (!provider) {
		throw new AppError(422, 'NL422', 'Choose Claude Code, Cursor or Codex.');
	}
	if (input.requestId.length < 8 || input.requestId.length > 100) {
		throw new AppError(409, 'NL409', 'The form is out of date. Reload the page and try again.');
	}

	const minted = await mintToken(db, person.id, {
		label: connectLabel(provider.id, person.fullName),
		// The token acts as the person who clicked, not as somebody chosen from
		// a list: a one-click connect has nobody else to mean.
		actsAs: person.id,
		scopes: [...CONNECT_SCOPES] as McpScope[],
		requestId: input.requestId
	});

	/*
	  A reused request id does not write twice: nl.claim_request hands back the
	  answer to the first write. That is what stops a double click minting two
	  live secrets, and it means a stale form comes back with the first token's
	  id beside a second secret that was never stored. Handing that over would
	  be a block that cannot authenticate, looking like the app's fault, so the
	  hash is checked and a person is asked to reload instead.
	*/
	const [stored] = await db.asUser(person.id, (tx) =>
		tx.sql<{ token_sha256: string }>`
			select token_sha256 from nl.mcp_tokens where id = ${minted.tokenId}`
	);
	if (!stored || stored.token_sha256 !== hashToken(minted.secret)) {
		throw new AppError(
			409,
			'NL409',
			'That button was already used once. Reload the page and press it again for a fresh token.'
		);
	}

	const details = { endpoint: input.endpoint, secret: minted.secret };
	return {
		provider: provider.id,
		providerName: provider.name,
		tokenId: minted.tokenId,
		label: minted.label,
		secret: minted.secret,
		config: assembleConfig(provider.id, details),
		link: deepLink(provider.id, details)
	};
}
