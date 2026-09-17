<script lang="ts">
	// One setting: what it is, what is in force, and one Save.
	//
	// Each field saves on its own rather than the whole section at once. That
	// keeps one row version per setting, so two people editing different
	// fields never fight, and a refusal names the field it belongs to.
	//
	// A secret is never sent to this component: it gets whether the setting is
	// set, its last four characters and when it changed. The input starts empty
	// and pasting into it replaces what is stored.
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import { moment } from '$lib/format';
	import {
		freshRequestId,
		MULTILINE_KEYS,
		NARROW_KEYS,
		SETTING_HELP,
		SETTING_LABEL,
		type SettingView
	} from './types';

	let {
		setting,
		version,
		unlocked,
		answer,
		first = false,
		suggest
	}: {
		setting: SettingView;
		/** The row version the page loaded, empty when nothing is stored. */
		version: string;
		unlocked: boolean;
		answer: { message: string; ok: boolean } | null;
		/** True for the first field in a section, which needs no hairline above it. */
		first?: boolean;
		/** An optional "make one for me" button (the scheduled run secret uses it). */
		suggest?: { label: string; make: () => string };
	} = $props();

	// What the box starts with. A secret always starts empty: the value is not
	// sent to the browser at all. untrack says "only the value it had when this
	// field appeared", which is what an input wants.
	let value = $state(untrack(() => (setting.isSecret ? '' : setting.shown)));
	let submitting = $state(false);

	const label = $derived(SETTING_LABEL[setting.key] ?? setting.key);
	const help = $derived(SETTING_HELP[setting.key] ?? '');
	const multiline = $derived(MULTILINE_KEYS.has(setting.key));
	const narrow = $derived(NARROW_KEYS.has(setting.key));

	// One line saying what is in force and where it came from.
	const status = $derived.by(() => {
		if (setting.unreadable) return 'Stored, but this server cannot read it.';
		if (setting.source === 'stored') {
			const ends = setting.isSecret && setting.shown ? `, ends ${setting.shown}` : '';
			return `Saved here${ends}${setting.updatedAt ? ` on ${moment(setting.updatedAt)}` : ''}.`;
		}
		if (setting.source === 'environment') {
			const ends = setting.isSecret && setting.shown ? `, ends ${setting.shown}` : '';
			return `From ${setting.envName}${ends}. Saving here takes over from it.`;
		}
		return `Not set. ${setting.envName} is empty too.`;
	});
</script>

<div class="field" class:locked={!unlocked} class:first>
	<div class="head">
		<span class="name">{label}</span>
		<span class="state" class:on={setting.source !== 'none'} class:warn={setting.unreadable}>{status}</span>
	</div>

	{#if help}
		<p class="faint help">{help}</p>
	{/if}

	<form
		method="POST"
		action="?/save"
		use:enhance={({ formData }) => {
			// A new id per submit, so a second attempt after a refusal is a new
			// write rather than a replay of the first one's answer.
			formData.set('requestId', freshRequestId());
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
				if (setting.isSecret) value = '';
			};
		}}
	>
		<input type="hidden" name="key" value={setting.key} />
		<input type="hidden" name="expectedUpdatedAt" value={version} />
		<input type="hidden" name="requestId" value="" />

		<div class="row">
			{#if multiline}
				<textarea
					name="value"
					rows="3"
					bind:value
					disabled={!unlocked || submitting}
					aria-label={label}
					placeholder="one@example.com&#10;two@example.com"
				></textarea>
			{:else}
				<input
					name="value"
					type={setting.isSecret ? 'password' : 'text'}
					class:narrow
					bind:value
					autocomplete="off"
					spellcheck="false"
					disabled={!unlocked || submitting}
					aria-label={label}
					placeholder={setting.isSecret
						? setting.source === 'none'
							? 'paste it here'
							: 'paste a new one to replace it'
						: ''}
				/>
			{/if}

			<div class="buttons">
				{#if suggest}
					<button
						type="button"
						class="button quiet"
						disabled={!unlocked || submitting}
						onclick={() => (value = suggest.make())}
					>
						{suggest.label}
					</button>
				{/if}
				<button class="button primary pressable" disabled={!unlocked || submitting}>
					{submitting ? 'Saving' : 'Save'}
				</button>
			</div>
		</div>
	</form>

	{#if setting.source === 'stored'}
		<form
			method="POST"
			action="?/clear"
			class="clear"
			use:enhance={({ formData }) => {
				formData.set('requestId', freshRequestId());
				return async ({ update }) => await update({ reset: false });
			}}
		>
			<input type="hidden" name="key" value={setting.key} />
			<input type="hidden" name="expectedUpdatedAt" value={version} />
			<input type="hidden" name="requestId" value="" />
			<button class="button quiet" disabled={!unlocked}>Clear what is saved here</button>
		</form>
	{/if}

	{#if answer}
		<p class="notice" class:error={!answer.ok} role={answer.ok ? 'status' : 'alert'}>{answer.message}</p>
	{/if}
</div>

<style>
	.field {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		/* One hairline between fields. The first in a section sits under the
		   panel head, which already has one. */
		border-top: 1px solid var(--hairline);
	}

	.field.first {
		border-top: 0;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.name {
		font-weight: 500;
	}

	.state {
		font-size: 0.85rem;
		color: var(--text-faint);
	}

	.state.on {
		color: var(--text-muted);
	}

	.state.warn {
		color: var(--warning);
	}

	.help {
		margin: 0;
		max-width: 78ch;
		font-size: 0.88rem;
	}

	.row {
		/* Flexbox, not grid: the same layout on Safari and Chromium. */
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: var(--space-2);
	}

	input,
	textarea {
		flex: 1 1 260px;
		min-width: 0;
		font-family: var(--font-mono);
		font-size: 0.9rem;
	}

	input.narrow {
		flex: 0 0 120px;
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
	}

	.clear {
		margin-top: calc(-1 * var(--space-1));
	}

	.clear button {
		padding: 0 6px;
		font-size: 0.85rem;
	}

	.notice {
		margin: 0;
		font-size: 0.88rem;
	}

	@media (max-width: 640px) {
		input,
		textarea,
		input.narrow {
			flex-basis: 100%;
		}
	}
</style>
