<script lang="ts">
	import { page } from '$app/state';
	import OutcomeForm from '$lib/components/OutcomeForm.svelte';
	import ProgressBar from '$lib/components/ProgressBar.svelte';
	import { money, percent, windowRange } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const current = $derived(data.waiting[0]);
	const mine = $derived(current ? current.ownerId === page.data.user?.id || data.mayAnswerAll : false);
	const failed = $derived(form && !('replayed' in form));
</script>

<svelte:head>
	<title>Windows closed short · Northline</title>
</svelte:head>

<main class="page">
	<a class="back" href="/commitments?who={data.who}">← Commitments</a>

	<header>
		<h1>Windows closed short</h1>
		<p class="muted">
			{#if data.waiting.length === 0}
				Nothing is waiting for an answer.
			{:else}
				{data.waiting.length} waiting. One question each: what happened?
			{/if}
		</p>
	</header>

	{#if form?.message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>{form.message}</p>
	{/if}

	{#if current}
		{#key current.id}
			<article class="question">
				<div class="top">
					<h2><a href="/commitments/{current.id}">{current.title}</a></h2>
					<span class="faint mono">C-{current.id}</span>
				</div>
				<p class="muted">
					{current.customerName} · owner {current.ownerName} · window {windowRange(current.startsOn, current.endsOn, data.year)},
					closed {current.daysSinceClose} days ago
				</p>
				<p>
					<strong class="num">{money(current.delivered)}</strong> delivered of
					<span class="num">{money(current.committedValue)}</span> ({percent(current.deliveredRatio)}).
				</p>
				<ProgressBar ratio={current.deliveredRatio} status={current.status} label="Delivered" />

				{#if mine}
					<OutcomeForm
						commitmentId={current.id}
						updatedAt={current.updatedAt}
						requestId={data.requestId}
						action="?"
					/>
				{:else}
					<p class="muted">Waiting on {current.ownerName}. Only the owner or an admin can answer.</p>
				{/if}
			</article>
		{/key}

		{#if data.waiting.length > 1}
			<section>
				<h2 class="up-next">Up next</h2>
				<ul class="next">
					{#each data.waiting.slice(1) as c (c.id)}
						<li>
							<a href="/commitments/{c.id}">{c.title}</a>
							<span class="muted">· {c.customerName} · {c.ownerName} · closed {c.daysSinceClose} days ago</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}
	{/if}
</main>

<style>
	.page {
		max-width: 720px;
		margin: 0 auto;
		padding: var(--space-4) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-4);
	}

	.back {
		font-size: 0.9rem;
	}

	.question {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius-lg);
		background: var(--surface);
		animation: arrive 220ms var(--ease);
	}

	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}

	.top {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.up-next {
		font-size: 0.85rem;
		color: var(--text-muted);
		margin-bottom: var(--space-1);
	}

	.next {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.next li {
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--hairline);
	}
</style>
