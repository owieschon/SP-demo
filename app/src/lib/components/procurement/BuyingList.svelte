<script lang="ts">
	// What needs buying, grouped by the vendor it would be bought from, worst
	// first. Each group says what it adds up to, what it puts at risk, and
	// whether it clears that vendor's minimum order and free-freight
	// threshold. Each row says why it is there, in words.
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { count, day, money } from '$lib/format';
	import type { DemandShape, ProcurementDesk, VendorGroup } from './types';

	let {
		desk,
		canBuy,
		draftRequestId,
		year
	}: {
		desk: ProcurementDesk;
		canBuy: boolean;
		draftRequestId: string;
		year: number;
	} = $props();

	const SHAPE_HINT: Record<DemandShape, string> = {
		none: 'Nothing sold in a year, so the target is the level the item card asks for',
		steady: 'Sells at much the same rate every month',
		lumpy: 'Uneven month to month, so the rate is a rough guide',
		erratic: 'So uneven that the rate is an average of nothing'
	};

	// Which groups are open. The first three start open, because a page that
	// needs three clicks before it says anything is a worse page.
	let opened = $state(new Set<string>());
	$effect(() => {
		opened = new Set(desk.groups.slice(0, 3).map((g) => g.vendorNo ?? g.kind));
	});

	const groupKey = (group: VendorGroup) => group.vendorNo ?? group.kind;

	function toggle(group: VendorGroup) {
		const key = groupKey(group);
		const next = new Set(opened);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		opened = next;
	}

	const isOpen = (group: VendorGroup) => opened.has(groupKey(group));
</script>

<section class="panel" aria-labelledby="buying-title">
	<header class="panel-head">
		<h2 id="buying-title">What needs buying</h2>
		<span class="faint">
			{#if desk.totals.parts === 0}
				Nothing is under its reorder point
			{:else}
				{count(desk.totals.parts)}
				{desk.totals.parts === 1 ? 'part' : 'parts'} ·
				{count(desk.totals.vendors)}
				{desk.totals.vendors === 1 ? 'vendor' : 'vendors'} ·
				{money(desk.totals.subtotal)}
			{/if}
		</span>
	</header>

	{#if desk.totals.parts === 0}
		<p class="body muted">
			Every stocked part covers what it is promised for through its own lead time. The list is worked out
			fresh on every load, so it will fill up on its own.
		</p>
	{:else}
		<p class="body faint small">
			A part is here when its stock, minus what open sales lines promise inside its lead time, plus what
			is already on order, falls under the level its item card asks for. The suggestion covers the lead
			time plus {desk.coverDays} days, less what is already coming.
			{#if desk.totals.itemCardIncomplete > 0}
				<strong>
					{count(desk.totals.itemCardIncomplete)}
					{desk.totals.itemCardIncomplete === 1 ? 'part' : 'parts'} cannot be ordered at all: no vendor
					or no cost on the item card.</strong
				>
			{/if}
			{#if desk.totals.madeHere > 0}
				{count(desk.totals.madeHere)}
				{desk.totals.madeHere === 1 ? 'part is' : 'parts are'} made here and want a production order
				rather than a purchase order.
			{/if}
			{#if !desk.sources.openPurchaseLines}
				Purchase orders already placed come from the item master, which carries no dates, so they all
				count as arriving inside the horizon.
			{/if}
		</p>

		{#each desk.groups as group (group.vendorNo ?? group.kind)}
			{@const open = isOpen(group)}
			<div class="group" class:orphan={group.kind === 'orphan'}>
				<h3>
					<button
						class="head pressable"
						type="button"
						aria-expanded={open}
						aria-controls="group-{group.vendorNo ?? group.kind}"
						onclick={() => toggle(group)}
					>
						<ChevronRight size={14} strokeWidth={2} class="caret" aria-hidden="true" />
						<span class="name">
							{#if group.vendorNo}
								{group.vendorName}
								<span class="faint mono">{group.vendorNo}</span>
							{:else}
								{group.vendorName}
							{/if}
						</span>
						<span class="figures">
							<span class="num">{count(group.lines.length)}</span>
							<span class="faint">{group.lines.length === 1 ? 'part' : 'parts'}</span>
							<span class="num strong">{money(group.subtotal)}</span>
							{#if group.valueAtRisk > 0}
								<span class="chip warn" title="Open sales lines for these parts that cannot ship">
									{money(group.valueAtRisk)} cannot ship
								</span>
							{:else if group.revenue90d > 0}
								<span class="chip" title="What these parts sold in the last 90 days">
									{money(group.revenue90d)} in 90 days
								</span>
							{/if}
						</span>
					</button>
				</h3>

				<div class="notes">
					{#if group.kind === 'orphan'}
						<p class="warn-line">
							<TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
							<span>
								These are bought in and there is nobody to buy them from, or no cost to buy them at.
								Put a vendor and a cost on each item card and they will join a real order.
							</span>
						</p>
					{:else if group.kind === 'made'}
						<p class="faint small">
							We make these, so they want a production order rather than a purchase order. The
							quantities and the dates are the same arithmetic; the order goes to the plant.
						</p>
					{:else}
						<p class="faint small">
							{#if group.terms}{group.terms}{/if}
							{#if group.freightTerms}· {group.freightTerms}{/if}
							{#if group.neededBy}· earliest wanted {day(group.neededBy, year)}{/if}
						</p>
						{#if !group.meetsMinimum && group.minOrder !== null}
							<p class="warn-line">
								<TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
								<span>
									{money(group.subtotal)} against a {money(group.minOrder)} minimum order:
									{money(group.minOrder - group.subtotal)} short. Add parts from this vendor, or wait.
								</span>
							</p>
						{:else if !group.clearsFreight && group.freeFreightAt !== null}
							<p class="warn-line">
								<TriangleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
								<span>
									{money(group.freeFreightAt - group.subtotal)} short of free freight at
									{money(group.freeFreightAt)}.
								</span>
							</p>
						{/if}
						{#if group.hasDraft}
							<p class="faint small">A draft for this vendor is already waiting below.</p>
						{/if}
					{/if}
				</div>

				{#if open}
					<div class="table-wrap" id="group-{group.vendorNo ?? group.kind}">
						<table>
							<thead>
								<tr>
									<th>Item</th>
									<th class="num">On hand</th>
									<th class="num">Promised</th>
									<th class="num">On order</th>
									<th class="num">Projected</th>
									<th class="num">Policy</th>
									<th class="num">{group.kind === 'made' ? 'Make' : 'Buy'}</th>
									<th class="num">Cost</th>
									<th>Wanted by</th>
									<th>Why</th>
								</tr>
							</thead>
							<tbody>
								{#each group.lines as line (line.itemNo)}
									<tr>
										<td class="item">
											<a class="link mono" href="/parts/{line.itemNo}">{line.itemNo}</a>
											<span class="faint desc">{line.description}</span>
										</td>
										<td class="num">{count(line.onHand)}</td>
										<td class="num" class:late={line.promisedPastDue > 0}>
											{line.promisedBeforeHorizon > 0 ? count(line.promisedBeforeHorizon) : '·'}
										</td>
										<td class="num">{line.onOrderTotal > 0 ? count(line.onOrderTotal) : '·'}</td>
										<td class="num" class:short={line.projectedAvailable < 0}>
											{count(line.projectedAvailable)}
										</td>
										<td class="num faint">{line.policyLevel === null ? '·' : count(line.policyLevel)}</td>
										<td class="num strong">{count(line.suggestedQty)}</td>
										<td class="num">{money(line.suggestedCost)}</td>
										<td class="nowrap" class:late={line.orderByOn !== null && line.orderByOn < desk.today}>
											{day(line.requestedOn, year)}
										</td>
										<td class="why">
											<span class="trigger {line.triggerReason === 'promised more than we will have'
												? 'oversold'
												: 'policy'}">{line.triggerReason}</span>
											<span class="faint reason">{line.reason}</span>
											<span class="faint shape" title={SHAPE_HINT[line.demandShape]}>
												{line.demandShape} demand · pack of {line.pack} · {line.leadTimeFormula ||
													'no lead time on the card'}
											</span>
										</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
				{/if}

				{#if canBuy && group.vendorNo && !group.hasDraft}
					<form method="POST" action="?/draft" class="draft-one">
						<input type="hidden" name="vendorNo" value={group.vendorNo} />
						<input type="hidden" name="requestId" value="{draftRequestId}-{group.vendorNo}" />
						<button class="button">Draft this order</button>
					</form>
				{/if}
			</div>
		{/each}
	{/if}
</section>

<style>
	.body {
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.92rem;
	}

	.group + .group {
		border-top: 1px solid var(--hairline);
	}

	.group h3 {
		margin: 0;
	}

	/* The whole row is the toggle, so there is nothing small to aim at. */
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		padding: 8px var(--space-3);
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.head:hover {
		background: var(--surface-hover);
	}

	.head :global(.caret) {
		flex: none;
		color: var(--text-faint);
		transition: transform var(--speed-slow) var(--ease);
	}

	.head[aria-expanded='true'] :global(.caret) {
		transform: rotate(90deg);
	}

	.name {
		font-weight: 600;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.figures {
		margin-left: auto;
		display: flex;
		align-items: center;
		gap: 6px;
		flex: none;
	}

	.strong {
		font-weight: 600;
	}

	.notes {
		display: grid;
		gap: 2px;
		padding: 0 var(--space-3) 8px 34px;
	}

	.warn-line {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		font-size: 0.92rem;
		color: var(--warning);
	}

	.warn-line :global(svg) {
		flex: none;
		margin-top: 2px;
	}

	.orphan .warn-line {
		color: var(--danger);
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
		max-width: 220px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.why {
		min-width: 260px;
	}

	.trigger {
		font-weight: 500;
	}

	.trigger.oversold {
		color: var(--danger);
	}

	.reason,
	.shape {
		display: block;
		font-size: 0.85rem;
	}

	.short {
		color: var(--danger);
	}

	.late {
		color: var(--warning);
	}

	.nowrap {
		white-space: nowrap;
	}

	.draft-one {
		padding: 0 var(--space-3) 10px 34px;
	}

	@media (max-width: 720px) {
		.figures {
			flex-wrap: wrap;
			justify-content: flex-end;
		}

		.notes,
		.draft-one {
			padding-left: var(--space-3);
		}

		.desc {
			max-width: 140px;
		}
	}
</style>
