<script lang="ts">
	// One commitment as a row inside its status column on the board.
	// The whole row opens the commitment (the title link is stretched over
	// it); the row action on the right appears on hover or focus, and is
	// always shown on touch screens.
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { money, percent, windowRange } from '$lib/format';
	import type { BoardCard } from '$lib/types';
	import ProgressBar from './ProgressBar.svelte';

	let { card, year, showOwner }: { card: BoardCard; year: number; showOwner: boolean } = $props();

	const open = $derived(!['kept', 'pushed', 'broken'].includes(card.status));
</script>

<article class="row" class:attention={card.needsOutcome}>
	<div class="top">
		<a class="title" href="/commitments/{card.id}">{card.title}</a>
		<span class="id mono faint">C-{card.id}</span>
	</div>
	<!-- Sits above the stretched title link, so the account is reachable too. -->
	<div class="customer muted">
		<a class="over link" href="/accounts/{card.customerNo}">{card.customerName}</a>
	</div>

	<div class="money">
		<span class="num"><span class="delivered">{money(card.delivered)}</span> <span class="faint">of</span> {money(card.committedValue)}</span>
		<span class="num faint">{percent(card.deliveredRatio)}</span>
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
			<span title="The owner's confidence that the rest will arrive">{card.confidence}% conf.</span>
		{/if}
		{#if showOwner}
			<span class="owner">{card.ownerName}</span>
		{/if}
	</div>

	{#if card.needsOutcome || !card.buyerName || card.outcomeSource === 'nightly'}
		<div class="chips">
			{#if card.needsOutcome}
				<span class="chip warn">Closed short {card.daysSinceClose}d ago</span>
			{/if}
			{#if !card.buyerName}
				<!-- An empty state that does something: it opens the buyer form. -->
				<a class="chip over" href="/commitments/{card.id}#buyer">Name the buyer</a>
			{/if}
			{#if card.outcomeSource === 'nightly'}
				<span class="chip" title="Pushed by the nightly job, with evidence">Nightly</span>
			{/if}
		</div>
	{/if}

	<div class="actions">
		{#if card.needsOutcome}
			<a class="button action" href="/commitments/{card.id}#question">Answer</a>
		{:else}
			<a class="button icon action" href="/commitments/{card.id}" aria-label="Open C-{card.id}" tabindex="-1">
				<ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" />
			</a>
		{/if}
	</div>
</article>

<style>
	.row {
		position: relative;
		display: grid;
		gap: 5px;
		padding: 9px var(--space-3) 10px;
		transition: background-color var(--speed) var(--ease);
	}

	.row + :global(.row) {
		border-top: 1px solid var(--hairline);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row:active {
		background: var(--surface-press);
	}

	/* A closed-short row carries a thin amber edge, nothing louder. */
	.row.attention {
		box-shadow: inset 2px 0 0 var(--status-pushed);
	}

	.top {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
	}

	.title {
		font-weight: 500;
		line-height: 1.3;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The title link covers the whole row. */
	.title::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	.title:focus-visible {
		outline: none;
	}

	.title:focus-visible::after {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	.id {
		flex: none;
		font-size: 0.85rem;
		transition: opacity var(--speed) var(--ease);
	}

	/* Anything with .over is clickable on top of the row-wide title link. */
	.over {
		position: relative;
		z-index: 1;
	}

	.customer {
		margin-top: -4px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.money {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		margin-top: 2px;
	}

	.delivered {
		font-weight: 600;
	}

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
		font-size: 0.88rem;
		color: var(--text-muted);
	}

	.meta > * + *::before {
		content: '·';
		margin-right: var(--space-2);
		color: var(--text-faint);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	/* Row action: hidden until the row is hovered or focused. */
	.actions {
		position: absolute;
		top: 6px;
		right: var(--space-2);
		z-index: 1;
		opacity: 0;
		transform: translateX(2px);
		transition:
			opacity var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.action {
		height: 22px;
		padding: 0 8px;
		font-size: 0.88rem;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.05);
	}

	.action.icon {
		width: 22px;
		padding: 0;
	}

	.row:hover .actions,
	.row:focus-within .actions {
		opacity: 1;
		transform: none;
	}

	.row:hover .id,
	.row:focus-within .id {
		opacity: 0;
	}

	/* Touch screens have no hover: keep the action visible. */
	@media (hover: none) {
		.actions {
			position: static;
			opacity: 1;
			transform: none;
			justify-self: start;
		}

		.row:hover .id,
		.row:focus-within .id {
			opacity: 1;
		}

		.action.icon {
			display: none;
		}
	}
</style>
