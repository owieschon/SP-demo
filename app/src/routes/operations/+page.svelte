<script lang="ts">
	import OperationsBoard from '$lib/components/exports/OperationsBoard.svelte';
	import OperationsBoardSkeleton from '$lib/components/exports/OperationsBoardSkeleton.svelte';
	import SnapshotReview from '$lib/components/exports/SnapshotReview.svelte';
	import UploadPanel from '$lib/components/exports/UploadPanel.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Both form actions say which one answered (see +page.server.ts), so each
	// answer shows up next to the form that sent it.
	const upload = $derived(form?.from === 'upload' ? form : null);
	const decision = $derived(
		form?.from === 'decide' ? { text: form.message, failed: form.failed, conflict: form.conflict } : null
	);
	// The upload's result, when it did not open a snapshot (refused, or already loaded).
	const uploadOutcome = $derived(upload && 'upload' in upload ? (upload.upload ?? null) : null);
	// An upload that failed before its file was read (no file, too big) has only a message.
	const uploadMessage = $derived(upload && !uploadOutcome ? upload.message : null);
</script>

<svelte:head>
	<title>Operations · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Operations</h1>
		<p class="faint">
			Each morning the ERP's three open-order exports (sales lines, purchase lines, production orders) are
			checked, staged and shown here before anything changes. A file that looks wrong is held for a person;
			a file that is none of the three is refused.
		</p>
		<nav class="tabs" aria-label="Operations views">
			<a class="button quiet" href="/operations" aria-current="page">Morning exports</a>
			<a class="button quiet" href="/operations/forecast">Late-order forecast</a>
		</nav>
	</header>

	{#if uploadMessage}
		<p class="notice error" role="alert">{uploadMessage}</p>
	{/if}

	<UploadPanel
		requestId={data.requestIds.upload}
		canRunImports={data.canRunImports}
		outcome={uploadOutcome}
		samples={data.samples}
		year={data.year}
	/>

	{#if data.review}
		<!-- A fresh component per snapshot, so a half-written note never carries over. -->
		{#key data.review.id}
			<SnapshotReview
				review={data.review}
				canDecide={data.canRunImports}
				requestId={data.requestIds.decide}
				message={decision}
			/>
		{/key}
	{/if}

	<!-- The board arrives a moment after the page (see +page.server.ts). -->
	{#await data.board}
		<OperationsBoardSkeleton />
	{:then board}
		<OperationsBoard {board} year={data.year} />
	{:catch}
		<p class="notice error" role="alert">
			The open lines could not be loaded.
			<a class="button" href="/operations" data-sveltekit-reload>Try again</a>
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

	.tabs {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}

	.tabs [aria-current='page'] {
		box-shadow: inset 0 0 0 1px var(--hairline-strong);
		color: var(--text);
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
