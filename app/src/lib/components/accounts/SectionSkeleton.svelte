<script lang="ts">
	// What a streaming section looks like while its query runs: the same
	// panel, the same row height, shimmering placeholders instead of text,
	// so nothing jumps when the real rows arrive.
	let {
		title,
		rows = 4,
		wide = false
	}: { title: string; rows?: number; wide?: boolean } = $props();

	const lines = $derived(Array.from({ length: rows }, (_, i) => i));
</script>

<!--
	role="status" on the section and aria-hidden on the shimmer inside it.

	This used to be aria-hidden="true" on the <section> with the "Loading
	{title}" text inside it, which put the announcement inside the hidden
	subtree: an account page streams six sections and a screen reader was
	told nothing about any of them. The sibling TableSkeleton had it the
	right way round.
-->
<section class="panel" role="status" aria-label="Loading {title}">
	<div aria-hidden="true">
		<header class="panel-head">
			<span class="skeleton" style:width="110px" style:height="12px"></span>
		</header>
		{#each lines as line (line)}
			<div class="row">
				<span class="skeleton" style:width="{(wide ? 40 : 28) - (line % 3) * 5}%" style:height="11px"></span>
				<span class="skeleton" style:width="16%" style:height="11px"></span>
				<span class="skeleton" style:width="10%" style:height="11px"></span>
			</div>
		{/each}
	</div>
</section>

<style>
	.panel {
		opacity: 0.8;
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
</style>
