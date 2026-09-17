<script lang="ts">
	// The conversation while it loads: a question, an answer, a lookup line.
	let { turns = 2 }: { turns?: number } = $props();

	const list = $derived(Array.from({ length: turns }, (_, i) => i));
</script>

<div class="thread" role="status" aria-label="Loading the conversation">
	{#each list as turn (turn)}
		<div class="turn" aria-hidden="true">
			<span class="skeleton asked" style:width="{46 - turn * 10}%" style:height="20px"></span>
			<span class="skeleton" style:width="{92 - turn * 12}%" style:height="11px"></span>
			<span class="skeleton" style:width="{78 - turn * 10}%" style:height="11px"></span>
			<span class="skeleton" style:width="{52 - turn * 8}%" style:height="11px"></span>
			<span class="skeleton looked" style:width="180px" style:height="24px"></span>
		</div>
	{/each}
</div>

<style>
	.thread {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-3) 0;
	}

	.turn {
		display: grid;
		gap: 8px;
		justify-items: start;
	}

	.asked {
		border-radius: var(--radius-lg);
	}

	.looked {
		border-radius: var(--radius);
		margin-top: 4px;
	}
</style>
