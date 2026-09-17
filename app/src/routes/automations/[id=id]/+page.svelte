<script lang="ts">
	import RuleActivity from '$lib/components/automation/RuleActivity.svelte';
	import RuleEditor from '$lib/components/automation/RuleEditor.svelte';
	import { TRIGGERS } from '$lib/automation/catalog';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const d = $derived(data.detail);
	const runMessage = $derived(form?.from === 'run' ? { text: form.message, failed: form.failed } : null);
</script>

<svelte:head>
	<title>{d.rule.name} · Automations · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>{d.rule.name}</h1>
		<p class="faint">
			Rule {d.id} · owned by {d.ownerName} · {TRIGGERS[d.rule.trigger].label.toLowerCase()}
			{#if d.rule.description}· {d.rule.description}{/if}
		</p>
	</header>

	{#if data.justSaved && !form}
		<p class="notice" role="status">Saved. Test it or run it below; it stays off until you switch it on.</p>
	{/if}

	<!-- A new version of the rule (after a save, or "Load the latest version")
	     starts a fresh editor from it. -->
	{#key d.updatedAt}
		<RuleEditor
			initial={d.rule}
			ruleId={d.id}
			updatedAt={d.updatedAt}
			requestId={data.requestId}
			canEdit={d.canEdit}
			ownerName={d.ownerName}
			people={data.people}
			answer={form ?? null}
		/>
	{/key}

	<RuleActivity detail={d} message={runMessage} />
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
		font-size: 0.92rem;
		overflow-wrap: anywhere;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
