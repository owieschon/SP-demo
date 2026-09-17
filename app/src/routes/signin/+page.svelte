<script lang="ts">
	import { enhance } from '$app/forms';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Mark from '$lib/components/Mark.svelte';
	import type { Role } from '$lib/types';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	// Which button is working, so only that one shows it.
	let pending = $state<number | null>(null);

	const ROLE_NOTE: Record<Role, string> = {
		admin: 'Sees every book and can answer for any commitment.',
		account_manager: 'Owns customers and their commitments.',
		operations: 'Runs the order desk and the daily open-orders export.'
	};

	// "Pat Doe" -> "PD"
	function initials(name: string) {
		return name
			.split(/\s+/)
			.filter(Boolean)
			.map((part) => part[0])
			.slice(0, 2)
			.join('')
			.toUpperCase();
	}
</script>

<svelte:head>
	<title>Sign in · Northline</title>
</svelte:head>

<main class="signin">
	<header>
		<Mark size={32} />
		<h1>Sign in to Northline</h1>
		<p class="muted">
			A portfolio app on invented data. Pick someone to be; there are no passwords. Every database
			call runs as the person you pick, and the database decides what they may change.
		</p>
	</header>

	{#if data.signedInAs}
		<p class="notice">Signed in as {data.signedInAs.fullName}. Pick someone else to switch.</p>
	{/if}
	{#if form?.message}
		<p class="notice error" role="alert">{form.message}</p>
	{/if}

	<ul class="people panel">
		{#each data.users as user (user.id)}
			<li>
				<form
					method="POST"
					use:enhance={() => {
						pending = user.id;
						return async ({ update }) => {
							await update();
							pending = null;
						};
					}}
				>
					<input type="hidden" name="userId" value={user.id} />
					<input type="hidden" name="next" value={data.next} />
					<button class="person" disabled={!user.active || pending !== null} aria-busy={pending === user.id}>
						<span class="avatar" aria-hidden="true">{initials(user.fullName)}</span>
						<span class="text">
							<span class="line">
								<span class="name">{user.fullName}</span>
								<span class="title muted">{user.title}</span>
							</span>
							<span class="role faint">
								{user.active ? ROLE_NOTE[user.role] : 'Inactive: shows that the database refuses writes from former staff.'}
							</span>
						</span>
						<span class="go" aria-hidden="true">
							{#if pending === user.id}
								<span class="spinner"></span>
							{:else}
								<ArrowRight size={14} strokeWidth={1.75} />
							{/if}
						</span>
					</button>
				</form>
			</li>
		{/each}
	</ul>
</main>

<style>
	.signin {
		max-width: 520px;
		margin: 0 auto;
		padding: 12vh var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-4);
	}

	header {
		display: grid;
		gap: var(--space-2);
		justify-items: start;
	}

	header h1 {
		margin-top: var(--space-2);
		font-size: 1.25rem;
	}

	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow: hidden;
	}

	.people li + li {
		border-top: 1px solid var(--hairline);
	}

	.people form {
		margin: 0;
	}

	.person {
		width: 100%;
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 10px var(--space-3);
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.person:hover:not(:disabled) {
		background: var(--surface-hover);
	}

	.person:active:not(:disabled) {
		transform: scale(0.97);
	}

	.person:focus-visible {
		outline-offset: -2px;
	}

	.person:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.avatar {
		flex: none;
		width: 28px;
		height: 28px;
		border-radius: 50%;
		display: grid;
		place-items: center;
		font-size: 0.8rem;
		font-weight: 600;
		background: var(--surface-press);
		box-shadow: inset 0 0 0 1px var(--hairline-strong);
	}

	.text {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 1px;
	}

	.line {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.name {
		font-weight: 500;
	}

	.role {
		font-size: 0.92rem;
	}

	.go {
		flex: none;
		display: grid;
		place-items: center;
		width: 20px;
		color: var(--text-faint);
		transition:
			transform var(--speed) var(--ease),
			color var(--speed) var(--ease);
	}

	.person:hover:not(:disabled) .go {
		transform: translateX(2px);
		color: var(--text);
	}

	.spinner {
		width: 12px;
		height: 12px;
		border-radius: 50%;
		border: 1.5px solid var(--hairline-strong);
		border-top-color: var(--text);
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.person:active:not(:disabled) {
			transform: none;
		}
	}
</style>
