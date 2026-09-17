<script lang="ts">
	// The commitment board once its rows have arrived: the "closed short"
	// banner, the totals strip, and one quiet column per status.
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { count, money } from '$lib/format';
	import { STATUS_ORDER, type BoardCard, type BoardData, type CommitmentStatus } from '$lib/types';
	import CommitmentCard from './CommitmentCard.svelte';
	import StatusBadge from './StatusBadge.svelte';

	let { board, who, year }: { board: BoardData; who: 'mine' | 'all'; year: number } = $props();

	const cards = $derived(board.cards);

	// One column per status, in the order a commitment moves through them.
	// A settled column holds only its newest cards; its count and total
	// come from the server.
	const columns = $derived(
		STATUS_ORDER.map((status) => {
			const inColumn = cards.filter((c) => c.status === status);
			const whole = isSettledStatus(status) ? board.settled[status] : null;
			return {
				status,
				cards: inColumn,
				count: whole ? whole.count : inColumn.length,
				hidden: whole ? whole.count - inColumn.length : 0,
				committed: whole ? whole.committed : sum(inColumn, (c) => c.committedValue),
				expected: sum(inColumn, (c) => c.expectedValue)
			};
		})
	);

	const open = $derived(cards.filter((c) => !isSettled(c.status)));
	const totals = $derived({
		committed: sum(open, (c) => c.committedValue),
		delivered: sum(open, (c) => c.delivered),
		expected: sum(open, (c) => c.expectedValue)
	});
	const needsOutcome = $derived(cards.filter((c) => c.needsOutcome).length);

	function sum(list: BoardCard[], pick: (c: BoardCard) => number) {
		return list.reduce((total, c) => total + pick(c), 0);
	}

	function isSettled(status: CommitmentStatus) {
		return status === 'kept' || status === 'pushed' || status === 'broken';
	}

	function isSettledStatus(status: CommitmentStatus): status is keyof BoardData['settled'] {
		return isSettled(status);
	}
</script>

<div class="summary">
	<dl class="totals">
		<div>
			<dt>Open</dt>
			<dd class="num">{count(open.length)}</dd>
		</div>
		<div>
			<dt>Committed</dt>
			<dd class="num">{money(totals.committed)}</dd>
		</div>
		<div>
			<dt>Delivered</dt>
			<dd class="num">{money(totals.delivered)}</dd>
		</div>
		<div>
			<dt title="Delivered plus each owner's confidence in the rest">Expected</dt>
			<dd class="num">{money(totals.expected)}</dd>
		</div>
	</dl>

	{#if needsOutcome > 0}
		<a class="banner pressable" href="/commitments/answer?who={who}">
			<span class="dot" aria-hidden="true"></span>
			<span>
				<strong class="num">{needsOutcome}</strong>
				{needsOutcome === 1 ? 'window' : 'windows'} closed short
			</span>
			<span class="go">Answer <ArrowRight size={13} strokeWidth={1.75} aria-hidden="true" /></span>
		</a>
	{/if}
</div>

<div class="board">
	{#each columns as column (column.status)}
		<section class="column panel" aria-labelledby="col-{column.status}">
			<header class="column-head">
				<h2 id="col-{column.status}"><StatusBadge status={column.status} /></h2>
				<span class="faint num">{count(column.count)}</span>
			</header>
			<p class="column-total faint num">
				{#if isSettled(column.status)}
					Last 90 days · {money(column.committed)}
				{:else}
					{money(column.expected)} exp. of {money(column.committed)}
				{/if}
			</p>
			<div class="rows">
				{#each column.cards as card (card.id)}
					<CommitmentCard {card} {year} showOwner={who === 'all'} />
				{:else}
					<p class="empty faint">Nothing here</p>
				{/each}
				{#if column.hidden > 0}
					<p class="more faint num">and {count(column.hidden)} more</p>
				{/if}
			</div>
		</section>
	{/each}
</div>

<style>
	.summary {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.totals {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-5);
		margin: 0;
	}

	.totals div {
		display: grid;
	}

	.totals dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.totals dd {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		letter-spacing: -0.01em;
		text-align: left;
	}

	.banner {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		height: 30px;
		padding: 0 6px 0 10px;
		border-radius: var(--radius);
		border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
		background: var(--warning-soft);
		color: var(--warning);
		transition:
			border-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.banner:hover {
		border-color: var(--warning);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--warning);
	}

	.go {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 22px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		background: var(--surface);
		color: var(--text);
		font-weight: 500;
	}

	.go :global(svg) {
		transition: transform var(--speed) var(--ease);
	}

	.banner:hover .go :global(svg) {
		transform: translateX(2px);
	}

	.board {
		display: grid;
		grid-template-columns: repeat(6, minmax(232px, 1fr));
		gap: var(--space-2);
		align-items: start;
		overflow-x: auto;
		padding-bottom: var(--space-2);
		scroll-snap-type: x proximity;
	}

	.column {
		min-width: 0;
		scroll-snap-align: start;
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.column-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px var(--space-3) 0;
	}

	.column-total {
		padding: 0 var(--space-3) 8px;
		font-size: 0.85rem;
		text-align: left;
		border-bottom: 1px solid var(--hairline);
	}

	.empty,
	.more {
		padding: 10px var(--space-3);
	}

	.more {
		border-top: 1px solid var(--hairline);
		font-size: 0.85rem;
	}

	/* On a phone, the columns stack. */
	@media (max-width: 720px) {
		.board {
			grid-template-columns: 1fr;
			overflow-x: visible;
		}
	}
</style>
