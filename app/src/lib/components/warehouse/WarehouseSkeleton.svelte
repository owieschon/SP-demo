<script lang="ts">
	// What the warehouse floor looks like while it is on the way: the same
	// shapes as the real panels, shimmering, so nothing jumps when it lands.
	const FIGURES = [0, 1, 2, 3, 4, 5];
	const ROWS = [0, 1, 2, 3, 4];
</script>

<div class="stack" role="status" aria-label="Loading the warehouse floor">
	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="110px" style:height="12px"></span>
			<span class="skeleton" style:width="180px" style:height="10px"></span>
		</header>
		<div class="figures">
			{#each FIGURES as i (i)}
				<div class="figure">
					<span class="skeleton" style:width="80px" style:height="11px"></span>
					<span class="skeleton" style:width="36px" style:height="20px"></span>
					<span class="skeleton" style:width="100px" style:height="10px"></span>
					<span class="skeleton" style:width="70px" style:height="10px"></span>
				</div>
			{/each}
		</div>
		<div class="bar"><span class="skeleton" style:width="100%" style:height="4px"></span></div>
	</section>

	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="90px" style:height="12px"></span>
		</header>
		{#each ROWS as r (r)}
			<div class="row">
				<span class="skeleton" style:width="{26 - (r % 3) * 4}%" style:height="11px"></span>
				<span class="skeleton" style:width="20%" style:height="11px"></span>
				<span class="skeleton" style:width="14%" style:height="11px"></span>
				<span class="skeleton" style:width="80px" style:height="22px"></span>
			</div>
		{/each}
	</section>

	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="120px" style:height="12px"></span>
		</header>
		{#each ROWS as r (r)}
			<div class="row">
				<span class="skeleton" style:width="{30 - (r % 4) * 3}%" style:height="11px"></span>
				<span class="skeleton" style:width="16%" style:height="11px"></span>
				<span class="skeleton" style:width="10%" style:height="11px"></span>
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
		flex: 1 1 150px;
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
		height: 34px;
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
