<script lang="ts">
	/*
	  What this account's record looks like, for the moment before somebody
	  promises them a date: how its settled windows ended, how its quotes
	  went, and why the losses were lost.

	  No chart. The account page already has one (24 months of revenue), and
	  the rule here is one per screen. The pattern is a small inline mark
	  beside a sentence that says the same thing in words.
	*/
	import { day, percent } from '$lib/format';
	import OutcomePattern from './OutcomePattern.svelte';
	import type { AccountRecord } from './types';

	let { record, year }: { record: AccountRecord; year: number } = $props();

	/** The record in one sentence, with what it is being compared against. */
	const verdict = $derived.by(() => {
		if (record.settledCount === 0) return 'Nothing has settled yet, so there is no record to read.';
		const kept = percent(record.keptRate ?? 0);
		const shape =
			(record.keptRate ?? 0) >= 0.8
				? 'They keep what they promise.'
				: (record.keptRate ?? 0) >= 0.6
					? 'They keep most of what they promise.'
					: 'They miss more windows than they keep. Worth saying so before agreeing a date.';
		return `${kept} of ${record.settledCount} settled windows were kept. ${shape}`;
	});

	const quoteLine = $derived.by(() => {
		const decided = record.quotesWon + record.quotesLost;
		if (record.quotes === 0) return 'No quote has ever gone out to this account.';
		if (decided === 0) return `${record.quotes} quotes out, none decided yet.`;
		return `${record.quotesWon} of ${decided} decided quotes were won (${percent(record.quotesWon / decided)}).`;
	});
</script>

<section class="panel" aria-labelledby="account-record">
	<header class="panel-head">
		<h2 id="account-record">Their record</h2>
		<span class="t-meta muted">
			{#if record.lastSettledOn}last settled {day(record.lastSettledOn, year)}{/if}
		</span>
	</header>

	<div class="panel-body body">
		<p class="headline">
			<OutcomePattern pattern={record.pattern} record={record} />
			<span>{verdict}</span>
		</p>

		<dl class="figures">
			<div>
				<dt>Kept</dt>
				<dd class="num">{record.kept}</dd>
			</div>
			<div>
				<dt>Pushed</dt>
				<dd class="num">{record.pushed}</dd>
			</div>
			<div>
				<dt>Broken</dt>
				<dd class="num">{record.broken}</dd>
			</div>
			<div>
				<dt>Quotes won</dt>
				<dd class="num">{record.quotesWon}</dd>
			</div>
			<div>
				<dt>Quotes lost</dt>
				<dd class="num">{record.quotesLost}</dd>
			</div>
		</dl>

		<p class="muted t-meta">{quoteLine}</p>

		{#if record.lossReasons.length > 0}
			<ul class="reasons">
				{#each record.lossReasons as r (r.reason)}
					<li>
						<span>{r.reason}</span>
						<span class="num">{r.count}</span>
					</li>
				{/each}
			</ul>
		{/if}

		{#if record.requirementsOpen > 0}
			<p class="t-meta owed">
				{record.requirementsOpen} condition{record.requirementsOpen === 1 ? '' : 's'} still owed across their
				quotes and programs{#if record.requirementsOverdue > 0}, {record.requirementsOverdue} past the day it was
					due{/if}.
			</p>
		{/if}
	</div>
</section>

<style>
	.body {
		display: grid;
		gap: var(--space-2);
	}

	.headline {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		margin: 0;
	}

	.figures dt {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.figures dd {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.reasons {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--hairline);
	}

	.reasons li {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 4px 0;
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.reasons li + li {
		border-top: 1px solid var(--hairline);
	}

	.owed {
		margin: 0;
		color: var(--warning);
	}
</style>
