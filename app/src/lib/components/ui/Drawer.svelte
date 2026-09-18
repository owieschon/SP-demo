<script lang="ts">
	/*
	  A modal panel, built on the platform's own <dialog>.

	    <Drawer bind:open title="Correct the count" description="Posts to the ledger">
	      ... a form ...
	      {#snippet footer()}<SubmitButton label="Post" />{/snippet}
	    </Drawer>

	  `showModal()` gives four things this app would otherwise have to build
	  and get wrong: focus moves into the panel, focus cannot leave it while
	  it is open, Escape closes it, and everything behind it becomes inert.
	  Closing returns focus to whatever opened it, also for free.

	  Nine inline disclosures in this app hid content behind a click with no
	  focus management at all, three of them dropping focus onto <body> by
	  removing the button that was just pressed. Anything that is really a
	  modal belongs here instead.

	  `placement="center"` is the command-palette shape: same mechanics, a box
	  in the middle rather than a panel down the side.
	*/
	import type { Snippet } from 'svelte';
	import X from '@lucide/svelte/icons/x';
	import { isBackdropClick } from './dialog';

	let {
		open = $bindable(false),
		title,
		/** One line under the title saying what this panel is for. */
		description,
		placement = 'right',
		/** Hide the title bar: the content supplies its own (the palette). */
		bare = false,
		/** Called after it closes, however it closed. */
		onclosed,
		children,
		footer
	}: {
		open?: boolean;
		title: string;
		description?: string;
		placement?: 'right' | 'center';
		bare?: boolean;
		onclosed?: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let el: HTMLDialogElement | null = $state(null);

	// One direction each way: the prop opens and closes the element, and the
	// element's own close event (Escape, the button, a form) clears the prop.
	$effect(() => {
		if (!el) return;
		if (open && !el.open) el.showModal();
		else if (!open && el.open) el.close();
	});

	function closed() {
		open = false;
		onclosed?.();
	}
</script>

<dialog
	bind:this={el}
	class={placement}
	aria-label={bare ? title : undefined}
	onclose={closed}
	onclick={(event) => {
		if (isBackdropClick(event.target, el)) open = false;
	}}
>
	<!-- The inner box stops a click on the content counting as the backdrop. -->
	<div class="panel-box">
		{#if !bare}
			<header class="head">
				<div class="titles">
					<h2>{title}</h2>
					{#if description}<p class="t-meta muted">{description}</p>{/if}
				</div>
				<button type="button" class="button quiet icon" onclick={() => (open = false)}>
					<X size={15} strokeWidth={1.75} aria-hidden="true" />
					<span class="sr-only">Close {title}</span>
				</button>
			</header>
		{/if}

		<div class="body">
			{@render children()}
		</div>

		{#if footer}
			<footer class="foot">{@render footer()}</footer>
		{/if}
	</div>
</dialog>

<style>
	dialog {
		margin: 0;
		padding: 0;
		border: 0;
		max-width: none;
		max-height: none;
		background: transparent;
		color: var(--text);
		overflow: visible;
	}

	dialog::backdrop {
		background: light-dark(rgb(28 25 23 / 0.28), rgb(0 0 0 / 0.5));
		-webkit-backdrop-filter: blur(2px);
		backdrop-filter: blur(2px);
	}

	.panel-box {
		display: flex;
		flex-direction: column;
		background: var(--surface);
		border: 1px solid var(--hairline-strong);
		box-shadow: var(--overlay-shadow);
		overflow: hidden;
	}

	/* A panel down the right edge, full height. */
	dialog.right {
		inset: 0 0 0 auto;
		height: 100dvh;
		width: min(560px, 100vw);
	}

	dialog.right .panel-box {
		height: 100%;
		border-radius: 0;
		border-right: 0;
		animation: slide-in var(--speed-slow) var(--ease);
	}

	/* A box in the middle, for the command palette. */
	dialog.center {
		inset: 0;
		width: 100vw;
		height: 100dvh;
		display: grid;
		align-items: start;
		justify-items: center;
		padding-top: min(12vh, 96px);
	}

	dialog.center .panel-box {
		width: min(640px, calc(100vw - 2 * var(--space-4)));
		max-height: min(70dvh, 560px);
		border-radius: var(--radius-lg);
		animation: rise var(--speed-slow) var(--ease);
	}

	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-3);
		border-bottom: 1px solid var(--hairline);
	}

	.titles {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.body {
		padding: var(--space-3);
		overflow: auto;
		min-height: 0;
	}

	.foot {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-2);
		padding: var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	@keyframes slide-in {
		from {
			transform: translateX(12px);
			opacity: 0;
		}
	}

	@keyframes rise {
		from {
			transform: translateY(-6px);
			opacity: 0;
		}
	}

	/* On a phone a side panel is the whole screen from the bottom. */
	@media (max-width: 720px) {
		dialog.right {
			inset: auto 0 0 0;
			width: 100vw;
			height: min(88dvh, 100dvh);
		}

		dialog.right .panel-box {
			border-radius: var(--radius-lg) var(--radius-lg) 0 0;
			border-right: 1px solid var(--hairline-strong);
		}

		dialog.center {
			padding-top: var(--space-4);
		}
	}
</style>
