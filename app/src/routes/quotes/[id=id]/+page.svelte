<script lang="ts">
	// One quote, as a web page: the same object the PDF is drawn from, so the
	// two can never show different numbers.
	import { day, moneyExact, place } from '$lib/format';
	import QuoteActions from '$lib/components/rfq/QuoteActions.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const q = $derived(data.quote);
	const us = $derived(data.letterhead);
	const expired = $derived(q.validUntil !== null && q.validUntil < new Date().toISOString().slice(0, 10));
</script>

<svelte:head>
	<title>Quote SQ-{q.quoteId} · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div class="title-row">
			<h1>Quote <span class="mono">SQ-{q.quoteId}</span></h1>
			{#if expired}
				<span class="chip warn">Past its valid-until date</span>
			{:else}
				<span class="chip">Valid to {q.validUntil ? day(q.validUntil, data.year) : 'on request'}</span>
			{/if}
		</div>
		<dl class="facts">
			<div>
				<dt>Account</dt>
				<dd>
					<a class="link" href="/accounts/{q.customerNo}">{q.customerName}</a>
					<span class="mono faint">{q.customerNo}</span>
				</dd>
			</div>
			<div>
				<dt>Quoted</dt>
				<dd>{day(q.quotedOn, data.year)} by {q.preparedBy}</dd>
			</div>
			{#if q.commitmentId !== null}
				<div>
					<dt>Commitment</dt>
					<dd><a class="link mono" href="/commitments/{q.commitmentId}">C-{q.commitmentId}</a></dd>
				</div>
			{/if}
			{#if q.draftId !== null}
				<div>
					<dt>From request</dt>
					<dd><a class="link mono" href="/rfq/{q.draftId}">R-{q.draftId}</a></dd>
				</div>
			{/if}
		</dl>
	</header>

	<section class="panel" aria-labelledby="send">
		<header class="panel-head"><h2 id="send">Send it</h2></header>
		<div class="body">
			<QuoteActions
				pdfUrl="/quotes/{q.quoteId}/pdf"
				mail={data.mail}
				lineCount={q.lines.length}
				subtotal={q.subtotal}
				fileName={data.pdfFileName}
			/>
		</div>
	</section>

	<section class="panel" aria-labelledby="quoted-to">
		<header class="panel-head"><h2 id="quoted-to">Quoted to</h2></header>
		<div class="body who">
			<div class="stack">
				<p><strong>{q.customerName}</strong></p>
				<p class="muted small">
					Account {q.customerNo}
					{#if q.customerCity}· {place(q.customerCity, q.customerState, q.customerCountry)}{/if}
					· {q.priceGroupLabel}
				</p>
				{#if q.buyerName}
					<p class="muted small">
						Attention: {q.buyerName}{#if q.buyerTitle}, {q.buyerTitle}{/if}
						{#if q.buyerEmail}· <span class="mono">{q.buyerEmail}</span>{/if}
					</p>
				{:else}
					<p class="muted small">No buyer is named on this quote.</p>
				{/if}
			</div>
			<div class="stack">
				<p><strong>{us.company}</strong></p>
				<p class="muted small">{us.street}, {us.town}</p>
				<p class="muted small">{us.phone} · {us.email}</p>
			</div>
		</div>
	</section>

	<section class="panel" aria-labelledby="lines">
		<header class="panel-head">
			<h2 id="lines">Lines</h2>
			<span class="chip">{q.lines.length} {q.lines.length === 1 ? 'line' : 'lines'}</span>
		</header>
		<div class="table-wrap">
			<table>
				<caption class="sr-only">The lines of quote SQ-{q.quoteId}</caption>
				<thead>
					<tr>
						<th scope="col" class="num">#</th>
						<th scope="col">Part</th>
						<th scope="col">Description</th>
						<th scope="col" class="num">Qty</th>
						<th scope="col" class="num">Unit price</th>
						<th scope="col" class="num">Extended</th>
					</tr>
				</thead>
				<tbody>
					{#each q.lines as line (line.lineNo)}
						<tr>
							<td data-label="#" class="num faint">{line.lineNo}</td>
							<td data-label="Part" class="mono">
								<a class="link" href="/parts/{encodeURIComponent(line.itemNo)}">{line.itemNo}</a>
							</td>
							<td data-label="Description" class="muted">{line.description}</td>
							<td data-label="Qty" class="num">{line.quantity}</td>
							<td data-label="Unit price" class="num">{moneyExact(line.unitPrice)}</td>
							<td data-label="Extended" class="num strong">{moneyExact(line.extended)}</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<td colspan="5" class="num strong">Subtotal</td>
						<td class="num strong">{moneyExact(q.subtotal)}</td>
					</tr>
				</tfoot>
			</table>
		</div>
		<div class="body terms">
			<p class="muted small">{q.freightNote}</p>
			<p class="muted small">{q.terms}</p>
		</div>
	</section>

	<p class="faint small demo">
		Every figure on this page is synthetic, including the company and the account. This is a demo app.
	</p>

	<p><a class="link" href="/accounts/{q.customerNo}">Back to {q.customerName}</a></p>
</main>

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: var(--space-3);
		margin-bottom: var(--space-1);
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
		margin: 0;
	}

	.facts dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.facts dd {
		margin: 0;
	}

	.body {
		padding: var(--space-3);
	}

	.who {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3) var(--space-5);
	}

	.who > * {
		flex: 1 1 280px;
	}

	.stack {
		display: grid;
		gap: 4px;
		align-content: start;
	}

	.stack p {
		margin: 0;
	}

	.small {
		font-size: 0.88rem;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.strong {
		font-weight: 600;
	}

	tfoot td {
		border-top: 1px solid var(--hairline-strong);
	}

	.terms {
		display: grid;
		gap: 4px;
		border-top: 1px solid var(--hairline);
	}

	.terms p {
		margin: 0;
		max-width: 72ch;
	}

	.demo {
		max-width: 72ch;
	}

	/* On a phone each line becomes a small card of labelled fields, the same
	   way the draft lines table does. */
	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}

		thead {
			display: none;
		}

		table,
		tbody,
		tfoot,
		tr,
		td {
			display: block;
			width: 100%;
		}

		tbody tr {
			padding: var(--space-2) 0;
			border-bottom: 1px solid var(--hairline);
		}

		td {
			height: auto;
			border: 0;
			padding: 3px var(--space-3);
			text-align: left;
		}

		td.num {
			text-align: left;
		}

		td[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: 0.78rem;
			color: var(--text-faint);
		}

		tfoot td {
			padding: var(--space-2) var(--space-3);
		}
	}
</style>
