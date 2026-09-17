<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import OutcomeForm from '$lib/components/OutcomeForm.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { count, day, moment, money, moneyExact, percent, windowRange } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const c = $derived(data.commitment);
	const failed = $derived(form && 'message' in form && !('replayed' in form));

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
	<a class="back" href="/commitments">← Commitments</a>

	<header class="head">
		<div class="title-row">
			<h1>{c.title}</h1>
			<StatusBadge status={c.status} />
		</div>
		<p class="muted">
			<span class="mono">C-{c.id}</span> ·
			{c.customerName} <span class="mono faint">{c.customerNo}</span>
			{#if c.customerCity}· {c.customerCity}, {c.customerState}{/if}
		</p>
		<p class="muted">
			Owner {c.ownerName} ·
			{#if c.buyerName}
				Buyer {c.buyerName}{#if c.buyerEmail}&nbsp;<span class="faint">({c.buyerEmail})</span>{/if}
			{:else}
				<span class="warn-text">No buyer named</span>
			{/if}
			· Window {windowRange(c.startsOn, c.endsOn, data.year)}
		</p>
	</header>

	{#if form?.message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>
			{form.message}
			{#if form && 'conflict' in form && form.conflict}
				<button class="button quiet" onclick={() => invalidateAll()}>Reload</button>
			{/if}
		</p>
	{/if}

	{#if c.needsOutcome}
		<section class="question" aria-labelledby="question">
			<h2 id="question">The window closed {c.daysSinceClose} days ago with {percent(c.deliveredRatio)} delivered. What happened?</h2>
			{#if c.canAnswer}
				<OutcomeForm commitmentId={c.id} updatedAt={c.updatedAt} requestId={data.requestIds.outcome} />
			{:else}
				<p class="muted">Waiting on {c.ownerName}. Only the owner or an admin can answer.</p>
			{/if}
		</section>
	{/if}

	<section class="numbers" aria-label="Progress">
		<dl>
			<div>
				<dt>Committed</dt>
				<dd class="num">{money(c.committedValue)}</dd>
			</div>
			<div>
				<dt>Delivered</dt>
				<dd class="num">{money(c.delivered)} <span class="faint">({percent(c.deliveredRatio)})</span></dd>
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
		<ProgressBar
			ratio={c.deliveredRatio}
			pace={c.isSettled ? null : c.windowElapsedRatio}
			status={c.status}
			label="Delivered"
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

		{#if c.canEdit}
			<form
				method="POST"
				action="?/confidence"
				class="confidence"
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
				<label>
					Your confidence that the rest arrives
					<select name="confidence" value={c.confidence}>
						{#each confidenceChoices as value (value)}
							<option {value}>{value}%</option>
						{/each}
					</select>
				</label>
				<button class="button" disabled={savingConfidence}>{savingConfidence ? 'Saving…' : 'Save'}</button>
			</form>
		{/if}
	</section>

	<section aria-labelledby="scope">
		<h2 id="scope">Parts in scope</h2>
		<p class="faint small">Delivery counts these item numbers, whatever order they arrive on.</p>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Item</th>
						<th>Description</th>
						<th class="num">Buyer's qty</th>
						<th class="num">Delivered qty</th>
						<th class="num">Delivered</th>
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

	<section aria-labelledby="lines">
		<h2 id="lines">Invoice lines that matched <span class="faint">({count(c.matchedLines)})</span></h2>
		{#if c.lines.length === 0}
			<p class="muted">No invoice lines have landed in scope yet.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Posted</th>
							<th>Invoice</th>
							<th>Shipped to</th>
							<th>Item</th>
							<th class="num">Qty</th>
							<th class="num">Amount</th>
							<th class="num">Running total</th>
						</tr>
					</thead>
					<tbody>
						{#each c.lines as line (line.invoiceNo + ':' + line.lineNo)}
							<tr>
								<td>{day(line.postedOn, data.year)}</td>
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
		{/if}
	</section>

	<div class="two">
		<section aria-labelledby="answers">
			<h2 id="answers">Outcome history</h2>
			{#if c.outcomes.length === 0}
				<p class="muted">No answers recorded.</p>
			{:else}
				<ul class="list">
					{#each c.outcomes as o (o.answeredAt + o.outcome)}
						<li>
							<strong>{o.outcome}</strong>
							<span class="muted">
								by {o.source === 'nightly' ? 'the nightly job' : o.answeredBy} · {moment(o.answeredAt)}
							</span>
							{#if o.note}<p class="small">{o.note}</p>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section aria-labelledby="quotes">
			<h2 id="quotes">Quotes</h2>
			{#if c.quotes.length === 0}
				<p class="muted">No quote on file.</p>
			{:else}
				<ul class="list">
					{#each c.quotes as q (q.id)}
						<li>
							<span class="mono">SQ-{q.id}</span> · {day(q.quotedOn, data.year)} ·
							<span class="num">{money(q.total)}</span>
							<span class="muted">
								{q.linked ? `${q.lines} lines` : `${q.lines} matching lines, written later for the same customer`}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<section aria-labelledby="steps">
			<h2 id="steps">Next steps</h2>
			{#if c.nextSteps.length === 0}
				<p class="muted">None.</p>
			{:else}
				<ul class="list">
					{#each c.nextSteps as s (s.id)}
						<li class:done={s.done}>
							{s.title}
							<span class="muted">· {s.ownerName}{#if s.dueOn} · due {day(s.dueOn, data.year)}{/if}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>

	{#if c.notes}
		<section aria-labelledby="notes">
			<h2 id="notes">Notes</h2>
			<p>{c.notes}</p>
		</section>
	{/if}
</main>

<style>
	.page {
		max-width: 1080px;
		margin: 0 auto;
		padding: var(--space-4) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-5);
	}

	.back {
		font-size: 0.9rem;
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.warn-text {
		color: var(--warning);
	}

	.question {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--warning);
		border-radius: var(--radius-lg);
		background: var(--warning-soft);
	}

	.question h2 {
		color: var(--warning);
	}

	.numbers {
		display: grid;
		gap: var(--space-3);
	}

	.numbers dl {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-6);
		margin: 0;
	}

	.numbers dt {
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	.numbers dd {
		margin: 0;
		font-size: 1.25rem;
		font-weight: 600;
		text-align: left;
	}

	.explain,
	.small {
		font-size: 0.85rem;
	}

	.confidence {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
	}

	section h2 {
		margin-bottom: var(--space-2);
	}

	.table-wrap {
		overflow-x: auto;
	}

	.negative {
		color: var(--danger);
	}

	.chip {
		font-size: 0.72rem;
		padding: 1px 6px;
		margin-left: 4px;
		border-radius: 999px;
		background: var(--surface-sunken);
		color: var(--text-muted);
	}

	.two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
		gap: var(--space-5);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--hairline);
	}

	.list li.done {
		color: var(--text-faint);
		text-decoration: line-through;
	}
</style>
