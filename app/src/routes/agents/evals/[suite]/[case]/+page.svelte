<script lang="ts">
	/*
	  One eval case: what went in, and what the suite expects out.

	  This is the page the eval scores on /agents link into. It is short on
	  purpose. The argument it makes is not "look how well it scores", it is
	  "here is the actual thing that was scored, read it yourself and decide
	  whether it is a fair test". That is the only honest way to show an eval
	  number written by the same hands as the agent.

	  Read width, because both panels are text a person reads rather than a
	  table they scan.
	*/
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import { routes } from '$lib/routes';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Page
	title={data.name}
	documentTitle="{data.name} · eval case"
	width="read"
	subtitle="One case from the {data.folder} suite, exactly as it sits on disk."
>
	{#snippet breadcrumb()}
		<a class="link" href={routes.agents()}>Agents</a>
		<span aria-hidden="true">/</span>
		<span>{data.folder} evals</span>
	{/snippet}

	<Panel title={data.expected === null ? 'The case' : 'What goes in'} source={data.path}>
		<pre>{data.body}</pre>
	</Panel>

	{#if data.expected !== null}
		<!--
			A text case keeps its expected answer in a file beside it. A JSON
			case carries both in the one file, so there is nothing to show
			twice and this panel is absent rather than empty.
		-->
		<Panel title="What the suite expects out" source="{data.name}.expected.json">
			<pre>{data.expected}</pre>
		</Panel>
	{/if}

	<p class="t-meta muted prose">
		The case, the expected answer and the extractor that reads the agent's output were all
		written by the same hands as the agent, so a case cannot surprise it the way real mail
		would. It is a regression floor, not an independent measure. A set written by somebody else
		is the fair comparison.
	</p>
</Page>

<style>
	pre {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
		line-height: 1.5;
		/* Long lines wrap rather than scroll the panel sideways, which on a
		   phone is the difference between readable and not. */
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text);
	}
</style>
