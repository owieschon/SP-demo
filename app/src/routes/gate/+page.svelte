<script lang="ts">
	// The curtain in front of the whole site. One password, typed once per
	// browser, then a signed cookie for a month. The app's own "sign in as"
	// picker comes after this.
	import { enhance } from '$app/forms';
	import Lock from '@lucide/svelte/icons/lock';
	import Mark from '$lib/components/Mark.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let checking = $state(false);
</script>

<svelte:head>
	<title>Northline</title>
	<meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="gate">
	<header>
		<Mark size={34} />
		<h1>Northline</h1>
		<p class="muted">A demo app on synthetic data. It is not open to the public.</p>
	</header>

	<form
		method="POST"
		use:enhance={() => {
			checking = true;
			return async ({ update }) => {
				await update();
				checking = false;
			};
		}}
	>
		<input type="hidden" name="next" value={data.next} />
		<label for="password">Password</label>
		<div class="row">
			<input
				id="password"
				name="password"
				type="password"
				autocomplete="current-password"
				autofocus
				required
				aria-describedby={form?.message ? 'gate-error' : 'gate-note'}
			/>
			<button class="button" disabled={checking} aria-busy={checking}>
				<Lock size={14} strokeWidth={1.75} aria-hidden="true" />
				{checking ? 'Checking' : 'Enter'}
			</button>
		</div>

		{#if form?.message}
			<p id="gate-error" class="error-text small" role="alert">{form.message}</p>
		{:else}
			<p id="gate-note" class="faint small">
				This browser stays open for {data.days} days.
			</p>
		{/if}
	</form>
</main>

<style>
	.gate {
		width: min(28rem, 100%);
		margin: 12vh auto 0;
		padding: 0 var(--space-3);
	}

	header {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-bottom: var(--space-4);
	}

	h1 {
		margin: 0;
		font-size: 1.35rem;
		letter-spacing: -0.01em;
	}

	header p {
		margin: 0;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-lg, var(--radius));
		background: var(--surface);
	}

	.row {
		display: flex;
		gap: 8px;
	}

	input {
		flex: 1;
		/* 16px keeps a phone from zooming in when the field takes focus. */
		font-size: 16px;
	}

	form p {
		margin: 0;
	}
</style>
