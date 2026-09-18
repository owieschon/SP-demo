<script lang="ts">
	// What the desk looks like while it is on the way: the same shapes as the
	// real panels, shimmering, so nothing jumps when the data lands.
	//
	// The buying list reads the whole catalog, so this is on screen for a
	// moment on every load, not only on a slow connection.
	const GROUPS = [0, 1, 2];
	const ROWS = [0, 1, 2, 3, 4];
</script>

<div class="stack" role="status" aria-label="Working out what needs buying">
	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="130px" style:height="12px"></span>
			<span class="skeleton" style:width="180px" style:height="10px"></span>
		</header>
		{#each GROUPS as g (g)}
			<div class="group">
				<div class="head">
					<span class="skeleton" style:width="{34 - g * 6}%" style:height="12px"></span>
					<span class="skeleton" style:width="90px" style:height="12px"></span>
				</div>
				{#if g === 0}
					{#each ROWS as r (r)}
						<div class="row">
							<span class="skeleton" style:width="{22 - (r % 3) * 3}%" style:height="11px"></span>
							<span class="skeleton" style:width="8%" style:height="11px"></span>
							<span class="skeleton" style:width="8%" style:height="11px"></span>
							<span class="skeleton" style:width="{30 - (r % 2) * 6}%" style:height="11px"></span>
						</div>
					{/each}
				{/if}
			</div>
		{/each}
	</section>

	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="110px" style:height="12px"></span>
		</header>
		{#each [0, 1] as r (r)}
			<div class="row">
				<span class="skeleton" style:width="26%" style:height="11px"></span>
				<span class="skeleton" style:width="14%" style:height="11px"></span>
				<span class="skeleton" style:width="10%" style:height="11px"></span>
			</div>
		{/each}
	</section>

	<section class="panel" aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="70px" style:height="12px"></span>
			<span class="skeleton" style:width="150px" style:height="10px"></span>
		</header>
		<div class="kinds">
			{#each [0, 1, 2, 3] as i (i)}
				<div class="kind">
					<span class="skeleton" style:width="80px" style:height="10px"></span>
					<span class="skeleton" style:width="34px" style:height="18px"></span>
					<span class="skeleton" style:width="100px" style:height="10px"></span>
				</div>
			{/each}
		</div>
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

	.group + .group {
		border-top: 1px solid var(--hairline);
	}

	.head,
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		height: 34px;
		padding: 0 var(--space-3);
	}

	.row + .row,
	.head + .row {
		border-top: 1px solid var(--hairline);
	}

	.kinds {
		display: flex;
		flex-wrap: wrap;
	}

	.kind {
		flex: 1 1 180px;
		display: grid;
		gap: 6px;
		padding: 10px var(--space-3);
	}

	.kind + .kind {
		border-left: 1px solid var(--hairline);
	}

	@media (max-width: 720px) {
		.kind {
			flex-basis: 45%;
		}

		.kind + .kind {
			border-left: 0;
		}
	}
</style>
