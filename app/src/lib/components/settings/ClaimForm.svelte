<script lang="ts">
	// First run: nobody owns this instance yet, so say what claiming means and
	// take a passcode. This is the only moment a passcode can be set without
	// knowing one.
	import { enhance } from '$app/forms';
	import { freshRequestId } from './types';

	let {
		minLength,
		unlockHours,
		answer
	}: {
		minLength: number;
		unlockHours: number;
		answer: { message: string; ok: boolean } | null;
	} = $props();

	let passcode = $state('');
	let again = $state('');
	let submitting = $state(false);

	const tooShort = $derived(passcode.length > 0 && passcode.length < minLength);
	const mismatch = $derived(again.length > 0 && again !== passcode);
	const ready = $derived(passcode.length >= minLength && again === passcode);
</script>

<section class="panel claim">
	<header class="panel-head">
		<h2>Claim this instance</h2>
	</header>

	<div class="body">
		<p>
			Signing in to this app needs no password: the sign-in page lists everyone and you pick one. That is
			fine for a demo of the sales and operations work, and useless for a page that holds API keys. So the
			first person here sets a passcode, and from then on changing a setting needs it.
		</p>
		<p class="faint">
			Only a salted hash of the passcode is stored, the tries are counted in the database, and a correct
			one unlocks this browser for {unlockHours} hours. If you are not the owner of this deployment, leave
			this alone.
		</p>

		<form
			method="POST"
			action="?/claim"
			use:enhance={({ formData }) => {
				formData.set('requestId', freshRequestId());
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
					passcode = '';
					again = '';
				};
			}}
		>
			<input type="hidden" name="requestId" value="" />
			<div class="row">
				<label>
					<span>Choose a passcode</span>
					<input
						name="passcode"
						type="password"
						bind:value={passcode}
						autocomplete="new-password"
						minlength={minLength}
						placeholder="at least {minLength} characters"
						disabled={submitting}
					/>
				</label>
				<label>
					<span>Type it again</span>
					<input
						name="again"
						type="password"
						bind:value={again}
						autocomplete="new-password"
						disabled={submitting}
					/>
				</label>
				<button class="button primary pressable" disabled={!ready || submitting}>
					{submitting ? 'Claiming' : 'Claim'}
				</button>
			</div>
		</form>

		{#if tooShort}
			<p class="faint small">{minLength - passcode.length} more characters. A phrase is easier to remember than a word.</p>
		{:else if mismatch}
			<p class="faint small">The two do not match yet.</p>
		{/if}

		{#if answer}
			<p class="notice" class:error={!answer.ok} role={answer.ok ? 'status' : 'alert'}>{answer.message}</p>
		{/if}
	</div>
</section>

<style>
	.claim {
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
		flex: 1 1 220px;
	}

	.notice {
		font-size: 0.9rem;
	}
</style>
