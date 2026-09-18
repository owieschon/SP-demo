<script lang="ts">
	/*
	  Today: the exception queue.

	  This screen is designed for the empty case, because the empty case is
	  what the product is for. The agents read the mail, price the lines, run
	  the rules and stage the export. A person is asked for a decision only
	  where a decision is genuinely theirs: an outcome nobody but the rep
	  knows, a draft going out under the company's name, a file that looked
	  wrong, a promise that will be broken, a count of a shelf.

	  So there are no charts here and no totals. One row per kind of decision,
	  the count, the decision in the words a person would use, how long the
	  oldest one has waited, and a link into the screen where it is made. When
	  every group is empty the page says so and says what the agents got
	  through instead.
	*/
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import { day } from '$lib/format';
	import { routes } from '$lib/routes';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import type { DecisionKind } from '$lib/server/today';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/*
	  What each kind of decision is, in one word, so a person scanning the
	  page sees the shape of their morning before reading any of it. The word
	  is shown as well as the color: five greys are not a category.
	*/
	const KIND_WORD: Record<DecisionKind, string> = {
		answer: 'Answer',
		approve: 'Approve',
		release: 'Release',
		schedule: 'Reschedule',
		count: 'Count'
	};

	/*
	  How long the oldest thing in a group has been waiting. Two lines: the
	  wait, and the date it started, because "44 days" is the urgency and
	  "since Aug 4" is the fact. A group whose oldest arrived today has no
	  second line: it would say "since today, since Sep 17".
	*/
	function waited(oldest: string, today: string): { wait: string; since: string | null } {
		const days = Math.round(
			(Date.parse(`${today}T00:00:00Z`) - Date.parse(`${oldest}T00:00:00Z`)) / 86_400_000
		);
		if (days <= 0) return { wait: 'arrived today', since: null };
		if (days === 1) return { wait: 'waiting 1 day', since: oldest };
		return { wait: `oldest waiting ${days} days`, since: oldest };
	}
</script>

<Page
	title="Today"
	documentTitle="Today"
	subtitle="Everything waiting on a person, and nothing else. The agents handle the rest."
>
	{#snippet actions()}
		<a class="button" href={routes.workspaceDecisions()}>What the agents did</a>
	{/snippet}

	{#await data.queue}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={3} cols={3} height={56} label="Working out what needs you" />
		</section>
	{:then queue}
		{#if queue.waiting === 0}
			<!--
				The case the product is aiming at, so it is designed first and it
				is not a shrug. It says plainly that nothing is waiting, says
				what the agents got through instead, and offers the one thing
				worth doing next: checking their work.
			-->
			<section class="panel clear" aria-labelledby="clear-title">
				<p class="tick" aria-hidden="true"><Check size={20} strokeWidth={2} /></p>
				<h2 id="clear-title">Nothing needs you</h2>
				{#if queue.agentActions > 0}
					<p class="muted prose">
						The agents handled {queue.agentActions}
						{queue.agentActions === 1 ? 'thing' : 'things'} in the last day without asking: mail
						read and answered, rules fired, lookups run.
					</p>
				{:else}
					<p class="muted prose">
						No decision is waiting on you, and the agents have not needed to ask about anything
						since this database was built.
					</p>
				{/if}
				<p class="links">
					<a class="button primary" href={routes.workspaceDecisions()}>
						See what the agents did
						<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
					</a>
					<a class="button" href={routes.commitments()}>Look at the book anyway</a>
				</p>
			</section>
		{:else}
			<p class="lede">
				<strong>{queue.waiting}</strong>
				{queue.waiting === 1 ? 'thing needs' : 'things need'} you, in
				{queue.groups.length}
				{queue.groups.length === 1 ? 'kind' : 'kinds'} of decision. Everything else the agents
				handled.
			</p>

			<Panel title="Waiting for you" asOf={queue.today} thisYear={data.year} flush>
				<ul class="rows">
					{#each queue.groups as group (group.id)}
						<li>
							<a class="row" href={group.href} data-group-id={group.id}>
								<span class="count num">{group.count}</span>
								<span class="what">
									<span class="title">
										<span class="kind">{KIND_WORD[group.kind]}</span>
										{group.title}
									</span>
									<span class="decision">{group.decision}</span>
								</span>
								<span class="when">
									{#if group.oldest}
										{@const age = waited(group.oldest, queue.today)}
										<span class="t-meta muted">{age.wait}</span>
										{#if age.since}
											<span class="t-meta faint">since {day(group.oldest, data.year)}</span>
										{/if}
									{/if}
								</span>
								<ArrowRight size={15} strokeWidth={1.75} class="go" aria-hidden="true" />
							</a>
						</li>
					{/each}
				</ul>
			</Panel>

			<p class="t-meta muted footnote">
				{#if queue.agentActions > 0}
					In the same day the agents handled {queue.agentActions} things without asking.
				{:else}
					Nothing else is waiting: the agents either finished it or never needed to ask.
				{/if}
				<a class="link" href={routes.workspaceDecisions()}>See their work</a>
			</p>
		{/if}
	{:catch}
		<LoadFailed what="what needs you" />
	{/await}
</Page>

<style>
	.lede {
		font-size: var(--fs-section);
		max-width: var(--measure);
	}

	/* ------------------------------------------------------- the queue */

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		min-height: 56px;
		transition: background-color var(--speed) var(--ease);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row:active {
		background: var(--surface-press);
	}

	/* The count is the first thing read, so it is the largest thing in the
	   row and it is tabular, so a column of them lines up. */
	.count {
		flex: none;
		min-width: 2.5ch;
		font-size: var(--fs-page);
		font-weight: 600;
		letter-spacing: -0.02em;
	}

	.what {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	.title {
		font-weight: 500;
	}

	/* The kind of decision, as a word. It leads the line because a person
	   triaging wants the verb before the noun. */
	.kind {
		display: inline-block;
		margin-right: 6px;
		padding: 0 5px;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
		font-size: var(--fs-meta);
		font-weight: 500;
		color: var(--text-muted);
	}

	.decision {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.when {
		flex: none;
		display: grid;
		gap: 0;
		justify-items: end;
		text-align: right;
	}

	.row :global(.go) {
		flex: none;
		color: var(--text-faint);
		transition: transform var(--speed) var(--ease);
	}

	.row:hover :global(.go) {
		color: var(--text);
		transform: translateX(2px);
	}

	/* -------------------------------------------------- nothing waiting */

	.clear {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		padding: var(--space-6) var(--space-4);
		text-align: center;
	}

	.tick {
		display: grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border-radius: var(--radius-full);
		background: var(--surface-sunken);
		color: var(--status-kept);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.links {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
		justify-content: center;
		margin-top: var(--space-2);
	}

	.footnote {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	/* On a phone the dates drop under the decision rather than squeezing it. */
	@media (max-width: 720px) {
		.row {
			flex-wrap: wrap;
		}

		.when {
			flex: 1 1 100%;
			justify-items: start;
			text-align: left;
		}
	}
</style>
