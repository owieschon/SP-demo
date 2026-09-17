<script lang="ts">
	import PartFlags from '$lib/components/catalog/PartFlags.svelte';
	import SalesChart from '$lib/components/catalog/SalesChart.svelte';
	import TableSkeleton from '$lib/components/catalog/TableSkeleton.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import {
		BUCKET_LABEL,
		accountHref,
		partHref,
		vendorHref
	} from '$lib/components/catalog/types';
	import { count, day, money, moneyExact, percent, place, windowRange } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const p = $derived(data.part);
	// Year on year, when there is a year before to compare with.
	const change = $derived(
		p.revenuePrior12m > 0 ? (p.revenue12m - p.revenuePrior12m) / p.revenuePrior12m : null
	);
</script>

<svelte:head>
	<title>{p.itemNo} · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div class="title-row">
			<h1 class="mono">{p.itemNo}</h1>
			<PartFlags part={p} />
		</div>
		<p class="desc">{p.description}</p>
		<dl class="facts">
			<div>
				<dt>Family</dt>
				<dd>{p.family} · {p.category}</dd>
			</div>
			<div>
				<dt>Product group</dt>
				<dd>{p.productGroup}</dd>
			</div>
			<div>
				<dt>Replenishment</dt>
				<dd>
					{p.replenishment}{#if p.workCenter}<span class="muted"> · {p.workCenter}</span>{/if}
				</dd>
			</div>
			<div>
				<dt>Lead time</dt>
				<dd>{p.leadTime || p.vendorLeadTime || 'not stated'}</dd>
			</div>
			<div>
				<dt>Vendor</dt>
				<dd>
					{#if p.vendorNo}
						<a class="link" href={vendorHref(p.vendorNo)}>{p.vendorName}</a>
						<span class="mono faint">{p.vendorNo}</span>
					{:else}
						<span class="muted">made here</span>
					{/if}
				</dd>
			</div>
		</dl>
	</header>

	<section class="numbers panel" aria-label="Price, cost and sales">
		<dl class="figures">
			<div>
				<dt>List price</dt>
				<dd class="num">{moneyExact(p.listPrice)}</dd>
				<p class="faint small">cost {moneyExact(p.unitCost)}</p>
			</div>
			<div>
				<dt>Margin at list</dt>
				<dd class="num">{p.listMargin === null ? '·' : percent(p.listMargin)}</dd>
				<p class="faint small">
					{#if p.margin12m !== null}sold at {percent(p.margin12m)} over 12 months{:else}nothing sold in 12 months{/if}
				</p>
			</div>
			<div>
				<dt>Revenue 12m</dt>
				<dd class="num">{money(p.revenue12m)}</dd>
				<p class="faint small">
					{#if change === null}
						no sales the year before
					{:else}
						{change >= 0 ? 'up' : 'down'} {percent(Math.abs(change))} on {money(p.revenuePrior12m)}
					{/if}
				</p>
			</div>
			<div>
				<dt>Units 12m</dt>
				<dd class="num">{count(p.units12m)}</dd>
				<p class="faint small">
					{count(p.buyers12m)} {p.buyers12m === 1 ? 'buyer' : 'buyers'}{#if p.lastSoldOn}, last {day(p.lastSoldOn, data.year)}{/if}
				</p>
			</div>
		</dl>

		<dl class="figures stock">
			<div>
				<dt>On hand</dt>
				<dd class="num">{count(p.onHand)}</dd>
				<p class="faint small">
					{#if p.shelf}shelf {p.shelf}, bin {p.bin}{:else}no shelf on file{/if}
				</p>
			</div>
			<div>
				<dt>Incoming</dt>
				<dd class="num">{count(p.onProductionOrder + p.onPurchaseOrder)}</dd>
				<p class="faint small">
					{count(p.onProductionOrder)} on production, {count(p.onPurchaseOrder)} on purchase
				</p>
			</div>
			<div>
				<dt>Promised</dt>
				<dd class="num">{count(p.openQty)}</dd>
				<p class="faint small">
					{count(p.openLines)} open {p.openLines === 1 ? 'line' : 'lines'}, {money(p.openValue)}
				</p>
			</div>
			<div class:warn={p.belowReorderPoint}>
				<dt>Projected available</dt>
				<dd class="num">{count(p.projectedAvailable)}</dd>
				<p class="faint small">
					{#if p.reorderPoint === null}
						no reorder point
					{:else}
						reorder at {count(p.reorderPoint)}, safety {count(p.safetyStock ?? 0)}
					{/if}
				</p>
			</div>
		</dl>
	</section>

	<section class="panel" aria-labelledby="chart">
		<header class="panel-head">
			<h2 id="chart">Units a month</h2>
			<span class="faint">last 24 months</span>
		</header>
		<div class="body">
			{#await data.sales}
				<div class="chart-loading"><span class="skeleton" style:width="100%" style:height="120px"></span></div>
			{:then sales}
				<SalesChart months={sales.months} />
			{:catch}
				<p class="muted">The sales history could not be loaded.</p>
			{/await}
		</div>
	</section>

	{#await data.sales}
		<div class="two">
			<TableSkeleton rows={6} title="Loading buyers" />
			<TableSkeleton rows={6} title="Loading invoice lines" />
		</div>
	{:then sales}
		<div class="two">
			<section class="panel" aria-labelledby="buyers">
				<header class="panel-head">
					<h2 id="buyers">Who bought it</h2>
					<span class="faint">last 12 months</span>
				</header>
				{#if sales.topBuyers.length === 0}
					<p class="body muted">Nobody has bought this part in the last 12 months.</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Account</th>
									<th class="num">Units</th>
									<th class="num">Revenue</th>
									<th class="num">Last price</th>
									<th class="num">Last order</th>
								</tr>
							</thead>
							<tbody>
								{#each sales.topBuyers as buyer (buyer.customerNo)}
									<tr>
										<td>
											<a class="link" href={accountHref(buyer.customerNo)}>{buyer.name}</a>
											<span class="faint small">{place(buyer.city, buyer.state, buyer.country)}</span>
										</td>
										<td class="num">{count(buyer.units)}</td>
										<td class="num">{money(buyer.revenue)}</td>
										<td class="num">{buyer.lastPrice === null ? '·' : moneyExact(buyer.lastPrice)}</td>
										<td class="num">{buyer.lastOn ? day(buyer.lastOn, data.year) : '·'}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>

			<section class="panel" aria-labelledby="lines">
				<header class="panel-head">
					<h2 id="lines">Recent invoice lines</h2>
				</header>
				{#if sales.recentLines.length === 0}
					<p class="body muted">This part has never been invoiced.</p>
				{:else}
					<div class="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Posted</th>
									<th>Invoice</th>
									<th>Account</th>
									<th class="num">Qty</th>
									<th class="num">Price</th>
									<th class="num">Amount</th>
								</tr>
							</thead>
							<tbody>
								{#each sales.recentLines as line (line.invoiceNo + ':' + line.lineNo)}
									<tr>
										<td class="nowrap">{day(line.postedOn, data.year)}</td>
										<td class="mono">
											{line.invoiceNo}
											{#if line.isCreditMemo}<span class="chip">credit</span>{/if}
										</td>
										<td><a class="link" href={accountHref(line.customerNo)}>{line.customerName}</a></td>
										<td class="num">{count(line.quantity)}</td>
										<td class="num">{moneyExact(line.unitPrice)}</td>
										<td class="num" class:negative={line.amount < 0}>{moneyExact(line.amount)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}
			</section>
		</div>
	{:catch}
		<p class="notice error" role="alert">The sales history could not be loaded.</p>
	{/await}

	{#await data.demand}
		<TableSkeleton rows={5} title="Loading what is promised" />
	{:then demand}
		<section class="panel" aria-labelledby="open">
			<header class="panel-head">
				<h2 id="open">On open orders</h2>
				<span class="faint">
					{#if demand.openLineCount > demand.openLines.length}
						{count(demand.openLines.length)} of {count(demand.openLineCount)} lines
					{:else}
						from the last applied export
					{/if}
				</span>
			</header>
			{#if demand.openLines.length === 0}
				<p class="body muted">
					No open order line asks for this part.
					<a class="link" href="/operations">See the order book</a>.
				</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Ship date</th>
								<th>Order</th>
								<th>Account</th>
								<th class="num">Qty</th>
								<th class="num">Covered</th>
								<th class="num">Short</th>
								<th>Bucket</th>
							</tr>
						</thead>
						<tbody>
							{#each demand.openLines as line (line.documentNo + ':' + line.lineNo)}
								<tr>
									<td class="nowrap">{day(line.shipDate, data.year)}</td>
									<td class="mono">{line.documentNo}</td>
									<td><a class="link" href={accountHref(line.customerNo)}>{line.customerName}</a></td>
									<td class="num">{count(line.quantity)}</td>
									<td class="num">{count(line.allocated)}</td>
									<td class="num">{line.short > 0 ? count(line.short) : '·'}</td>
									<td>
										<span class="chip" class:warn={line.bucket === 'past_due' || line.bucket === 'at_risk'}>
											{BUCKET_LABEL[line.bucket]}
										</span>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<div class="two">
			<section class="panel" aria-labelledby="commitments">
				<header class="panel-head">
					<h2 id="commitments">Commitments that include it</h2>
				</header>
				{#if demand.commitments.length === 0}
					<p class="body muted">No commitment names this part.</p>
				{:else}
					<ul class="list">
						{#each demand.commitments as c (c.id)}
							<li>
								<span class="line">
									<a class="link grow" href="/commitments/{c.id}">{c.title}</a>
									<StatusBadge status={c.status} />
								</span>
								<span class="muted small">
									<a class="link" href={accountHref(c.customerNo)}>{c.customerName}</a>
									· {windowRange(c.startsOn, c.endsOn, data.year)}
									· {money(c.committedValue)} at {percent(c.deliveredRatio)}
									{#if c.quantity}· asked for {count(c.quantity)}{/if}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="panel" aria-labelledby="quotes">
				<header class="panel-head">
					<h2 id="quotes">Open quotes</h2>
				</header>
				{#if demand.quotes.length === 0}
					<p class="body muted">No quote on this part is still valid.</p>
				{:else}
					<ul class="list">
						{#each demand.quotes as q (q.id + ':' + q.lineNo)}
							<li>
								<span class="line">
									<span class="mono">SQ-{q.id}</span>
									<a class="link grow" href={accountHref(q.customerNo)}>{q.customerName}</a>
									<span class="num">{moneyExact(q.unitPrice)}</span>
								</span>
								<span class="muted small">
									{count(q.quantity)} at {day(q.quotedOn, data.year)}
									{#if q.validUntil}· good to {day(q.validUntil, data.year)}{/if}
									{#if q.commitmentId}· <a class="link" href="/commitments/{q.commitmentId}">C-{q.commitmentId}</a>{/if}
									· {q.createdBy}
								</span>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	{:catch}
		<p class="notice error" role="alert">What is promised against this part could not be loaded.</p>
	{/await}

	{#await data.siblings then siblings}
		{#if siblings.parts.length > 0}
			<section class="panel" aria-labelledby="siblings">
				<header class="panel-head">
					<h2 id="siblings">Other {siblings.size} {p.family} parts</h2>
					<span class="faint">best sellers first</span>
				</header>
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Item</th>
								<th>Description</th>
								<th class="num">On hand</th>
								<th class="num">Revenue 12m</th>
							</tr>
						</thead>
						<tbody>
							{#each siblings.parts as sibling (sibling.itemNo)}
								<tr>
									<td class="mono"><a class="link" href={partHref(sibling.itemNo)}>{sibling.itemNo}</a></td>
									<td>
										{sibling.description}
										{#if sibling.blocked}<span class="chip warn">Blocked</span>{/if}
										{#if sibling.madeToOrder}<span class="chip">MTO</span>{/if}
									</td>
									<td class="num">{count(sibling.onHand)}</td>
									<td class="num">{money(sibling.revenue12m)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}
	{/await}
</main>

<style>
	.page {
		max-width: 1180px;
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
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	h1 {
		font-size: 1.3rem;
	}

	.desc {
		font-size: 1rem;
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

	.figures.stock {
		border-top: 1px solid var(--hairline);
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

	.chart-loading {
		padding: 14px 0 0;
	}

	.two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
		gap: var(--space-3);
		align-items: start;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.nowrap {
		white-space: nowrap;
	}

	.negative {
		color: var(--danger);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		display: grid;
		gap: 1px;
		padding: 8px var(--space-3);
	}

	.list li + li {
		border-top: 1px solid var(--hairline);
	}

	.line {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.grow {
		flex: 1 1 auto;
		min-width: 0;
	}

	td .faint {
		display: block;
		font-size: 0.85rem;
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
