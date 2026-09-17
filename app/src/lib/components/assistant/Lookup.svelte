<script lang="ts">
	// One thing the assistant asked for, as a line you can open.
	//
	// Closed, it says what it asked for and how it went. Open, it shows the
	// exact input, which is the point: a reader can see that the gated tool
	// was asked for and did not run, and what a SQL query really was.
	import Database from '@lucide/svelte/icons/database';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import MessageSquareQuote from '@lucide/svelte/icons/message-square-quote';
	import type { LookupView } from '$lib/assistant/types';

	let { lookup }: { lookup: LookupView } = $props();

	const ICON = {
		read: Database,
		additive: FilePlus,
		gated: ShieldAlert,
		propose: MessageSquareQuote
	};
	const Icon = $derived(ICON[lookup.risk]);

	const OUTCOME = {
		ran: '',
		gated: 'did not run',
		refused: 'refused',
		failed: 'failed'
	};

	// The input, pretty but compact. A long SQL query keeps its line breaks.
	const shown = $derived(JSON.stringify(lookup.input ?? {}, null, 1));
</script>

<details class="lookup" class:gated={lookup.risk === 'gated'} class:bad={lookup.outcome === 'failed'}>
	<summary>
		<Icon size={13} aria-hidden="true" />
		<span class="name mono">{lookup.name}</span>
		{#if OUTCOME[lookup.outcome]}
			<span class="chip" class:warn={lookup.outcome !== 'ran'}>{OUTCOME[lookup.outcome]}</span>
		{/if}
		<span class="facts faint">
			{#if lookup.rows !== null}{lookup.rows} {lookup.rows === 1 ? 'row' : 'rows'}{/if}
			<!-- The timing is kept, as a tooltip on the count, rather than
			     shown as a bare "412 ms" next to a customer's name. -->
			<span class="sr-only">, took {lookup.ms} milliseconds</span>
		</span>
	</summary>
	<div class="body">
		{#if lookup.note}
			<p class="note">{lookup.note}</p>
		{/if}
		<pre class="mono">{shown}</pre>
	</div>
</details>

<style>
	.lookup {
		border-top: 1px solid var(--hairline);
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 30px;
		padding: 2px var(--space-3);
		cursor: pointer;
		color: var(--text-muted);
		list-style: none;
		transition: background-color var(--speed) var(--ease);
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:hover {
		background: var(--surface-hover);
	}

	summary :global(svg) {
		flex: none;
	}

	.gated summary :global(svg) {
		color: var(--status-pushed);
	}

	.bad summary :global(svg) {
		color: var(--danger);
	}

	.name {
		color: var(--text);
	}

	.facts {
		margin-left: auto;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.body {
		display: grid;
		gap: 6px;
		padding: 0 var(--space-3) var(--space-3);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.note {
		color: var(--text-muted);
		max-width: 76ch;
	}

	pre {
		margin: 0;
		padding: var(--space-2);
		border-radius: var(--radius);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
		overflow-x: auto;
		font-size: 0.85rem;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
