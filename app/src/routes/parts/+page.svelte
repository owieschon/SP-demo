<script lang="ts">
	import Blank from '$lib/components/ui/Blank.svelte';
	import PartFlags from '$lib/components/catalog/PartFlags.svelte';
	import TableSkeleton from '$lib/components/catalog/TableSkeleton.svelte';
	import { PART_SORT_LABEL, PART_SORTS, partHref } from '$lib/components/catalog/types';
	import { count, day, money, percent } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = $derived(data.query);

	// With JavaScript on, changing a filter submits the form at once. Without
	// it, the Apply button does the same thing.
	function submitNow(event: Event) {
		(event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
	}
</script>

<svelte:head>
	<title>Parts · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Parts</h1>
		<p class="faint">
			Every part we sell, with what it sold in the last 12 months, what it earns and what
			is promised against it. Search by number or by words from the description.
		</p>
	</header>

	<!-- A plain GET form: the filters end up in the URL. -->
	<form class="filters panel" method="GET" data-sveltekit-keepfocus>
		<label class="grow">
			<span class="sr-only">Search parts</span>
			<input name="q" value={q.q} placeholder="Number or description, for example 8 chrome stack" />
		</label>

		<label>
			<span class="sr-only">Family</span>
			{#await data.families}
				<select disabled><option>Family</option></select>
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

		<label>
			<span class="sr-only">Sort by</span>
			<select name="sort" onchange={submitNow}>
				{#each PART_SORTS as sort (sort)}
					<option value={sort} selected={sort === q.sort}>{PART_SORT_LABEL[sort]}</option>
				{/each}
			</select>
		</label>

		<label class="tick">
			<input type="checkbox" name="short" value="1" checked={q.short} onchange={submitNow} />
			<span>Short on open orders</span>
		</label>

		<label class="tick">
			<input type="checkbox" name="reorder" value="1" checked={q.belowReorder} onchange={submitNow} />
			<span>Below reorder point</span>
		</label>

		<button class="button">Apply</button>
	</form>

	{#await data.parts}
		<TableSkeleton rows={8} title="Loading parts" />
	{:then parts}
		<section class="panel" aria-labelledby="results">
			<header class="panel-head">
				<h2 id="results">
					{count(parts.total)} {parts.total === 1 ? 'part' : 'parts'}
				</h2>
				{#if parts.total > parts.rows.length}
					<span class="faint">showing the first {count(parts.rows.length)} by {PART_SORT_LABEL[q.sort].toLowerCase()}</span>
				{/if}
			</header>

			{#if parts.rows.length === 0}
				<p class="body muted">
					No part matches. Try fewer words, or
					<a class="link" href="/parts">clear the filters</a>.
				</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">Item</th>
								<th scope="col">Description</th>
								<th scope="col">Family</th>
								<th scope="col" class="num">On hand</th>
								<th scope="col" class="num">Units 12m</th>
								<th scope="col" class="num">Revenue 12m</th>
								<th scope="col" class="num">Margin</th>
								<th scope="col" class="num">Last sold</th>
							</tr>
						</thead>
						<tbody>
							{#each parts.rows as part (part.itemNo)}
								<tr>
									<td class="mono"><a class="link" href={partHref(part.itemNo)}>{part.itemNo}</a></td>
									<td class="desc">
										{part.description}
										<PartFlags {part} compact />
									</td>
									<td class="muted">{part.family}</td>
									<td class="num">{count(part.onHand)}</td>
									<td class="num">{count(part.units12m)}</td>
									<td class="num">{money(part.revenue12m)}</td>
									<td class="num">{#if part.margin12m === null}<Blank word="not known" />{:else}{percent(part.margin12m)}{/if}</td>
									<td class="num">{part.lastSoldOn ? day(part.lastSoldOn, data.year) : 'never'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{:catch}
		<p class="notice error" role="alert">
			The parts could not be loaded.
			<a class="button" href="/parts" data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page {
		max-width: 1180px;
		margin: 0 auto;
		padding: var(--space-3) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head p {
		max-width: 80ch;
		font-size: 0.92rem;
	}

	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	.filters label {
		display: block;
	}

	.filters .grow {
		flex: 1 1 260px;
	}

	.filters .grow input {
		width: 100%;
	}

	.filters .tick {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.desc {
		min-width: 22ch;
	}

	.body {
		padding: var(--space-3);
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}

		.filters {
			gap: var(--space-2);
		}
	}
</style>
