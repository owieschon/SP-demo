<script lang="ts">
	// The one question a closed-short window asks. Used on the answer page
	// and on a commitment's own page. The request id comes from the server
	// with the page, so a double click or a retry cannot record twice.
	//
	// Optional hooks for the answer page's animation:
	//   onsubmitting: called the moment an answer is sent
	//   onsaved:      awaited after the server said yes, before the page data
	//                 refreshes (so the current question can finish leaving)
	//   onfailed:     called when the server said no
	//   ondone:       called after the page data has refreshed
	import { enhance } from '$app/forms';
	import { OUTCOME_CHOICES } from '$lib/types';

	let {
		commitmentId,
		updatedAt,
		requestId,
		action = '?/outcome',
		onsubmitting,
		onsaved,
		onfailed,
		ondone
	}: {
		commitmentId: number;
		updatedAt: string;
		requestId: string;
		action?: string;
		onsubmitting?: () => void;
		onsaved?: () => Promise<void> | void;
		onfailed?: () => void;
		ondone?: () => void;
	} = $props();

	let submitting = $state(false);
</script>

<form
	method="POST"
	{action}
	class="outcome"
	use:enhance={() => {
		submitting = true;
		onsubmitting?.();
		return async ({ result, update }) => {
			if (result.type === 'success') {
				await onsaved?.();
			} else {
				onfailed?.();
			}
			await update();
			submitting = false;
			ondone?.();
		};
	}}
>
	<input type="hidden" name="commitmentId" value={commitmentId} />
	<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
	<input type="hidden" name="requestId" value={requestId} />

	<label>
		<span>Note <span class="faint">(optional)</span></span>
		<textarea name="note" rows="2" maxlength="500" placeholder="What did the buyer say?"></textarea>
	</label>

	<div class="choices">
		{#each OUTCOME_CHOICES as choice (choice.value)}
			<button class="choice {choice.value}" name="outcome" value={choice.value} disabled={submitting}>
				<span class="label"><span class="swatch" aria-hidden="true"></span>{choice.label}</span>
				<span class="hint">{choice.hint}</span>
			</button>
		{/each}
	</div>
</form>

<style>
	.outcome {
		display: grid;
		gap: var(--space-3);
	}

	/* Three answers side by side; they wrap on a phone. */
	.choices {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.choice {
		flex: 1 1 150px;
		display: grid;
		gap: 2px;
		padding: 8px 10px;
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			border-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.choice:hover:not(:disabled) {
		background: var(--surface-hover);
		border-color: color-mix(in srgb, var(--tone) 55%, var(--hairline-strong));
	}

	.choice:active:not(:disabled) {
		transform: scale(0.97);
	}

	.choice:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.choice.pushed {
		--tone: var(--status-pushed);
	}

	.choice.kept {
		--tone: var(--status-kept);
	}

	.choice.broken {
		--tone: var(--status-broken);
	}

	.label {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
	}

	.swatch {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--tone);
	}

	.hint {
		padding-left: 14px;
		font-size: 0.88rem;
		color: var(--text-muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.choice:active:not(:disabled) {
			transform: none;
		}
	}
</style>
