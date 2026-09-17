<script lang="ts">
	/*
	  A truncated list has to say so. Fourteen tables in this app show the
	  server's first N rows and read as though they were the whole thing.

	    <RowCount shown={lines.length} total={lineCount} noun="lines"
	              order="oldest ship date first" allHref="?all=1" />

	  When nothing is hidden it renders the plain count, so the line does
	  not shout at a list that happens to be short.
	*/
	import { count } from '$lib/format';

	let {
		shown,
		total,
		/** What is being counted, in the plural: 'lines', 'shipments'. */
		noun,
		/** How the rows were sorted, so the reader knows which N these are. */
		order,
		/** Where the rest of the rows are, if anywhere. */
		allHref
	}: {
		shown: number;
		total: number;
		noun: string;
		order?: string;
		allHref?: string;
	} = $props();

	const hidden = $derived(total > shown);
</script>

<span class="t-meta muted">
	{#if hidden}
		{count(shown)} of {count(total)} {noun}{#if order}, {order}{/if}.
		{#if allHref}
			<a class="link" href={allHref}>Show all {count(total)}</a>
		{/if}
	{:else}
		{count(total)} {noun}
	{/if}
</span>
