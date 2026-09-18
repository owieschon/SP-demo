<script lang="ts">
	/*
	  The one-click connect row: one button per coding agent.

	  Three submit buttons in one form, each posting its own provider. They are
	  the same size, the same tone and in one row, because none of them is the
	  recommended one: a person already knows which agent they use.

	  They are real <button> elements, so Tab reaches them, Enter and Space
	  press them, and the form still posts with JavaScript off. `use:enhance`
	  only adds a fresh request id and a working state on top of that.

	  What the click does and does not do is in $lib/mcp/providers.ts: it mints
	  a token and assembles that provider's config. There is no hosted consent
	  screen for any of these three to send a person to, so the flow does not
	  pretend there is one.
	*/
	import { enhance } from '$app/forms';
	import ProviderMark from './ProviderMark.svelte';
	import { freshRequestId } from './types';
	import { isMcpProviderId } from '$lib/mcp/providers';
	import type { McpProvider, McpProviderId } from '$lib/mcp/providers';

	let {
		providers,
		/**
		 * One request id for this page render, so the form posts one even with
		 * JavaScript off. A successful post re-renders the page and brings a new
		 * one, so two connects in a row are two different writes.
		 */
		requestId,
		/** False for anybody who is not an admin: the buttons say why instead. */
		canConnect,
		/** Why the buttons are off, shown when canConnect is false. */
		reason
	}: {
		providers: McpProvider[];
		requestId: string;
		canConnect: boolean;
		reason: string;
	} = $props();

	/** Which button was pressed, so only that one says it is working. */
	let working = $state<McpProviderId | ''>('');
</script>

<form
	method="POST"
	action="?/connect"
	use:enhance={({ formData }) => {
		// A fresh id per attempt: a double click writes one token, and a second
		// try after a refusal is a real second try rather than a replayed answer.
		formData.set('requestId', freshRequestId());
		const pressed = String(formData.get('provider') ?? '');
		working = isMcpProviderId(pressed) ? pressed : '';
		return async ({ update }) => {
			await update();
			working = '';
		};
	}}
>
	<div class="row">
		{#each providers as provider (provider.id)}
			<button
				class="button provider"
				type="submit"
				name="provider"
				value={provider.id}
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
		{/each}
	</div>

	<input type="hidden" name="requestId" value={requestId} />
</form>

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
	  Equal weight: every button gets the same minimum width and grows the
	  same, so no provider is visually the default. Taller than a normal
	  control because it carries a mark.
	*/
	.provider {
		flex: 1 1 180px;
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
