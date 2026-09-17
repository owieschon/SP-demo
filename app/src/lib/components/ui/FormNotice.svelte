<script lang="ts">
	/*
	  What came back from a form action, in one place. Five pages each worked
	  out "did it fail?" differently, which is why some failures announced
	  themselves and some did not.

	    <FormNotice {form} />

	  A failure is announced (role="alert"). A success is polite. A conflict
	  (someone else changed the row while this page was open) is a failure
	  with its own action, because reloading is the only way out of it.
	*/
	import { invalidateAll } from '$app/navigation';

	let {
		form,
		/** Set when a success message should not be shown at all. */
		quietOnSuccess = false
	}: {
		form: { message?: string; failed?: boolean; conflict?: boolean } | null | undefined;
		quietOnSuccess?: boolean;
	} = $props();

	// One rule for the whole app: a form result failed if it says so, or if
	// it is a conflict. Anything else with a message is a success.
	const failed = $derived(Boolean(form?.failed || form?.conflict));
	const show = $derived(Boolean(form?.message) && !(quietOnSuccess && !failed));
</script>

{#if show && form?.message}
	<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>
		<span>{form.message}</span>
		{#if form.conflict}
			<button type="button" class="button" onclick={() => invalidateAll()}>
				Load the latest version
			</button>
		{/if}
	</p>
{/if}

<style>
	.notice {
		justify-content: space-between;
		flex-wrap: wrap;
	}
</style>
