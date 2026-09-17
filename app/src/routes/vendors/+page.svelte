<script lang="ts">
	import TableSkeleton from '$lib/components/catalog/TableSkeleton.svelte';
	import { vendorHref } from '$lib/components/catalog/types';
	import { count, money, place } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = $derived(data.query);
</script>

<svelte:head>
	<title>Vendors · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1 class="sr-only">Vendors</h1>
		<p class="faint">
			Who supplies the bought parts, on what terms, and how those parts sell. Vendors with nothing on
			the item master are hidden until you ask for them.
		</p>
	</header>

	<form class="filters panel" method="GET" data-sveltekit-keepfocus>
		<label class="grow">
			<span class="sr-only">Search vendors</span>
			<input name="q" value={q.q} placeholder="Vendor name or number" />
		</label>
		<label class="tick">
			<input type="checkbox" name="all" value="1" checked={q.all} />
			<span>Include vendors with no parts</span>
		</label>
		<button class="button">Apply</button>
	</form>

	{#await data.vendors}
		<TableSkeleton rows={8} title="Loading vendors" />
	{:then vendors}
		<section class="panel" aria-labelledby="results">
			<header class="panel-head">
				<h2 id="results">{count(vendors.total)} {vendors.total === 1 ? 'vendor' : 'vendors'}</h2>
				{#if vendors.total > vendors.rows.length}
					<span class="faint">showing the first {count(vendors.rows.length)} by 12-month revenue</span>
				{/if}
			</header>

			{#if vendors.rows.length === 0}
				<p class="body muted">
					No vendor matches.
					{#if !q.all}
						Some vendors supply nothing at the moment;
						<a class="link" href="/vendors?all=1{q.q ? `&q=${encodeURIComponent(q.q)}` : ''}">include those</a>.
					{/if}
				</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Vendor</th>
								<th>Where</th>
								<th>Terms</th>
								<th>Lead time</th>
								<th class="num">Parts</th>
								<th class="num">Revenue 12m</th>
								<th>Watch</th>
							</tr>
						</thead>
						<tbody>
							{#each vendors.rows as vendor (vendor.vendorNo)}
								<tr>
									<td>
										<a class="link" href={vendorHref(vendor.vendorNo)}>{vendor.name}</a>
										<span class="mono faint">{vendor.vendorNo}</span>
									</td>
									<td class="muted">{place(vendor.city, vendor.state, 'US')}</td>
									<td class="muted">{vendor.terms || '·'}</td>
									<td class="muted">{vendor.leadTime || '·'}</td>
									<td class="num">{count(vendor.activeItems)}</td>
									<td class="num">{money(vendor.revenue12m)}</td>
									<td>
										{#if vendor.itemsShort > 0}
											<span class="chip warn">{count(vendor.itemsShort)} short</span>
										{/if}
										{#if vendor.itemsBelowReorder > 0}
											<span class="chip">{count(vendor.itemsBelowReorder)} to reorder</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{:catch}
		<p class="notice error" role="alert">
			The vendors could not be loaded.
			<a class="button" href="/vendors" data-sveltekit-reload>Try again</a>
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

	.body {
		padding: var(--space-3);
	}

	td .faint {
		margin-left: 6px;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
