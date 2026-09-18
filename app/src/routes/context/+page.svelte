<script lang="ts">
	// Coverage: the context engine's work list.
	//
	// The thing this screen exists to prevent is a surprise. A gap you can see
	// is a job; a gap you cannot see is a customer telling you about it. So
	// the worst-covered rows come first, each one says how many of the
	// subjects that matter have no fresh answer, and each one carries the
	// control that goes and looks.
	import { enhance } from '$app/forms';
	import CoverageTable from '$lib/components/context/CoverageTable.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import { count } from '$lib/format';
	import { routes } from '$lib/routes';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let building = $state(false);

	const message = $derived(form && 'message' in form ? form.message : null);
	const failed = $derived(Boolean(form && 'conflict' in form));
</script>

<Page
	title="Context"
	subtitle="What the agents know, where each piece came from, and what is still missing."
>
	{#snippet actions()}
		<form
			method="POST"
			action="?/build"
			use:enhance={() => {
				building = true;
				return async ({ update }) => {
					building = false;
					await update({ reset: false });
				};
			}}
		>
			<SubmitButton label="Run the build" workingLabel="Building" working={building} />
		</form>
	{/snippet}

	<!-- Two screens, not two tabs on one: they are separate routes, so these
	     are links and middle-click works. -->
	<nav class="segmented" aria-label="Which context view">
		<a href={routes.context()} aria-current="page">Coverage</a>
		<a href={routes.contextConflicts()}>Conflicts and queries</a>
	</nav>

	{#if message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>{message}</p>
	{/if}

	<Panel title="Where it comes from, and how far each one is trusted" flush>
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">Source</th>
						<th scope="col" class="num">Trust</th>
						<th scope="col">Refreshed</th>
						<th scope="col">Authoritative for</th>
						<th scope="col" class="num">Documents</th>
						<th scope="col" class="num">Claims</th>
					</tr>
				</thead>
				<tbody>
					{#each data.sources as source (source.key)}
						<tr>
							<th scope="row">
								{source.name}
								<span class="t-meta muted mono">{source.kind}</span>
							</th>
							<td class="num">{source.trust_tier} of 5</td>
							<td class="t-meta">{source.refresh_cadence}</td>
							<td class="t-meta muted">{source.authoritative_for}</td>
							<td class="num">{count(source.documents)}</td>
							<td class="num">{count(source.claims)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="t-meta muted foot">
			Trust is the whole of what the promotion rule knows about a source: highest tier wins, then
			the most recent assertion, then the most corroborated.
			{#if data.policyEngine}
				Thresholds and freshness horizons come from the policy engine.
			{:else}
				Thresholds and freshness horizons come from this feature's own defaults; the policy engine
				is not in this database.
			{/if}
		</p>
	</Panel>

	{#await data.coverage}
		<Panel title="Coverage" busy flush>
			<SkeletonRows rows={10} cols={6} header label="Loading coverage" />
		</Panel>
	{:then coverage}
		<Panel
			title="Coverage"
			source="the data dictionary against the accounts that matter"
			flush
		>
			{#if coverage.rows.length === 0}
				<EmptyState
					line="No attributes in the data dictionary yet, so there is nothing to cover."
				/>
			{:else}
				<CoverageTable rows={coverage.rows} gaps={coverage.gaps} requestId={data.requestId} />
			{/if}
		</Panel>
	{:catch}
		<LoadFailed what="the coverage list" />
	{/await}

	{#await data.covered then covered}
		{#if covered.length > 0}
			<Panel title="Subjects with the most context" flush>
				<ul class="rows">
					{#each covered as subject (`${subject.subject_kind}|${subject.subject_id}`)}
						<li>
							<a class="link" href={routes.contextFor(subject.subject_kind, subject.subject_id)}>
								{subject.name ?? subject.subject_id}
							</a>
							<span class="t-meta muted">
								{subject.subject_kind}
								<span aria-hidden="true">·</span>
								{count(subject.facts)} fact{subject.facts === 1 ? '' : 's'}
							</span>
						</li>
					{/each}
				</ul>
			</Panel>
		{/if}
	{/await}
</Page>

<style>
	.foot {
		padding: var(--space-3);
		margin: 0;
	}

	.mono {
		display: block;
	}

	.rows > li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: var(--space-2) var(--space-3);
	}

	.rows > li > span {
		margin-left: auto;
	}
</style>
