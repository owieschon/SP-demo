<script lang="ts" generics="Row">
	/*
	  One table, used everywhere.

	    <DataTable
	      columns={[
	        { key: 'item', header: 'Item', sort: { asc: 'item' } },
	        { key: 'desc', header: 'Description', width: '34%' },
	        { key: 'rev', header: 'Revenue 12m', align: 'right', sort: { asc: 'revenue' } }
	      ]}
	      rows={parts.rows}
	      rowKey={(p) => p.itemNo}
	      caption="Parts, by 12-month revenue"
	      sortParam="sort"
	      sort={q.sort}
	      shown={parts.rows.length}
	      total={parts.total}
	      noun="parts"
	      order="by 12-month revenue"
	      emptyLine="No part matches."
	    >
	      {#snippet row(part)}
	        <td class="mono"><a class="link" href={routes.part(part.itemNo)}>{part.itemNo}</a></td>
	        <td>{part.description}</td>
	        <td class="num"><Money value={part.revenue12m} /></td>
	      {/snippet}
	    </DataTable>

	  The caller writes the cells, because only the caller knows what a cell
	  means. Everything a table gets wrong when it is built by hand is in
	  here: `scope="col"` on every header (there were 166 headers in this app
	  and none had it), a sticky header, a real <caption>, a sortable header
	  that is an anchor carrying the sort in the URL with `aria-sort` on the
	  cell, a scroller a keyboard can reach, and a footer that says how many
	  rows are hidden instead of letting the first fifty read as all of them.

	  A row is reachable from the keyboard because the record's name in it is
	  a link, which is the convention throughout this app: middle-click and
	  copy-link then work, which they do not on a clickable <tr>.
	*/
	import type { Snippet } from 'svelte';
	import { page } from '$app/state';
	import EmptyState from './EmptyState.svelte';
	import { ariaSortValue, nextSortValue, rowCountLine, type ColumnSort } from './table';

	export interface Column {
		/** Unique within the table; only used as the key for the header cells. */
		key: string;
		header: string;
		/** Figures go right. Anything a person reads goes left. */
		align?: 'left' | 'right';
		/** A CSS width for the column, when one column should take the room. */
		width?: string;
		/** Makes the header a link that sorts, through the URL. */
		sort?: ColumnSort;
		/** Hide the header text but keep it for a screen reader (action columns). */
		hideHeader?: boolean;
	}

	let {
		columns,
		rows,
		rowKey,
		/** What the table is, as a sentence. It becomes the <caption>. */
		caption,
		/** Show the caption. It is for a screen reader only by default. */
		captionVisible = false,
		/** The query parameter the sort lives in. */
		sortParam = 'sort',
		/** The sort value currently in the URL. */
		sort = null,
		/** How many rows are on screen. Defaults to what was passed in. */
		shown,
		/** How many rows there are in total, from the server, not this array. */
		total,
		/** What the rows are, in the plural: 'parts', 'lines'. */
		noun,
		/** How the rows were sorted, for the footer line. */
		order,
		/** Where the rest of the rows are, if anywhere. */
		allHref,
		/** Keep the header in place. On by default: a table can always grow. */
		sticky = true,
		emptyLine,
		emptyAction,
		emptyHref,
		row,
		/** A last cell per row for its actions. Name them with their record. */
		action,
		/** Extra content in the footer, next to the count. */
		footer
	}: {
		columns: Column[];
		rows: Row[];
		rowKey: (row: Row) => string | number;
		caption: string;
		captionVisible?: boolean;
		sortParam?: string;
		sort?: string | null;
		shown?: number;
		total?: number;
		noun: string;
		order?: string;
		allHref?: string;
		sticky?: boolean;
		emptyLine?: string;
		emptyAction?: string;
		emptyHref?: string;
		row: Snippet<[Row]>;
		action?: Snippet<[Row]>;
		footer?: Snippet;
	} = $props();

	const onScreen = $derived(shown ?? rows.length);
	const allRows = $derived(total ?? onScreen);
	const countLine = $derived(rowCountLine({ shown: onScreen, total: allRows, noun, order }));

	/** The sort link for one column: this URL with the sort changed, page one. */
	function sortHref(columnSort: ColumnSort): string {
		const params = new URLSearchParams(page.url.search);
		params.set(sortParam, nextSortValue(columnSort, sort));
		params.delete('page');
		const query = params.toString();
		return query ? `?${query}` : '?';
	}
</script>

{#if rows.length === 0 && emptyLine}
	<EmptyState line={emptyLine} action={emptyAction} href={emptyHref} />
{:else}
	<!--
		tabindex makes the scroller itself reachable, which an overflow
		container is not by default: without it a keyboard user cannot scroll
		a wide table sideways at all.
	-->
	<div class="table-wrap" tabindex="0" role="group" aria-label={caption}>
		<table class:sticky>
			<caption class:sr-only={!captionVisible}>{caption}</caption>
			<thead>
				<tr>
					{#each columns as column (column.key)}
						<th
							scope="col"
							class:num={column.align === 'right'}
							style:width={column.width}
							aria-sort={ariaSortValue(column.sort, sort)}
						>
							{#if column.sort}
								<a class="sort" href={sortHref(column.sort)} data-sveltekit-keepfocus>
									<span class:sr-only={column.hideHeader}>{column.header}</span>
									<span class="arrow" aria-hidden="true">
										{#if sort === column.sort.asc}&uarr;{:else if column.sort.desc && sort === column.sort.desc}&darr;{/if}
									</span>
								</a>
							{:else}
								<span class:sr-only={column.hideHeader}>{column.header}</span>
							{/if}
						</th>
					{/each}
					{#if action}
						<th scope="col" class="actions"><span class="sr-only">Row actions</span></th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each rows as item (rowKey(item))}
					<tr>
						{@render row(item)}
						{#if action}
							<td class="actions">{@render action(item)}</td>
						{/if}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<!--
		Always shown, even when nothing is hidden. A count that appears only
		when a list is truncated is a count nobody learns to look for.
	-->
	<div class="foot">
		<span class="t-meta muted">{countLine}</span>
		<span class="foot-right">
			{#if footer}{@render footer()}{/if}
			{#if allHref && allRows > onScreen}
				<a class="button sm" href={allHref}>Show all {allRows}</a>
			{/if}
		</span>
	</div>
{/if}

<style>
	/* A sticky header needs the scroller to be the one that scrolls. */
	.table-wrap {
		max-height: min(70dvh, 720px);
		overflow: auto;
	}

	.table-wrap:focus-visible {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
	}

	caption {
		text-align: left;
		padding: 6px var(--space-3);
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	/* The header link fills the cell, so the whole header is the target. */
	.sort {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		border-radius: var(--radius-sm);
		color: inherit;
		transition: color var(--speed) var(--ease);
	}

	.sort:hover {
		color: var(--text);
	}

	/* The arrow's room is always reserved, so sorting does not shift a header. */
	.arrow {
		display: inline-block;
		min-width: 8px;
		color: var(--text);
	}

	th[aria-sort='ascending'] .sort,
	th[aria-sort='descending'] .sort {
		color: var(--text);
		font-weight: 600;
	}

	.actions {
		width: 1%;
		white-space: nowrap;
		text-align: right;
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: 6px var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	.foot-right {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
