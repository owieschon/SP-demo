<script lang="ts">
	/*
	  A small mark for one coding agent, drawn inline.

	  Every path is in this file. There is no <img>, no CDN, no icon package
	  and no fetch, so a connect panel renders the same on a plane as it does
	  in the office, and nothing about which agent a person uses leaves the
	  page.

	  These are simple recognisable marks, not the companies' artwork, and
	  they are drawn in currentColor so they sit in light and dark without a
	  second copy. They stand next to the product's name to identify a third
	  party tool; the page says as much underneath. Nothing here should be
	  read as those companies endorsing this app.
	*/
	import type { McpProviderId } from '$lib/mcp/providers';

	let {
		provider,
		size = 18
	}: {
		provider: McpProviderId;
		size?: number;
	} = $props();
</script>

<svg
	class="mark"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.6"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
>
	{#if provider === 'claude-code'}
		<!-- A radial burst: eight strokes out of one centre. -->
		<path d="M12 4v5M12 15v5M4 12h5M15 12h5" />
		<path d="M6.7 6.7l3.2 3.2M14.1 14.1l3.2 3.2M17.3 6.7l-3.2 3.2M9.9 14.1l-3.2 3.2" />
	{:else if provider === 'cursor'}
		<!-- A cube seen corner on: the outline and the three edges that meet. -->
		<path d="M12 3l8 4.6v8.8L12 21l-8-4.6V7.6z" />
		<path d="M12 12l8-4.4M12 12l-8-4.4M12 12v9" />
	{:else if provider === 'codex'}
		<!-- Codex: a ring with six nodes, the knot pattern reduced to its bones. -->
		<circle cx="12" cy="12" r="7.5" />
		<path d="M12 4.5v3M12 16.5v3M5.5 8.2l2.6 1.5M15.9 14.3l2.6 1.5M5.5 15.8l2.6-1.5M15.9 9.7l2.6-1.5" />
	{/if}
</svg>

<style>
	.mark {
		flex: none;
		display: block;
	}
</style>
