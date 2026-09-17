<script lang="ts">
	/*
	  A two-step confirm for something that cannot be undone, without a
	  native confirm() (which an agent cannot get past) and without losing
	  the keyboard's place.

	    <ConfirmButton label="Discard" confirmLabel="Yes, discard"
	                   record={`snapshot ${r.id}`} working={submitting} />

	  Three inline confirms in this app remove the button that was clicked,
	  which drops focus to the body. This one keeps a button in the same
	  place in the tab order both times, and moves focus onto the step it
	  just revealed.
	*/
	import { tick } from 'svelte';

	let {
		label,
		confirmLabel,
		/** What is being acted on, for the accessible name. */
		record,
		working = false,
		/** The form value the confirming button submits. */
		name,
		value
	}: {
		label: string;
		confirmLabel: string;
		record?: string;
		working?: boolean;
		name?: string;
		value?: string;
	} = $props();

	let armed = $state(false);
	let confirmEl: HTMLButtonElement | null = $state(null);
	let triggerEl: HTMLButtonElement | null = $state(null);

	async function arm() {
		armed = true;
		// Wait for the confirming button to exist, then put the keyboard on it.
		await tick();
		confirmEl?.focus();
	}

	async function cancel() {
		armed = false;
		await tick();
		triggerEl?.focus();
	}
</script>

{#if armed}
	<span class="pair">
		<button
			bind:this={confirmEl}
			class="button danger"
			{name}
			{value}
			disabled={working}
			aria-busy={working || undefined}
			aria-label={record ? `${confirmLabel}: ${record}` : undefined}
		>
			{#if working}<span class="spinner" aria-hidden="true"></span>{/if}
			{confirmLabel}
		</button>
		<button type="button" class="button quiet" onclick={cancel}>Cancel</button>
	</span>
{:else}
	<button
		bind:this={triggerEl}
		type="button"
		class="button danger"
		onclick={arm}
		aria-label={record ? `${label}: ${record}` : undefined}
	>
		{label}
	</button>
{/if}

<style>
	.pair {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
