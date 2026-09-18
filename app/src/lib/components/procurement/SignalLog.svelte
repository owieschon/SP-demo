<script lang="ts">
	// What woke the desk, and when.
	//
	// This is a log, not a queue. A signal is recorded the first time somebody
	// is told about a subject and never a second time, which is the same
	// discipline the automation rules use (a unique key on the pair, enforced
	// by the database). What needs buying TODAY is the list above, worked out
	// fresh on every load.
	import { count, moment, money } from '$lib/format';
	import { SIGNAL_HINT, SIGNAL_LABEL, type SignalKind, type SignalRow } from './types';

	let {
		signals,
		openCount,
		canBuy,
		sweepRequestId,
		message = null
	}: {
		signals: SignalRow[];
		openCount: number;
		canBuy: boolean;
		sweepRequestId: string;
		message?: { text: string; failed: boolean } | null;
	} = $props();

	let show = $state<'open' | 'all'>('open');
	const shown = $derived(show === 'open' ? signals.filter((s) => s.clearedAt === null) : signals);

	// How many of each kind are still open, for the row of counts.
	const byKind = $derived.by(() => {
		const counted = new Map<SignalKind, number>();
		for (const signal of signals) {
			if (signal.clearedAt !== null) continue;
			counted.set(signal.signal, (counted.get(signal.signal) ?? 0) + 1);
		}
		return [...counted.entries()].sort((a, b) => b[1] - a[1]);
	});
</script>

<section class="panel" aria-labelledby="signals-title">
	<header class="panel-head">
		<h2 id="signals-title">Signals</h2>
		<div class="tools">
			<div class="segmented" role="group" aria-label="Which signals">
				<button type="button" aria-pressed={show === 'open'} onclick={() => (show = 'open')}>
					Open {count(openCount)}
				</button>
				<button type="button" aria-pressed={show === 'all'} onclick={() => (show = 'all')}>
					All
				</button>
			</div>
			{#if canBuy}
				<form method="POST" action="?/sweep">
					<input type="hidden" name="requestId" value={sweepRequestId} />
					<button class="button">Look for anything new</button>
				</form>
			{/if}
		</div>
	</header>

	{#if message}
		<p class="body">
			<span class="notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
				{message.text}
			</span>
		</p>
	{/if}

	{#if byKind.length > 0}
		<dl class="kinds">
			{#each byKind as [kind, n] (kind)}
				<div>
					<dt>{SIGNAL_LABEL[kind]}</dt>
					<dd class="num">{count(n)}</dd>
					<dd class="faint hint">{SIGNAL_HINT[kind]}</dd>
				</div>
			{/each}
		</dl>
	{/if}

	{#if shown.length === 0}
		<p class="body muted">
			{#if signals.length === 0}
				Nothing recorded yet.
				{#if canBuy}
					Look for anything new and the desk will write down what it finds.
				{/if}
			{:else}
				Every signal has been cleared. Switch to All to read the history.
			{/if}
		</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Signal</th>
						<th>What</th>
						<th class="num">At stake</th>
						<th>First noticed</th>
					</tr>
				</thead>
				<tbody>
					{#each shown as signal (signal.id)}
						<tr class:cleared={signal.clearedAt !== null}>
							<td class="nowrap">
								<span class="chip" class:warn={signal.clearedAt === null}>
									{SIGNAL_LABEL[signal.signal]}
								</span>
							</td>
							<td class="what">
								{#if signal.itemNo}
									<a class="link mono" href="/parts/{signal.itemNo}">{signal.itemNo}</a>
								{:else if signal.vendorNo}
									<a class="link" href="/vendors/{signal.vendorNo}">
										{signal.vendorName ?? signal.vendorNo}
									</a>
								{/if}
								<span class="headline">{signal.headline}</span>
							</td>
							<td class="num">{signal.valueAtRisk > 0 ? money(signal.valueAtRisk) : '·'}</td>
							<td class="nowrap faint">
								{moment(signal.raisedAt)}
								{#if signal.clearedAt !== null}
									<span class="chip">cleared</span>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<p class="body faint small">
			A signal is written down the first time the desk is told about something and never a second
			time, so this reads as a history. It is cleared when the thing it was about is no longer true.
		</p>
	{/if}
</section>

<style>
	.body {
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.92rem;
	}

	.tools {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.tools form {
		margin: 0;
	}

	.kinds {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
		border-bottom: 1px solid var(--hairline);
	}

	.kinds div {
		flex: 1 1 180px;
		display: grid;
		gap: 1px;
		align-content: start;
		padding: 8px var(--space-3);
	}

	.kinds div + div {
		border-left: 1px solid var(--hairline);
	}

	.kinds dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.kinds dd {
		margin: 0;
		text-align: left;
	}

	.kinds dd.num {
		font-size: 1.2rem;
		font-weight: 600;
	}

	.hint {
		font-size: 0.85rem;
	}

	.table-wrap {
		overflow-x: auto;
		max-height: 420px;
		overflow-y: auto;
	}

	/* Column headings stay put while the rows scroll. */
	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
		z-index: 1;
	}

	.what {
		min-width: 260px;
	}

	.headline {
		display: block;
		font-size: 0.92rem;
	}

	.nowrap {
		white-space: nowrap;
	}

	tr.cleared {
		color: var(--text-muted);
	}

	@media (max-width: 720px) {
		.kinds div {
			flex-basis: 45%;
		}

		.kinds div + div {
			border-left: 0;
		}

		.tools {
			flex-wrap: wrap;
			justify-content: flex-end;
		}
	}
</style>
