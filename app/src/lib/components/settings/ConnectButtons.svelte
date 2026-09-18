<script lang="ts">
	/*
	  The one-click connect row: one button per coding agent.

	  One small form each, rather than one form with three submit buttons, so
	  every button carries its own request id. Two different buttons are then
	  two different writes even from a page that has been open a while, and
	  pressing one button twice is one token rather than two live secrets.

	  They are the same size, the same tone and in one row, because none of
	  them is the recommended one: a person already knows which agent they
	  use. They are real <button> elements, so Tab reaches them and Enter and
	  Space press them, and the forms still post with JavaScript off.
	  `use:enhance` only adds a fresh request id and a working state on top.

	  What the click does and does not do is in $lib/mcp/providers.ts: it mints
	  a token and assembles that provider's config. There is no hosted consent
	  screen for any of these three to send a person to, so the flow does not
	  pretend there is one.
	*/
	import { enhance } from '$app/forms';
	import ProviderMark from './ProviderMark.svelte';
	import { freshRequestId } from './types';
	import type { McpProvider, McpProviderId } from '$lib/mcp/providers';

	let {
		providers,
		/** A request id per provider, for a page posting without JavaScript. */
		requestIds,
		/** False for anybody who is not an admin: the buttons say why instead. */
		canConnect,
		/** Why the buttons are off, shown when canConnect is false. */
		reason
	}: {
		providers: McpProvider[];
		requestIds: Record<string, string>;
		canConnect: boolean;
		reason: string;
	} = $props();

	/** Which button was pressed, so only that one says it is working. */
	let working = $state<McpProviderId | ''>('');
</script>

<div class="row">
	{#each providers as provider (provider.id)}
		<form
			class="one"
			method="POST"
			action="?/connect"
			use:enhance={({ formData }) => {
				// A fresh id per attempt: a second try after a refusal is a real
				// second try rather than a replayed answer to the first.
				formData.set('requestId', freshRequestId());
				working = provider.id;
				return async ({ update }) => {
					await update();
					working = '';
				};
			}}
		>
			<input type="hidden" name="provider" value={provider.id} />
			<input type="hidden" name="requestId" value={requestIds[provider.id] ?? ''} />
			<button
				class="button provider"
				type="submit"
				disabled={!canConnect || working !== ''}
				aria-busy={working === provider.id || undefined}
				aria-describedby={canConnect ? undefined : 'connect-off'}
			>
				<ProviderMark provider={provider.id} />
				<span>{provider.name}</span>
				{#if working === provider.id}
					<span class="spinner" aria-hidden="true"></span>
					<span class="sr-only">Connecting</span>
				{/if}
			</button>
		</form>
	{/each}
</div>

{#if !canConnect}
	<p class="notice" id="connect-off" role="status">{reason}</p>
{/if}

<style>
	/* Flexbox, so three buttons become one per line on a phone without a
	   grid rule that Safari and Chrome disagree about. */
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/*
	  Equal weight: every form gets the same minimum width and grows the
	  same, so no provider is visually the default.
	*/
	.one {
		display: flex;
		flex: 1 1 180px;
		min-width: 0;
	}

	/* Taller than a normal control, because it carries a mark. */
	.provider {
		flex: 1 1 auto;
		justify-content: flex-start;
		gap: var(--space-2);
		height: auto;
		min-height: var(--touch-h);
		padding: var(--space-2) var(--space-3);
		color: var(--text);
	}

	.provider:hover:not(:disabled) {
		border-color: var(--text-faint);
	}

	.provider span {
		font-weight: 500;
	}
</style>
