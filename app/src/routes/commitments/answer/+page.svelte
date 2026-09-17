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

	// Optimistic hand-off between questions: the moment an answer is sent the
	// current question starts leaving; once the server says yes we wait for
	// that animation to finish, then the page data refreshes and the next
	// question arrives. If the server says no, the question comes back.
	const LEAVE_MS = 200;
	// The id of the question that is leaving. Tied to the id, so the next
	// question never starts out hidden.
	let leavingId = $state<number | null>(null);
	let leftAt = 0;

	function reducedMotion() {
		return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	}

	function startLeaving() {
		leavingId = current?.id ?? null;
		leftAt = performance.now();
	}

	async function finishLeaving() {
		const wait = reducedMotion() ? 0 : LEAVE_MS - (performance.now() - leftAt);
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	}

	// Server said no, or the same question is still first after the refresh.
	function comeBack() {
		leavingId = null;
	}
</script>

<svelte:head>
	<title>Windows closed short · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Windows closed short</h1>
		<p class="muted">
			{#if data.waiting.length === 0}
				Nothing is waiting for an answer.
			{:else}
				<span class="num">{data.waiting.length}</span> waiting. One question each: what happened?
			{/if}
		</p>
	</header>

	{#if form?.message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>{form.message}</p>
	{/if}

	{#if current}
		{#key current.id}
			<article class="question panel" class:leaving={leavingId === current.id} aria-busy={leavingId === current.id}>
				<div class="q-head">
					<h2><a class="link" href="/commitments/{current.id}">{current.title}</a></h2>
					<span class="faint mono">C-{current.id}</span>
				</div>
				<p class="muted">
					{current.customerName} · {current.ownerName} · {windowRange(current.startsOn, current.endsOn, data.year)}
					· closed {current.daysSinceClose} days ago
				</p>

				<div class="progress">
					<p>
						<strong class="num">{money(current.delivered)}</strong>
						<span class="faint">of</span>
						<span class="num">{money(current.committedValue)}</span>
						<span class="faint num">· {percent(current.deliveredRatio)}</span>
					</p>
					<ProgressBar ratio={current.deliveredRatio} status={current.status} label="Delivered" size="md" />
				</div>

				<div class="answer">
					{#if mine}
						<OutcomeForm
							commitmentId={current.id}
							updatedAt={current.updatedAt}
							requestId={data.requestId}
							action="?"
							onsubmitting={startLeaving}
							onsaved={finishLeaving}
							onfailed={comeBack}
							ondone={comeBack}
						/>
					{:else}
						<p class="muted">Waiting on {current.ownerName}. Only the owner or an admin can answer.</p>
					{/if}
				</div>
			</article>
		{/key}

		{#if data.waiting.length > 1}
			<section class="panel">
				<header class="panel-head">
					<h2>Up next</h2>
					<span class="faint num">{data.waiting.length - 1}</span>
				</header>
				<ul class="next">
					{#each data.waiting.slice(1) as c (c.id)}
						<li>
							<a href="/commitments/{c.id}">
								<span class="title">{c.title}</span>
								<span class="muted rest">{c.customerName} · {c.ownerName}</span>
								<span class="faint num">{c.daysSinceClose}d ago</span>
							</a>
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
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: 2px;
	}

	.question {
		display: grid;
		animation: arrive var(--speed-slow) var(--ease);
		transition:
			opacity 200ms var(--ease),
			transform 200ms var(--ease);
	}

	/* The current question slides away while its answer is saved. */
	.question.leaving {
		opacity: 0;
		transform: translateX(-16px) scale(0.99);
		pointer-events: none;
	}

	@keyframes arrive {
		from {
			opacity: 0;
			transform: translateX(16px);
		}
	}

	.question > * {
		padding: var(--space-3) var(--space-4);
	}

	.question > * + * {
		border-top: 1px solid var(--hairline);
	}

	.question > .q-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-2);
		padding-bottom: 0;
	}

	.question > .q-head + p {
		border-top: 0;
		padding-top: 2px;
	}

	.progress {
		display: grid;
		gap: 8px;
	}

	.next {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.next li + li {
		border-top: 1px solid var(--hairline);
	}

	.next a {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		height: 34px;
		padding: 0 var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.next a:hover {
		background: var(--surface-hover);
	}

	.next li:last-child a {
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}

	.next .title {
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.next .rest {
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
