<script lang="ts">
	// Orders: what is on order and not shipped yet (from the morning's ERP
	// export, with the bucket operations sees), then the last twenty
	// invoices with their biggest parts.
	import { count, day, money, moneyExact } from '$lib/format';
	import { BUCKET_LABEL } from '$lib/components/exports/types';
	import RowCount from '$lib/components/ui/RowCount.svelte';
	import type { Orders } from './types';

	let { orders, year }: { orders: Orders; year: number } = $props();

	/*
	  These two come from the query, not from the rows on screen.

	  This header used to sum `orders.openLines`, which SQL had already cut to
	  fifty rows, and present the result as what the account has on order. For
	  an account with more than fifty open lines the headline dollar figure
	  was simply wrong, and nothing on the page said so.
	*/
	const openCount = $derived(orders.openLineCount);
	const openValue = $derived(orders.openLineValue);
</script>

<section class="panel" aria-labelledby="orders-title">
	<header class="panel-head">
		<h2 id="orders-title">Orders and invoices</h2>
		{#if openCount > 0}
			<span class="muted">
				{count(openCount)} open {openCount === 1 ? 'line' : 'lines'} worth
				<span class="num">{money(openValue)}</span>
			</span>
		{/if}
	</header>

	{#if orders.openLines.length > 0}
		<div class="table-wrap">
			<table>
				<caption class="sr-only">Open order lines</caption>
				<thead>
					<tr>
						<th scope="col">Ship date</th>
						<th scope="col">Order</th>
						<th scope="col">Item</th>
						<th scope="col" class="num">Qty</th>
						<th scope="col" class="num">Short</th>
						<th scope="col" class="num">Value</th>
						<th scope="col">Bucket</th>
					</tr>
				</thead>
				<tbody>
					{#each orders.openLines as line (line.documentNo + ':' + line.lineNo)}
						<tr>
							<td class="nowrap">{day(line.shipDate, year)}</td>
							<td class="mono">{line.documentNo}</td>
							<td class="mono">
								<a class="link" href="/parts/{encodeURIComponent(line.itemNo)}">{line.itemNo}</a>
							</td>
							<td class="num">{count(line.quantity)}</td>
							<td class="num" class:short={line.short > 0}>{line.short > 0 ? count(line.short) : '·'}</td>
							<td class="num">{money(line.openValue)}</td>
							<td>
								<span class="swatch" style:--tone="var(--bucket-{line.bucket})" aria-hidden="true"></span>
								{BUCKET_LABEL[line.bucket]}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if openCount > orders.openLines.length}
			<p class="body">
				<RowCount
					shown={orders.openLines.length}
					total={openCount}
					noun="open lines"
					order="oldest ship date first"
				/>
			</p>
		{/if}
	{/if}

	{#if orders.invoices.length === 0}
		<p class="body muted">Nothing has been invoiced to this account.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<caption class="sr-only">Recent invoices</caption>
				<thead>
					<tr>
						<th scope="col">Posted</th>
						<th scope="col">Invoice</th>
						<th scope="col">Their PO</th>
						<th scope="col">Biggest parts</th>
						<th scope="col" class="num">Lines</th>
						<th scope="col" class="num">Freight</th>
						<th scope="col" class="num">Subtotal</th>
					</tr>
				</thead>
				<tbody>
					{#each orders.invoices as invoice (invoice.invoiceNo)}
						<tr>
							<td class="nowrap">{day(invoice.postedOn, year)}</td>
							<td class="mono">
								{invoice.invoiceNo}
								{#if invoice.docType === 'credit_memo'}<span class="chip">credit</span>{/if}
							</td>
							<td class="mono faint">{invoice.customerPo ?? '·'}</td>
							<td class="parts">
								{#each invoice.topParts as part (part)}
									<a class="mono link" href="/parts/{encodeURIComponent(part)}">{part}</a>
								{/each}
							</td>
							<td class="num">{invoice.lines}</td>
							<td class="num faint">{invoice.freight > 0 ? moneyExact(invoice.freight) : '·'}</td>
							<td class="num" class:negative={invoice.subtotal < 0}>{moneyExact(invoice.subtotal)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<style>
	/* The same four bucket colors the operations board uses. */
	.panel {
		--bucket-past_due: var(--status-broken);
		--bucket-at_risk: var(--status-pushed);
		--bucket-on_pace: var(--status-kept);
		--bucket-later: var(--status-promised);
	}

	.body {
		padding: var(--space-3);
	}

	.table-wrap {
		overflow-x: auto;
	}

	.table-wrap + .table-wrap {
		border-top: 1px solid var(--hairline);
	}

	.nowrap {
		white-space: nowrap;
	}

	.short {
		color: var(--warning);
	}

	.negative {
		color: var(--danger);
	}

	.parts {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
	}

	.swatch {
		display: inline-block;
		width: 7px;
		height: 7px;
		margin-right: 5px;
		border-radius: 50%;
		background: var(--tone);
	}

	.chip {
		margin-left: 4px;
	}
</style>
