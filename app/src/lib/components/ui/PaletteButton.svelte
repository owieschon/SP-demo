<script lang="ts">
	/*
	  The visible way into the command palette, for anyone who does not know
	  the shortcut. A palette only a keyboard can reach is a palette most
	  people never find.

	  It is separate from the palette itself so the app can have several of
	  these (the top bar, the phone bar) and exactly one dialog.
	*/
	import Search from '@lucide/svelte/icons/search';
	import { openPalette } from './palette.svelte';

	let {
		/** 'bar' is the top bar's box, 'compact' is the phone bar's icon. */
		variant = 'bar'
	}: { variant?: 'bar' | 'compact' } = $props();
</script>

<button type="button" class="opener" class:compact={variant === 'compact'} onclick={openPalette}>
	<Search size={variant === 'compact' ? 18 : 14} strokeWidth={1.75} aria-hidden="true" />
	{#if variant === 'compact'}
		<span class="tag">Search</span>
	{:else}
		<span class="label">Search or jump to</span>
		<kbd>Ctrl K</kbd>
	{/if}
</button>

<style>
	.opener {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		height: var(--control-h);
		padding: 0 8px;
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		font: inherit;
		cursor: pointer;
		transition:
			background-color var(--speed) var(--ease),
			color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.opener:hover {
		background: var(--surface-hover);
		color: var(--text);
	}

	.opener:active {
		transform: scale(0.97);
	}

	kbd {
		font-family: inherit;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		padding: 0 4px;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	/* In the phone bar it matches the two entries beside it. */
	.opener.compact {
		flex-direction: column;
		justify-content: center;
		gap: 3px;
		width: 100%;
		height: 100%;
		border: 0;
		background: transparent;
		font-size: var(--fs-meta);
		line-height: 1;
	}

	.opener.compact .tag {
		font-weight: 500;
	}

	@media (max-width: 720px) {
		.opener .label {
			display: none;
		}

		.opener kbd {
			display: none;
		}
	}
</style>
