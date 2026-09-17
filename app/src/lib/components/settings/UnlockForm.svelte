<script lang="ts">
	// The passcode gate. Locked: one field and a clear note about what is
	// visible without it. Unlocked: how long is left, a way to lock again, and
	// the only place the passcode can be changed.
	import { enhance } from '$app/forms';
	import { moment } from '$lib/format';
	import { freshRequestId } from './types';

	let {
		unlocked,
		unlockHours,
		minLength,
		passcodeUpdatedAt,
		unlockAnswer,
		passcodeAnswer
	}: {
		unlocked: boolean;
		unlockHours: number;
		minLength: number;
		/** The row version of the passcode, needed to change it. */
		passcodeUpdatedAt: string | null;
		unlockAnswer: { message: string; ok: boolean } | null;
		passcodeAnswer: { message: string; ok: boolean } | null;
	} = $props();

	let passcode = $state('');
	let submitting = $state(false);
	let changing = $state(false);
	let oldPasscode = $state('');
	let next = $state('');
	let again = $state('');

	const readyToChange = $derived(
		oldPasscode.length > 0 && next.length >= minLength && next === again && next !== oldPasscode
	);
</script>

<section class="panel gate" class:open={unlocked}>
	<header class="panel-head">
		<h2>{unlocked ? 'Settings are unlocked' : 'Settings are locked'}</h2>
		{#if unlocked}
			<form
				method="POST"
				action="?/lock"
				use:enhance={() => async ({ update }) => await update()}
			>
				<button class="button quiet">Lock again</button>
			</form>
		{/if}
	</header>

	<div class="body">
		{#if unlocked}
			<p class="faint">
				This browser is unlocked for up to {unlockHours} hours from when the passcode was typed. Locking
				again only affects this browser.
			</p>
		{:else}
			<form
				method="POST"
				action="?/unlock"
				use:enhance={({ formData }) => {
					formData.set('requestId', freshRequestId());
					submitting = true;
					return async ({ update }) => {
						await update({ reset: false });
						submitting = false;
						passcode = '';
					};
				}}
			>
				<input type="hidden" name="requestId" value="" />
				<div class="row">
					<label>
						<span>Admin passcode</span>
						<input
							name="passcode"
							type="password"
							bind:value={passcode}
							autocomplete="current-password"
							disabled={submitting}
						/>
					</label>
					<button class="button primary pressable" disabled={passcode.length === 0 || submitting}>
						{submitting ? 'Checking' : 'Unlock'}
					</button>
				</div>
			</form>
			<p class="faint small">
				Everything below is read only until then, apart from Health, which holds nothing secret. Five wrong
				answers in fifteen minutes and this account waits.
			</p>
		{/if}

		{#if unlockAnswer}
			<p class="notice" class:error={!unlockAnswer.ok} role={unlockAnswer.ok ? 'status' : 'alert'}>
				{unlockAnswer.message}
			</p>
		{/if}

		{#if unlocked}
			<div class="change">
				<button class="button quiet" onclick={() => (changing = !changing)} aria-expanded={changing}>
					{changing ? 'Leave the passcode alone' : 'Change the passcode'}
				</button>
				{#if passcodeUpdatedAt}
					<span class="faint small">Last changed {moment(passcodeUpdatedAt)}.</span>
				{/if}
			</div>

			{#if changing}
				<form
					method="POST"
					action="?/passcode"
					use:enhance={({ formData }) => {
						formData.set('requestId', freshRequestId());
						return async ({ result, update }) => {
							await update({ reset: false });
							if (result.type === 'success') {
								oldPasscode = '';
								next = '';
								again = '';
								changing = false;
							}
						};
					}}
				>
					<input type="hidden" name="requestId" value="" />
					<input type="hidden" name="expectedUpdatedAt" value={passcodeUpdatedAt ?? ''} />
					<div class="row">
						<label>
							<span>The passcode now</span>
							<input name="old" type="password" bind:value={oldPasscode} autocomplete="current-password" />
						</label>
						<label>
							<span>The new one</span>
							<input
								name="passcode"
								type="password"
								bind:value={next}
								autocomplete="new-password"
								minlength={minLength}
								placeholder="at least {minLength} characters"
							/>
						</label>
						<label>
							<span>Again</span>
							<input name="again" type="password" bind:value={again} autocomplete="new-password" />
						</label>
						<button class="button primary pressable" disabled={!readyToChange}>Change it</button>
					</div>
					<p class="faint small">
						The old one is checked in the database, so only somebody who can type it can change it. Anyone
						already unlocked stays unlocked until their {unlockHours} hours run out.
					</p>
				</form>
			{/if}
		{/if}

		{#if passcodeAnswer}
			<p class="notice" class:error={!passcodeAnswer.ok} role={passcodeAnswer.ok ? 'status' : 'alert'}>
				{passcodeAnswer.message}
			</p>
		{/if}
	</div>
</section>

<style>
	.gate {
		border-color: var(--hairline-strong);
	}

	.body {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
	}

	p {
		margin: 0;
		max-width: 80ch;
	}

	.small {
		font-size: 0.85rem;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
	}

	label {
		flex: 1 1 180px;
	}

	.change {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.change button {
		padding: 0 6px;
	}

	.notice {
		font-size: 0.9rem;
	}
</style>
