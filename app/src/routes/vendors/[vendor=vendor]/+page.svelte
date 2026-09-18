<script lang="ts">
	import { page } from '$app/state';
	import RowCount from '$lib/components/ui/RowCount.svelte';
	import PartFlags from '$lib/components/catalog/PartFlags.svelte';
	import TableSkeleton from '$lib/components/catalog/TableSkeleton.svelte';
	import VendorContacts from '$lib/components/catalog/VendorContacts.svelte';
	import { partHref } from '$lib/components/catalog/types';
	import { count, money, moneyExact, place } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const v = $derived(data.vendor);
	const message = $derived(form ? { text: form.message, failed: form.failed } : null);
	// How many receipts a part needs before the observed figure is trusted. It
	// comes from the loader so the sentence on the page and nl.promise_lead_days
	// cannot drift apart.
	const minReceipts = $derived(data.minReceipts);
</script>

<svelte:head>
	<title>{v.name} · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div class="title-row">
			<h1>{v.name}</h1>
			<span class="mono faint">{v.vendorNo}</span>
		</div>
		<dl class="facts">
			<div>
				<dt>Where</dt>
				<dd>{place(v.city, v.state, 'US') || 'not stated'}</dd>
			</div>
			<div>
				<dt>Ships from</dt>
				<dd>{v.shipsFrom || 'not stated'}</dd>
			</div>
			<div>
				<dt>Terms</dt>
				<dd>{v.terms || 'not stated'}</dd>
			</div>
			<div>
				<dt>Freight</dt>
				<dd>{v.freightTerms || 'not stated'}</dd>
			</div>
			<div>
				<dt>Lead time default</dt>
				<dd>
					{v.leadTime || 'not stated'}
					<span class="faint small">covers every part, see below</span>
				</dd>
			</div>
			<div>
				<dt>Minimum order</dt>
				<dd>{v.minOrder === null ? 'none' : moneyExact(v.minOrder)}</dd>
			</div>
		</dl>
	</header>

	<section class="panel" aria-label="What this vendor supplies">
		<dl class="figures">
			<div>
				<dt>Parts supplied</dt>
				<dd class="num">{count(v.activeItems)}</dd>
				<p class="faint small">
					{#if v.items > v.activeItems}{count(v.items - v.activeItems)} more are blocked{:else}none blocked{/if}
				</p>
			</div>
			<div>
				<dt>Revenue 12m</dt>
				<dd class="num">{money(v.revenue12m)}</dd>
				<p class="faint small">{count(v.units12m)} units sold</p>
			</div>
			<div class:warn={v.itemsShort > 0}>
				<dt>Short on open orders</dt>
				<dd class="num">{count(v.itemsShort)}</dd>
				<p class="faint small">
					{#if v.shortQty > 0}{count(v.shortQty)} pieces missing{:else}open orders are covered{/if}
				</p>
			</div>
			<div>
				<dt>Below reorder point</dt>
				<dd class="num">{count(v.itemsBelowReorder)}</dd>
				<p class="faint small">projected available under the reorder point</p>
			</div>
		</dl>
	</section>

	<VendorContacts
		contacts={v.contacts}
		vendorNo={v.vendorNo}
		updatedAt={v.updatedAt}
		requestId={data.requestId}
		canAdd={data.canAddContact}
		{message}
	/>

	{#await data.leadTimes}
		<TableSkeleton rows={8} title="Loading lead times" />
	{:then leadTimes}
		<section class="panel" aria-labelledby="lead-times">
			<header class="panel-head">
				<h2 id="lead-times">Lead time by part</h2>
				<span class="faint">what they quote against what they do, worst tail first</span>
			</header>
			{#if leadTimes.length === 0}
				<p class="body muted">
					No part names this vendor as a source, so there is nothing to compare.
				</p>
			{:else}
				<p class="body small faint">
					A promise uses the ninetieth percentile of what actually arrived once there are
					{minReceipts} receipts for a part, and the quote until then. The basis column says which.
				</p>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Item</th>
								<th class="num">Quoted</th>
								<th class="num">Median</th>
								<th class="num">90th</th>
								<th class="num">Tail</th>
								<th class="num">Late</th>
								<th class="num">Promise</th>
								<th>Basis</th>
								<th class="num">Min order</th>
							</tr>
						</thead>
						<tbody>
							{#each leadTimes as part (part.itemNo)}
								<tr>
									<td class="mono">
										<a class="link" href={partHref(part.itemNo)}>{part.itemNo}</a>
										{#if !part.isPrimary}<span class="faint small">alternate</span>{/if}
										{#if part.status !== 'active'}
											<span class="warn small">{part.status}</span>
										{/if}
									</td>
									<td class="num">{part.quotedLeadDays === null ? '·' : `${part.quotedLeadDays}d`}</td>
									<td class="num">{part.medianDays === null ? '·' : `${part.medianDays}d`}</td>
									<td class="num">{part.p90Days === null ? '·' : `${part.p90Days}d`}</td>
									<td class="num" class:warn={(part.tailDays ?? 0) > 7}>
										{part.tailDays === null ? '·' : `${part.tailDays > 0 ? '+' : ''}${part.tailDays}d`}
									</td>
									<td class="num">
										{part.lateShare === null ? '·' : `${Math.round(part.lateShare * 100)}%`}
									</td>
									<td class="num" class:warn={!part.canPromise}>
										{part.canPromise ? `${part.promiseDays}d` : 'no date'}
									</td>
									<td>
										<span class="basis" class:faint={part.promiseBasis !== 'observed'}>
											{part.promiseBasis}
										</span>
										{#if part.promiseBasis === 'observed'}
											<span class="faint small">{part.receipts} receipts</span>
										{/if}
									</td>
									<td class="num">
										{count(part.minOrderQty)}{#if part.orderMultiple > 1}<span class="faint small"
												>x{part.orderMultiple}</span
											>{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{:catch}
		<p class="notice error" role="alert">The lead times could not be loaded.</p>
	{/await}

	{#await data.parts}
		<TableSkeleton rows={8} title="Loading parts" />
	{:then supplied}
		<section class="panel" aria-labelledby="parts">
			<header class="panel-head">
				<h2 id="parts">Parts supplied</h2>
				<span class="faint">short and low stock first, then best sellers</span>
			</header>
			{#if supplied.parts.length === 0}
				<p class="body muted">
					No part on the item master names this vendor.
					<a class="link" href="/parts">Look at the parts list</a>.
				</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th scope="col">Item</th>
								<th scope="col">Description</th>
								<th scope="col" class="num">Cost</th>
								<th scope="col" class="num">On hand</th>
								<th scope="col" class="num">On order</th>
								<th scope="col" class="num">Reorder at</th>
								<th scope="col" class="num">Revenue 12m</th>
							</tr>
						</thead>
						<tbody>
							{#each supplied.parts as part (part.itemNo)}
								<tr>
									<td class="mono"><a class="link" href={partHref(part.itemNo)}>{part.itemNo}</a></td>
									<td class="desc">
										{part.description}
										<PartFlags {part} compact />
									</td>
									<td class="num">{moneyExact(part.unitCost)}</td>
									<td class="num">{count(part.onHand)}</td>
									<td class="num">{count(part.onPurchaseOrder)}</td>
									<td class="num">{part.reorderPoint === null ? '·' : count(part.reorderPoint)}</td>
									<td class="num">{money(part.revenue12m)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				{#if supplied.total > supplied.parts.length}
					<p class="body">
						<RowCount
							shown={supplied.parts.length}
							total={supplied.total}
							noun="parts"
							order="short and low stock first, then best sellers"
						/>
					</p>
				{/if}
			{/if}
		</section>
	{:catch}
		<p class="notice error" role="alert">
			The parts could not be loaded.
			<a class="button" href={page.url.pathname} data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page {
		max-width: 1080px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: var(--space-2);
	}

	.title-row {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
		margin: var(--space-1) 0 0;
	}

	.facts dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.facts dd {
		margin: 0;
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
	}

	.figures div {
		flex: 1 1 170px;
		padding: 10px var(--space-3);
	}

	.figures div + div {
		border-left: 1px solid var(--hairline);
	}

	.figures dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.figures dd {
		margin: 2px 0 0;
		font-size: 1.2rem;
		font-weight: 600;
		letter-spacing: -0.015em;
		text-align: left;
	}

	.figures div.warn dd {
		color: var(--warning);
	}

	.small {
		font-size: 0.85rem;
	}

	.body {
		padding: var(--space-3);
	}

	.table-wrap {
		overflow-x: auto;
	}

	.desc {
		min-width: 22ch;
	}

	.basis {
		font-variant-caps: all-small-caps;
		letter-spacing: 0.03em;
	}

	.warn {
		color: var(--warning);
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-4) var(--space-3);
		}

		.figures div {
			flex-basis: 45%;
		}

		.figures div + div {
			border-left: 0;
		}
	}
</style>
