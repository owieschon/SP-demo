<script lang="ts">
	/*
	  A submit button that shows and announces that it is working. Eight
	  forms each did some of this; only the sign-in page did all of it.

	    <SubmitButton working={saving} label="Save" workingLabel="Saving"
	                  record={contact.fullName} />

	  `record` is not decoration. A list of twenty rows with twenty buttons
	  called "Done" is unusable with a screen reader and unusable by an
	  agent, so the record's name goes into the accessible name while the
	  visible label stays short.
	*/
	let {
		label,
		workingLabel,
		working = false,
		/** The record this button acts on, e.g. the contact's name. */
		record,
		tone = 'primary',
		disabled = false,
		/** The form value this button submits, when a form has several. */
		name,
		value
	}: {
		label: string;
		workingLabel?: string;
		working?: boolean;
		record?: string;
		tone?: 'primary' | 'plain' | 'danger';
		disabled?: boolean;
		name?: string;
		value?: string;
	} = $props();

	const accessibleName = $derived(record ? `${label}: ${record}` : undefined);
</script>

<button
	class="button"
	class:primary={tone === 'primary'}
	class:danger={tone === 'danger'}
	{name}
	{value}
	disabled={disabled || working}
	aria-busy={working || undefined}
	aria-label={accessibleName}
>
	{#if working}
		<span class="spinner" aria-hidden="true"></span>
	{/if}
	{working ? (workingLabel ?? label) : label}
</button>
