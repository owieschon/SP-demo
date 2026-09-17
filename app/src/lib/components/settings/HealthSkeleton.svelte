<script lang="ts">
	// What Health looks like while the checks run, in the same shapes as
	// HealthPanel.svelte so nothing jumps when they arrive.
	const LINES = [0, 1, 2, 3, 4, 5, 6, 7];
</script>

<section class="panel" role="status" aria-label="Running the health checks">
	<header class="panel-head" aria-hidden="true">
		<span class="skeleton" style:width="60px" style:height="12px"></span>
		<span class="skeleton" style:width="220px" style:height="10px"></span>
	</header>
	{#each LINES as line (line)}
		<div class="line" aria-hidden="true">
			<span class="skeleton dot"></span>
			<span class="skeleton" style:width="{110 - (line % 3) * 20}px" style:height="11px"></span>
			<span class="skeleton" style:width="{30 + (line % 4) * 8}%" style:height="11px"></span>
		</div>
	{/each}
</section>

<style>
	.panel {
		opacity: 0.8;
	}

	.line {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
	}

	.line + .line {
		border-top: 1px solid var(--hairline);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}
</style>
