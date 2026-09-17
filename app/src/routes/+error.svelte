<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head>
	<title>{page.status} · Northline</title>
</svelte:head>

<main class="page">
	<p class="code mono faint">{page.status}</p>
	<h1>{page.status === 404 ? 'Not found' : 'Something went wrong'}</h1>
	{#if page.error?.message}
		<p class="muted">{page.error.message}</p>
	{/if}
	<p><a class="button" href="/commitments">Back to commitments</a></p>
</main>

<style>
	.page {
		max-width: 480px;
		margin: 0 auto;
		padding: 14vh var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-2);
		justify-items: start;
	}

	.code {
		font-size: 0.92rem;
	}

	p:last-child {
		margin-top: var(--space-2);
	}
</style>
