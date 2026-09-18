<script lang="ts">
	/*
	  What the agents declined to do, and under which rule.

	  This is the most persuasive thing in the app and the thing nobody ever
	  shows. Anybody can demo an agent doing work. An agent that stops, names
	  the rule that stopped it, and leaves the refusal on the record is the
	  only evidence that the rules are real rather than a paragraph in a deck.

	  Three things per row, and they are all load bearing:

	    the rule      its id, which is the id in the guardrail registry and
	                  the id the eval suite has a case for
	    what it says  the rule in a person's words
	    where it is
	    enforced      the file and function that really refuses. NOT the
	                  registry: the registry names and counts the checks, and
	                  if the two ever disagreed the feature would win, because
	                  the feature is the one on the write path.

	  A refusal count with no rule text beside it is a number nobody can
	  argue with, which is the opposite of what this page is for.
	*/
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import { count, moment } from '$lib/format';
	import type { RefusalRow } from '$lib/agents/types';

	let {
		refusals,
		roster
	}: {
		refusals: RefusalRow[];
		/** Every named check, so the page can say what CAN refuse. */
		roster: { checkId: string; agents: string; description: string }[];
	} = $props();

	/** Checks that have never refused anything yet, by id. */
	const quiet = $derived(
		roster.filter((check) => !refusals.some((r) => r.checkId === check.checkId))
	);

	const total = $derived(refusals.reduce((sum, r) => sum + r.times, 0));
</script>

{#if refusals.length === 0}
	<EmptyState
		line="No guardrail has refused a run yet. {roster.length} named checks are in force and every one has an eval case."
	/>
{:else}
	<p class="lead prose">
		{count(total)} refusals across {refusals.length} of the {roster.length} named checks. Each one
		stopped a run that had already been drafted, and the run is still on the record.
	</p>

	<table>
		<caption class="sr-only">
			Every guardrail refusal, grouped by the rule that refused, most frequent first
		</caption>
		<thead>
			<tr>
				<th scope="col">Rule</th>
				<th scope="col">Agent</th>
				<th scope="col" class="num">Times</th>
				<th scope="col">What it stopped, last time</th>
			</tr>
		</thead>
		<tbody>
			{#each refusals as refusal (refusal.agent + refusal.workKind + refusal.checkId)}
				<tr>
					<th scope="row">
						<span class="mono">{refusal.checkId}</span>
						<span class="t-meta muted rule">{refusal.rule}</span>
						<span class="t-meta faint rule">Enforced in {refusal.enforcedIn}</span>
					</th>
					<td>
						{refusal.agentName}
						{#if refusal.workKind}
							<span class="t-meta muted block">{refusal.workKind.replace(/_/g, ' ')}</span>
						{/if}
					</td>
					<td class="num">
						{count(refusal.times)}
						<span class="t-meta muted block">last {moment(refusal.lastAt)}</span>
					</td>
					<td class="detail">
						{refusal.lastDetail || 'No detail was recorded with the refusal.'}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

{#if quiet.length > 0}
	<details class="quiet">
		<summary>
			{quiet.length} more named checks that have not had to refuse anything
		</summary>
		<!--
			A check with no refusals against it is not a check doing nothing. It
			is a check the agents have not yet tried to walk past, and the list
			is the answer to "what would stop it" rather than "what has stopped
			it". Both questions get asked.
		-->
		<ul>
			{#each quiet as check (check.checkId)}
				<li>
					<span class="mono">{check.checkId}</span>
					<span class="muted">{check.description}</span>
					<span class="t-meta faint">Applies to {check.agents}.</span>
				</li>
			{/each}
		</ul>
	</details>
{/if}

<style>
	.lead {
		margin: 0 0 var(--space-3);
	}

	.rule,
	.block {
		display: block;
		font-weight: 400;
		white-space: normal;
	}

	th[scope='row'] {
		max-width: 38ch;
	}

	.detail {
		max-width: 44ch;
		white-space: normal;
		color: var(--text-muted);
	}

	.quiet {
		margin-top: var(--space-4);
		font-size: var(--fs-meta);
	}

	.quiet summary {
		cursor: pointer;
		color: var(--text-muted);
	}

	.quiet ul {
		margin: var(--space-3) 0 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--space-2);
	}

	.quiet li {
		display: flex;
		gap: var(--space-2);
		flex-wrap: wrap;
		align-items: baseline;
		padding-bottom: var(--space-2);
		border-bottom: 1px solid var(--hairline);
	}
</style>
