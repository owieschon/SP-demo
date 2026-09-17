<script lang="ts">
	/*
	  A section's query failed. Say what happened, say what to try, and give
	  a control that tries it, keeping whatever filters the person had set.

	    {:catch}
	      <LoadFailed what="the open orders" />

	  `data-sveltekit-reload` forces a real request, because a client-side
	  navigation to the URL we are already on would be a no-op.
	*/
	import { page } from '$app/state';

	let {
		/** What did not load, in a person's words: "the open orders". */
		what,
		/** Something to try other than reloading. */
		hint
	}: { what: string; hint?: string } = $props();

	// Same path, same query, so filters and the page number survive the retry.
	const here = $derived(page.url.pathname + page.url.search);
</script>

<p class="notice error" role="alert">
	<span>
		Could not load {what}. {hint ?? 'The database did not answer in time.'}
	</span>
	<a class="button" href={here} data-sveltekit-reload>Try again</a>
</p>

<style>
	.notice {
		justify-content: space-between;
		flex-wrap: wrap;
		padding: var(--space-3);
	}
</style>
