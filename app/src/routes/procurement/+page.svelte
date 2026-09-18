<script lang="ts">
	import BuyingList from '$lib/components/procurement/BuyingList.svelte';
	import DeskSkeleton from '$lib/components/procurement/DeskSkeleton.svelte';
	import SignalLog from '$lib/components/procurement/SignalLog.svelte';
	import SuggestedOrders from '$lib/components/procurement/SuggestedOrders.svelte';
	import VendorEmails from '$lib/components/procurement/VendorEmails.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Each action says which one answered (see +page.server.ts), so every
	// answer shows up next to the form that sent it.
	const answer = (from: string) =>
		form?.from === from
			? { text: form.message, failed: form.failed, conflict: form.conflict }
			: null;

	const sweepAnswer = $derived(answer('sweep'));
	const draftAnswer = $derived(answer('draft'));
	const lineAnswer = $derived(answer('line'));
	const approveAnswer = $derived(answer('approve'));
</script>

<svelte:head>
	<title>Procurement · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1 class="sr-only">Procurement</h1>
		<p class="faint">
			What to buy, how much, from whom and by when, worked out from how fast each part sells, how long
			it takes to arrive, what is already promised and what is already on order. Nothing is ordered
			and no email is sent without a person pressing the button.
		</p>
	</header>

	{#if draftAnswer}
		<p class="notice" class:error={draftAnswer.failed} role={draftAnswer.failed ? 'alert' : 'status'}>
			{draftAnswer.text}
		</p>
	{/if}

	<!-- The desk arrives a moment after the page (see +page.server.ts). -->
	{#await data.desk}
		<DeskSkeleton />
	{:then desk}
		{#if data.canBuy && desk.totals.parts > 0}
			<form method="POST" action="?/draft" class="draft-all">
				<input type="hidden" name="requestId" value={data.requestIds.draft} />
				<button class="button primary">Draft every order</button>
				<span class="faint">
					One draft per vendor, with every quantity and date still yours to change.
				</span>
			</form>
		{:else if !data.canBuy}
			<p class="faint read-only">
				You can read the desk. Raising and approving orders belongs to operations.
			</p>
		{/if}

		<BuyingList
			{desk}
			canBuy={data.canBuy}
			draftRequestId={data.requestIds.draft}
			year={data.year}
		/>

		<SuggestedOrders
			requests={desk.requests}
			canBuy={data.canBuy}
			today={desk.today}
			lineRequestId={data.requestIds.line}
			approveRequestId={data.requestIds.approve}
			lineMessage={lineAnswer}
			approveMessage={approveAnswer}
			year={data.year}
		/>

		<VendorEmails drafts={desk.drafts} sources={desk.sources} />

		<SignalLog
			signals={desk.signals}
			openCount={desk.openSignalCount}
			canBuy={data.canBuy}
			sweepRequestId={data.requestIds.sweep}
			message={sweepAnswer}
		/>
	{:catch}
		<p class="notice error" role="alert">
			The desk could not be loaded.
			<a class="button" href="/procurement" data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page {
		max-width: 1180px;
		margin: 0 auto;
		padding: var(--space-3) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head p {
		max-width: 80ch;
		font-size: 0.92rem;
	}

	.draft-all {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: 0;
		font-size: 0.92rem;
	}

	.read-only {
		font-size: 0.92rem;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}

		.draft-all {
			flex-wrap: wrap;
			gap: var(--space-2);
		}
	}
</style>
