<script lang="ts">
	/*
	  The shell every page uses, so the title starts in the same place and
	  there are two content widths in the app instead of nine.

	    <Page title="Parts" subtitle="What we sell and what it earns">
	      {#snippet actions()}<a class="button primary" href="/parts/new">New part</a>{/snippet}
	      ... the page ...
	    </Page>

	  It owns the <main>, the browser tab title and the <h1>. The skip link's
	  target (#content) stays on the layout's wrapper, so it still works on a
	  page that has not been migrated yet.

	  The h1 is always visible. Six of nine list pages had `sr-only` on theirs
	  and leaned on the top bar's breadcrumb, which is hidden on phones, so on
	  a phone those six screens had no title anywhere.

	  `width="read"` gives the narrow measure for a form or a single question.
	*/
	import type { Snippet } from 'svelte';

	let {
		title,
		documentTitle,
		subtitle,
		width = 'list',
		label,
		/** Something above the h1: a record's parent, a status, a back link. */
		breadcrumb,
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
		breadcrumb?: Snippet;
		actions?: Snippet;
		children: Snippet;
	} = $props();

	const tab = $derived(`${documentTitle ?? title} · Northline`);
</script>

<svelte:head>
	<title>{tab}</title>
</svelte:head>

<main class="page" class:read={width === 'read'} aria-label={label}>
	<div class="page-head">
		<div class="titles">
			{#if breadcrumb}
				<div class="above">{@render breadcrumb()}</div>
			{/if}
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

<style>
	.above {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}
</style>
