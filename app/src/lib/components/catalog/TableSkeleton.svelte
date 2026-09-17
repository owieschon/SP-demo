<script lang="ts">
	// A panel-shaped placeholder while a table streams in: the same hairlines
	// and row height as the real table, shimmering, so nothing jumps.
	let { rows = 6, title = 'Loading' }: { rows?: number; title?: string } = $props();

	// Row widths vary a little, which reads as text rather than as blocks.
	const widths = $derived(Array.from({ length: rows }, (_, i) => 30 - (i % 4) * 5));
</script>

<section class="panel" role="status" aria-label={title}>
	<header class="panel-head">
		<span class="skeleton" style:width="120px" style:height="12px"></span>
	</header>
	{#each widths as width, i (i)}
		<div class="row" aria-hidden="true">
			<span class="skeleton" style:width="{width}%" style:height="11px"></span>
			<span class="skeleton" style:width="16%" style:height="11px"></span>
			<span class="skeleton" style:width="10%" style:height="11px"></span>
		</div>
	{/each}
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
		height: 32px;
		padding: 0 var(--space-3);
	}

	.row + .row {
		border-top: 1px solid var(--hairline);
	}
</style>
