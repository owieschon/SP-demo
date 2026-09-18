<script lang="ts">
	// What we know about one account, supplier, part or person.
	//
	// Two halves, and the split is the point.
	//
	// The top half is what an AGENT reads: the compiled bundle for one
	// purpose, with its version, its hash and its age. Switching the purpose
	// changes which facts are in it, which is the dictionary's surfaces and
	// disclosure rules working in front of you rather than in a document.
	//
	// The bottom half is the whole record: every fact including the stale
	// ones, each with the words it came from. A fact with no visible snippet
	// is an assertion, so the snippet is part of the row.
	import FactList from '$lib/components/context/FactList.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Figure from '$lib/components/ui/Figure.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import { bundleAgeLabel } from '$lib/context/links';
	import { SURFACE_LABEL, SURFACES, bundleServed } from '$lib/context/types';
	import { count, day } from '$lib/format';
	import { routes } from '$lib/routes';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const message = $derived(form && 'message' in form ? form.message : null);
	const failed = $derived(Boolean(form && 'conflict' in form));
	const thisYear = 2026;

	const subject = $derived(data.context.subject);
	const fresh = $derived(data.context.facts.filter((fact) => !fact.stale && !fact.expired));
	const stale = $derived(data.context.facts.filter((fact) => fact.stale || fact.expired));

	/** The record this entity has its own page for, when it has one. */
	const recordHref = $derived(
		subject.kind === 'customer'
			? routes.account(subject.id)
			: subject.kind === 'vendor'
				? routes.vendor(subject.id)
				: subject.kind === 'item'
					? routes.part(subject.id)
					: null
	);

	function purposeHref(purpose: string): string {
		return `?purpose=${purpose}`;
	}
</script>

<Page title={subject.name ?? subject.id} documentTitle="Context for {subject.name ?? subject.id}">
	{#snippet actions()}
		{#if recordHref}
			<a class="button" href={recordHref}>Open the record</a>
		{/if}
	{/snippet}

	<p class="t-meta muted crumbs">
		<a class="link" href={routes.context()}>Context</a>
		<span aria-hidden="true">·</span>
		{subject.kind}
		{subject.id}
		{#if data.context.openConflicts > 0}
			<span aria-hidden="true">·</span>
			<a class="link" href={routes.contextConflicts()}>
				{data.context.openConflicts} waiting on a decision
			</a>
		{/if}
	</p>

	{#if message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>{message}</p>
	{/if}

	<Panel title="What an agent reads">
		<nav class="segmented" aria-label="Which purpose">
			{#each SURFACES as purpose (purpose)}
				<a href={purposeHref(purpose)} aria-current={data.purpose === purpose ? 'page' : undefined}>
					{SURFACE_LABEL[purpose]}
				</a>
			{/each}
		</nav>

		{#if bundleServed(data.bundle)}
			<dl class="figures">
				<Figure
					label="Facts in the bundle"
					value={count(data.bundle.facts.length)}
					compare="of {count(data.context.facts.length)} we hold"
					source="compiled bundle"
				/>
				<Figure
					label="Version"
					value={String(data.bundle.bundle_version)}
					compare={bundleAgeLabel(data.bundle.age_hours)}
					tone={data.bundle.bundle_stale ? 'warn' : 'plain'}
					toneWord={data.bundle.bundle_stale ? 'the mill is behind' : undefined}
				/>
				<Figure
					label="Playbooks in scope"
					value={count(data.bundle.playbooks.length)}
					compare="durable know-how, not extracted"
				/>
				<Figure
					label="Stale, not served"
					value={count(data.bundle.stale.length)}
					compare="asking to be verified again"
					tone={data.bundle.stale.length > 0 ? 'warn' : 'plain'}
					toneWord={data.bundle.stale.length > 0 ? 'past its horizon' : undefined}
				/>
			</dl>

			<p class="t-meta muted hash">
				{data.bundle.external
					? 'This purpose can end up in front of somebody outside the company, so nothing marked internal is in it.'
					: 'This purpose stays inside, so internal facts are included.'}
				<span aria-hidden="true">·</span>
				hash <span class="mono">{data.bundle.content_hash.slice(0, 12)}</span>
				<span aria-hidden="true">·</span>
				the same bytes over MCP at
				<span class="mono">northline://context/{subject.kind}/{subject.id}/{data.purpose}</span>
			</p>

			{#if data.bundle.facts.length === 0}
				<EmptyState
					line="Nothing above the bar for this purpose. An agent asking would be told that, not given an empty answer."
				/>
			{:else}
				<ul class="rows tight">
					{#each data.bundle.facts as fact (fact.fact_id)}
						<li>
							<span class="label">{fact.label}</span>
							<span class="value">{fact.value_display}</span>
							<span class="t-meta muted">
								{fact.citations.length} citation{fact.citations.length === 1 ? '' : 's'}
							</span>
						</li>
					{/each}
				</ul>
			{/if}

			{#if data.bundle.playbooks.length > 0}
				<details>
					<summary class="t-meta">
						The playbooks in this bundle ({data.bundle.playbooks.length})
					</summary>
					<ul class="rows">
						{#each data.bundle.playbooks as playbook (playbook.key)}
							<li class="book">
								<span class="label">{playbook.title}</span>
								<span class="t-meta muted">
									version {playbook.version}
									{#if playbook.reviewed_at}
										<span aria-hidden="true">·</span>reviewed {day(playbook.reviewed_at, thisYear)}
									{/if}
								</span>
							</li>
						{/each}
					</ul>
				</details>
			{/if}
		{:else}
			<p class="notice" role="status">
				<span>
					Nothing is served for {SURFACE_LABEL[data.purpose]}. {data.bundle.reason}
				</span>
			</p>
			{#if data.bundle.expired && data.bundle.expired.length > 0}
				<ul class="rows tight">
					{#each data.bundle.expired as gone (gone.attribute)}
						<li>
							<span class="label">{gone.label}</span>
							<span class="value">{gone.value_display}</span>
							<span class="t-meta muted">expired {day(gone.valid_to, thisYear)}</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</Panel>

	<Panel title="Where every piece came from" flush>
		{#if fresh.length === 0 && stale.length === 0}
			<EmptyState line="We hold nothing about this one yet. The coverage list says so too." action="See the coverage list" href={routes.context()} />
		{:else}
			<FactList
				facts={[...fresh, ...stale]}
				subject={{ kind: subject.kind, id: subject.id, name: subject.name }}
				requestId={data.requestId}
				{thisYear}
			/>
		{/if}
	</Panel>

	{#if data.context.missing.length > 0}
		<Panel title="What we do not know" flush>
			<p class="t-meta muted pad">
				In the dictionary for a {subject.kind}, and nothing has been said about it.
			</p>
			<ul class="rows tight">
				{#each data.context.missing as gap (gap.attribute)}
					<li>
						<span class="label">{gap.label}</span>
						<span class="t-meta muted mono">{gap.attribute}</span>
						{#if gap.disclosure === 'internal'}
							<span class="chip">internal only</span>
						{/if}
					</li>
				{/each}
			</ul>
		</Panel>
	{/if}

	{#if data.context.reads.length > 0}
		<Panel title="Which agent actions read which version" flush>
			<p class="t-meta muted pad">
				This is what makes a reply explainable after the fact: the action, and the exact bundle
				version it was working from.
			</p>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th scope="col">Action</th>
							<th scope="col">For</th>
							<th scope="col" class="num">Version</th>
							<th scope="col">Produced</th>
							<th scope="col">When</th>
							<th scope="col">By</th>
						</tr>
					</thead>
					<tbody>
						{#each data.context.reads as read (`${read.action}|${read.read_at}`)}
							<tr>
								<th scope="row">{read.action}</th>
								<td>{SURFACE_LABEL[read.purpose as keyof typeof SURFACE_LABEL] ?? read.purpose}</td>
								<td class="num">{read.bundle_version}</td>
								<td class="t-meta muted">
									{read.entity}{#if read.entity_id}
										{read.entity_id}{/if}
								</td>
								<td class="t-meta">{day(read.read_at.slice(0, 10), thisYear)}</td>
								<td class="t-meta muted">{read.actor_name ?? 'an agent'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</Panel>
	{/if}
</Page>

<style>
	.crumbs {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
		margin: 0 0 var(--space-3);
	}

	.hash {
		display: flex;
		flex-wrap: wrap;
		gap: 0 6px;
		margin: 0 0 var(--space-3);
	}

	.rows.tight > li,
	.rows > li.book {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: 6px 0;
	}

	.label {
		font-weight: 500;
	}

	.value {
		font-variant-numeric: tabular-nums;
	}

	.rows.tight > li > .t-meta:last-child,
	.rows > li.book > .t-meta:last-child {
		margin-left: auto;
	}

	.pad {
		margin: 0;
		padding: var(--space-3) var(--space-3) 0;
	}

	details {
		margin-top: var(--space-3);
	}

	summary {
		cursor: pointer;
	}
</style>
