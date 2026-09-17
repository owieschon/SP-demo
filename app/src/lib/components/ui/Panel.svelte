<script lang="ts">
	/*
	  One section container. It draws the head, wires the heading to the
	  section with aria-labelledby, and marks itself busy while its data is
	  still streaming.

	    <Panel title="Open orders" asOf={a.today} source="this morning's ERP export">
	      {#snippet actions()}<a class="button sm" href="?all=1">Show all</a>{/snippet}
	      <table>...</table>
	    </Panel>

	  `asOf` and `source` are not decoration. A figure with no provenance is a
	  figure a person cannot argue with, so the panel that holds figures says
	  where they came from and when.
	*/
	import type { Snippet } from 'svelte';
	import { day } from '$lib/format';

	let {
		title,
		id = crypto.randomUUID().slice(0, 8),
		/** 'ISO date' the figures inside are true as of. */
		asOf,
		/** Where the figures came from, in a person's words. */
		source,
		/** The year that does not need saying in the as-of date. */
		thisYear,
		/** True while the data is still arriving, so the region says so. */
		busy = false,
		/** Set when the panel's own content already supplies its padding. */
		flush = false,
		actions,
		children
	}: {
		title: string;
		id?: string;
		asOf?: string;
		source?: string;
		thisYear?: number;
		busy?: boolean;
		flush?: boolean;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	const headingId = $derived(`panel-${id}-title`);
</script>

<section class="panel" aria-labelledby={headingId} aria-busy={busy || undefined}>
	<header class="panel-head">
		<h2 id={headingId}>{title}</h2>
		<div class="right">
			{#if source || asOf}
				<span class="t-meta muted provenance">
					{#if source}{source}{/if}{#if source && asOf}, {/if}{#if asOf}as of {day(asOf, thisYear)}{/if}
				</span>
			{/if}
			{#if actions}{@render actions()}{/if}
		</div>
	</header>
	<div class:panel-body={!flush}>
		{@render children()}
	</div>
</section>

<style>
	.right {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.provenance {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	/* On a phone the provenance line drops under the title rather than
	   squeezing it, so the heading always wins the space. */
	@media (max-width: 720px) {
		.panel-head {
			flex-wrap: wrap;
		}

		.provenance {
			white-space: normal;
		}
	}
</style>
