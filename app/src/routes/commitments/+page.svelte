<script lang="ts">
	import CommitmentCard from '$lib/components/CommitmentCard.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { count, money } from '$lib/format';
	import { STATUS_ORDER, type BoardCard, type CommitmentStatus } from '$lib/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// One column per status, in the order a commitment moves through them.
	const columns = $derived(
		STATUS_ORDER.map((status) => {
			const cards = data.cards.filter((c) => c.status === status);
			return {
				status,
				cards,
				committed: sum(cards, (c) => c.committedValue),
				expected: sum(cards, (c) => c.expectedValue)
			};
		})
	);

	const open = $derived(data.cards.filter((c) => !isSettled(c.status)));
	const totals = $derived({
		committed: sum(open, (c) => c.committedValue),
		delivered: sum(open, (c) => c.delivered),
		expected: sum(open, (c) => c.expectedValue)
	});

	function sum(cards: BoardCard[], pick: (c: BoardCard) => number) {
		return cards.reduce((total, c) => total + pick(c), 0);
	}

	function isSettled(status: CommitmentStatus) {
		return status === 'kept' || status === 'pushed' || status === 'broken';
	}
</script>

<svelte:head>
	<title>Commitments · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div>
			<h1>Commitments</h1>
			<p class="muted">
				Named buyers' promises to buy specific parts inside a window. Delivery is measured from
				invoice lines; status is never picked by hand.
			</p>
		</div>
		<div class="who" role="group" aria-label="Whose commitments">
			<a class="button" class:active={data.who === 'mine'} href="?who=mine" aria-current={data.who === 'mine' ? 'true' : undefined}>Mine</a>
			<a class="button" class:active={data.who === 'all'} href="?who=all" aria-current={data.who === 'all' ? 'true' : undefined}>Everyone's</a>
		</div>
	</header>

	{#if data.needsOutcome > 0}
		<a class="banner" href="/commitments/answer?who={data.who}">
			<strong>
				{data.needsOutcome}
				{data.needsOutcome === 1 ? 'window' : 'windows'} closed short: need an outcome
			</strong>
			<span>Answer them →</span>
		</a>
	{/if}

	<dl class="totals">
		<div>
			<dt>Open commitments</dt>
			<dd class="num">{count(open.length)}</dd>
		</div>
		<div>
			<dt>Committed</dt>
			<dd class="num">{money(totals.committed)}</dd>
		</div>
		<div>
			<dt>Delivered so far</dt>
			<dd class="num">{money(totals.delivered)}</dd>
		</div>
		<div>
			<dt title="Delivered plus each owner's confidence in the rest">Expected</dt>
			<dd class="num">{money(totals.expected)}</dd>
		</div>
	</dl>

	<div class="board">
		{#each columns as column (column.status)}
			<section class="column" aria-labelledby="col-{column.status}">
				<header>
					<h2 id="col-{column.status}"><StatusBadge status={column.status} /></h2>
					<span class="faint num">{column.cards.length}</span>
				</header>
				<p class="column-total faint num">
					{#if isSettled(column.status)}
						Last 90 days · {money(column.committed)} committed
					{:else}
						{money(column.expected)} expected of {money(column.committed)}
					{/if}
				</p>
				<div class="cards">
					{#each column.cards as card (card.id)}
						<CommitmentCard {card} year={data.year} showOwner={data.who === 'all'} />
					{:else}
						<p class="empty faint">None</p>
					{/each}
				</div>
			</section>
		{/each}
	</div>
</main>

<style>
	.page {
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-4);
	}

	.head {
		display: flex;
		justify-content: space-between;
		align-items: flex-end;
		gap: var(--space-4);
		flex-wrap: wrap;
	}

	.head p {
		max-width: 60ch;
		margin-top: var(--space-1);
	}

	.who {
		display: flex;
		gap: 0;
	}

	.who .button {
		border-radius: 0;
	}

	.who .button:first-child {
		border-radius: var(--radius) 0 0 var(--radius);
	}

	.who .button:last-child {
		border-radius: 0 var(--radius) var(--radius) 0;
		margin-left: -1px;
	}

	.who .button.active {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent);
		position: relative;
	}

	.banner {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--warning);
		border-radius: var(--radius-lg);
		background: var(--warning-soft);
		color: var(--warning);
		transition: filter var(--speed) var(--ease);
	}

	.banner:hover {
		text-decoration: none;
		filter: brightness(0.98);
	}

	.totals {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-6);
		margin: 0;
		padding: var(--space-3) 0;
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
	}

	.totals dt {
		font-size: 0.78rem;
		color: var(--text-muted);
	}

	.totals dd {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
		text-align: left;
	}

	.board {
		display: grid;
		grid-template-columns: repeat(6, minmax(250px, 1fr));
		gap: var(--space-3);
		overflow-x: auto;
		padding-bottom: var(--space-2);
	}

	.column {
		display: grid;
		align-content: start;
		gap: var(--space-2);
		min-width: 0;
	}

	.column header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-bottom: var(--space-1);
		border-bottom: 1px solid var(--hairline-strong);
	}

	.column-total {
		font-size: 0.78rem;
		text-align: left;
	}

	.cards {
		display: grid;
		gap: var(--space-2);
	}

	.empty {
		font-size: 0.85rem;
		padding: var(--space-2) 0;
	}

	/* On a phone, the columns stack. */
	@media (max-width: 760px) {
		.board {
			grid-template-columns: 1fr;
			overflow-x: visible;
		}
	}
</style>
