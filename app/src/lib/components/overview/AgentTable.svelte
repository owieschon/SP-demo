<script lang="ts">
	/*
	  One row per agent and kind of work, straight off the harness board. The
	  numbers are not recomputed here and they are not recomputed on the
	  server either: nl.agent_autonomy_board counts them once and
	  lib/server/harness/ladder.ts is the only reader.

	  A rate reads as "not yet" rather than as 0% until somebody has decided
	  one, because a fresh agent at 0% approval and an agent nobody has looked
	  at are not the same thing and a dash is the honest difference.
	*/
	import { count, percent } from '$lib/format';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import type { AgentRow } from '$lib/server/overview/types';

	let { rows }: { rows: AgentRow[] } = $props();
</script>

<DataTable
	columns={[
		{ key: 'work', header: 'Agent and work' },
		{ key: 'level', header: 'May do' },
		{ key: 'runs', header: 'Runs', align: 'right' },
		{ key: 'waiting', header: 'Waiting', align: 'right' },
		{ key: 'approval', header: 'Approved', align: 'right' },
		{ key: 'edit', header: 'Edited', align: 'right' },
		{ key: 'refusals', header: 'Refused', align: 'right' },
		{ key: 'alone', header: 'Acted alone', align: 'right' }
	]}
	{rows}
	rowKey={(row: AgentRow) => `${row.agent}:${row.workKind}`}
	caption="Every agent and kind of work, with the level it is at and the numbers behind it"
	shown={rows.length}
	total={rows.length}
	noun="kinds of agent work"
	order="by agent"
	emptyLine="No agent is set up in this database yet."
>
	{#snippet row(agent: AgentRow)}
		<td>
			<a class="link" href={agent.href}>{agent.label}</a>
			<span class="t-meta muted block">{agent.agent} · reviewed by {agent.reviewer}</span>
			{#if agent.paused}
				<span class="t-meta paused">Paused{agent.pausedReason ? `: ${agent.pausedReason}` : ''}</span>
			{/if}
		</td>
		<td>
			{agent.levelLabel}
			<span class="t-meta muted block">{agent.verdict}</span>
		</td>
		<td class="num">{count(agent.runs)}</td>
		<td class="num">{count(agent.waiting)}</td>
		<td class="num">
			{#if agent.approvalRate === null}
				<span class="muted" title="Nobody has decided one of these yet">not yet</span>
			{:else}
				{percent(agent.approvalRate)}
				<span class="t-meta muted block">of {count(agent.reviewed)}</span>
			{/if}
		</td>
		<td class="num">
			{#if agent.editRate === null}
				<span class="muted">not yet</span>
			{:else}
				{percent(agent.editRate)}
			{/if}
		</td>
		<td class="num">
			{#if agent.refusals === 0}
				0
			{:else}
				<a class="link" href={agent.refusalsHref}>{count(agent.refusals)}</a>
			{/if}
		</td>
		<td class="num">
			{#if agent.actedAlone === 0}
				0
			{:else}
				<a class="link" href={agent.actedHref}>{count(agent.actedAlone)}</a>
				{#if agent.undone > 0}
					<span class="t-meta block warnword">{count(agent.undone)} undone</span>
				{/if}
			{/if}
		</td>
	{/snippet}
</DataTable>

<style>
	.block {
		display: block;
	}

	.paused {
		display: block;
		color: var(--danger);
	}

	.warnword {
		color: var(--warning);
	}
</style>
