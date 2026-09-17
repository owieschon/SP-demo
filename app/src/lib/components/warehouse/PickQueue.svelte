<script lang="ts">
	// The pick queue: shipments still on the floor, oldest promised date
	// first, each with its lines in bin order so a picker walks the aisle
	// once. The button moves the shipment one step along and carries the row
	// version, so two people cannot both succeed on the same shipment.
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { count, day, moment } from '$lib/format';
	import {
		ADVANCE_LABEL,
		NEXT_SHIPMENT_STATUS,
		SHIPMENT_STATUS_LABEL,
		type PickShipment
	} from './types';

	let {
		shipments,
		total,
		today,
		year,
		canRun,
		requestId,
		message
	}: {
		shipments: PickShipment[];
		total: number;
		/** Today as 'YYYY-MM-DD', so a promised date in the past can be marked. */
		today: string;
		year: number;
		canRun: boolean;
		requestId: string;
		message: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	let busy = $state('');

	const submitting: SubmitFunction = ({ formData }) => {
		busy = String(formData.get('shipmentNo') ?? '');
		return async ({ update }) => {
			await update();
			busy = '';
		};
	};
</script>

<section class="panel" aria-labelledby="pick-title">
	<header class="panel-head">
		<h2 id="pick-title">Pick queue</h2>
		<span class="faint num">
			{#if total > shipments.length}{shipments.length} of {count(total)}{:else}{count(total)}{/if}
		</span>
	</header>

	{#if message}
		<p class="body notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
			{message.text}
		</p>
	{/if}

	{#if shipments.length === 0}
		<p class="body muted">
			Nothing waiting. New shipments appear here as soon as an order is released to the floor.
		</p>
	{:else}
		<ul class="list">
			{#each shipments as s (s.shipmentNo)}
				{@const next = NEXT_SHIPMENT_STATUS[s.status]}
				<li class="job" class:late={s.promisedOn !== null && s.promisedOn < today}>
					<div class="head">
						<div class="who">
							<span class="title">
								<span class="mono">{s.shipmentNo}</span>
								<a class="link" href="/accounts/{s.customerNo}">{s.customerName}</a>
							</span>
							<span class="muted small">
								{SHIPMENT_STATUS_LABEL[s.status]} · {s.locationCode} · {s.carrier}
								{#if s.promisedOn}
									· promised {day(s.promisedOn, year)}
									{#if s.promisedOn < today}<span class="overdue">past due</span>{/if}
								{/if}
								{#if s.packedBy}· packed by {s.packedBy}{/if}
								{#if s.packedAt}<span class="faint">{moment(s.packedAt)}</span>{/if}
							</span>
						</div>
						<div class="act">
							<span class="faint small nowrap">{count(s.pieces)} pcs</span>
							{#if canRun && next}
								<form method="POST" action="?/advance" use:enhance={submitting}>
									<input type="hidden" name="shipmentNo" value={s.shipmentNo} />
									<input type="hidden" name="toStatus" value={next} />
									<input type="hidden" name="expectedUpdatedAt" value={s.updatedAt} />
									<input type="hidden" name="requestId" value="{requestId}-{s.shipmentNo}" />
									<button class="button" disabled={busy === s.shipmentNo}>
										{ADVANCE_LABEL[s.status]}
										<ArrowRight size={12} strokeWidth={2} aria-hidden="true" />
									</button>
								</form>
							{/if}
						</div>
					</div>

					{#if s.lines.length > 0}
						<div class="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Bin</th>
										<th>Item</th>
										<th class="num">Qty</th>
										<th>Order</th>
									</tr>
								</thead>
								<tbody>
									{#each s.lines as l (l.lineNo)}
										<tr>
											<td class="mono nowrap">{l.bin || '·'}</td>
											<td>
												<a class="link mono" href="/parts/{encodeURIComponent(l.itemNo)}">{l.itemNo}</a>
												<span class="faint desc">{l.description}</span>
											</td>
											<td class="num">{count(l.quantity)}</td>
											<td class="mono nowrap faint">
												{l.documentNo}{#if l.orderLineNo}/{l.orderLineNo}{/if}
											</td>
										</tr>
									{/each}
								</tbody>
							</table>
						</div>
					{/if}

					{#if s.note}<p class="note muted">{s.note}</p>{/if}
				</li>
			{/each}
		</ul>
	{/if}

	{#if !canRun && shipments.length > 0}
		<p class="body faint small">
			Read only: operations and admins move a shipment along.
		</p>
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

	.job + .job {
		border-top: 1px solid var(--hairline);
	}

	/* A shipment past its promised date carries a thin amber edge. */
	.job.late {
		box-shadow: inset 2px 0 0 var(--status-pushed);
	}

	.head {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 8px var(--space-3);
	}

	.who {
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

	.act {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex: none;
	}

	.act form {
		margin: 0;
	}

	.overdue {
		margin-left: 4px;
		color: var(--warning);
	}

	.table-wrap {
		overflow-x: auto;
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}

	.nowrap {
		white-space: nowrap;
	}

	.desc {
		display: block;
		font-size: 0.85rem;
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.note {
		margin: 0;
		padding: 6px var(--space-3);
		font-size: 0.9rem;
		border-top: 1px solid var(--hairline);
	}

	@media (max-width: 720px) {
		.head {
			flex-wrap: wrap;
		}

		.act {
			width: 100%;
			justify-content: space-between;
		}

		.desc {
			max-width: 160px;
		}
	}
</style>
