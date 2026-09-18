<script lang="ts">
	// Setting a policy: a value, where it applies, from when, and why.
	//
	// The value box changes shape with the policy: a fixed list becomes a
	// select, a yes or no becomes two options, a list of words takes commas. A
	// value that does not fit is refused by the database, which writes the
	// sentence this form shows, so there is no second copy of the rules here.
	import { enhance } from '$app/forms';
	import { policyValueHint, policyValueToText } from '$lib/policy/value';
	import {
		SCOPE_HINT,
		SCOPE_LABEL,
		type PolicyRow,
		type PolicyScopeKind,
		type PolicyType
	} from '$lib/policy/types';
	import { freshRequestId } from './ids.ts';

	let {
		type,
		row = null,
		requestId,
		today,
		message = null,
		failed = false
	}: {
		type: PolicyType;
		/** The row being changed, or null to add one. */
		row?: PolicyRow | null;
		requestId: string;
		today: string;
		message?: string | null;
		failed?: boolean;
	} = $props();

	// Two fields the form has to follow: the scope kind, because it decides
	// whether the "which one" box is any use, and the value, because its input
	// changes shape. Each keeps what somebody typed and otherwise shows what
	// the row (or the default) says. The parent remounts this form when the row
	// changes, which is what clears them.
	let pickedScope = $state('');
	let typedValue = $state<string | null>(null);

	const scopeKind: PolicyScopeKind = $derived(
		pickedScope !== ''
			? (pickedScope as PolicyScopeKind)
			: (row?.scopeKind ?? (type.scopes.includes('customer') ? 'customer' : type.scopes[0]))
	);
	const valueText = $derived(
		typedValue ?? policyValueToText(type, row ? row.value : type.defaultValue)
	);
	const hint = $derived(policyValueHint(type));
</script>

<form
	method="POST"
	action="?/set"
	use:enhance={({ formData }) => {
		// A new id per submit, so a second attempt after a refusal is a new
		// write rather than a replay of the first one's answer.
		formData.set('requestId', freshRequestId());
		return async ({ update }) => await update({ reset: false });
	}}
>
	<input type="hidden" name="policyType" value={type.key} />
	<input type="hidden" name="policyId" value={row?.id ?? ''} />
	<input type="hidden" name="expectedUpdatedAt" value={row?.updatedAt ?? ''} />
	<input type="hidden" name="requestId" value={requestId} />

	<div class="grid">
		<label>
			Applies to
			<select
				name="scopeKind"
				value={scopeKind}
				onchange={(event) => (pickedScope = event.currentTarget.value)}
			>
				{#each type.scopes as scope (scope)}
					<option value={scope}>{SCOPE_LABEL[scope]}</option>
				{/each}
			</select>
		</label>

		<label>
			Which one
			<input
				name="scopeId"
				value={row?.scopeId ?? ''}
				placeholder={SCOPE_HINT[scopeKind]}
				disabled={scopeKind === 'global'}
				autocomplete="off"
			/>
			{#if scopeKind === 'global'}
				<span class="field-help">A company-wide policy applies to everyone.</span>
			{/if}
		</label>

		<label>
			Value
			{#if type.valueType === 'enum'}
				<select
					name="valueText"
					value={valueText}
					onchange={(event) => (typedValue = event.currentTarget.value)}
				>
					{#each type.allowed as choice (choice)}
						<option value={choice}>{choice}</option>
					{/each}
				</select>
			{:else if type.valueType === 'boolean'}
				<select
					name="valueText"
					value={valueText}
					onchange={(event) => (typedValue = event.currentTarget.value)}
				>
					<option value="yes">yes</option>
					<option value="no">no</option>
				</select>
			{:else}
				<input
					name="valueText"
					value={valueText}
					oninput={(event) => (typedValue = event.currentTarget.value)}
					autocomplete="off"
					inputmode="text"
				/>
			{/if}
			{#if hint !== ''}
				<span class="field-help">{hint}</span>
			{/if}
			{#if type.valueType === 'text_list' && type.allowed.length > 0}
				<span class="field-help">From: {type.allowed.join(', ')}</span>
			{/if}
		</label>

		<label>
			From
			<input type="date" name="effectiveFrom" value={row?.effectiveFrom ?? today} required />
		</label>

		<label>
			To
			<input type="date" name="effectiveTo" value={row?.effectiveTo ?? ''} />
			<span class="field-help">Leave it empty for open ended.</span>
		</label>

		<label>
			Priority
			<input type="number" name="priority" value={row?.priority ?? 0} min="-100" max="100" step="1" />
			<span class="field-help">Breaks a tie at the same scope. Higher wins.</span>
		</label>
	</div>

	<label class="why">
		Why
		<input
			name="note"
			value={row?.note ?? ''}
			maxlength="300"
			placeholder="The sentence you would say out loud about this"
			autocomplete="off"
		/>
	</label>

	<div class="foot">
		<button class="button primary" type="submit">{row ? 'Save this policy' : 'Set this policy'}</button>
		{#if row}
			<a class="button quiet" href="?type={type.key}">Cancel</a>
		{/if}
		{#if message}
			<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>{message}</p>
		{/if}
	</div>
</form>

<style>
	form {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	/*
	  Flexbox rather than auto-fit grid tracks: this app has been bitten by
	  Safari iOS handling those differently from Chrome.
	*/
	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.grid > label {
		flex: 1 1 170px;
		min-width: 0;
	}

	.why input {
		width: 100%;
	}

	.foot {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.foot p {
		margin: 0;
	}
</style>
