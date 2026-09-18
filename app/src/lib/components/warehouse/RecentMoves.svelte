<script lang="ts">
	// The last few rows of the stock ledger: what moved, which way, off which
	// shelf, against what paperwork, and who did it. The ERP's own loads have
	// no person against them, which is the honest answer, not a gap.
	import Blank from '$lib/components/ui/Blank.svelte';
	import { count, moment } from '$lib/format';
	import { MOVE_LABEL, type MoveRow } from './types';

	let { moves, transitCount }: { moves: MoveRow[]; transitCount: number } = $props();
</script>

<section class="panel" aria-labelledby="moves-title">
	<header class="panel-head">
		<h2 id="moves-title">Recent stock moves</h2>
		<span class="faint">Last {count(moves.length)} of the ledger</span>
	</header>

	{#if moves.length === 0}
		<p class="body muted">
			Nothing has moved in the last month. A receipt, a shipment, a count or a correction all land here.
		</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col">When</th>
						<th scope="col">What</th>
						<th scope="col">Item</th>
						<th scope="col">Where</th>
						<th scope="col" class="num">Qty</th>
						<th scope="col">Against</th>
						<th scope="col">Who</th>
					</tr>
				</thead>
				<tbody>
					{#each moves as m (m.id)}
						<tr>
							<td class="nowrap faint">{moment(m.movedAt)}</td>
							<td class="nowrap">
								<span class="chip" style:--tone="var(--move-{m.kind})">{MOVE_LABEL[m.kind]}</span>
								{#if m.reason}<span class="faint reason">{m.reason}</span>{/if}
							</td>
							<td>
								<a class="link mono" href="/warehouse?part={encodeURIComponent(m.itemNo)}">{m.itemNo}</a>
								<span class="faint desc">{m.description}</span>
							</td>
							<td class="nowrap">{m.locationCode}</td>
							<td class="num" class:down={m.quantity < 0}>
								{m.quantity > 0 ? '+' : ''}{count(m.quantity)}
							</td>
							<td class="mono nowrap faint">{#if m.reference}{m.reference}{:else}<Blank word="no reference" />{/if}</td>
							<td class="nowrap">{m.actorName ?? 'ERP'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}

	{#if transitCount > 0}
		<p class="body faint small">
			Stock on a truck between our own buildings still counts at the building it left, so nothing lands
			in the ledger until the transfer is received.
		</p>
	{/if}
</section>

<style>
	section {
		--move-receipt: var(--status-kept);
		--move-shipment: var(--status-quoted);
		--move-adjustment: var(--status-pushed);
		--move-transfer_out: var(--status-delivering);
		--move-transfer_in: var(--status-delivering);
		--move-count: var(--status-broken);
	}

	.body {
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.9rem;
	}

	.chip {
		background: color-mix(in srgb, var(--tone) 14%, transparent);
		color: color-mix(in srgb, var(--tone) 85%, var(--text));
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 28%, transparent);
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

	.down {
		color: var(--text-muted);
	}

	.reason {
		margin-left: 4px;
		font-size: 0.85rem;
	}

	.desc {
		display: block;
		font-size: 0.85rem;
		max-width: 240px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 720px) {
		.desc {
			display: none;
		}
	}
</style>
