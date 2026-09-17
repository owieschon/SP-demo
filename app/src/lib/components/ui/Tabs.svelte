<script lang="ts">
	/*
	  Tabs that live in the URL, so a link opens the same view a person is
	  looking at and an agent can be handed one.

	    <Tabs param="view" tabs={[
	      { value: 'queue', label: 'Pick queue' },
	      { value: 'counts', label: 'Counts' }
	    ]} current={data.view} label="Warehouse view" />

	  They are anchors, not buttons, so middle-click and copy-link work.
	  `aria-current="page"` rather than `aria-selected`, because a link that
	  navigates is a link: a real tablist would need the panels to live in
	  the same document, which they do not here.
	*/
	import { page } from '$app/state';

	let {
		param,
		tabs,
		current,
		label
	}: {
		/** The query parameter that holds the choice. */
		param: string;
		tabs: { value: string; label: string; count?: number }[];
		current: string;
		label: string;
	} = $props();

	// Keep every other parameter, so switching a tab does not clear filters.
	function href(value: string): string {
		const params = new URLSearchParams(page.url.search);
		params.set(param, value);
		return `?${params}`;
	}
</script>

<nav class="segmented" aria-label={label}>
	{#each tabs as tab (tab.value)}
		<a href={href(tab.value)} aria-current={tab.value === current ? 'page' : undefined}>
			{tab.label}
			{#if tab.count !== undefined && tab.count > 0}
				<span class="count">{tab.count}</span>
			{/if}
		</a>
	{/each}
</nav>

<style>
	/* Zero is not news: a count only shows when there is something to see,
	   which is why the caller's `count` is skipped at 0 above. */
	.count {
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}
</style>
