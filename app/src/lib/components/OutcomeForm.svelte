<script lang="ts">
	// The one question a closed-short window asks. Used on the answer page
	// and on a commitment's own page. The request id comes from the server
	// with the page, so a double click or a retry cannot record twice.
	import { enhance } from '$app/forms';
	import { OUTCOME_CHOICES } from '$lib/types';

	let {
		commitmentId,
		updatedAt,
		requestId,
		action = '?/outcome'
	}: {
		commitmentId: number;
		updatedAt: string;
		requestId: string;
		action?: string;
	} = $props();

	let submitting = $state(false);
</script>

<form
	method="POST"
	{action}
	class="outcome"
	use:enhance={() => {
		submitting = true;
		return async ({ update }) => {
			await update();
			submitting = false;
		};
	}}
>
	<input type="hidden" name="commitmentId" value={commitmentId} />
	<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
	<input type="hidden" name="requestId" value={requestId} />

	<label>
		Note (optional)
		<textarea name="note" rows="2" maxlength="500" placeholder="What did the buyer say?"></textarea>
	</label>

	<div class="choices">
		{#each OUTCOME_CHOICES as choice (choice.value)}
			<button class="button choice {choice.value}" name="outcome" value={choice.value} disabled={submitting}>
				<span class="label">{choice.label}</span>
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

	.choices {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
		gap: var(--space-2);
	}

	.choice {
		flex-direction: column;
		align-items: flex-start;
		min-height: 64px;
		padding: var(--space-2) var(--space-3);
		text-align: left;
		border-left: 3px solid var(--tone);
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
		font-weight: 600;
	}

	.hint {
		font-size: 0.8rem;
		font-weight: 400;
		color: var(--text-muted);
	}
</style>
