<script lang="ts">
	// What is being sold to this account: commitments across its billing
	// family, the quotes behind them, and this reader's own quote requests.
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { day, money, percent } from '$lib/format';
	import type { Deals } from './types';

	let {
		deals,
		customerNo,
		year
	}: { deals: Deals; customerNo: string; year: number } = $props();

	// Every other status in the app goes through a label map; this one used to
	// print the raw value from the table.
	const REQUEST_STATUS = {
		draft: 'Waiting for review',
		approved: 'Approved',
		rejected: 'Rejected'
	} as const;
</script>

<section class="panel" aria-labelledby="deals-title">
	<header class="panel-head">
		<h2 id="deals-title">Commitments</h2>
		<span class="faint">Anything promised by this account or the office it bills to.</span>
	</header>

	{#if deals.commitments.length === 0}
		<p class="body muted">
			No commitment on this account yet. One starts from a named buyer, the parts they said they would
			buy, and a window.
		</p>
	{:else}
		<ul class="list">
			{#each deals.commitments as c (c.id)}
				<li class="deal" class:attention={c.needsOutcome}>
					<div class="line">
						<a class="title" href="/commitments/{c.id}">{c.title}</a>
						<StatusBadge status={c.status} />
						<span class="num push">{money(c.delivered)} <span class="faint">of {money(c.committedValue)}</span></span>
					</div>
					<ProgressBar
						ratio={c.deliveredRatio}
						pace={null}
						status={c.status}
						label="Delivered for {c.title}"
					/>
					<div class="meta muted">
						<span>{percent(c.deliveredRatio)} delivered</span>
						<span>{day(c.startsOn, year)} to {day(c.endsOn, year)}</span>
						{#if c.buyerName}<span>{c.buyerName}</span>{:else}
							<span><a class="link" href="/commitments/{c.id}#buyer">No buyer named</a></span>
						{/if}
						<span>{c.ownerName}</span>
						{#if c.customerNo !== customerNo}
							<span>on <a class="link" href="/accounts/{c.customerNo}">{c.customerName}</a></span>
						{/if}
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if deals.quotes.length > 0}
		<div class="table-wrap">
			<table>
				<caption class="sr-only">Quotes for this account</caption>
				<thead>
					<tr>
						<th scope="col">Quote</th>
						<th scope="col">Quoted</th>
						<th scope="col">Valid until</th>
						<th scope="col">For</th>
						<th scope="col" class="num">Lines</th>
						<th scope="col" class="num">Total</th>
					</tr>
				</thead>
				<tbody>
					{#each deals.quotes as q (q.id)}
						<tr>
							<td class="mono"><a class="link" href="/quotes/{q.id}">SQ-{q.id}</a></td>
							<td class="nowrap">{day(q.quotedOn, year)}</td>
							<td class="nowrap">{q.validUntil ? day(q.validUntil, year) : '·'}</td>
							<td>
								{#if q.commitmentId}
									<a class="link" href="/commitments/{q.commitmentId}">C-{q.commitmentId}</a>
								{:else if q.contactName}
									{q.contactName}
								{:else}
									<span class="faint">no commitment</span>
								{/if}
							</td>
							<td class="num">{q.lines}</td>
							<td class="num">{money(q.total)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if deals.rfqDrafts.length > 0}
		<h3 class="eyebrow requests-head">Quote requests</h3>
		<ul class="list drafts">
			{#each deals.rfqDrafts as draft (draft.id)}
				<li class="draft">
					<a class="link" href="/rfq/{draft.id}">R-{draft.id}</a>
					<span class="muted">{REQUEST_STATUS[draft.status] ?? draft.status}</span>
					{#if draft.needsReview > 0}
						<span class="chip warn">{draft.needsReview} to check</span>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.body {
		padding: var(--space-3);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.deal {
		display: grid;
		gap: 4px;
		padding: 9px var(--space-3);
	}

	.deal + .deal {
		border-top: 1px solid var(--hairline);
	}

	.deal.attention {
		box-shadow: inset 2px 0 0 var(--status-pushed);
	}

	.line {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.title {
		font-weight: 500;
		text-decoration: underline;
		text-decoration-color: var(--hairline-strong);
		text-underline-offset: 2px;
	}

	.title:hover {
		text-decoration-color: currentColor;
	}

	.push {
		margin-left: auto;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
		font-size: 0.88rem;
	}

	.meta > * + *::before {
		content: '·';
		margin-right: var(--space-2);
		color: var(--text-faint);
	}

	.table-wrap {
		overflow-x: auto;
		border-top: 1px solid var(--hairline);
	}

	.nowrap {
		white-space: nowrap;
	}

	.requests-head {
		padding: var(--space-3) var(--space-3) 0;
	}

	.drafts {
		border-top: 1px solid var(--hairline);
	}

	.draft {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 6px var(--space-3);
	}

	.draft + .draft {
		border-top: 1px solid var(--hairline);
	}
</style>
