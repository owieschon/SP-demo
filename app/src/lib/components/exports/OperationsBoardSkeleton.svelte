<script lang="ts">
	// What the operations board looks like while it is on the way: the same
	// shapes as OperationsBoard.svelte, shimmering, so nothing jumps.
	const ROWS = [0, 1, 2, 3, 4, 5];
</script>

<div class="stack" role="status" aria-label="Loading open lines">
	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="90px" style:height="12px"></span>
			<span class="skeleton" style:width="200px" style:height="10px"></span>
		</header>
		<div class="figures">
			{#each [0, 1, 2, 3] as i (i)}
				<div class="figure">
					<span class="skeleton" style:width="70px" style:height="11px"></span>
					<span class="skeleton" style:width="40px" style:height="20px"></span>
					<span class="skeleton" style:width="110px" style:height="10px"></span>
					<span class="skeleton" style:width="80px" style:height="10px"></span>
				</div>
			{/each}
		</div>
		<div class="bar"><span class="skeleton" style:width="100%" style:height="4px"></span></div>
	</section>

	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="130px" style:height="12px"></span>
		</header>
		{#each ROWS as r (r)}
			<div class="row">
				<span class="skeleton" style:width="{28 - (r % 3) * 4}%" style:height="11px"></span>
				<span class="skeleton" style:width="18%" style:height="11px"></span>
				<span class="skeleton" style:width="12%" style:height="11px"></span>
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
		flex: 1 1 170px;
		display: grid;
		gap: 7px;
		padding: 12px var(--space-3);
	}

	.figure + .figure {
		border-left: 1px solid var(--hairline);
	}

	.bar {
		padding: 0 var(--space-3) var(--space-3);
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

	@media (max-width: 720px) {
		.figure {
			flex-basis: 45%;
		}

		.figure + .figure {
			border-left: 0;
		}
	}
</style>
