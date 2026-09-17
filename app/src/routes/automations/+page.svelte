<script lang="ts">
	import Plus from '@lucide/svelte/icons/plus';
	import RuleListSkeleton from '$lib/components/automation/RuleListSkeleton.svelte';
	import { count, moment } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Automations · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div>
			<h1>Automations</h1>
			<p class="faint">
				Rules the team set up to catch things early: when something happens, and the conditions hold, the
				rule adds a next step or a note. Rules never change or remove anything.
			</p>
		</div>
		<a class="button primary" href="/automations/new">
			<Plus size={14} strokeWidth={1.75} aria-hidden="true" />
			New rule
		</a>
	</header>

	<!-- The list arrives a moment after the page (see +page.server.ts). -->
	{#await data.rules}
		<RuleListSkeleton />
	{:then rules}
		{#if rules.length === 0}
			<section class="panel empty">
				<p>No rules yet.</p>
				<p class="faint">Start with one: for example, a next step whenever a commitment window closes short.</p>
				<a class="button" href="/automations/new">Create the first rule</a>
			</section>
		{:else}
			<ul class="panel list">
				{#each rules as r (r.id)}
					<li>
						<a class="rule" href="/automations/{r.id}">
							<span class="top">
								<span class="name">{r.name}</span>
								<span class="state" class:on={r.enabled}>
									<span class="dot" aria-hidden="true"></span>{r.enabled ? 'On' : 'Off'}
								</span>
							</span>
							<span class="sentence">{r.sentence}</span>
							<span class="meta faint">
								<span>{r.ownerName}</span>
								<span>
									{#if r.lastRun === null}
										Never run
									{:else if r.lastRun.error}
										<span class="bad">Last run failed</span> {moment(r.lastRun.startedAt)}
									{:else}
										Last run {moment(r.lastRun.startedAt)}: {count(r.lastRun.fired ?? 0)} new of {count(r.lastRun.matched ?? 0)}
									{/if}
								</span>
								<span>{count(r.firingCount)} written in total</span>
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{/if}
	{:catch}
		<p class="notice error" role="alert">
			The rules could not be loaded.
			<a class="button" href="/automations" data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page {
		max-width: 980px;
		margin: 0 auto;
		padding: var(--space-3) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.head > div {
		display: grid;
		gap: 4px;
		flex: 1 1 360px;
	}

	.head p {
		max-width: 72ch;
		font-size: 0.92rem;
	}

	.empty {
		display: grid;
		justify-items: start;
		gap: var(--space-2);
		padding: var(--space-5) var(--space-3);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow: hidden;
	}

	.list li + li {
		border-top: 1px solid var(--hairline);
	}

	.rule {
		display: grid;
		gap: 4px;
		padding: 10px var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.rule:hover {
		background: var(--surface-hover);
	}

	.rule:active {
		background: var(--surface-press);
	}

	.rule:focus-visible {
		outline-offset: -2px;
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.name {
		font-weight: 500;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 0.85rem;
		color: var(--text-faint);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--hairline-strong);
	}

	.state.on {
		color: var(--status-kept);
	}

	.state.on .dot {
		background: var(--status-kept);
	}

	.sentence {
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 2px var(--space-3);
		font-size: 0.85rem;
	}

	.bad {
		color: var(--danger);
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
