<script lang="ts">
	// Explain this number.
	//
	// The item master says a part has so many on hand. This panel shows where
	// that figure comes from: the balance it had 90 days ago, every move
	// since, and the closing figure, which has to be the same number. If it is
	// not, the panel says so rather than hiding it, because a stock figure
	// nobody can explain is worse than one that is visibly wrong.
	import Blank from '$lib/components/ui/Blank.svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Equal from '@lucide/svelte/icons/equal';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { count, day, moment } from '$lib/format';
	import { ADJUSTMENT_REASONS, MOVE_LABEL, type PartLedger } from './types';

	let {
		ledger,
		year,
		canRun,
		requestId,
		message
	}: {
		ledger: PartLedger;
		year: number;
		canRun: boolean;
		requestId: string;
		message: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	let correcting = $state('');
	let busy = $state(false);

	const submitting: SubmitFunction = () => {
		busy = true;
		return async ({ update, result }) => {
			await update();
			busy = false;
			if (result.type === 'success') correcting = '';
		};
	};
</script>

<section class="panel" aria-labelledby="ledger-title">
	<header class="panel-head">
		<h2 id="ledger-title">
			Where <span class="mono">{ledger.itemNo}</span> came from
		</h2>
		<a class="link" href="/parts/{encodeURIComponent(ledger.itemNo)}">Part page</a>
	</header>

	<p class="body faint">{ledger.description}</p>

	{#if message}
		<p class="body notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
			{message.text}
		</p>
	{/if}

	<!-- The one sentence the whole panel exists to say. -->
	<div class="sum" class:off={!ledger.agrees}>
		<div class="term">
			<span class="label">Opening{#if ledger.openedOn} {day(ledger.openedOn, year)}{/if}</span>
			<span class="value num">{count(ledger.opening)}</span>
		</div>
		<span class="op" aria-hidden="true">+</span>
		<div class="term">
			<span class="label">
				{count(ledger.moveCount)} {ledger.moveCount === 1 ? 'move' : 'moves'} since
			</span>
			<span class="value num">{ledger.moved > 0 ? '+' : ''}{count(ledger.moved)}</span>
		</div>
		<span class="op" aria-hidden="true"><Equal size={14} strokeWidth={2} /></span>
		<div class="term">
			<span class="label">Ledger closing</span>
			<span class="value num strong">{count(ledger.closing)}</span>
		</div>
		<div class="term">
			<span class="label">Item master on hand</span>
			<span class="value num strong">{count(ledger.onHand)}</span>
		</div>
		<div class="verdict">
			{#if ledger.agrees}
				<span class="agrees">The ledger and the item master agree.</span>
			{:else}
				<span class="disagrees">
					<TriangleAlert size={13} strokeWidth={2} aria-hidden="true" />
					These do not agree. Operations has been told and is putting it right.
				</span>
			{/if}
		</div>
	</div>

	<dl class="kinds">
		{#each ledger.byKind as k (k.kind)}
			<div>
				<dt>{MOVE_LABEL[k.kind]}</dt>
				<dd>
					<span class="num">{k.quantity > 0 ? '+' : ''}{count(k.quantity)}</span>
					<span class="faint small">on {count(k.moves)}</span>
				</dd>
			</div>
		{/each}
		<div>
			<dt>Claimed by open orders</dt>
			<dd>
				<span class="num">{count(ledger.allocated)}</span>
				<span class="faint small">leaves {count(ledger.available)}</span>
			</dd>
		</div>
	</dl>

	<h3 class="sub">On the shelf</h3>
	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th scope="col">Where</th>
					<th scope="col">Zone</th>
					<th scope="col">Bin</th>
					<th scope="col" class="num">Qty</th>
					<th scope="col">Last counted</th>
					{#if canRun}<th scope="col"></th>{/if}
				</tr>
			</thead>
			<tbody>
				{#each ledger.bins as b (b.locationCode)}
					<tr>
						<td class="nowrap">{b.locationCode} <span class="faint">{b.locationName}</span></td>
						<td class="nowrap">{#if b.zone}{b.zone}{:else}<Blank word="no zone" />{/if}</td>
						<td class="mono nowrap">{#if b.bin}{b.bin}{:else}<Blank word="no bin" />{/if}</td>
						<td class="num">{count(b.quantity)}</td>
						<td class="nowrap faint">{b.countedOn ? day(b.countedOn, year) : 'never'}</td>
						{#if canRun}
							<td class="right">
								<button
									class="button quiet small"
									aria-expanded={correcting === b.locationCode}
									onclick={() => (correcting = correcting === b.locationCode ? '' : b.locationCode)}
								>
									Correct
								</button>
							</td>
						{/if}
					</tr>
					{#if canRun && correcting === b.locationCode}
						<tr class="editor-row">
							<td colspan="6">
								<form method="POST" action="?/adjust" class="editor" use:enhance={submitting}>
									<input type="hidden" name="itemNo" value={ledger.itemNo} />
									<input type="hidden" name="locationCode" value={b.locationCode} />
									<input type="hidden" name="expectedUpdatedAt" value={b.updatedAt} />
									<input type="hidden" name="requestId" value="{requestId}-{b.locationCode}" />
									<label>
										<span>Up or down by</span>
										<input
											type="number"
											name="quantity"
											required
											step="1"
											min={-b.quantity}
											placeholder="-2"
											size="6"
										/>
									</label>
									<label>
										<span>Reason</span>
										<select name="reason">
											{#each ADJUSTMENT_REASONS as reason (reason)}
												<option value={reason}>{reason}</option>
											{/each}
										</select>
									</label>
									<label class="wide">
										<span>What happened</span>
										<input name="note" maxlength="500" placeholder="Forklift caught the end of the bundle." />
									</label>
									<div class="row-end">
										<button class="button quiet" type="button" onclick={() => (correcting = '')}>Cancel</button>
										<button class="button primary" disabled={busy}>Post the correction</button>
									</div>
								</form>
							</td>
						</tr>
					{/if}
				{:else}
					<tr>
						<td colspan={canRun ? 6 : 5} class="muted">
							This part has no bin anywhere. Nothing is stocked and nothing has moved.
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>

	<h3 class="sub">Every move since {ledger.openedOn ? day(ledger.openedOn, year) : 'the start'}</h3>
	{#if ledger.moves.length === 0}
		<p class="body muted">Nothing has moved. The opening balance is still sitting there.</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">When</th>
						<th scope="col">What</th>
						<th scope="col">Where</th>
						<th scope="col" class="num">Qty</th>
						<th scope="col">Against</th>
						<th scope="col">Who</th>
					</tr>
				</thead>
				<tbody>
					{#each ledger.moves as m (m.id)}
						<tr>
							<td class="nowrap faint">{moment(m.movedAt)}</td>
							<td class="nowrap">
								<span class="chip">{MOVE_LABEL[m.kind]}</span>
								{#if m.reason}<span class="faint reason">{m.reason}</span>{/if}
							</td>
							<td class="nowrap">{m.locationCode}</td>
							<td class="num">{m.quantity > 0 ? '+' : ''}{count(m.quantity)}</td>
							<td class="mono nowrap faint">{#if m.reference}{m.reference}{:else}<Blank word="no reference" />{/if}</td>
							<td class="nowrap">{m.actorName ?? 'ERP'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if ledger.moveCount > ledger.moves.length}
			<p class="body faint small">
				Showing the {count(ledger.moves.length)} newest of {count(ledger.moveCount)}. The opening balance and
				the closing figure above count all of them.
			</p>
		{/if}
	{/if}
</section>

<style>
	.body {
		margin: 0;
		padding: 8px var(--space-3);
	}

	.small {
		font-size: 0.9rem;
	}

	.sub {
		margin: 0;
		padding: 8px var(--space-3);
		font-size: 0.85rem;
		font-weight: 500;
		color: var(--text-muted);
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}

	/* The arithmetic, laid out as arithmetic. Flexbox, so it wraps on a
	   phone instead of scrolling sideways. */
	.sum {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding: 10px var(--space-3);
		border-top: 1px solid var(--hairline);
		border-bottom: 1px solid var(--hairline);
	}

	.term {
		display: grid;
		gap: 1px;
	}

	.term .label {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.term .value {
		font-size: 1.1rem;
		font-weight: 600;
	}

	.term .value.strong {
		font-size: 1.3rem;
		letter-spacing: -0.015em;
	}

	.op {
		display: flex;
		align-items: center;
		color: var(--text-faint);
		font-size: 1.1rem;
	}

	.verdict {
		flex-basis: 100%;
		font-size: 0.9rem;
	}

	.agrees {
		color: var(--status-kept);
	}

	.disagrees {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--danger);
	}

	.sum.off {
		background: var(--danger-soft);
	}

	.kinds {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
	}

	.kinds div {
		flex: 1 1 120px;
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
		margin: 2px 0 0;
		font-weight: 600;
	}

	.table-wrap {
		overflow-x: auto;
		max-height: 420px;
		overflow-y: auto;
	}

	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
		z-index: 1;
	}

	.nowrap {
		white-space: nowrap;
	}

	.right {
		text-align: right;
	}

	.button.small {
		height: 22px;
		padding: 0 8px;
		font-size: 0.88rem;
	}

	.editor-row td {
		padding: 0;
		background: var(--surface-sunken);
	}

	.editor {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.editor label.wide {
		flex: 1 1 220px;
	}

	.row-end {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}

	.reason {
		margin-left: 4px;
		font-size: 0.85rem;
	}

	@media (max-width: 720px) {
		.kinds div + div {
			border-left: 0;
		}
	}
</style>
