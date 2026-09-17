<script lang="ts">
	/*
	  A placeholder that is told the shape of what is coming, so the page
	  does not jump when it arrives. Every skeleton in the app guessed: four
	  rows at 34px standing in for fifty rows at 51px, three bars standing
	  in for eight columns.

	    <SkeletonRows rows={12} cols={8} height={32} header />

	  Pass the same numbers the real component uses: `rows` the server's
	  limit (or what fits on screen, whichever is smaller), `cols` the real
	  column count, `height` the real row height (a table row is 32px, which
	  is `td { height }` in app.css).
	*/
	let {
		rows = 8,
		cols = 4,
		/** The real row height in pixels. */
		height = 32,
		/** Draw a header bar, for a table with a thead. */
		header = false,
		/** What is loading, for the screen reader. */
		label
	}: {
		rows?: number;
		cols?: number;
		height?: number;
		header?: boolean;
		label: string;
	} = $props();

	const rowList = $derived(Array.from({ length: rows }, (_, i) => i));
	const colList = $derived(Array.from({ length: cols }, (_, i) => i));

	// The first column is the name and takes the room; the rest are figures.
	function width(col: number, row: number): string {
		if (col === 0) return `${34 - (row % 3) * 4}%`;
		return `${Math.max(6, 14 - col)}%`;
	}
</script>

<div role="status" aria-label={label}>
	{#if header}
		<div class="row head" aria-hidden="true">
			{#each colList as col (col)}
				<span class="skeleton" style:width={width(col, 0)} style:height="9px"></span>
			{/each}
		</div>
	{/if}
	{#each rowList as row (row)}
		<div class="row" style:height="{height}px" aria-hidden="true">
			{#each colList as col (col)}
				<span class="skeleton" style:width={width(col, row)} style:height="11px"></span>
			{/each}
		</div>
	{/each}
</div>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-3);
		border-bottom: 1px solid var(--hairline);
	}

	/* The header bar matches th: 6px of padding above and below. */
	.row.head {
		height: 27px;
	}

	.row:last-child {
		border-bottom: 0;
	}

	/* Figures sit to the right, as they do in the real table. */
	.row > span:first-child {
		margin-right: auto;
	}
</style>
