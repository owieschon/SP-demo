<script lang="ts">
	import { money, percent, windowRange } from '$lib/format';
	import type { BoardCard } from '$lib/types';
	import ProgressBar from './ProgressBar.svelte';

	let { card, year, showOwner }: { card: BoardCard; year: number; showOwner: boolean } = $props();

	const open = $derived(!['kept', 'pushed', 'broken'].includes(card.status));
</script>

<a class="card" href="/commitments/{card.id}" class:attention={card.needsOutcome}>
	<div class="top">
		<span class="title">{card.title}</span>
		<span class="id faint mono">C-{card.id}</span>
	</div>
	<div class="customer muted">{card.customerName}</div>

	<div class="money">
		<span class="num"><strong>{money(card.delivered)}</strong> of {money(card.committedValue)}</span>
		<span class="faint num">{percent(card.deliveredRatio)}</span>
	</div>
	<ProgressBar
		ratio={card.deliveredRatio}
		pace={open ? card.windowElapsedRatio : null}
		status={card.status}
		label="Delivered for {card.title}"
	/>

	<div class="meta">
		<span>{windowRange(card.startsOn, card.endsOn, year)}</span>
		{#if open}
			<span title="The owner's confidence that the rest will arrive">{card.confidence}% confident</span>
		{/if}
		{#if showOwner}
			<span>{card.ownerName}</span>
		{/if}
	</div>

	{#if card.needsOutcome || !card.buyerName || card.outcomeSource === 'nightly'}
		<div class="chips">
			{#if card.needsOutcome}
				<span class="chip warn">Closed short {card.daysSinceClose}d ago: needs an outcome</span>
			{/if}
			{#if !card.buyerName}
				<span class="chip">No buyer named</span>
			{/if}
			{#if card.outcomeSource === 'nightly'}
				<span class="chip">Pushed by the nightly job, with evidence</span>
			{/if}
		</div>
	{/if}
</a>

<style>
	.card {
		display: grid;
		gap: 6px;
		padding: var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-lg);
		background: var(--surface);
		color: inherit;
		transition:
			border-color var(--speed) var(--ease),
			box-shadow var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.card:hover {
		text-decoration: none;
		border-color: var(--hairline-strong);
		box-shadow: var(--shadow-pop);
	}

	.card:active {
		transform: scale(0.995);
	}

	.card.attention {
		border-color: var(--warning);
	}

	.top {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.title {
		font-weight: 600;
		line-height: 1.25;
	}

	.id {
		font-size: 0.75rem;
		white-space: nowrap;
	}

	.customer {
		font-size: 0.88rem;
		margin-top: -4px;
	}

	.money {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		font-size: 0.9rem;
		margin-top: var(--space-1);
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 2px var(--space-3);
		font-size: 0.8rem;
		color: var(--text-muted);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.chip {
		font-size: 0.75rem;
		padding: 2px 8px;
		border-radius: 999px;
		background: var(--surface-sunken);
		color: var(--text-muted);
	}

	.chip.warn {
		background: var(--warning-soft);
		color: var(--warning);
	}
</style>
