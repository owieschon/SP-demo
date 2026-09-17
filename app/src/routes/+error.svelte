<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · Northline</title>
</svelte:head>

<main class="page">
	<h1>{page.status === 404 ? 'Not found' : 'Something went wrong'}</h1>
	<p class="muted">{page.error?.message}</p>
	<p><a href="/commitments">Back to commitments</a></p>
</main>

<style>
	.page {
		max-width: 560px;
		margin: 0 auto;
		padding: var(--space-6) var(--space-4);
		display: grid;
		gap: var(--space-3);
	}
</style>
