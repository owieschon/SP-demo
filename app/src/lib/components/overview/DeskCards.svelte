<script lang="ts">
	/*
	  One card per agent, side by side, never added together.

	  The order desk and the procurement desk do different work for different
	  counterparties, and they earn trust separately. A single blended approval
	  rate across both of them hides the only thing worth knowing, which is
	  that one of them is ready for more rope and the other is not.

	  Four numbers per card and no more: how much it handled, how often a
	  person let it through, how often a person had to correct it first, and
	  how often a guardrail stopped it. Those are the four that change the
	  decision. Everything else is a click away.
	*/
	import { count, percent } from '$lib/format';
	import type { DeskRow } from '$lib/server/overview/types';

	let { desks, deepHref }: { desks: DeskRow[]; deepHref?: string } = $props();
</script>

<ul class="cards">
	{#each desks as desk (desk.agent)}
		<li class="card" data-agent={desk.agent}>
			<div class="head">
				<h3><a class="link" href={desk.href}>{desk.label}</a></h3>
				<span class="level">{desk.levels.join(', ')}</span>
			</div>
			{#if desk.responsibility}
				<p class="what">{desk.responsibility}</p>
			{/if}

			<dl class="four">
				<div>
					<dt>Handled</dt>
					<dd>{count(desk.runs)}</dd>
					<span class="note">{count(desk.waiting)} waiting on a person</span>
				</div>
				<div>
					<dt>Let through</dt>
					<dd>
						{#if desk.approvalRate === null}
							<span class="none">not yet</span>
						{:else}
							{percent(desk.approvalRate)}
						{/if}
					</dd>
					<span class="note">
						{desk.reviewed === 0 ? 'nobody has decided one' : `of ${count(desk.reviewed)} decided`}
					</span>
				</div>
				<div class:warn={desk.editRate !== null && desk.editRate > 0.3}>
					<dt>Corrected first</dt>
					<dd>
						{#if desk.editRate === null}
							<span class="none">not yet</span>
						{:else}
							{percent(desk.editRate)}
						{/if}
					</dd>
					<span class="note">
						{desk.approved + desk.edited === 0
							? 'nothing approved yet'
							: `${count(desk.edited)} of ${count(desk.approved + desk.edited)} approved`}
					</span>
				</div>
				<div class:warn={desk.refusals > 0}>
					<dt>Refused</dt>
					<dd>
						{#if desk.refusals === 0}
							0
						{:else}
							<a class="link" href={desk.refusalsHref}>{count(desk.refusals)}</a>
						{/if}
					</dd>
					<span class="note">by a guardrail, before anybody saw it</span>
				</div>
			</dl>

			<p class="verdict" class:ready={desk.readyForMore && desk.reviewed > 0}>
				{#if desk.paused}
					<strong>Paused.</strong>
					{desk.pausedReason ?? 'Somebody pulled the brake. It still drafts and stops.'}
				{:else}
					{desk.verdict}
				{/if}
			</p>

			<p class="ways">
				<a class="link" href={desk.href}>Its runs</a>
				{#if desk.actedAlone > 0}
					<a class="link" href={desk.actedHref}>
						{count(desk.actedAlone)} acted alone{desk.undone > 0 ? `, ${count(desk.undone)} undone` : ''}
					</a>
				{/if}
			</p>
		</li>
	{/each}
</ul>

{#if deepHref}
	<p class="t-meta muted deeper">
		<a class="link" href={deepHref}>Everything about the agents, one screen per desk</a>
	</p>
{/if}

<style>
	/*
	  Flexbox rather than grid: mobile layout on Safari iOS has been the
	  unstable one in this app, and wrapping flex items with a min-width behave
	  the same in both engines.
	*/
	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.card {
		flex: 1 1 320px;
		min-width: 0;
		display: grid;
		gap: 6px;
		align-content: start;
		padding: var(--space-3);
		border-radius: var(--radius);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	h3 {
		margin: 0;
		font-size: var(--fs-section);
	}

	.level {
		font-size: var(--fs-meta);
		color: var(--text-muted);
		padding: 0 5px;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.what {
		margin: 0;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		max-width: var(--measure);
	}

	.four {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin: 4px 0 0;
	}

	.four > div {
		flex: 1 1 100px;
		min-width: 0;
		display: grid;
		gap: 1px;
	}

	.four dt {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.four dd {
		margin: 0;
		font-size: var(--fs-title);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.four > div.warn dd {
		color: var(--warning);
	}

	.four .note {
		font-size: var(--fs-meta);
		color: var(--text-faint);
	}

	.none {
		font-size: var(--fs-body);
		font-weight: 400;
		color: var(--text-muted);
	}

	/* The harness's own sentence about why the level has not moved. It is the
	   most useful line on the card, so it is not a tooltip. */
	.verdict {
		margin: 4px 0 0;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		max-width: var(--measure);
	}

	.verdict.ready {
		color: var(--status-kept);
	}

	.ways {
		margin: 0;
		display: flex;
		gap: var(--space-3);
		flex-wrap: wrap;
		font-size: var(--fs-meta);
	}

	.deeper {
		margin-top: var(--space-3);
	}
</style>
