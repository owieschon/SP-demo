<script lang="ts">
	// The inbox or the queue while it loads: the same rows, shimmering.
	let { rows = 5, label = 'Loading' }: { rows?: number; label?: string } = $props();
	const lines = $derived(Array.from({ length: rows }, (_, i) => i));
</script>

<ul class="rows" role="status" aria-label={label}>
	{#each lines as i (i)}
		<li aria-hidden="true">
			<span class="skeleton" style:width="52px" style:height="11px"></span>
			<span class="stack">
				<span class="skeleton" style:width="{68 - i * 7}%" style:height="11px"></span>
				<span class="skeleton" style:width="{44 - i * 5}%" style:height="9px"></span>
			</span>
			<span class="skeleton" style:width="78px" style:height="11px"></span>
		</li>
	{/each}
</ul>

<style>
	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 48px;
		padding: 6px var(--space-3);
	}

	li + li {
		border-top: 1px solid var(--hairline);
	}

	.stack {
		flex: 1;
		display: grid;
		gap: 5px;
	}
</style>
