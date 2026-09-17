<script lang="ts">
	import { enhance } from '$app/forms';
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
</script>

<svelte:head>
	<title>Sign in · Northline</title>
</svelte:head>

<main class="signin">
	<header>
		<p class="mark" aria-hidden="true">N</p>
		<h1>Northline</h1>
		<p class="muted">
			A portfolio app on invented data. Pick someone to be; there are no passwords. Every
			database call runs as the person you pick, and the database decides what they may change.
		</p>
	</header>

	{#if data.signedInAs}
		<p class="notice">Signed in as {data.signedInAs.fullName}. Pick someone else to switch.</p>
	{/if}
	{#if form?.message}
		<p class="notice error" role="alert">{form.message}</p>
	{/if}

	<ul class="people">
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
						<span class="name">{user.fullName}</span>
						<span class="title muted">{user.title}</span>
						<span class="role faint">
							{user.active ? ROLE_NOTE[user.role] : 'Inactive: shows that the database refuses writes from former staff.'}
						</span>
						<span class="go" aria-hidden="true">{pending === user.id ? '…' : '→'}</span>
					</button>
				</form>
			</li>
		{/each}
	</ul>
</main>

<style>
	.signin {
		max-width: 560px;
		margin: 0 auto;
		padding: var(--space-6) var(--space-4);
		display: grid;
		gap: var(--space-5);
	}

	header {
		display: grid;
		gap: var(--space-2);
	}

	.mark {
		width: 36px;
		height: 36px;
		border-radius: 8px;
		display: grid;
		place-items: center;
		background: var(--accent);
		color: var(--accent-text);
		font-weight: 700;
	}

	.people {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--hairline);
	}

	.person {
		width: 100%;
		display: grid;
		grid-template-columns: 1fr auto;
		grid-template-areas:
			'name go'
			'title go'
			'role go';
		gap: 2px var(--space-3);
		padding: var(--space-3) var(--space-2);
		border: 0;
		border-bottom: 1px solid var(--hairline);
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background var(--speed) var(--ease);
	}

	.person:hover:not(:disabled) {
		background: var(--surface-sunken);
	}

	.person:active:not(:disabled) {
		background: var(--hairline);
	}

	.person:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}

	.name {
		grid-area: name;
		font-weight: 600;
	}

	.title {
		grid-area: title;
		font-size: 0.9rem;
	}

	.role {
		grid-area: role;
		font-size: 0.85rem;
	}

	.go {
		grid-area: go;
		align-self: center;
		color: var(--text-faint);
		transition: transform var(--speed) var(--ease);
	}

	.person:hover:not(:disabled) .go {
		transform: translateX(3px);
		color: var(--accent);
	}
</style>
