<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Northline</title>
</svelte:head>

<main>
	<h1>Northline</h1>
	<p>A portfolio app on invented data. Database: {data.database}.</p>
	<table>
		<thead>
			<tr><th>Status</th><th>Commitments</th><th>Need an outcome</th></tr>
		</thead>
		<tbody>
			{#each data.statuses as row (row.status)}
				<tr><td>{row.status}</td><td>{row.commitments}</td><td>{row.needs_outcome}</td></tr>
			{/each}
		</tbody>
	</table>
</main>
