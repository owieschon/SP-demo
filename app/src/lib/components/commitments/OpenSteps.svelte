<script lang="ts">
	/*
	  What somebody still owes on this commitment, and what has already been
	  done. Overdue at the top, then due today, then the rest.

	  A step proposed by an agent says so on its own row, because the point of
	  letting an agent propose work is being able to see afterwards how much
	  of it was worth doing.
	*/
	import { day, moment } from '$lib/format';
	import { NEXT_STEP_LABEL, type DepthStep } from './types';

	let { steps, year }: { steps: DepthStep[]; year: number } = $props();

	const open = $derived(steps.filter((s) => !s.done));
	const done = $derived(steps.filter((s) => s.done));
	const overdue = $derived(open.filter((s) => s.overdue).length);
	const fromAgent = $derived(open.filter((s) => s.source === 'agent').length);

	/** Overdue first, then due today, then by date. */
	const ordered = $derived(
		open.slice().sort((a, b) => {
			const rank = (s: DepthStep) => (s.overdue ? 0 : s.dueToday ? 1 : 2);
			return rank(a) - rank(b) || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999');
		})
	);
</script>

<section class="panel" aria-labelledby="next-steps-depth">
	<header class="panel-head">
		<h2 id="next-steps-depth">Next steps</h2>
		{#if open.length > 0}
			<span class="t-meta muted">
				{open.length} open{#if overdue > 0}, {overdue} past due{/if}{#if fromAgent > 0}, {fromAgent} proposed by
					an agent{/if}
			</span>
		{/if}
	</header>

	{#if steps.length === 0}
		<p class="empty">
			<span>Nothing owed on this one. If it needs a call or a quote, that is the thing nobody has written down.</span>
		</p>
	{:else}
		<ul class="list">
			{#each ordered as s (s.id)}
				<li class:overdue={s.overdue} class:today={s.dueToday}>
					<span class="line">
						<span class="kind chip">{NEXT_STEP_LABEL[s.kind]}</span>
						<span class="title">{s.title}</span>
						{#if s.source === 'agent'}
							<span class="chip">proposed by the {s.agent}</span>
						{/if}
					</span>
					<span class="meta t-meta">
						{s.ownerName}
						{#if s.dueOn}
							· {s.overdue ? 'was due' : s.dueToday ? 'due today,' : 'due'}
							{s.dueToday ? '' : day(s.dueOn, year)}
						{:else}
							· no date
						{/if}
						{#if s.source === 'person' && s.createdByName !== s.ownerName}· written by {s.createdByName}{/if}
					</span>
					{#if s.note}<span class="note t-meta">{s.note}</span>{/if}
				</li>
			{/each}
		</ul>

		{#if done.length > 0}
			<details class="done">
				<summary>{done.length} already done</summary>
				<ul class="list">
					{#each done as s (s.id)}
						<li class="finished">
							<span class="line">
								<span class="kind chip">{NEXT_STEP_LABEL[s.kind]}</span>
								<span class="title">{s.title}</span>
								{#if s.doneLate}<span class="chip warn">late</span>{/if}
							</span>
							<span class="meta t-meta">
								{s.ownerName}
								{#if s.completedAt}· finished {moment(s.completedAt)}{/if}
								{#if s.dueOn}· was due {day(s.dueOn, year)}{/if}
							</span>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	{/if}
</section>

<style>
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

	.list li.overdue {
		box-shadow: inset 2px 0 0 var(--warning);
	}

	.list li.today {
		box-shadow: inset 2px 0 0 var(--hairline-strong);
	}

	.line {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.title {
		font-weight: 500;
	}

	.finished .title {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.meta,
	.note {
		color: var(--text-muted);
	}

	.note {
		color: var(--text-faint);
	}

	.done {
		border-top: 1px solid var(--hairline);
	}

	.done summary {
		padding: 7px var(--space-3);
		cursor: pointer;
		color: var(--text-muted);
		font-size: var(--fs-meta);
	}

	.done summary:hover {
		color: var(--text);
	}
</style>
