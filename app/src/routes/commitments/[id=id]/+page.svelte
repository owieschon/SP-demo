<script lang="ts">
	import { enhance } from '$app/forms';
	import RowCount from '$lib/components/ui/RowCount.svelte';
	import { invalidateAll } from '$app/navigation';
	import BuyerPicker from '$lib/components/accounts/BuyerPicker.svelte';
	import OutcomeForm from '$lib/components/OutcomeForm.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { count, day, moment, money, moneyExact, percent, place, windowRange } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const c = $derived(data.commitment);
	// The outcome and confidence forms answer here; the buyer forms carry a
	// `from` and answer inside the buyer picker instead.
	const general = $derived(form && !('from' in form) ? form : null);
	const failed = $derived(general && 'message' in general && !('replayed' in general));
	const buyerAnswer = $derived(
		form && 'from' in form && form.from === 'buyer'
			? { text: form.message, failed: form.failed, conflict: form.conflict }
			: null
	);
	const where = $derived(place(c.customerCity, c.customerState, c.customerCountry));

	// The confidence picker offers tens, plus the current value if it is not one.
	const confidenceChoices = $derived(
		[...new Set([...Array.from({ length: 11 }, (_, i) => i * 10), c.confidence])].sort((a, b) => a - b)
	);
	let savingConfidence = $state(false);
</script>

<svelte:head>
	<title>C-{c.id} {c.title} · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div class="title-row">
			<h1>{c.title}</h1>
			<StatusBadge status={c.status} />
		</div>
		<dl class="facts">
			<div>
				<dt>Customer</dt>
				<dd>
					<a class="link" href="/accounts/{c.customerNo}">{c.customerName}</a>
					<span class="mono faint">{c.customerNo}</span>
					{#if where}<span class="muted">· {where}</span>{/if}
				</dd>
			</div>
			<div>
				<dt>Owner</dt>
				<dd>{c.ownerName}</dd>
			</div>
			<div class="buyer-fact">
				<dt>Buyer</dt>
				<dd>
					<!-- Nobody named is a button, not a label: it opens a small form. -->
					<BuyerPicker
						commitmentId={c.id}
						customerNo={c.customerNo}
						updatedAt={c.updatedAt}
						buyerName={c.buyerName}
						buyerEmail={c.buyerEmail}
						choices={data.buyerChoices}
						canEdit={c.canEdit}
						setRequestId={data.requestIds.setBuyer}
						addRequestId={data.requestIds.addBuyer}
						message={buyerAnswer}
					/>
				</dd>
			</div>
			<div>
				<dt>Window</dt>
				<dd>{windowRange(c.startsOn, c.endsOn, data.year)}</dd>
			</div>
		</dl>
	</header>

	{#if general?.message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>
			<span>{general.message}</span>
			{#if general && 'conflict' in general && general.conflict}
				<button class="button" onclick={() => invalidateAll()}>Reload</button>
			{/if}
		</p>
	{/if}

	{#if c.needsOutcome}
		<section class="question panel" aria-labelledby="question">
			<header class="panel-head">
				<h2 id="question">
					The window closed {c.daysSinceClose} days ago with {percent(c.deliveredRatio)} delivered. What happened?
				</h2>
			</header>
			<div class="body">
				{#if c.canAnswer}
					<OutcomeForm commitmentId={c.id} updatedAt={c.updatedAt} requestId={data.requestIds.outcome} />
				{:else}
					<p class="muted">Waiting on {c.ownerName}. Only the owner or an admin can answer.</p>
				{/if}
			</div>
		</section>
	{/if}

	<section class="numbers panel" aria-label="Progress">
		<dl class="figures">
			<div>
				<dt>Committed</dt>
				<dd class="num">{money(c.committedValue)}</dd>
			</div>
			<div>
				<dt>Delivered</dt>
				<dd class="num">{money(c.delivered)} <span class="faint pct">{percent(c.deliveredRatio)}</span></dd>
			</div>
			<div>
				<dt>Remaining</dt>
				<dd class="num">{money(c.remaining)}</dd>
			</div>
			<div>
				<dt>Expected</dt>
				<dd class="num">{money(c.expectedValue)}</dd>
			</div>
		</dl>
		<div class="body bar">
			<ProgressBar
				ratio={c.deliveredRatio}
				pace={c.isSettled ? null : c.windowElapsedRatio}
				status={c.status}
				label="Delivered"
				size="md"
			/>
			<p class="faint explain">
				{#if c.isSettled}
					Settled: expected equals what was delivered.
				{:else}
					Expected = delivered + {c.confidence}% confidence × remaining. The line at 95% is where it
					counts as kept; the tick is how far through its window it is today.
				{/if}
				{#if c.lastDeliveryOn}Last delivery {day(c.lastDeliveryOn, data.year)}.{/if}
			</p>
		</div>

		{#if c.canEdit}
			<form
				method="POST"
				action="?/confidence"
				class="body confidence"
				use:enhance={() => {
					savingConfidence = true;
					return async ({ update }) => {
						await update({ reset: false });
						savingConfidence = false;
					};
				}}
			>
				<input type="hidden" name="commitmentId" value={c.id} />
				<input type="hidden" name="expectedUpdatedAt" value={c.updatedAt} />
				<input type="hidden" name="requestId" value={data.requestIds.confidence} />
				<label for="confidence">Your confidence that the rest arrives</label>
				<select id="confidence" name="confidence" value={c.confidence}>
					{#each confidenceChoices as value (value)}
						<option {value}>{value}%</option>
					{/each}
				</select>
				<button class="button" disabled={savingConfidence} aria-busy={savingConfidence}>
					{#if savingConfidence}<span class="spinner" aria-hidden="true"></span>{/if}
					Save
				</button>
			</form>
		{/if}
	</section>

	<section class="panel" aria-labelledby="scope">
		<header class="panel-head">
			<h2 id="scope">Parts in scope</h2>
			<span class="faint">Delivery counts these item numbers, whatever order they arrive on.</span>
		</header>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">Item</th>
						<th scope="col">Description</th>
						<th scope="col" class="num">Buyer's qty</th>
						<th scope="col" class="num">Delivered qty</th>
						<th scope="col" class="num">Delivered</th>
					</tr>
				</thead>
				<tbody>
					{#each c.items as item (item.itemNo)}
						<tr>
							<td class="mono">{item.itemNo}</td>
							<td>{item.description}</td>
							<td class="num">{item.quantity ?? '·'}</td>
							<td class="num">{count(item.deliveredQty)}</td>
							<td class="num">{money(item.delivered)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<section class="panel" aria-labelledby="lines">
		<header class="panel-head">
			<h2 id="lines">Invoice lines that matched</h2>
			<span class="faint num">{count(c.matchedLines)}</span>
		</header>
		{#if c.lines.length === 0}
			<p class="body muted">No invoice lines have landed in scope yet.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">Posted</th>
							<th scope="col">Invoice</th>
							<th scope="col">Shipped to</th>
							<th scope="col">Item</th>
							<th scope="col" class="num">Qty</th>
							<th scope="col" class="num">Amount</th>
							<th scope="col" class="num">Running total</th>
						</tr>
					</thead>
					<tbody>
						{#each c.lines as line (line.invoiceNo + ':' + line.lineNo)}
							<tr>
								<td class="nowrap">{day(line.postedOn, data.year)}</td>
								<td class="mono">{line.invoiceNo}</td>
								<td>
									{line.customerName}
									{#if line.viaFamily}<span class="chip" title="Billed to this commitment's customer">branch</span>{/if}
								</td>
								<td class="mono">{line.itemNo}</td>
								<td class="num">{line.quantity}</td>
								<td class="num" class:negative={line.amount < 0}>{moneyExact(line.amount)}</td>
								<td class="num">{moneyExact(line.runningDelivered)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
			{#if c.matchedLines > c.lines.length}
				<p class="body">
					<RowCount
						shown={c.lines.length}
						total={c.matchedLines}
						noun="matched lines"
						order="the newest, oldest first on screen"
					/>
				</p>
			{/if}
		{/if}
	</section>

	<div class="three">
		<section class="panel" aria-labelledby="answers">
			<header class="panel-head"><h2 id="answers">Outcome history</h2></header>
			{#if c.outcomes.length === 0}
				<p class="body muted">No answers recorded.</p>
			{:else}
				<ul class="list">
					{#each c.outcomes as o (o.answeredAt + o.outcome)}
						<li>
							<span class="outcome-name">{o.outcome}</span>
							<span class="muted small">
								by {o.source === 'nightly' ? 'the nightly job' : o.answeredBy} · {moment(o.answeredAt)}
							</span>
							{#if o.note}<p class="note">{o.note}</p>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="panel" aria-labelledby="quotes">
			<header class="panel-head"><h2 id="quotes">Quotes</h2></header>
			{#if c.quotes.length === 0}
				<p class="body muted">No quote on file.</p>
			{:else}
				<ul class="list">
					{#each c.quotes as q (q.id)}
						<li>
							<span class="line">
								<a class="link mono" href="/quotes/{q.id}">SQ-{q.id}</a>
								<span class="muted">{day(q.quotedOn, data.year)}</span>
								<span class="num push">{money(q.total)}</span>
							</span>
							<span class="muted small">
								{q.linked ? `${q.lines} lines` : `${q.lines} matching lines, written later for the same customer`}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section class="panel" aria-labelledby="steps">
			<header class="panel-head"><h2 id="steps">Next steps</h2></header>
			{#if c.nextSteps.length === 0}
				<p class="body muted">None.</p>
			{:else}
				<ul class="list">
					{#each c.nextSteps as s (s.id)}
						<li class:done={s.done}>
							<span class="step-title">{s.title}</span>
							<span class="muted small">{s.ownerName}{#if s.dueOn} · due {day(s.dueOn, data.year)}{/if}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>

	{#if c.notes}
		<section class="panel" aria-labelledby="notes">
			<header class="panel-head"><h2 id="notes">Notes</h2></header>
			<p class="body notes">{c.notes}</p>
		</section>
	{/if}
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

	/* The buyer form opens under the facts row, full width. */
	.buyer-fact {
		flex: 1 1 100%;
	}

	.body {
		padding: var(--space-3);
	}

	/* The panel scrolls to its question when opened from a board row. */
	.question {
		scroll-margin-top: calc(var(--topbar-h) + var(--space-3));
		border-color: color-mix(in srgb, var(--warning) 35%, var(--hairline));
	}

	.question .panel-head {
		background: var(--warning-soft);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
	}

	.question h2 {
		color: var(--warning);
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
		border-bottom: 1px solid var(--hairline);
	}

	.figures div {
		flex: 1 1 140px;
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
		font-size: 1.25rem;
		font-weight: 600;
		letter-spacing: -0.015em;
		text-align: left;
	}

	.pct {
		font-size: 0.92rem;
		font-weight: 500;
	}

	.bar {
		display: grid;
		gap: 10px;
		padding-top: var(--space-4);
	}

	.explain,
	.small {
		font-size: 0.92rem;
	}

	.confidence {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		border-top: 1px solid var(--hairline);
	}

	.confidence label {
		display: inline;
		margin-right: auto;
	}

	.spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 1.5px solid var(--hairline-strong);
		border-top-color: var(--text);
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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

	.chip {
		margin-left: 4px;
	}

	.three {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: var(--space-3);
		align-items: start;
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
		gap: var(--space-2);
	}

	.push {
		margin-left: auto;
	}

	.outcome-name {
		font-weight: 500;
		text-transform: capitalize;
	}

	.note {
		margin-top: 2px;
	}

	.list li.done .step-title {
		color: var(--text-faint);
		text-decoration: line-through;
	}

	.notes {
		white-space: pre-line;
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
