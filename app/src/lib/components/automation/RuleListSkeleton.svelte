<script lang="ts">
	// The rule list while it is on the way: the same shapes, shimmering.
	const ROWS = [0, 1, 2, 3];
</script>

<div class="panel" role="status" aria-label="Loading rules">
	{#each ROWS as r (r)}
		<div class="row" aria-hidden="true">
			<div class="line">
				<span class="skeleton" style:width="{34 - r * 4}%" style:height="12px"></span>
				<span class="skeleton" style:width="40px" style:height="16px"></span>
			</div>
			<span class="skeleton" style:width="{88 - r * 6}%" style:height="10px"></span>
			<span class="skeleton" style:width="30%" style:height="10px"></span>
		</div>
	{/each}
</div>

<style>
	.panel {
		opacity: 0.8;
	}

	.row {
		display: grid;
		gap: 8px;
		padding: 12px var(--space-3);
	}

	.row + .row {
		border-top: 1px solid var(--hairline);
	}

	.line {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
</style>
