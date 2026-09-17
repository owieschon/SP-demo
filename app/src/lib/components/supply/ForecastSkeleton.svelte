<script lang="ts">
	// What the forecast looks like while it is on the way: the same shapes as
	// ForecastBoard.svelte, shimmering, so nothing jumps when it arrives.
	const ROWS = [0, 1, 2, 3, 4, 5, 6];
</script>

<div class="stack" role="status" aria-label="Working out the projection">
	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="150px" style:height="12px"></span>
			<span class="skeleton" style:width="180px" style:height="10px"></span>
		</header>
		<div class="figures">
			{#each [0, 1, 2, 3] as i (i)}
				<div class="figure">
					<span class="skeleton" style:width="90px" style:height="11px"></span>
					<span class="skeleton" style:width="70px" style:height="20px"></span>
					<span class="skeleton" style:width="120px" style:height="10px"></span>
				</div>
			{/each}
		</div>
	</section>

	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="170px" style:height="12px"></span>
			<span class="skeleton" style:width="40px" style:height="10px"></span>
		</header>
		{#each ROWS as r (r)}
			<div class="row">
				<span class="skeleton" style:width="{26 - (r % 3) * 5}%" style:height="11px"></span>
				<span class="skeleton" style:width="14%" style:height="11px"></span>
				<span class="skeleton" style:width="10%" style:height="11px"></span>
				<span class="skeleton" style:width="{22 + (r % 2) * 8}%" style:height="11px"></span>
				<span class="skeleton" style:width="8%" style:height="11px"></span>
			</div>
		{/each}
	</section>
</div>

<style>
	.stack {
		display: grid;
		gap: var(--space-3);
	}

	.panel {
		opacity: 0.8;
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
	}

	.figure {
		flex: 1 1 190px;
		display: grid;
		gap: 7px;
		padding: 12px var(--space-3);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 11px var(--space-3);
		border-top: 1px solid var(--hairline);
	}
</style>
