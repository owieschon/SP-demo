<script lang="ts">
	// The agent workspace: one queue over every agent request that is waiting
	// for a person, whichever feature made it. Approve, correct and approve, or
	// reject, without visiting four pages.
	//
	// Everything the agents do that does not need a person stays where it is.
	// This page only collects the moments where a person has to say yes or no.
	import Inbox from '@lucide/svelte/icons/inbox';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import DecisionList from '$lib/components/workspace/DecisionList.svelte';
	import QueueItemRow from '$lib/components/workspace/QueueItemRow.svelte';
	import QueueSkeleton from '$lib/components/workspace/QueueSkeleton.svelte';
	import { countQueue, subjectsOf } from '$lib/workspace/summary';
	import { QUEUE_SOURCES, SOURCE_LABEL, type QueueItem } from '$lib/workspace/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let tab = $state<'waiting' | 'decided'>('waiting');

	const message = $derived(form && 'message' in form ? form.message : null);
	const failed = $derived(Boolean(form && 'conflict' in form));

	/** A filter link that keeps the other filter. */
	function filterHref(key: 'source' | 'account', value: string | null) {
		const params = new URLSearchParams(page.url.search);
		if (value === null) params.delete(key);
		else params.set(key, value);
		const search = params.toString();
		return search ? `?${search}` : '/workspace';
	}

	function split(items: QueueItem[]) {
		return {
			counts: countQueue(items),
			yours: items.filter((item) => item.needsYou),
			others: items.filter((item) => !item.needsYou),
			subjects: subjectsOf(items)
		};
	}

	/** The sources this database has, in a fixed order. */
	const availableSources = $derived(QUEUE_SOURCES.filter((source) => data.sources[source]));
	const missingSources = $derived(QUEUE_SOURCES.filter((source) => !data.sources[source]));

	function onAccountChange(event: Event) {
		const value = (event.currentTarget as HTMLSelectElement).value;
		goto(filterHref('account', value === '' ? null : value));
	}
</script>

<svelte:head>
	<title>Workspace · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Workspace</h1>
		<p class="faint">
			Everything an agent has put in front of a person, in one place. Approve it, correct it and then
			approve it, or reject it. Whatever the agents do not need a person for, they have already done.
		</p>
	</header>

	{#if message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>{message}</p>
	{/if}

	{#await data.items}
		<section class="panel">
			<header class="panel-head">
				<h2>Waiting</h2>
			</header>
			<QueueSkeleton />
		</section>
	{:then items}
		{@const view = split(items)}

		<div class="counts">
			<div class="count">
				<span class="figure">{view.counts.needsYou}</span>
				<span class="faint small">waiting on you</span>
			</div>
			<div class="count">
				<span class="figure">{view.counts.needsSomeone}</span>
				<span class="faint small">waiting on someone</span>
			</div>
			{#each availableSources as source (source)}
				<div class="count">
					<span class="figure">{view.counts.bySource[source]}</span>
					<span class="faint small">{SOURCE_LABEL[source].toLowerCase()}s</span>
				</div>
			{/each}
		</div>

		<div class="bar">
			<div class="segmented" role="group" aria-label="Which view">
				<button type="button" aria-pressed={tab === 'waiting'} onclick={() => (tab = 'waiting')}>
					Waiting
				</button>
				<button type="button" aria-pressed={tab === 'decided'} onclick={() => (tab = 'decided')}>
					Recent decisions
				</button>
			</div>

			{#if tab === 'waiting'}
				<div class="segmented" role="group" aria-label="Which source">
					<a href={filterHref('source', null)} aria-current={data.filters.source === null ? 'true' : undefined}>
						All
					</a>
					{#each availableSources as source (source)}
						<a
							href={filterHref('source', source)}
							aria-current={data.filters.source === source ? 'true' : undefined}
						>
							{SOURCE_LABEL[source]}
						</a>
					{/each}
				</div>

				<label class="account">
					<span class="sr-only">Account or vendor</span>
					<select value={data.filters.account ?? ''} onchange={onAccountChange}>
						<option value="">Every account and vendor</option>
						{#each view.subjects as subject (subject.no)}
							<option value={subject.no}>{subject.name}</option>
						{/each}
					</select>
				</label>
			{/if}
		</div>

		{#if tab === 'waiting'}
			{#if view.counts.total === 0}
				<section class="panel empty">
					<Inbox size={22} strokeWidth={1.5} aria-hidden="true" />
					<p class="none">Nothing is waiting on you</p>
					<p class="faint">
						That is the good case. The agents keep working; anything that needs a person will turn up
						here.
					</p>
				</section>
			{:else}
				<section class="panel" aria-labelledby="needs-you">
					<header class="panel-head">
						<h2 id="needs-you">Needs you</h2>
						<span class="faint small">{view.yours.length}</span>
					</header>
					{#if view.yours.length === 0}
						<p class="body muted">Nothing is waiting on you.</p>
					{:else}
						<ul class="rows">
							{#each view.yours as item (`${item.source}:${item.sourceId}`)}
								<QueueItemRow {item} requestBase={data.requestId} open={view.yours.length === 1} />
							{/each}
						</ul>
					{/if}
				</section>

				{#if view.others.length > 0}
					<section class="panel" aria-labelledby="needs-someone">
						<header class="panel-head">
							<h2 id="needs-someone">Needs someone</h2>
							<span class="faint small">{view.others.length}</span>
						</header>
						<ul class="rows">
							{#each view.others as item (`${item.source}:${item.sourceId}`)}
								<QueueItemRow {item} requestBase={data.requestId} />
							{/each}
						</ul>
					</section>
				{/if}
			{/if}

			{#if missingSources.length > 0}
				<p class="faint small footnote">
					This database does not have {missingSources.map((s) => `${SOURCE_LABEL[s].toLowerCase()}s`).join(' or ')}
					yet, so none appear above.
				</p>
			{/if}
		{:else}
			<section class="panel" aria-labelledby="decided">
				<header class="panel-head">
					<h2 id="decided">Recent decisions</h2>
				</header>
				{#await data.decisions}
					<QueueSkeleton />
				{:then decisions}
					<DecisionList {decisions} />
				{:catch}
					<p class="body notice error" role="alert">The history could not be loaded. Reload the page.</p>
				{/await}
			</section>
		{/if}
	{:catch}
		<p class="notice error" role="alert">
			The queue could not be loaded. Reload the page to try again.
		</p>
	{/await}
</main>

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: 4px;
	}

	.head p {
		max-width: 76ch;
	}

	.counts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-lg);
		background: var(--surface);
	}

	.count {
		display: grid;
		gap: 0;
	}

	.figure {
		font-size: 1.2rem;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		line-height: 1.2;
	}

	.small {
		font-size: 0.85rem;
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.account {
		margin-left: auto;
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	/* The rows are their own component, so the hairline between them belongs
	   to the list that holds them. */
	.rows :global(.row + .row) {
		border-top: 1px solid var(--hairline);
	}

	.body {
		padding: var(--space-3);
	}

	.empty {
		display: grid;
		justify-items: center;
		gap: 4px;
		padding: var(--space-6) var(--space-4);
		color: var(--text-faint);
		text-align: center;
	}

	.empty .none {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 500;
		color: var(--text);
	}

	.empty p {
		max-width: 52ch;
	}

	.footnote {
		margin: 0;
	}

	@media (max-width: 720px) {
		.account {
			margin-left: 0;
			flex-basis: 100%;
		}

		.account select {
			width: 100%;
		}
	}
</style>
