<script lang="ts">
	// One agent's runs, newest first: what woke it, what it decided, how long
	// it took, and whether a person changed anything afterwards.
	//
	// That last column is the one worth reading over time. An agent whose
	// drafts go out as written is an agent being trusted; a column full of
	// "edited" is an agent that needs its rules looking at.
	//
	// This component is deliberately self-contained so the trust page can
	// mount it as it is: it takes rows and renders them, and knows nothing
	// about where they came from. docs/agent-runs.md says how to mount it.
	import Ban from '@lucide/svelte/icons/ban';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import type { RunSummary } from '$lib/agentruns/types';
	import { AGENT_LABEL, DIFF_LABEL, OUTCOME_LABEL, WOKE_LABEL } from '$lib/agentruns/types';
	import { count, moment } from '$lib/format';

	let {
		runs,
		href = (run: RunSummary) => (run.entity === 'mail_message' && run.entityId ? `/desk/${run.entityId}` : null),
		showAgent = false,
		empty = 'No agent has run yet. Check the desk for mail and one will.'
	}: {
		runs: RunSummary[];
		/** Where a row goes, when it goes anywhere. */
		href?: (run: RunSummary) => string | null;
		showAgent?: boolean;
		empty?: string;
	} = $props();

	function took(ms: number | null): string {
		if (ms === null) return '';
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	function agentLabel(agent: string): string {
		return AGENT_LABEL[agent] ?? agent.replace(/_/g, ' ');
	}
</script>

{#if runs.length === 0}
	<EmptyState line={empty} />
{:else}
	<table>
		<thead>
			<tr>
				<th scope="col">When</th>
				{#if showAgent}<th scope="col">Agent</th>{/if}
				<th scope="col">What woke it</th>
				<th scope="col">What it did</th>
				<th scope="col" class="num">Refused</th>
				<th scope="col" class="num">Took</th>
				<th scope="col" class="num">Tokens</th>
				<th scope="col">Since then</th>
			</tr>
		</thead>
		<tbody>
			{#each runs as run (run.id)}
				{@const to = href(run)}
				<tr>
					<td class="when">
						{#if to}
							<a class="link" href={to}>{moment(run.startedAt)}</a>
						{:else}
							{moment(run.startedAt)}
						{/if}
					</td>
					{#if showAgent}<td>{agentLabel(run.agent)}</td>{/if}
					<td>
						<span class="woke">{WOKE_LABEL[run.wokeBy]}</span>
						{#if run.wokeNote}<span class="faint small">{run.wokeNote}</span>{/if}
					</td>
					<td class="did">
						<span class="outcome {run.outcome}">{OUTCOME_LABEL[run.outcome]}</span>
						{#if run.diff}<span class="faint small">{DIFF_LABEL[run.diff]}</span>{/if}
						{#if run.decision}<span class="faint small">{run.decision}</span>{/if}
						{#if run.error}<span class="error-text small">{run.error}</span>{/if}
					</td>
					<td class="num">
						{#if run.refusals > 0}
							<span class="refused"><Ban size={11} aria-hidden="true" />{run.refusals}</span>
						{:else}
							<span class="faint">none</span>
						{/if}
					</td>
					<td class="num">{took(run.durationMs)}</td>
					<td class="num">
						{run.inputTokens + run.outputTokens === 0 ? '0' : count(run.inputTokens + run.outputTokens)}
					</td>
					<td>
						{#if run.humanChange}
							{run.humanChange}
						{:else}
							<span class="faint">nothing yet</span>
						{/if}
						{#if run.replays > 0}
							<span class="faint small">{run.replays} {run.replays === 1 ? 'replay' : 'replays'}</span>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
{/if}

<style>
	.when {
		white-space: nowrap;
	}

	.woke {
		display: block;
	}

	.did {
		max-width: 46ch;
	}

	.did span,
	td > span.small {
		display: block;
	}

	.small {
		font-size: 0.85rem;
	}

	.outcome.refused,
	.outcome.failed {
		color: var(--warning);
	}

	.outcome.drafted {
		color: var(--status-delivering);
	}

	.refused {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		color: var(--warning);
	}

	.error-text {
		color: var(--danger);
	}
</style>
