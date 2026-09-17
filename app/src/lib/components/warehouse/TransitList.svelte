<script lang="ts">
	// Transfers on the road. There is no button here on purpose: booking one
	// in is a receiving-dock job with the paperwork in hand, and the write
	// function (nl.receive_transfer) is what the receiving screen will call.
	import { count, day } from '$lib/format';
	import type { TransitTransfer } from './types';

	let { transfers, year }: { transfers: TransitTransfer[]; year: number } = $props();
</script>

<section class="panel" aria-labelledby="transit-title">
	<header class="panel-head">
		<h2 id="transit-title">In transit</h2>
		<span class="faint num">{count(transfers.length)}</span>
	</header>

	{#if transfers.length === 0}
		<p class="body muted">Nothing on the road between our buildings.</p>
	{:else}
		<ul class="list">
			{#each transfers as t (t.transferNo)}
				<li class="row" class:late={t.late}>
					<div class="what">
						<span class="title">
							<span class="mono">{t.transferNo}</span>
							{t.fromLocation} to {t.toLocation}
						</span>
						<span class="muted small">
							Sent {day(t.sentOn, year)} · expected {day(t.expectedOn, year)}
							{#if t.late}<span class="overdue">overdue</span>{/if}
							{#if t.sentBy}· by {t.sentBy}{/if}
						</span>
						{#if t.note}<span class="faint small">{t.note}</span>{/if}
					</div>
					<span class="faint small nowrap">
						{count(t.lines)} {t.lines === 1 ? 'line' : 'lines'} · {count(t.pieces)} pcs
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.body {
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.9rem;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.row {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 8px var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.row + .row {
		border-top: 1px solid var(--hairline);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row.late {
		box-shadow: inset 2px 0 0 var(--status-pushed);
	}

	.what {
		display: grid;
		gap: 1px;
		min-width: 0;
	}

	.title {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		font-weight: 500;
	}

	.overdue {
		margin-left: 4px;
		color: var(--warning);
	}

	.nowrap {
		white-space: nowrap;
	}
</style>
