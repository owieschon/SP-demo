<script lang="ts">
	/*
	  The run feed. One row per agent run, newest first, and beside it the
	  refusals the agents ran into most often, so a person arriving to ask
	  "what is it refusing to do" does not have to read the feed to find out.
	*/
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { count, moment } from '$lib/format';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import type { RunListRow } from '$lib/server/overview/agents';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const REVIEW_WORD: Record<string, string> = {
		none: 'nobody asked',
		waiting: 'waiting on a person',
		approved: 'approved as drafted',
		edited_approved: 'corrected, then approved',
		rejected: 'rejected'
	};
</script>

<Page title="Agent runs" documentTitle="Agent runs">
	{#snippet breadcrumb()}
		<a class="link-quiet" href={data.nav.overview}>
			<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
			Overview
		</a>
	{/snippet}

	{#snippet actions()}
		<a class="button sm" href={data.nav.all}>Every run</a>
		<a class="button sm" href={data.nav.refused}>Refused</a>
		<a class="button sm" href={data.nav.acted}>Acted alone</a>
	{/snippet}

	{#await data.feed}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={12} cols={6} height={32} header label="Reading the run log" />
		</section>
	{:then feed}
		<Panel title="Runs" source="the harness run log" flush>
			<p class="t-meta muted note">{feed.note}</p>
			<DataTable
				columns={[
					{ key: 'run', header: 'Run' },
					{ key: 'woke', header: 'What woke it' },
					{ key: 'subject', header: 'About' },
					{ key: 'produced', header: 'What it produced' },
					{ key: 'decided', header: 'What happened next' },
					{ key: 'tools', header: 'Lookups', align: 'right' },
					{ key: 'when', header: 'Started' }
				]}
				rows={feed.rows}
				rowKey={(row: RunListRow) => row.runKey}
				caption="Agent runs, newest first, with what woke each one and what a person decided about it"
				shown={feed.rows.length}
				total={feed.rows.length}
				noun="runs"
				order="newest first"
				emptyLine="No agent has run yet. The desks start a run when they read their mail."
			>
				{#snippet row(run: RunListRow)}
					<td>
						<a class="link" href={run.href}>{run.agent}</a>
						<span class="t-meta muted block">{run.workKind}</span>
					</td>
					<td>
						{run.wokeBy}
						{#if run.wakeDetail}<span class="t-meta muted block">{run.wakeDetail}</span>{/if}
					</td>
					<td>
						{#if run.subjectHref && run.subjectNo}
							<a class="link" href={run.subjectHref}>{run.subjectNo}</a>
						{:else if run.subjectNo}
							{run.subjectNo}
						{/if}
					</td>
					<td>
						{run.produced}
						{#if run.actedAlone}<span class="t-meta alone block">acted on its own</span>{/if}
						{#if run.degraded}<span class="t-meta warnword block">degraded to a cheaper path</span>{/if}
					</td>
					<td>
						{#if run.guardrail}
							<span class="dangerword">{run.guardrail}</span>
							<span class="t-meta muted block">{run.guardrailReason}</span>
						{:else}
							{REVIEW_WORD[run.reviewState] ?? run.reviewState}
							{#if run.reviewedByName}
								<span class="t-meta muted block">{run.reviewedByName}</span>
							{/if}
						{/if}
					</td>
					<td class="num">{count(run.toolCallCount)}</td>
					<td>
						{moment(run.startedAt)}
						<span class="t-meta muted block">{count(run.ms)} ms</span>
					</td>
				{/snippet}
			</DataTable>
		</Panel>

		<Panel title="What they were refused most often" source="guardrail events" flush>
			{#if feed.refusals.length === 0}
				<p class="t-meta muted note">No guardrail has refused anything yet.</p>
			{:else}
				<ul class="rows">
					{#each feed.refusals as refusal (`${refusal.agent}:${refusal.workKind}:${refusal.checkId}`)}
						<li>
							<a class="refusal" href={refusal.href}>
								<span class="times num">{refusal.times}</span>
								<span class="what">
									<span class="title">{refusal.checkId}</span>
									<span class="detail">
										{refusal.agent} · {refusal.workKind}. Last time: {refusal.lastDetail}
									</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{:catch}
		<LoadFailed what="the run feed" />
	{/await}
</Page>

<style>
	.block {
		display: block;
	}

	.note {
		padding: var(--space-3) var(--space-3) 0;
		max-width: var(--measure);
	}

	.warnword {
		color: var(--warning);
	}

	.dangerword {
		color: var(--danger);
		font-weight: 500;
	}

	.alone {
		color: var(--status-delivering);
	}

	.refusal {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.refusal:hover {
		background: var(--surface-hover);
	}

	.times {
		flex: none;
		min-width: 3ch;
		font-weight: 600;
		color: var(--danger);
	}

	.what {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		gap: 1px;
	}

	.title {
		font-weight: 500;
	}

	.detail {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}
</style>
