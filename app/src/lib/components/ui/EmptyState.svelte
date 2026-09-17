<script lang="ts">
	/*
	  Nothing here yet, and what to do about it. One line and one action.

	    <EmptyState line="No contacts on this account." action="Add the first one" href="#new" />
	    <EmptyState line="No drafts yet." >
	      {#snippet action()}<button class="button">Load a sample</button>{/snippet}
	    </EmptyState>

	  A paragraph explaining the data model belongs in help text, not here.
	*/
	import type { Snippet } from 'svelte';

	let {
		line,
		/** The label of a link action. Pass `href` with it. */
		action,
		href,
		/** A control instead of a link, when the action is a form submit. */
		children
	}: {
		line: string;
		action?: string;
		href?: string;
		children?: Snippet;
	} = $props();
</script>

<p class="empty">
	<span>{line}</span>
	{#if children}
		{@render children()}
	{:else if action && href}
		<a class="button" {href}>{action}</a>
	{/if}
</p>
