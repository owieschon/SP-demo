<script lang="ts">
	/*
	  A form field with a real label, help text and an error, all wired
	  together. A placeholder is never a label.

	    <Field label="Part number" name="itemNo" help="As it appears on the quote.">
	      {#snippet control({ id, describedBy, invalid })}
	        <input {id} name="itemNo" aria-describedby={describedBy}
	               aria-invalid={invalid} autocomplete="off" required />
	      {/snippet}
	    </Field>

	  The control is a snippet rather than a prop so the page keeps full
	  control of the input: its type, its autocomplete, its constraints.
	*/
	import type { Snippet } from 'svelte';

	let {
		label,
		name,
		/** One short line about what to type, shown under the field. */
		help,
		/** The server's message for this field, if it refused. */
		error,
		optional = false,
		control
	}: {
		label: string;
		name: string;
		help?: string;
		error?: string;
		optional?: boolean;
		control: Snippet<[{ id: string; describedBy: string | undefined; invalid: true | undefined }]>;
	} = $props();

	const id = $derived(`f-${name}`);
	const helpId = $derived(`${id}-help`);
	const errorId = $derived(`${id}-error`);
	// Both ids, in reading order, so the field announces its help and then
	// the reason it was refused.
	const describedBy = $derived(
		[help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined
	);
</script>

<div class="field">
	<label for={id}>
		{label}{#if optional}<span class="muted"> (optional)</span>{/if}
	</label>
	{@render control({ id, describedBy, invalid: error ? true : undefined })}
	{#if help}
		<span class="field-help" id={helpId}>{help}</span>
	{/if}
	{#if error}
		<span class="field-error" id={errorId} role="alert">{error}</span>
	{/if}
</div>

<style>
	.field {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	/* The label is already styled by app.css; it just must not stretch. */
	label {
		justify-self: start;
	}
</style>
