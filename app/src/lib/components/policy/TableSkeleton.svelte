<script lang="ts">
	// A table on the way: the same shapes, shimmering. Never the word "loading".
	let { rows = 4, label = 'Loading' }: { rows?: number; label?: string } = $props();
	const widths = [42, 26, 18, 30, 22, 36, 14];
</script>

<div class="wrap" role="status" aria-label={label}>
	{#each Array.from({ length: rows }, (_, i) => i) as row (row)}
		<div class="line" aria-hidden="true">
			<span class="skeleton" style:width="{widths[row % widths.length]}%" style:height="11px"></span>
			<span class="skeleton" style:width="{widths[(row + 3) % widths.length]}%" style:height="11px"></span>
			<span class="skeleton" style:width="64px" style:height="11px"></span>
		</div>
	{/each}
</div>

<style>
	.wrap {
		opacity: 0.8;
	}

	.line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		height: 32px;
		padding: 0 var(--space-3);
	}

	.line + .line {
		border-top: 1px solid var(--hairline);
	}
</style>
