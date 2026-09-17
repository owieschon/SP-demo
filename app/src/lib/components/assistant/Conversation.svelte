<script lang="ts">
	// The conversation: what was asked, what came back, what it looked up, and
	// the proposals it put in front of you.
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { ConversationView } from '$lib/assistant/types';
	import { moment } from '$lib/format';
	import Lookup from './Lookup.svelte';
	import ProposalCard from './ProposalCard.svelte';

	let {
		conversation,
		requestId
	}: { conversation: ConversationView; requestId: string } = $props();
</script>

<ol class="thread">
	{#each conversation.messages as message (message.id)}
		<li class={message.role}>
			{#if message.role === 'question'}
				<p class="asked">{message.body}</p>
				<span class="when faint">{moment(message.createdAt)}</span>
			{:else if message.role === 'decision'}
				<p class="decided">{message.body}</p>
			{:else}
				<div class="answer">
					{#each message.body.split('\n').filter(Boolean) as paragraph, i (i)}
						<p>{paragraph}</p>
					{/each}
				</div>

				{#if message.lookups.length > 0}
					<details class="looked" open={message.proposal?.status === 'draft'}>
						<summary>
							<ChevronDown size={13} class="marker" aria-hidden="true" />
							What it looked up
							<span class="chip">{message.lookups.length}</span>
							{#if message.lookups.some((l) => l.outcome === 'gated')}
								<span class="chip warn">1 gated, not run</span>
							{/if}
						</summary>
						<div class="lookups">
							{#each message.lookups as lookup, i (i)}
								<Lookup {lookup} />
							{/each}
						</div>
					</details>
				{/if}

				{#if message.proposal}
					<ProposalCard proposal={message.proposal} conversationId={conversation.id} {requestId} />
				{/if}
			{/if}
		</li>
	{/each}
</ol>

<style>
	.thread {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-4);
	}

	li {
		display: grid;
		gap: 4px;
	}

	.question {
		justify-items: start;
	}

	.asked {
		padding: 6px 10px;
		border-radius: var(--radius-lg);
		background: var(--surface-press);
		font-weight: 500;
		max-width: 72ch;
		white-space: pre-wrap;
	}

	.when {
		font-size: 0.82rem;
	}

	.answer {
		display: grid;
		gap: 6px;
		max-width: 76ch;
		font-size: 1rem;
		line-height: 1.55;
	}

	.decided {
		padding: 4px 10px;
		border-left: 2px solid var(--status-kept);
		color: var(--text-muted);
	}

	.looked {
		margin-top: 2px;
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.looked summary {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		padding: 0 var(--space-3);
		cursor: pointer;
		color: var(--text-muted);
		font-size: 0.92rem;
		list-style: none;
	}

	.looked summary::-webkit-details-marker {
		display: none;
	}

	.looked summary:hover {
		color: var(--text);
	}

	.looked summary :global(.marker) {
		flex: none;
		transition: transform var(--speed) var(--ease);
	}

	.looked[open] summary :global(.marker) {
		transform: rotate(-180deg);
	}

	.lookups {
		animation: fade-in var(--speed-slow) var(--ease);
	}
</style>
