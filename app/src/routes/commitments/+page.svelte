<script lang="ts">
	import Board from '$lib/components/Board.svelte';
	import BoardSkeleton from '$lib/components/BoardSkeleton.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Commitments · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1 class="sr-only">Commitments</h1>
		<p class="faint">
			Named buyers' promises to buy specific parts inside a window. Delivery is measured from invoice
			lines; status is never picked by hand.
		</p>
	</header>

	<!-- The rows arrive a moment after the page (see +page.server.ts). -->
	{#await data.board}
		<BoardSkeleton />
	{:then board}
		<Board {board} who={data.who} year={data.year} />
	{:catch}
		<p class="notice error" role="alert">
			The board could not be loaded.
			<a class="button" href={`?who=${data.who}`} data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page {
		padding: var(--space-3) var(--space-4) var(--space-5);
		display: grid;
		gap: var(--space-3);
	}

	.head p {
		max-width: 80ch;
		font-size: 0.92rem;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
