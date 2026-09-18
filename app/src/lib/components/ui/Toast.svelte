<script lang="ts">
	/*
	  Where the short messages appear. Rendered once, in the layout.

	  Two live regions rather than one, because the two cases are not the
	  same announcement: a success is polite and waits its turn, a failure is
	  an alert and interrupts. A single region would have to pick one and be
	  wrong half the time.
	*/
	import X from '@lucide/svelte/icons/x';
	import { dismissToast, toasts } from './toasts.svelte';

	const good = $derived(toasts.filter((toast) => toast.tone === 'ok'));
	const bad = $derived(toasts.filter((toast) => toast.tone === 'error'));
</script>

<div class="stack">
	<div role="status" aria-live="polite">
		{#each good as toast (toast.id)}
			<p class="notice">
				<span>{toast.message}</span>
				<button type="button" class="button quiet icon sm" onclick={() => dismissToast(toast.id)}>
					<X size={13} strokeWidth={1.75} aria-hidden="true" />
					<span class="sr-only">Dismiss</span>
				</button>
			</p>
		{/each}
	</div>
	<div role="alert" aria-live="assertive">
		{#each bad as toast (toast.id)}
			<p class="notice error">
				<span>{toast.message}</span>
				<button type="button" class="button quiet icon sm" onclick={() => dismissToast(toast.id)}>
					<X size={13} strokeWidth={1.75} aria-hidden="true" />
					<span class="sr-only">Dismiss</span>
				</button>
			</p>
		{/each}
	</div>
</div>

<style>
	.stack {
		position: fixed;
		z-index: 70;
		right: var(--space-4);
		bottom: var(--space-4);
		display: grid;
		gap: var(--space-2);
		justify-items: end;
		pointer-events: none;
	}

	.notice {
		pointer-events: auto;
		max-width: min(420px, calc(100vw - 2 * var(--space-4)));
		box-shadow: var(--overlay-shadow);
		justify-content: space-between;
		gap: var(--space-3);
	}

	/* Above the phone's bottom nav bar, not behind it. */
	@media (max-width: 720px) {
		.stack {
			right: var(--space-3);
			left: var(--space-3);
			bottom: calc(var(--rail-w) + env(safe-area-inset-bottom) + var(--space-2));
			justify-items: stretch;
		}
	}
</style>
