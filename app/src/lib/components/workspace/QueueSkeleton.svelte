<script lang="ts">
	// The queue while it loads: the same rows, shimmering.
	const ROWS = [0, 1, 2, 3, 4];
</script>

<ul class="rows" role="status" aria-label="Loading what is waiting">
	{#each ROWS as i (i)}
		<li aria-hidden="true">
			<span class="skeleton" style:width="84px" style:height="11px"></span>
			<span class="skeleton grow" style:width="{58 - i * 6}%" style:height="11px"></span>
			<span class="skeleton" style:width="64px" style:height="11px"></span>
			<span class="skeleton" style:width="72px" style:height="11px"></span>
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
		height: 40px;
		padding: 0 var(--space-3);
	}

	li + li {
		border-top: 1px solid var(--hairline);
	}

	.grow {
		flex: none;
		margin-right: auto;
	}
</style>
