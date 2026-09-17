<script lang="ts">
	// What the board looks like while its rows are on the way: the same
	// shapes, shimmering. Shaped like Board.svelte so nothing jumps when the
	// real rows replace it.
	import { STATUS_ORDER } from '$lib/types';
	import StatusBadge from './StatusBadge.svelte';

	// A few rows per column, different in each so it does not look like a grid.
	const ROWS = [3, 4, 2, 3, 1, 1];
</script>

<div class="summary" aria-hidden="true">
	{#each [0, 1, 2, 3] as i (i)}
		<div class="figure">
			<span class="skeleton" style:width="52px" style:height="10px"></span>
			<span class="skeleton" style:width="{i === 0 ? 32 : 84}px" style:height="18px"></span>
		</div>
	{/each}
</div>

<div class="board" role="status" aria-label="Loading commitments">
	{#each STATUS_ORDER as status, c (status)}
		<section class="column panel" aria-hidden="true">
			<header class="column-head">
				<StatusBadge {status} />
			</header>
			<div class="column-total">
				<span class="skeleton" style:width="120px" style:height="10px"></span>
			</div>
			{#each Array.from({ length: ROWS[c] }, (_, i) => i) as r (r)}
				<div class="row">
					<span class="skeleton" style:width="{70 - ((r + c) % 3) * 12}%" style:height="12px"></span>
					<span class="skeleton" style:width="45%" style:height="10px"></span>
					<span class="skeleton" style:width="100%" style:height="4px"></span>
					<span class="skeleton" style:width="60%" style:height="10px"></span>
				</div>
			{/each}
		</section>
	{/each}
</div>

<style>
	.summary {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-5);
		min-height: 36px;
		align-items: center;
	}

	.figure {
		display: grid;
		gap: 6px;
	}

	.board {
		display: grid;
		grid-template-columns: repeat(6, minmax(232px, 1fr));
		gap: var(--space-2);
		align-items: start;
		overflow-x: hidden;
	}

	.column {
		min-width: 0;
		opacity: 0.8;
	}

	.column-head {
		padding: 8px var(--space-3) 0;
	}

	.column-total {
		padding: 6px var(--space-3) 10px;
		border-bottom: 1px solid var(--hairline);
	}

	.row {
		display: grid;
		gap: 8px;
		padding: 12px var(--space-3);
	}

	.row + .row {
		border-top: 1px solid var(--hairline);
	}

	@media (max-width: 720px) {
		.board {
			grid-template-columns: 1fr;
		}
	}
</style>
