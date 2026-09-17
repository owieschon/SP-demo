<script lang="ts">
	/*
	  The bar above a list: search, filters, a view switch, and how many rows
	  the filters found.

	    <Toolbar action="/accounts" searchName="q" searchValue={f.q}
	             searchLabel="Search by name, number or city"
	             searchPlaceholder="Name, customer number or city"
	             resultCount="512 accounts" filtered={anyFilterSet}
	             clearHref="/accounts">
	      {#snippet filters()} ... selects and checkboxes ... {/snippet}
	      {#snippet view()}<Tabs ... />{/snippet}
	    </Toolbar>

	  It is a plain GET form, so the state of the list is the URL: every view
	  can be linked, bookmarked and handed to somebody else, and the whole
	  thing works with JavaScript off. `keepfocus` means changing a filter
	  does not throw a person out of the box they were typing in.

	  Hidden fields carry the parameters that are not controls in this form
	  (the sort, the whose-records switch) so submitting a search does not
	  quietly reset them.
	*/
	import Search from '@lucide/svelte/icons/search';
	import type { Snippet } from 'svelte';

	let {
		action,
		/** Parameters this form must not lose: { sort: 'revenue', who: 'mine' }. */
		keep = {},
		searchName,
		searchValue = '',
		searchLabel,
		searchPlaceholder,
		/** The Apply or Search button's label. */
		submitLabel = 'Search',
		/** What the filters found, already formatted: "512 accounts". */
		resultCount,
		/** True when any filter is set, so Clear is only offered when it helps. */
		filtered = false,
		clearHref,
		filters,
		view
	}: {
		action: string;
		keep?: Record<string, string>;
		searchName?: string;
		searchValue?: string;
		searchLabel?: string;
		searchPlaceholder?: string;
		submitLabel?: string;
		resultCount?: string;
		filtered?: boolean;
		clearHref?: string;
		filters?: Snippet;
		view?: Snippet;
	} = $props();
</script>

<div class="toolbar">
	<form class="bar" method="GET" {action} role="search" data-sveltekit-keepfocus>
		{#each Object.entries(keep) as [name, value] (name)}
			<input type="hidden" {name} {value} />
		{/each}

		{#if searchName}
			<label class="find">
				<span class="sr-only">{searchLabel ?? 'Search'}</span>
				<span class="with-icon">
					<Search size={14} strokeWidth={1.75} aria-hidden="true" />
					<input
						type="search"
						name={searchName}
						value={searchValue}
						maxlength="80"
						placeholder={searchPlaceholder}
					/>
				</span>
			</label>
		{/if}

		{#if filters}{@render filters()}{/if}

		<button class="button primary">{submitLabel}</button>
		{#if filtered && clearHref}
			<a class="button quiet" href={clearHref}>Clear</a>
		{/if}
	</form>

	{#if resultCount || view}
		<div class="found">
			{#if resultCount}<span class="t-meta muted">{resultCount}</span>{/if}
			{#if view}{@render view()}{/if}
		</div>
	{/if}
</div>

<style>
	.toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		min-width: 0;
	}

	/* Flexbox, so the bar wraps to one control per line on a phone. */
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		flex: 1 1 320px;
		min-width: 0;
	}

	.find {
		flex: 1 1 240px;
		min-width: 0;
	}

	.with-icon {
		position: relative;
		display: block;
	}

	.with-icon :global(svg) {
		position: absolute;
		top: 50%;
		left: 8px;
		transform: translateY(-50%);
		color: var(--text-faint);
		pointer-events: none;
	}

	.with-icon input {
		width: 100%;
		height: var(--control-h);
		padding-left: 28px;
	}

	.found {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex: none;
	}
</style>
