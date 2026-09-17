<script lang="ts">
	// A text box for an action's words, with a chip for each value the
	// trigger can fill in. Clicking a chip types {name} where the cursor is,
	// so nobody has to remember the exact spelling.
	import { tick } from 'svelte';

	let {
		value = $bindable(),
		label,
		hint = '',
		placeholders,
		maxlength,
		rows = 2,
		disabled = false,
		error = null
	}: {
		value: string;
		label: string;
		hint?: string;
		/** name -> label, e.g. { customer: 'Customer name' } */
		placeholders: { name: string; label: string }[];
		maxlength: number;
		rows?: number;
		disabled?: boolean;
		error?: string | null;
	} = $props();

	let box: HTMLTextAreaElement | undefined = $state();
	const id = $props.id();

	async function insert(name: string) {
		const token = `{${name}}`;
		// Where the cursor was (or the end, if the box never had focus).
		const start = box?.selectionStart ?? value.length;
		const end = box?.selectionEnd ?? value.length;
		value = value.slice(0, start) + token + value.slice(end);
		// Wait for Svelte to put the new text in the box, then put the cursor
		// just after the inserted word.
		await tick();
		box?.focus();
		box?.setSelectionRange(start + token.length, start + token.length);
	}
</script>

<div class="template">
	<label for="{id}-text">
		<span>{label}</span>
		{#if hint}<span class="faint hint">{hint}</span>{/if}
	</label>
	<textarea
		id="{id}-text"
		bind:this={box}
		bind:value
		{rows}
		{maxlength}
		{disabled}
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? `${id}-error` : undefined}
	></textarea>
	<div class="chips" role="group" aria-label="Insert a value">
		<span class="faint">Insert:</span>
		{#each placeholders as p (p.name)}
			<button type="button" class="token pressable" {disabled} onclick={() => insert(p.name)} title={`Adds {${p.name}}`}>
				{p.label}
			</button>
		{/each}
	</div>
	{#if error}
		<p class="field-error" id="{id}-error">{error}</p>
	{/if}
</div>

<style>
	.template {
		display: grid;
		gap: 6px;
	}

	label {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
	}

	.hint {
		font-size: 0.85rem;
	}

	textarea {
		font-size: 1rem;
	}

	textarea[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		font-size: 0.85rem;
	}

	.token {
		height: 22px;
		padding: 0 7px;
		border: 0;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline-strong);
		color: var(--text-muted);
		font: inherit;
		font-weight: 500;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.token:hover:not(:disabled) {
		background: var(--surface-hover);
		color: var(--text);
	}

	.token:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.field-error {
		color: var(--danger);
		font-size: 0.88rem;
	}
</style>
