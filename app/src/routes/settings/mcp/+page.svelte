<script lang="ts">
	// Connect a coding agent to Northline. An admin picks their provider, and
	// the click mints the token and assembles that provider's config around
	// it. Everyone sees what the server exposes. Only an admin sees the
	// token controls.
	import Check from '@lucide/svelte/icons/check';
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Plus from '@lucide/svelte/icons/plus';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { enhance } from '$app/forms';
	import ConnectButtons from '$lib/components/settings/ConnectButtons.svelte';
	import ProviderMark from '$lib/components/settings/ProviderMark.svelte';
	import { count, moment } from '$lib/format';
	import { assembleConfig, deepLink, PLACEHOLDER_SECRET } from '$lib/mcp/providers';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// The token stands in for the real one in every panel until one is minted
	// on this page, and then the real one is pasted in for you. A connect
	// button and the mint form both land here.
	const secret = $derived(
		(form?.from === 'connect' || form?.from === 'mint') && form.secret ? form.secret : PLACEHOLDER_SECRET
	);

	/** The provider whose button was just pressed, or null. */
	const connected = $derived(form?.from === 'connect' && form.secret ? (form.provider ?? null) : null);

	const curlCommand = $derived(
		`curl -s ${data.endpoint} \\\n  -H "Authorization: Bearer ${secret}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
	);

	// Which snippet's copy button was pressed last, so it can say so briefly.
	let copied = $state('');
	let copyTimer: ReturnType<typeof setTimeout> | undefined;

	async function copy(what: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = what;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copied = ''), 1600);
		} catch {
			// Some browsers refuse the clipboard without a gesture they like.
			// The text is on the page and can be selected by hand.
			copied = '';
		}
	}

	const readTools = $derived(data.tools.filter((tool) => tool.readOnly));
	const proposeTools = $derived(data.tools.filter((tool) => !tool.readOnly));
</script>

<svelte:head>
	<title>Connect a coding agent · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div>
			<h1>Connect a coding agent</h1>
			<p class="faint">
				Northline speaks MCP, so Claude Code, Cursor or Codex can read it and ask for changes. Read tools
				answer straight away. Anything that would change a record becomes a proposal someone approves in
				the app, exactly like the in-app assistant. Nothing an outside agent can call writes a record.
			</p>
		</div>
	</header>

	{#if form?.message && !(form.from === 'connect' && form.secret) && !(form.from === 'mint' && form.secret)}
		<p class="notice error" role="alert">{form.message}</p>
	{/if}

	<section class="panel">
		<div class="panel-head"><h2>Pick your agent</h2></div>
		<div class="body">
			<p>
				One click mints a token that acts as {data.personName}, and fills it into the block that agent
				needs. Nothing is typed by hand and no secret is stored: only the token's SHA-256 is kept.
			</p>
			<ConnectButtons
				providers={data.providers}
				requestIds={data.connectIds}
				canConnect={data.isAdmin}
				reason="Only an admin can mint a token, so these are off for you. Ask an admin for one with your name on it, or ask them to make you an admin of this deployment."
			/>
			{#if form?.from === 'connect' && form.secret}
				<!-- The block itself is in that provider's panel below, so the
				     message carries a link to it rather than leaving somebody on a
				     phone to scroll and guess which panel changed. -->
				<p class="notice" role="status">
					<span>{form.message}</span>
					<a class="button" href={`#provider-${connected}`}>Go to the block</a>
				</p>
			{/if}
			<p class="faint small">
				Claude Code, Cursor and Codex are third party tools. The marks above are ours, drawn to
				identify each one, and the names belong to their owners. None of them endorses this app.
			</p>
		</div>
	</section>

	<section class="panel">
		<div class="panel-head"><h2>The endpoint</h2></div>
		<div class="body">
			<div class="snippet">
				<pre><code>{data.endpoint}</code></pre>
				<button class="button" type="button" onclick={() => copy('endpoint', data.endpoint)}>
					{#if copied === 'endpoint'}
						<Check size={14} strokeWidth={1.75} aria-hidden="true" /> Copied
					{:else}
						<Copy size={14} strokeWidth={1.75} aria-hidden="true" /> Copy
					{/if}
				</button>
			</div>
			<p class="faint">
				One POST, MCP over streamable HTTP. It holds no sessions, so a GET answers 405 with this same
				information. A token may make {count(data.limits.perTokenPerDay)} tool calls a day, and one tool
				result is capped at 16 KB.
			</p>
		</div>
	</section>

	<!--
	  One panel per provider, each with the finished thing rather than a
	  template. The panel for the agent just connected carries the real token
	  and says so; the other two show <token> so a person can see what they
	  would get before they press anything.
	-->
	{#each data.providers as provider (provider.id)}
		{@const block = assembleConfig(provider.id, { endpoint: data.endpoint, secret })}
		{@const link = deepLink(provider.id, { endpoint: data.endpoint, secret })}
		<section class="panel" class:fresh={connected === provider.id} id={`provider-${provider.id}`}>
			<div class="panel-head">
				<h2><ProviderMark provider={provider.id} /> {provider.name}</h2>
				{#if connected === provider.id}
					<span class="chip warn">
						<TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
						Token shown once
					</span>
				{/if}
			</div>
			<div class="body">
				<p class="faint">{provider.pasteWhere}</p>
				<div class="snippet">
					<pre><code>{block}</code></pre>
					<div class="stack">
						<button class="button" type="button" onclick={() => copy(provider.id, block)}>
							{#if copied === provider.id}
								<Check size={14} strokeWidth={1.75} aria-hidden="true" /> Copied
							{:else}
								<Copy size={14} strokeWidth={1.75} aria-hidden="true" /> Copy
							{/if}
						</button>
						{#if link}
							<!-- Cursor is the only one of the three with an install link. It
							     opens the app on this machine, so the token stays here. -->
							<a class="button" href={link}>
								<ExternalLink size={14} strokeWidth={1.75} aria-hidden="true" />
								Open in {provider.name}
							</a>
						{/if}
					</div>
				</div>
				{#if connected === provider.id}
					<p class="faint">
						Only its SHA-256 is stored, so this cannot be shown again. If you lose it, revoke
						"{form?.from === 'connect' ? form.label : ''}" below and press the button again.
					</p>
				{:else if data.isAdmin}
					<p class="faint">
						Press <strong>{provider.name}</strong> above to mint a token and fill it in here.
					</p>
				{/if}
				{#if provider.id === 'codex'}
					<p class="faint">
						Codex has moved its HTTP server settings around between versions. If it does not take
						this, check <code class="mono">codex mcp add --help</code>.
					</p>
				{/if}
			</div>
		</section>
	{/each}

	<section class="panel">
		<div class="panel-head"><h2>Try it without a client</h2></div>
		<div class="body">
			<div class="snippet">
				<pre><code>{curlCommand}</code></pre>
				<button class="button" type="button" onclick={() => copy('curl', curlCommand)}>
					{#if copied === 'curl'}
						<Check size={14} strokeWidth={1.75} aria-hidden="true" /> Copied
					{:else}
						<Copy size={14} strokeWidth={1.75} aria-hidden="true" /> Copy
					{/if}
				</button>
			</div>
		</div>
	</section>

	<section class="panel">
		<div class="panel-head"><h2>What it exposes</h2></div>
		<div class="body">
			<p class="scoped"><span class="chip">read</span> answers straight away, writes nothing:</p>
			<ul class="tools">
				{#each readTools as tool (tool.name)}
					<li><code class="mono">{tool.name}</code></li>
				{/each}
			</ul>
			<p class="scoped"><span class="chip">propose</span> creates a proposal a person approves:</p>
			<ul class="tools">
				{#each proposeTools as tool (tool.name)}
					<li><code class="mono">{tool.name}</code></li>
				{/each}
			</ul>
			<p class="faint">
				The tools that write are not here at all, so there is no input that could run one. An agent that
				needs a note written asks a person for it.
			</p>
		</div>
	</section>

	{#if data.isAdmin}
		{#if form?.from === 'mint' && form.secret}
			<section class="panel fresh">
				<div class="panel-head">
					<h2>Token minted: {form.label}</h2>
					<span class="chip warn">
						<TriangleAlert size={12} strokeWidth={1.75} aria-hidden="true" />
						Shown once
					</span>
				</div>
				<div class="body">
					<p>{form.message}</p>
					<div class="snippet">
						<pre><code>{form.secret}</code></pre>
						<button class="button" type="button" onclick={() => copy('secret', form?.secret ?? '')}>
							{#if copied === 'secret'}
								<Check size={14} strokeWidth={1.75} aria-hidden="true" /> Copied
							{:else}
								<Copy size={14} strokeWidth={1.75} aria-hidden="true" /> Copy
							{/if}
						</button>
					</div>
					<p class="faint">
						Only its SHA-256 is stored, so this cannot be shown again. If you lose it, revoke it and
						mint another. The panels above already have it in them.
					</p>
				</div>
			</section>
		{/if}

		<section class="panel">
			<div class="panel-head"><h2>Mint a token for somebody else</h2></div>
			<form class="body mint" method="POST" action="?/mint" use:enhance>
				<input type="hidden" name="requestId" value={data.mintId} />
				<label>
					<span>Label</span>
					<input name="label" maxlength="60" required placeholder="Claude Code on the work laptop" />
				</label>
				<label>
					<span>Acts as</span>
					<select name="actsAs" required>
						{#each data.people as person (person.id)}
							<option value={person.id}>{person.fullName} ({person.title})</option>
						{/each}
					</select>
				</label>
				<fieldset>
					<legend>Scopes</legend>
					{#each data.scopes as scope (scope)}
						<label class="check">
							<input type="checkbox" name="scopes" value={scope} checked={scope === 'read'} />
							<span>{scope}</span>
						</label>
					{/each}
				</fieldset>
				<button class="button primary" type="submit">
					<Plus size={14} strokeWidth={1.75} aria-hidden="true" />
					Mint
				</button>
				<p class="faint wide">
					The buttons at the top mint for you. This one is for handing a token to somebody else: it
					acts as the person you choose and sees exactly what they see. Give it
					<code class="mono">read</code> only unless it needs to ask for changes.
				</p>
			</form>
		</section>

		<section class="panel">
			<div class="panel-head">
				<h2>Tokens</h2>
				<span class="faint small">{count(data.tokens.length)} in total</span>
			</div>
			{#if data.tokens.length === 0}
				<div class="body">
					<p>No tokens yet.</p>
					<p class="faint">Press your agent's button at the top of this page.</p>
				</div>
			{:else}
				<table>
					<thead>
						<tr>
							<th scope="col">Label</th>
							<th scope="col">Acts as</th>
							<th scope="col">Scopes</th>
							<th scope="col">Last used</th>
							<th scope="col" class="right">Today</th>
							<th scope="col"></th>
						</tr>
					</thead>
					<tbody>
						{#each data.tokens as token (token.id)}
							<tr class:revoked={token.revokedAt !== null}>
								<td>
									{token.label}
									{#if token.revokedAt !== null}
										<span class="chip">revoked {moment(token.revokedAt)}</span>
									{/if}
								</td>
								<td>{token.actsAsName}</td>
								<td class="mono small">{token.scopes.join(', ')}</td>
								<td class="faint">
									{token.lastUsedAt === null ? 'Never' : moment(token.lastUsedAt)}
								</td>
								<td class="right num">{count(token.callsToday)}</td>
								<td class="right">
									{#if token.revokedAt === null}
										<form method="POST" action="?/revoke" use:enhance>
											<input type="hidden" name="tokenId" value={token.id} />
											<input type="hidden" name="requestId" value={data.revokeIds[token.id]} />
											<button class="button quiet" type="submit">Revoke</button>
										</form>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</section>
	{:else}
		<section class="panel">
			<div class="panel-head"><h2>Getting a token</h2></div>
			<div class="body">
				<p>Only an admin can mint or revoke a token. Ask one for a token with your name on it.</p>
				<p class="faint">
					A token acts as one person, so the one you are given sees what you see and nothing more.
				</p>
			</div>
		</section>
	{/if}
</main>

<style>
	.page {
		max-width: 860px;
		margin: 0 auto;
		padding: var(--space-3) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head > div {
		display: grid;
		gap: 4px;
	}

	.head p {
		max-width: 72ch;
		font-size: 0.92rem;
	}

	.body {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
	}

	.body p {
		font-size: 0.92rem;
		max-width: 72ch;
	}

	.fresh {
		border-color: color-mix(in srgb, var(--warning) 35%, transparent);
	}

	/* A notice with a link in it wraps on a phone rather than squeezing both. */
	.notice {
		justify-content: space-between;
		flex-wrap: wrap;
	}

	/* A provider panel's title carries its mark, so the two sit on one line. */
	.panel-head h2 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	/* A snippet and its copy button, side by side, wrapping on a phone. */
	.snippet {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.snippet pre {
		flex: 1 1 320px;
		margin: 0;
		padding: var(--space-2);
		overflow-x: auto;
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface-sunken);
		font-family: var(--font-mono);
		font-size: 0.85rem;
		line-height: 1.5;
		white-space: pre-wrap;
		word-break: break-all;
	}

	/* Copy, and the install link under it when a provider has one. */
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		flex: none;
	}

	.scoped {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: var(--space-1);
	}

	.tools {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
		font-size: 0.85rem;
	}

	.tools li {
		padding: 2px 6px;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	/* Flexbox rather than grid columns: it behaves the same everywhere. */
	.mint {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}

	.mint label {
		display: grid;
		gap: 4px;
		flex: 1 1 200px;
		font-size: 0.92rem;
	}

	.mint label > span {
		color: var(--text-muted);
	}

	.mint fieldset {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		border: 0;
	}

	.mint legend {
		padding: 0;
		font-size: 0.92rem;
		color: var(--text-muted);
	}

	.mint .check {
		display: flex;
		align-items: center;
		gap: 5px;
		flex: 0 0 auto;
	}

	.mint .check input {
		width: auto;
		height: auto;
	}

	.wide {
		flex: 1 1 100%;
	}

	.small {
		font-size: 0.85rem;
	}

	.right {
		text-align: right;
	}

	.revoked td {
		color: var(--text-faint);
	}

	tbody form {
		display: inline;
	}

	@media (max-width: 640px) {
		.page {
			padding: var(--space-2) var(--space-2) var(--space-5);
		}

		/* On a phone the copy button and the install link go side by side
		   under the block rather than in a column beside it. */
		.stack {
			flex-direction: row;
			flex-wrap: wrap;
		}
	}
</style>
