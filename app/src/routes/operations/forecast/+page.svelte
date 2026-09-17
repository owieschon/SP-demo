<script lang="ts">
	import ForecastBoard from '$lib/components/supply/ForecastBoard.svelte';
	import ForecastFilters from '$lib/components/supply/ForecastFilters.svelte';
	import ForecastSkeleton from '$lib/components/supply/ForecastSkeleton.svelte';
	import ShipCheck from '$lib/components/supply/ShipCheck.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>Late-order forecast · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1 class="sr-only">Late-order forecast</h1>
		<p class="faint">
			Every open order line, netted against what is on the shelf and what is on order from vendors and the
			shop floor. A line's projected date is the day the parts for it and for every line promised before it
			are there. <a class="link" href="/operations">The morning exports</a> feed it: sales lines, purchase
			lines and production orders.
		</p>
	</header>

	<!-- The filters come from the URL, so they render with the page, before the
	     projection arrives. -->
	{#await data.forecast}
		<ForecastFilters filters={data.filters} options={{ vendors: [], workCenters: [], customers: [] }} lineCount={0} />
		<ForecastSkeleton />
	{:then forecast}
		<ForecastFilters filters={forecast.filters} options={forecast.options} lineCount={forecast.lineCount} />
		<ForecastBoard {forecast} year={data.year} />
		<ShipCheck answer={form?.answer ?? null} message={form?.message ?? null} today={forecast.today} />
	{:catch}
		<p class="notice error" role="alert">
			The projection could not be worked out.
			<a class="button" href="/operations/forecast" data-sveltekit-reload>Try again</a>
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

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
