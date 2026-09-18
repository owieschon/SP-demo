<script lang="ts">
	/*
	  The parts list: one Page, one Toolbar, one Panel, one DataTable.

	  The filters are a GET form, so the state of the list is the URL. The
	  three sortable columns are header links that carry the sort in the query
	  string, which replaces the select that used to sit in the filter bar:
	  the header is where a person looks for a sort, and a link can be shared.
	*/
	import PartFlags from '$lib/components/catalog/PartFlags.svelte';
	import { PART_SORT_LABEL } from '$lib/components/catalog/types';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Money from '$lib/components/ui/Money.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import Qty from '$lib/components/ui/Qty.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import Toolbar from '$lib/components/ui/Toolbar.svelte';
	import WhenDate from '$lib/components/ui/WhenDate.svelte';
	import { count, percent } from '$lib/format';
	import { routes } from '$lib/routes';
	import type { Column } from '$lib/components/ui/table';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = $derived(data.query);
	const filtered = $derived(Boolean(q.q || q.family || q.short || q.belowReorder));

	const columns: Column[] = [
		{ key: 'item', header: 'Item' },
		{ key: 'desc', header: 'Description', width: '32%' },
		{ key: 'family', header: 'Family' },
		{ key: 'onHand', header: 'On hand', align: 'right', sort: { asc: 'on_hand' } },
		{ key: 'units', header: 'Units 12m', align: 'right' },
		{ key: 'revenue', header: 'Revenue 12m', align: 'right', sort: { asc: 'revenue' } },
		{ key: 'margin', header: 'Margin', align: 'right', sort: { asc: 'margin' } },
		{ key: 'lastSold', header: 'Last sold', align: 'right' }
	];

	// With JavaScript on, changing a filter submits the form at once. Without
	// it, the Apply button does the same thing.
	function submitNow(event: Event) {
		(event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
	}
</script>

<Page
	title="Parts"
	subtitle="What each part sold in the last twelve months, what it earns, and what is promised against it. Search by number or by words from the description."
>
	{#await data.parts}
		<Toolbar
			action={routes.parts()}
			keep={{ sort: q.sort }}
			searchName="q"
			searchValue={q.q}
			searchLabel="Search parts by number or description"
			searchPlaceholder="Number or description, for example 8 chrome stack"
			submitLabel="Apply"
			{filtered}
			clearHref={routes.parts()}
		/>
		<Panel title="Parts" busy flush>
			<SkeletonRows rows={10} cols={8} header label="Loading parts" />
		</Panel>
	{:then parts}
		<Toolbar
			action={routes.parts()}
			keep={{ sort: q.sort }}
			searchName="q"
			searchValue={q.q}
			searchLabel="Search parts by number or description"
			searchPlaceholder="Number or description, for example 8 chrome stack"
			submitLabel="Apply"
			resultCount="{count(parts.total)} {parts.total === 1 ? 'part' : 'parts'} match"
			{filtered}
			clearHref={routes.parts()}
		>
			{#snippet filters()}
				<label>
					<span class="sr-only">Family</span>
					{#await data.families}
						<select disabled aria-busy="true">
							<option value="">Loading families</option>
						</select>
					{:then families}
						<select name="family" onchange={submitNow}>
							<option value="">Every family</option>
							{#each families as family (family.family)}
								<option value={family.family} selected={family.family === q.family}>
									{family.family} ({count(family.items)})
								</option>
							{/each}
						</select>
					{/await}
				</label>

				<label class="tick">
					<input type="checkbox" name="short" value="1" checked={q.short} onchange={submitNow} />
					<span>Short on open orders</span>
				</label>

				<label class="tick">
					<input
						type="checkbox"
						name="reorder"
						value="1"
						checked={q.belowReorder}
						onchange={submitNow}
					/>
					<span>Below reorder point</span>
				</label>
			{/snippet}
		</Toolbar>

		<Panel title="Parts" flush>
			<DataTable
				{columns}
				rows={parts.rows}
				rowKey={(part) => part.itemNo}
				caption="Parts, sorted by {PART_SORT_LABEL[q.sort].toLowerCase()}"
				sort={q.sort}
				total={parts.total}
				noun="parts"
				order="by {PART_SORT_LABEL[q.sort].toLowerCase()}"
				emptyLine="No part matches those filters."
				emptyAction="Clear the filters"
				emptyHref={routes.parts()}
			>
				{#snippet row(part)}
					<td class="mono"><a class="link" href={routes.part(part.itemNo)}>{part.itemNo}</a></td>
					<td class="desc">
						{part.description}
						<PartFlags {part} compact />
					</td>
					<td class="muted">{part.family}</td>
					<td class="num"><Qty value={part.onHand} unit="pieces" bare /></td>
					<td class="num"><Qty value={part.units12m} unit="units" bare /></td>
					<td class="num"><Money value={part.revenue12m} /></td>
					<td class="num">
						{#if part.margin12m === null}
							<span class="muted">no cost on file</span>
						{:else}
							{percent(part.margin12m)}
						{/if}
					</td>
					<td class="num">
						<WhenDate iso={part.lastSoldOn} thisYear={data.year} fallback="never" />
					</td>
				{/snippet}
			</DataTable>
		</Panel>
	{:catch}
		<LoadFailed what="the parts" />
	{/await}
</Page>

<style>
	.tick {
		display: flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}

	.desc {
		min-width: 22ch;
	}
</style>
