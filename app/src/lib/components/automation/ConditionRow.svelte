<script lang="ts">
	// One IF row: [field] [comparison] [value] [remove].
	// The comparison list depends on the field's type, and so does the value
	// box: dollars, a percent, days, a plain number, or a person.
	import X from '@lucide/svelte/icons/x';
	import { OPERATORS, OPERATORS_BY_TYPE, TRIGGERS, type TriggerKey } from '$lib/automation/catalog';
	import type { PersonOption } from '$lib/automation/types';
	import { fieldOf, fitRowToField, type EditorRow } from './editor';

	let {
		row = $bindable(),
		trigger,
		people,
		index,
		disabled = false,
		error = null,
		onremove
	}: {
		row: EditorRow;
		trigger: TriggerKey;
		people: PersonOption[];
		index: number;
		disabled?: boolean;
		error?: string | null;
		onremove: () => void;
	} = $props();

	const field = $derived(fieldOf(trigger, row.field));
	const type = $derived(field?.type ?? 'number');
	const id = $props.id();

	// What sits either side of the number box.
	const before = $derived(type === 'money' ? '$' : '');
	const after = $derived(type === 'percent' ? '%' : type === 'days' ? 'days' : '');

	function changeField(key: string) {
		const previousType = field?.type;
		row.field = key;
		fitRowToField(trigger, row, previousType);
	}
</script>

<div class="condition" class:invalid={error !== null}>
	<span class="joiner faint" aria-hidden="true">{index === 0 ? 'If' : 'and'}</span>

	<select
		aria-label="Condition {index + 1}: what to check"
		value={row.field}
		onchange={(event) => changeField(event.currentTarget.value)}
		{disabled}
	>
		{#each TRIGGERS[trigger].fields as f (f.key)}
			<option value={f.key}>{f.label}</option>
		{/each}
	</select>

	<select aria-label="Condition {index + 1}: comparison" bind:value={row.op} {disabled}>
		{#each OPERATORS_BY_TYPE[type] as op (op)}
			<option value={op}>{OPERATORS[op]}</option>
		{/each}
	</select>

	{#if type === 'user'}
		<select aria-label="Condition {index + 1}: person" bind:value={row.value} {disabled}>
			<option value="me">Me (whoever owns this rule)</option>
			{#each people as person (person.id)}
				<option value={String(person.id)}>{person.name}</option>
			{/each}
		</select>
	{:else}
		<!-- A text box with a number keyboard: it keeps half-typed values like "-" as they are. -->
		<span class="amount" class:has-before={before !== ''}>
			{#if before}<span class="unit before" aria-hidden="true">{before}</span>{/if}
			<input
				id="{id}-value"
				type="text"
				inputmode="decimal"
				autocomplete="off"
				aria-label="Condition {index + 1}: {field?.label ?? 'value'}{after ? ` in ${after}` : ''}"
				aria-invalid={error ? 'true' : undefined}
				bind:value={row.value}
				{disabled}
			/>
			{#if after}<span class="unit after" aria-hidden="true">{after}</span>{/if}
		</span>
	{/if}

	<button
		type="button"
		class="button quiet icon remove"
		aria-label="Remove condition {index + 1}"
		title="Remove"
		onclick={onremove}
		{disabled}
	>
		<X size={14} strokeWidth={1.75} aria-hidden="true" />
	</button>

	{#if error}
		<p class="field-error" role="alert">{error}</p>
	{/if}
</div>

<style>
	/* A row that wraps on a phone: the selects take the space, the joiner and
	   the remove button keep their size. */
	.condition {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 8px var(--space-3);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.condition + :global(.condition) {
		border-top: 1px solid var(--hairline);
	}

	.joiner {
		width: 24px;
		font-size: 0.85rem;
		font-weight: 500;
	}

	select {
		flex: 1 1 160px;
		min-width: 0;
		max-width: 100%;
	}

	.amount {
		position: relative;
		flex: 0 1 150px;
		display: flex;
		align-items: center;
	}

	.amount input {
		width: 100%;
		height: var(--control-h);
		font-variant-numeric: tabular-nums;
		padding-right: 40px;
	}

	.amount.has-before input {
		padding-left: 18px;
	}

	.unit {
		position: absolute;
		color: var(--text-faint);
		pointer-events: none;
	}

	.unit.before {
		left: 8px;
	}

	.unit.after {
		right: 8px;
	}

	.invalid input,
	input[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.remove {
		flex: 0 0 auto;
	}

	.field-error {
		flex-basis: 100%;
		padding-left: 30px;
		color: var(--danger);
		font-size: 0.88rem;
	}

	/* On a phone each control gets its own line, between the joiner on the
	   left and the remove button on the right. */
	@media (max-width: 720px) {
		.condition {
			position: relative;
			padding-left: 44px;
			padding-right: 44px;
		}

		.joiner {
			position: absolute;
			left: var(--space-3);
			top: 14px;
		}

		.remove {
			position: absolute;
			right: var(--space-2);
			top: 8px;
		}

		select,
		.amount {
			flex: 1 1 100%;
		}

		.field-error {
			padding-left: 0;
		}

		/* 16px text stops phones from zooming into a focused box. */
		select,
		input {
			font-size: 16px;
		}
	}
</style>
