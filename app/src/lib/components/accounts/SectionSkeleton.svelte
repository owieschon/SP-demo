<script lang="ts">
	// What a streaming section looks like while its query runs: the same
	// panel, the same row height, shimmering placeholders instead of text,
	// so nothing jumps when the real rows arrive.
	let {
		title,
		rows = 4,
		wide = false
	}: { title: string; rows?: number; wide?: boolean } = $props();

	const lines = $derived(Array.from({ length: rows }, (_, i) => i));
</script>

<section class="panel" aria-hidden="true">
	<header class="panel-head">
		<span class="skeleton" style:width="110px" style:height="12px"></span>
	</header>
	{#each lines as line (line)}
		<div class="row">
			<span class="skeleton" style:width="{(wide ? 40 : 28) - (line % 3) * 5}%" style:height="11px"></span>
			<span class="skeleton" style:width="16%" style:height="11px"></span>
			<span class="skeleton" style:width="10%" style:height="11px"></span>
		</div>
	{/each}
	<span class="sr-only">Loading {title}</span>
</section>

<style>
	.panel {
		opacity: 0.8;
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		height: 34px;
		padding: 0 var(--space-3);
	}

	.row + .row {
		border-top: 1px solid var(--hairline);
	}
</style>
