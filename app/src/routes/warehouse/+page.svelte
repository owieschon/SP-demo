<script lang="ts">
	import CountSheet from '$lib/components/warehouse/CountSheet.svelte';
	import PartLedgerPanel from '$lib/components/warehouse/PartLedgerPanel.svelte';
	import PickQueue from '$lib/components/warehouse/PickQueue.svelte';
	import RecentMoves from '$lib/components/warehouse/RecentMoves.svelte';
	import TransitList from '$lib/components/warehouse/TransitList.svelte';
	import WarehouseSkeleton from '$lib/components/warehouse/WarehouseSkeleton.svelte';
	import WarehouseToday from '$lib/components/warehouse/WarehouseToday.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Each form action says which form it answered (see +page.server.ts), so
	// the answer shows up next to the form that sent it and nowhere else.
	function answer(from: 'advance' | 'count' | 'adjust') {
		return form?.from === from
			? { text: form.message, failed: form.failed, conflict: form.conflict }
			: null;
	}

	const advanceMessage = $derived(answer('advance'));
	const countMessage = $derived(answer('count'));
	const adjustMessage = $derived(answer('adjust'));
</script>

<svelte:head>
	<title>Warehouse · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1 class="sr-only">Warehouse</h1>
		<p class="faint">
			Every part has a bin, and every change to it leaves a row in the stock ledger. The item master's
			on-hand figure, the sum of the bins and the ledger all say the same number, and a check in the
			database complains the moment they do not.
		</p>
	</header>

	{#if data.ledger}
		<!-- A fresh panel per part, so a half-typed correction never carries over. -->
		{#key data.ledger.itemNo}
			<PartLedgerPanel
				ledger={data.ledger}
				year={data.year}
				canRun={data.canRun}
				requestId={data.requestIds.adjust}
				message={adjustMessage}
			/>
		{/key}
	{/if}

	<!-- The floor arrives a moment after the page (see +page.server.ts). -->
	{#await data.board}
		<WarehouseSkeleton />
	{:then board}
		<WarehouseToday buckets={board.buckets} />

		<PickQueue
			shipments={board.pickQueue}
			total={board.pickQueueTotal}
			today={board.today}
			year={data.year}
			canRun={data.canRun}
			requestId={data.requestIds.advance}
			message={advanceMessage}
		/>

		{#if board.openCount}
			<CountSheet
				session={board.openCount}
				today={board.today}
				year={data.year}
				canRun={data.canRun}
				requestId={data.requestIds.count}
				message={countMessage}
			/>
		{/if}

		<div class="two">
			<TransitList transfers={board.transit} year={data.year} />
			<RecentMoves moves={board.recentMoves} transitCount={board.transit.length} />
		</div>
	{:catch}
		<p class="notice error" role="alert">
			The warehouse could not be loaded.
			<a class="button" href="/warehouse" data-sveltekit-reload>Try again</a>
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

	/*
	  Two columns on a wide screen, one on a narrow one. Flexbox rather than
	  grid: the same two rules give the stacked phone layout for free.
	*/
	.two {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: start;
	}

	.two > :global(*) {
		flex: 1 1 360px;
		min-width: 0;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
