<script lang="ts">
	import RuleEditor from '$lib/components/automation/RuleEditor.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
</script>

<svelte:head>
	<title>New rule · Automations · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>New rule</h1>
		<p class="faint">
			Pick what to watch for, narrow it down, and say what should happen. Test it against today's data
			before you save; testing writes nothing.
		</p>
	</header>

	<RuleEditor
		initial={data.rule}
		ruleId={null}
		updatedAt={null}
		requestId={data.requestId}
		canEdit={true}
		ownerName={data.user?.fullName ?? 'you'}
		people={data.people}
		answer={form ?? null}
	/>
</main>

<style>
	.page {
		max-width: 980px;
		margin: 0 auto;
		padding: var(--space-3) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: 4px;
	}

	.head p {
		max-width: 72ch;
		font-size: 0.92rem;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
