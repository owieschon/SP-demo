<script lang="ts">
	/*
	  What is waiting on you, grouped by the kind of decision it needs.

	  Every group is short because nl.work_waiting_for only returns items this
	  person may actually decide. A group longer than the fold shows its first
	  few and says how many more there are, with a link to the section that
	  works them properly: a home page is a starting point, not a queue.

	  The page head is written with the .page and .page-head classes from
	  app.css rather than through ui/Page.svelte, because the layout already
	  owns the one <main id="content"> and two of them would share an id.
	*/
	import Panel from '$lib/components/ui/Panel.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import { money } from '$lib/format';
	import { PRESET_LABEL, WORK_LABEL } from '$lib/roles/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** How many of a group to show before saying "and N more". */
	const SHOWN = 6;

	const greeting = $derived(data.policy.fullName.split(/\s+/)[0]);

	/** "3 days" or "today", from the age the database worked out. */
	function age(days: number): string {
		if (days <= 0) return 'today';
		if (days === 1) return '1 day';
		return `${days} days`;
	}
</script>

<svelte:head>
	<title>Home · Northline</title>
</svelte:head>

<div class="page">
	<div class="page-head">
		<div class="titles">
			<h1>Waiting on you</h1>
			<p class="muted prose">
				Everything in your own scope that needs a decision only you can make.
			</p>
		</div>
	</div>

	{#await data.work}
		<Panel title="Waiting on you" busy>
			<SkeletonRows rows={5} cols={4} label="Working out what is waiting on you" />
		</Panel>
	{:then work}
		{#if work.items.length === 0}
			<Panel title="Waiting on you">
				<!--
					Nothing waiting is the good outcome, so it reads as one. An empty
					table here would leave the person wondering whether it loaded.
				-->
				<EmptyState
					line="Nothing is waiting on you, {greeting}. No agent has stopped on anything and no decision is open."
					action="See what they have been doing"
					href="/workspace"
				/>
			</Panel>
		{:else}
			{#each work.groups as group (group.kind)}
				<Panel title={WORK_LABEL[group.kind]}>
					{#snippet actions()}
						<span class="t-meta muted">{group.items.length}</span>
					{/snippet}
					<table>
						<caption class="sr-only">
							{WORK_LABEL[group.kind]}: {group.items.length} waiting
						</caption>
						<thead>
							<tr>
								<th scope="col">What</th>
								<th scope="col" class="num">Value</th>
								<th scope="col" class="num">Waiting</th>
								<th scope="col">Why</th>
							</tr>
						</thead>
						<tbody>
							{#each group.items.slice(0, SHOWN) as item (item.ref)}
								<tr>
									<td><a href={item.href}>{item.subject}</a></td>
									<td class="num">{item.amount === null ? '' : money(item.amount)}</td>
									<td class="num">{age(item.ageDays)}</td>
									<td class="muted">{item.why}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					{#if group.items.length > SHOWN}
						<p class="t-meta muted more">
							and {group.items.length - SHOWN} more, worked from
							<a href={group.items[0].href}>the section itself</a>.
						</p>
					{/if}
				</Panel>
			{/each}
		{/if}
	{:catch}
		<LoadFailed what="what is waiting on you" />
	{/await}

	<Panel title="Why this is your list">
		<!--
			A derived page has to be able to say what it was derived from.
			Otherwise "why can I not see the warehouse" has no answer except to
			go and ask somebody.
		-->
		<p class="prose">
			You are set up as <strong>{PRESET_LABEL[data.policy.preset]}</strong>.
			{data.policy.responsibility}
		</p>
		<p class="prose muted">
			An item appears here when it sits inside your scope and is waiting on one of the
			{data.policy.authority.length} decisions you may make.
			<a href="/people">See who may decide what</a>, including yours.
		</p>
	</Panel>
</div>

<style>
	.more {
		margin: var(--space-2) 0 0;
	}
</style>
