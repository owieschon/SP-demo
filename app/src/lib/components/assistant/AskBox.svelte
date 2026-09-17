<script lang="ts">
	// The question box. Enter sends it, shift and Enter make a new line.
	//
	// The caps are written under it rather than hidden in a tooltip: knowing
	// that one question gets eight lookups is part of trusting the answer.
	import { enhance } from '$app/forms';
	import CornerDownLeft from '@lucide/svelte/icons/corner-down-left';
	import type { CapsView } from '$lib/assistant/types';

	let {
		requestId,
		caps,
		conversationId = null,
		question = $bindable(''),
		placeholder = 'Ask about an account, a commitment, a part, or anything in the book...'
	}: {
		requestId: string;
		caps: CapsView;
		conversationId?: number | null;
		question?: string;
		placeholder?: string;
	} = $props();

	let asking = $state(false);
	let box: HTMLTextAreaElement | undefined = $state();

	const ready = $derived(question.trim().length > 1);
	const left = $derived(Math.max(caps.userLimit - caps.userUsed, 0));

	function keydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			if (ready) box?.form?.requestSubmit();
		}
	}
</script>

<form
	method="POST"
	action="?/ask"
	class="ask"
	use:enhance={() => {
		asking = true;
		return async ({ update }) => {
			await update({ reset: false });
			question = '';
			asking = false;
		};
	}}
>
	<input type="hidden" name="requestId" value={requestId} />
	{#if conversationId !== null}
		<input type="hidden" name="conversationId" value={conversationId} />
	{/if}

	<label class="field">
		<span class="sr-only">Your question</span>
		<textarea
			bind:this={box}
			bind:value={question}
			name="question"
			rows="3"
			maxlength="2000"
			{placeholder}
			spellcheck="true"
			onkeydown={keydown}
		></textarea>
	</label>

	<div class="under">
		<p class="faint small">
			{caps.rounds} lookups per question, {caps.conversationMessages} messages per conversation, {left}
			{left === 1 ? 'question' : 'questions'} left today. Nothing is written without your approval.
		</p>
		<button class="button primary" disabled={!ready || asking} aria-busy={asking}>
			{#if asking}
				<span class="spinner" aria-hidden="true"></span>Thinking...
			{:else}
				Ask<CornerDownLeft size={13} aria-hidden="true" />
			{/if}
		</button>
	</div>
</form>

<style>
	.ask {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
	}

	.field {
		gap: 0;
	}

	textarea {
		font-size: 1rem;
		line-height: 1.5;
	}

	.under {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.small {
		font-size: 0.88rem;
		max-width: 62ch;
	}

	.spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 1.5px solid currentColor;
		border-top-color: transparent;
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 720px) {
		.under {
			flex-direction: column-reverse;
			align-items: stretch;
		}

		.under button {
			height: 36px;
		}
	}
</style>
