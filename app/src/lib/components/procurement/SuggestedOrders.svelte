<script lang="ts">
	// The suggested orders. Each draft shows its lines with the quantity and
	// the date editable, what it adds up to, and one button that approves it.
	//
	// Approving raises the purchase order and queues the vendor email. That is
	// the only thing on this page that commits money, so it says exactly what
	// it is about to do and the database checks the row version again.
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { count, day, moment, money, moneyExact } from '$lib/format';
	import type { PurchaseRequest } from './types';

	let {
		requests,
		canBuy,
		today,
		lineRequestId,
		approveRequestId,
		lineMessage = null,
		approveMessage = null,
		year
	}: {
		requests: PurchaseRequest[];
		canBuy: boolean;
		today: string;
		lineRequestId: string;
		approveRequestId: string;
		lineMessage?: { text: string; failed: boolean; conflict: boolean } | null;
		approveMessage?: { text: string; failed: boolean; conflict: boolean } | null;
		year: number;
	} = $props();

	const drafts = $derived(requests.filter((r) => r.status === 'draft'));
	const approved = $derived(requests.filter((r) => r.status === 'approved'));

	// Which line is being saved, so only that row's button goes quiet.
	let savingLine = $state<number | null>(null);
	let approving = $state<number | null>(null);
</script>

<section class="panel" aria-labelledby="orders-title">
	<header class="panel-head">
		<h2 id="orders-title">Suggested orders</h2>
		<span class="faint">
			{#if drafts.length === 0}
				Nothing waiting
			{:else}
				{count(drafts.length)} waiting · {money(drafts.reduce((sum, r) => sum + r.subtotal, 0))}
			{/if}
		</span>
	</header>

	{#if approveMessage}
		<p class="body">
			<span
				class="notice"
				class:error={approveMessage.failed}
				role={approveMessage.failed ? 'alert' : 'status'}
			>
				<span>{approveMessage.text}</span>
				{#if approveMessage.conflict}
					<button class="button" type="button" onclick={() => invalidateAll()}>Reload</button>
				{/if}
			</span>
		</p>
	{/if}

	{#if drafts.length === 0}
		<p class="body muted">
			Nothing to approve. Draft an order from the list above and it will appear here, with every
			quantity and date still yours to change.
		</p>
	{/if}

	{#each drafts as draft (draft.id)}
		<!-- A fresh component per draft, so a half-typed quantity never carries over. -->
		{#key draft.updatedAt}
			<article class="draft" aria-labelledby="draft-{draft.id}">
				<header class="draft-head">
					<h3 id="draft-{draft.id}">
						<a class="link" href="/vendors/{draft.vendorNo}">{draft.vendorName}</a>
						<span class="faint mono">{draft.vendorNo}</span>
					</h3>
					<span class="num total">{money(draft.subtotal)}</span>
				</header>

				<p class="facts faint small">
					{#if draft.terms}{draft.terms}{/if}
					{#if draft.freightNote}· {draft.freightNote}{/if}
					{#if draft.neededBy}· earliest wanted {day(draft.neededBy, year)}{/if}
					· drafted by {draft.createdBy}
					{moment(draft.createdAt)}
				</p>

				{#if !draft.meetsMinimum && draft.minOrder !== null}
					<p class="warn-line">
						<TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
						<span>
							{money(draft.subtotal)} against a {money(draft.minOrder)} minimum order. Raising a
							quantity, or waiting for another part to come due, both work.
						</span>
					</p>
				{/if}

				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Item</th>
								<th class="num">Suggested</th>
								<th class="num">Quantity</th>
								<th>Wanted by</th>
								<th class="num">Unit</th>
								<th class="num">Line</th>
								<th>Why</th>
								{#if canBuy}<th><span class="sr-only">Save</span></th>{/if}
							</tr>
						</thead>
						<tbody>
							{#each draft.lines as line (line.id)}
								<tr>
									<td class="item">
										<a class="link mono" href="/parts/{line.itemNo}">{line.itemNo}</a>
										<span class="faint desc">{line.description}</span>
									</td>
									<td class="num faint">{count(line.suggestedQty)}</td>
									{#if canBuy}
										<td class="num">
											<form
												method="POST"
												action="?/line"
												class="edit"
												id="line-{line.id}"
												use:enhance={() => {
													savingLine = line.id;
													return async ({ update }) => {
														await update({ reset: false });
														savingLine = null;
													};
												}}
											>
												<input type="hidden" name="lineId" value={line.id} />
												<input type="hidden" name="expectedUpdatedAt" value={draft.updatedAt} />
												<input type="hidden" name="requestId" value="{lineRequestId}-{line.id}" />
												<input
													class="qty num"
													type="number"
													name="quantity"
													min="1"
													max="1000000"
													step="1"
													value={line.quantity}
													aria-label="Quantity of {line.itemNo}"
												/>
											</form>
										</td>
										<td>
											<input
												class="when"
												type="date"
												name="requestedOn"
												form="line-{line.id}"
												value={line.requestedOn}
												min={today}
												aria-label="Date wanted for {line.itemNo}"
											/>
										</td>
									{:else}
										<td class="num">{count(line.quantity)}</td>
										<td class="nowrap">{day(line.requestedOn, year)}</td>
									{/if}
									<td class="num">{moneyExact(line.unitCost)}</td>
									<td class="num">{money(line.lineTotal)}</td>
									<td class="why">
										{#if line.edited}<span class="chip">edited</span>{/if}
										<span class="faint reason">{line.reason}</span>
									</td>
									{#if canBuy}
										<td>
											<button
												class="button quiet"
												form="line-{line.id}"
												disabled={savingLine === line.id}
											>
												{savingLine === line.id ? 'Saving' : 'Save'}
											</button>
										</td>
									{/if}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				{#if lineMessage?.failed}
					<p class="body">
						<span class="notice error" role="alert">
							<span>{lineMessage.text}</span>
							{#if lineMessage.conflict}
								<button class="button" type="button" onclick={() => invalidateAll()}>Reload</button>
							{/if}
						</span>
					</p>
				{/if}

				<div class="approve">
					{#if !canBuy}
						<p class="muted">Only operations or an admin can approve an order.</p>
					{:else}
						<p class="live-note">
							<strong>Nothing is ordered until you approve it.</strong>
							Approving raises the purchase order and writes the vendor an email for you to read and
							send. The vendor is told the parts, the quantities, the dates, the prices we pay them and
							our terms, and nothing else.
						</p>
						<form
							method="POST"
							action="?/approve"
							use:enhance={() => {
								approving = draft.id;
								return async ({ update }) => {
									await update({ reset: false });
									approving = null;
								};
							}}
						>
							<input type="hidden" name="purchaseRequestId" value={draft.id} />
							<input type="hidden" name="expectedUpdatedAt" value={draft.updatedAt} />
							<input type="hidden" name="requestId" value="{approveRequestId}-{draft.id}" />
							<button class="button primary" disabled={approving === draft.id}>
								Approve {money(draft.subtotal)} to {draft.vendorName}
							</button>
						</form>
					{/if}
				</div>
			</article>
		{/key}
	{/each}

	{#if approved.length > 0}
		<div class="done">
			<h3>Raised</h3>
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Order</th>
							<th>Vendor</th>
							<th class="num">Lines</th>
							<th class="num">Value</th>
							<th>Approved</th>
							<th>Forecast</th>
						</tr>
					</thead>
					<tbody>
						{#each approved as order (order.id)}
							<tr>
								<td class="mono nowrap">{order.orderNo ?? '·'}</td>
								<td>
									<a class="link" href="/vendors/{order.vendorNo}">{order.vendorName}</a>
								</td>
								<td class="num">{count(order.lines.length)}</td>
								<td class="num">{money(order.subtotal)}</td>
								<td class="nowrap">
									{order.decidedBy}
									<span class="faint">{order.decidedAt ? moment(order.decidedAt) : ''}</span>
								</td>
								<td>
									{#if order.mirrored}
										<span class="chip">in the supply forecast</span>
									{:else}
										<span class="chip" title="The supply forecast reads this desk's own orders">
											on this desk
										</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</section>

<style>
	.body,
	.facts,
	.warn-line,
	.approve {
		padding: 8px var(--space-3);
	}

	.small {
		font-size: 0.92rem;
	}

	.draft {
		border-top: 1px solid var(--hairline);
	}

	.draft-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: 8px var(--space-3) 0;
	}

	.draft-head h3 {
		margin: 0;
	}

	.total {
		font-size: 1.05rem;
		font-weight: 600;
	}

	.facts {
		padding-top: 0;
	}

	.warn-line {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding-top: 0;
		font-size: 0.92rem;
		color: var(--warning);
	}

	.warn-line :global(svg) {
		flex: none;
		margin-top: 2px;
	}

	.table-wrap {
		overflow-x: auto;
	}

	.item {
		min-width: 150px;
	}

	.desc {
		display: block;
		font-size: 0.85rem;
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* The two editable fields sit in the table without making the row taller. */
	.edit {
		display: contents;
	}

	.qty {
		width: 78px;
		height: 24px;
		padding: 0 6px;
		text-align: right;
	}

	.when {
		height: 24px;
		padding: 0 6px;
	}

	.why {
		min-width: 220px;
	}

	.reason {
		display: block;
		font-size: 0.85rem;
	}

	.nowrap {
		white-space: nowrap;
	}

	.approve {
		display: grid;
		gap: var(--space-2);
		justify-items: start;
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}

	.live-note {
		max-width: 80ch;
		font-size: 0.92rem;
		color: var(--text-muted);
	}

	.live-note strong {
		color: var(--text);
	}

	.done {
		border-top: 1px solid var(--hairline);
	}

	.done h3 {
		padding: 8px var(--space-3);
		color: var(--text-muted);
	}

	@media (max-width: 720px) {
		.desc {
			max-width: 130px;
		}
	}
</style>
