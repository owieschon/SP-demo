<script lang="ts">
	/*
	  The conditions this commitment and its quotes carry, as a checklist:
	  what is still owed at the top, what is signed off underneath.

	  These are the facts a reply must not forget. The heading carries the
	  count as a number with its comparison in words rather than a gauge.
	*/
	import { day } from '$lib/format';
	import { REQUIREMENT_LABEL, type RequirementRow } from './types';

	let { requirements, year }: { requirements: RequirementRow[]; year: number } = $props();

	const met = $derived(requirements.filter((r) => r.satisfied).length);
	const overdue = $derived(requirements.filter((r) => r.overdue).length);
</script>

<section class="panel" aria-labelledby="requirements">
	<header class="panel-head">
		<h2 id="requirements">Conditions</h2>
		{#if requirements.length > 0}
			<span class="t-meta muted">
				{met} of {requirements.length} signed off{#if overdue > 0}, {overdue} past the day they were due{/if}
			</span>
		{/if}
	</header>

	{#if requirements.length === 0}
		<p class="empty">
			<span>No conditions recorded. Standard terms, standard packaging, no certificate asked for.</span>
		</p>
	{:else}
		<ul class="list">
			{#each requirements as r (r.id)}
				<li class:met={r.satisfied} class:overdue={r.overdue}>
					<span class="box" aria-hidden="true">{r.satisfied ? '✓' : ''}</span>
					<span class="body">
						<span class="line">
							<span class="kind">{REQUIREMENT_LABEL[r.kind]}</span>
							{#if r.attribute}<span class="attribute mono">{r.attribute}</span>{/if}
							{#if r.onCommitment}
								<span class="chip">whole program</span>
							{:else if r.quoteId}
								<a class="chip" href="/quotes/{r.quoteId}">SQ-{r.quoteId}</a>
							{/if}
							{#if r.lapsed}<span class="chip warn">hold has run out</span>{/if}
						</span>
						{#if r.detail}<span class="detail muted">{r.detail}</span>{/if}
						<span class="state t-meta">
							{#if r.satisfied}
								Signed off{#if r.satisfiedOn}
									{day(r.satisfiedOn, year)}{/if}{#if r.satisfiedByName}
									by {r.satisfiedByName}{/if}.
								{#if r.satisfiedNote}{r.satisfiedNote}{/if}
							{:else if r.overdue && r.requiredBy}
								Still owed. Was due {day(r.requiredBy, year)}.
							{:else if r.requiredBy}
								Still owed, due {day(r.requiredBy, year)}.
							{:else}
								Still owed. No date agreed.
							{/if}
						</span>
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: 8px var(--space-3);
	}

	.list li + li {
		border-top: 1px solid var(--hairline);
	}

	.list li.overdue {
		box-shadow: inset 2px 0 0 var(--warning);
	}

	.box {
		flex: none;
		width: 16px;
		height: 16px;
		margin-top: 2px;
		border-radius: var(--radius-sm);
		display: grid;
		place-items: center;
		font-size: 11px;
		line-height: 1;
		box-shadow: inset 0 0 0 1px var(--hairline-strong);
	}

	.list li.met .box {
		background: color-mix(in srgb, var(--status-kept) 18%, transparent);
		box-shadow: inset 0 0 0 1px var(--status-kept);
		color: var(--status-kept);
	}

	.body {
		display: grid;
		gap: 1px;
		min-width: 0;
	}

	.line {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.kind {
		font-weight: 500;
	}

	.list li.met .kind {
		color: var(--text-muted);
	}

	.attribute {
		font-size: var(--fs-meta);
	}

	.detail,
	.state {
		font-size: var(--fs-meta);
	}

	.state {
		color: var(--text-faint);
	}
</style>
