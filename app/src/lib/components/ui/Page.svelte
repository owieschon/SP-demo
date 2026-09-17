<script lang="ts">
	/*
	  The shell every page uses, so the title starts in the same place and
	  there are two content widths in the app instead of eight.

	    <Page title="Parts" subtitle="Every part we sell">
	      {#snippet actions()}<a class="button" href="/parts/new">New part</a>{/snippet}
	      ... the page ...
	    </Page>

	  It owns the <main>, the browser tab title, the <h1>, and the skip-link
	  target that the layout's skip link points at. `width="read"` gives the
	  narrow measure for a form or a single question.
	*/
	import type { Snippet } from 'svelte';

	let {
		title,
		documentTitle,
		subtitle,
		width = 'list',
		label,
		actions,
		children
	}: {
		/** The page's h1. */
		title: string;
		/** The browser tab title, when it should differ from the h1. */
		documentTitle?: string;
		/** One line under the h1 saying what a person does here. */
		subtitle?: string;
		width?: 'list' | 'read';
		/** An accessible name for <main>, when the h1 is not the right one. */
		label?: string;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	const tab = $derived(`${documentTitle ?? title} · Northline`);
</script>

<svelte:head>
	<title>{tab}</title>
</svelte:head>

<main id="content" class="page" class:read={width === 'read'} aria-label={label}>
	<div class="page-head">
		<div class="titles">
			<h1>{title}</h1>
			{#if subtitle}
				<p class="muted prose">{subtitle}</p>
			{/if}
		</div>
		{#if actions}
			<div class="actions">{@render actions()}</div>
		{/if}
	</div>

	{@render children()}
</main>
