<script lang="ts">
	/*
	  Every answer this commitment's windows got, oldest first: what was
	  promised, what had arrived, who said what, and where the business went
	  when it moved.

	  A trail, so a list. The figures are stated next to each other with the
	  share in words, which is what a reference line on a chart would have
	  been for.
	*/
	import { day, money, moment, percentFloor, windowRange } from '$lib/format';
	import type { OutcomeEntry } from './types';

	let { outcomes, year }: { outcomes: OutcomeEntry[]; year: number } = $props();
</script>

<section class="panel" aria-labelledby="outcome-trail">
	<header class="panel-head">
		<h2 id="outcome-trail">Outcome trail</h2>
		{#if outcomes.length > 0}
			<span class="t-meta muted">{outcomes.length} answer{outcomes.length === 1 ? '' : 's'}, oldest first</span>
		{/if}
	</header>

	{#if outcomes.length === 0}
		<p class="empty">
			<span>No window has closed short yet, so nobody has had to answer for one.</span>
		</p>
	{:else}
		<ol class="trail">
			{#each outcomes as o (o.id)}
				<li style:--tone="var(--status-{o.outcome})">
					<div class="line">
						<span class="answer">{o.outcome}</span>
						{#if o.reason}<span class="muted">on {o.reason}</span>{/if}
						<span class="muted t-meta">
							{o.source === 'nightly' ? 'the nightly job' : (o.answeredByName ?? 'somebody')} · {moment(
								o.answeredAt
							)}
						</span>
					</div>

					{#if o.windowEndsOn && o.committedValue !== null && o.deliveredValue !== null}
						<p class="figures">
							Window {o.windowStartsOn
								? windowRange(o.windowStartsOn, o.windowEndsOn, year)
								: `closed ${day(o.windowEndsOn, year)}`}:
							promised {money(o.committedValue)}, delivered {money(o.deliveredValue)}
							{#if o.committedValue > 0}
								({percentFloor(o.deliveredValue / o.committedValue)} of it)
							{/if}
						</p>
					{/if}

					{#if o.note}<p class="note">{o.note}</p>{/if}

					{#if o.pushedToStartsOn && o.pushedToEndsOn}
						<p class="moved">
							Moved to {windowRange(o.pushedToStartsOn, o.pushedToEndsOn, year)}
							{#if o.nextCommitmentId}
								· <a class="link" href="/commitments/{o.nextCommitmentId}">C-{o.nextCommitmentId}</a>
							{/if}
						</p>
					{/if}
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.trail {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.trail li {
		display: grid;
		gap: 2px;
		padding: 9px var(--space-3);
		box-shadow: inset 2px 0 0 var(--tone);
	}

	.trail li + li {
		border-top: 1px solid var(--hairline);
	}

	.line {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.answer {
		font-weight: 600;
		text-transform: capitalize;
		color: var(--tone);
	}

	.figures,
	.note,
	.moved {
		margin: 0;
		font-size: var(--fs-meta);
	}

	.figures {
		font-variant-numeric: tabular-nums;
	}

	.note {
		color: var(--text-muted);
	}
</style>
