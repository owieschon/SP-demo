<script lang="ts">
	import { count, day, money, percent } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The load board's colour follows the state the view worked out, so the
	// page never decides what "over" means on its own.
	function stateClass(state: string): string {
		if (state === 'over') return 'over';
		if (state === 'tight') return 'tight';
		return '';
	}

	// A bar that can go past its track, because a cell can be booked past
	// its capacity and pretending otherwise hides the problem.
	function barWidth(ratio: number | null): string {
		if (ratio === null) return '0%';
		return `${Math.min(100, Math.round(ratio * 100))}%`;
	}
</script>

<svelte:head>
	<title>Plant · Northline</title>
</svelte:head>

<main class="page">
	<header class="page-head">
		<div class="titles">
			<h1>Plant</h1>
			<p class="faint">
				Hours of work in front of each cell against the hours it can sell, orders that are short
				traced down to the part actually missing, and shipments whose document package is not
				complete yet.
			</p>
		</div>
	</header>

	{#await data.board}
		<div class="panel" aria-busy="true">
			<div class="panel-head"><h2>Work centre load</h2></div>
			<div class="panel-body">
				<div class="skeleton" style="height: 120px"></div>
			</div>
		</div>
	{:then board}
		<section class="panel">
			<div class="panel-head">
				<h2>Work centre load, next four weeks</h2>
				<span class="chip">{board.load.length} cells</span>
			</div>
			<div class="table-wrap" tabindex="-1">
				<table>
					<thead>
						<tr>
							<th scope="col">Cell</th>
							<th scope="col">Department</th>
							<th scope="col" class="num">Orders</th>
							<th scope="col" class="num">Late</th>
							<th scope="col" class="num">Hours needed</th>
							<th scope="col" class="num">Hours available</th>
							<th scope="col">Load</th>
						</tr>
					</thead>
					<tbody>
						{#each board.load as cell (cell.code)}
							<tr>
								<th scope="row">
									{cell.code}
									<span class="faint">{cell.shifts === 1 ? 'one shift' : `${cell.shifts} shifts`}</span>
								</th>
								<td>{cell.department || 'Plant'}</td>
								<td class="num">{count(cell.orders)}</td>
								<td class="num" class:negative={cell.overdueOrders > 0}>
									{cell.overdueOrders ? count(cell.overdueOrders) : ''}
								</td>
								<td class="num">{cell.hoursRequired.toFixed(1)}</td>
								<td class="num">{cell.hoursAvailable4w.toFixed(0)}</td>
								<td>
									<div class="load {stateClass(cell.state)}">
										<div class="track">
											<div class="fill" style="width: {barWidth(cell.loadRatio)}"></div>
										</div>
										<span class="label">
											{cell.loadRatio === null ? 'no capacity set' : percent(cell.loadRatio)}
										</span>
									</div>
								</td>
							</tr>
						{:else}
							<tr><td colspan="7" class="empty">No production orders are open.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
			<p class="foot faint">
				An order routed through four cells counts in all four, so these hours add up to more than
				the order book. That is four answers to four questions, not a total. Only the ordered
				part's own routing counts: making its children is work that has no production order yet.
			</p>
		</section>

		{#if board.notReady.length}
			<section class="panel">
				<div class="panel-head">
					<h2>Steps that cannot run today</h2>
					<span class="chip warn">{board.notReady.length}</span>
				</div>
				<ul class="rows">
					{#each board.notReady as op (`${op.itemNo}-${op.seq}`)}
						<li class="row">
							<div>
								<a href="/manufacturing/parts/{op.itemNo}">{op.itemNo}</a>
								<span class="faint">{op.description}</span>
							</div>
							<span class="chip warn">{op.reason}</span>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="panel">
			<div class="panel-head">
				<h2>Why these orders are short</h2>
				<span class="chip">{board.shortages.length}</span>
			</div>
			<div class="table-wrap" tabindex="-1">
				<table>
					<thead>
						<tr>
							<th scope="col">Order</th>
							<th scope="col">Customer</th>
							<th scope="col">Part</th>
							<th scope="col" class="num">Short</th>
							<th scope="col" class="num">Value</th>
							<th scope="col">Because</th>
							<th scope="col">Cleared by</th>
						</tr>
					</thead>
					<tbody>
						{#each board.shortages as row (`${row.documentNo}-${row.lineNo}`)}
							<tr>
								<th scope="row">{row.documentNo}<span class="faint">line {row.lineNo}</span></th>
								<td><a href="/accounts/{row.customerNo}">{row.customerName}</a></td>
								<td>
									<a href="/manufacturing/parts/{row.itemNo}">{row.itemNo}</a>
									<span class="faint">{day(row.shipDate, data.year)}</span>
								</td>
								<td class="num negative">{count(row.short)}</td>
								<td class="num">{money(row.valueShort)}</td>
								<td>
									{#if row.blockingItem}
										<a href="/manufacturing/parts/{row.blockingItem}">{row.blockingItem}</a>
										<span class="faint">
											{row.blockingKind}, {count(row.blockingShort ?? 0)} short
											{row.blockingDepth ? `, ${row.blockingDepth} levels down` : ''}
										</span>
									{:else}
										<span class="faint">nothing underneath it is short</span>
									{/if}
								</td>
								<td>
									{#if row.blockingCoveringDocument}
										{row.blockingCoveringDocument}
										<span class="faint">
											{row.blockingCoveringSource}, {row.blockingCoveringDate
												? day(row.blockingCoveringDate, data.year)
												: 'no date'}
										</span>
									{:else if row.blockingLeadDays}
										<span class="faint">nothing on order, {row.blockingLeadDays} days to get</span>
									{:else}
										<span class="faint">nothing on order</span>
									{/if}
								</td>
							</tr>
						{:else}
							<tr><td colspan="7" class="empty">Nothing is short today.</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>

		<section class="panel">
			<div class="panel-head">
				<h2>Shipments waiting on paperwork</h2>
				<span class="chip" class:warn={board.packages.length > 0}>{board.packages.length}</span>
			</div>
			{#if board.packages.length}
				<ul class="rows">
					{#each board.packages as row (row.shipmentNo)}
						<li class="row">
							<div>
								<strong>{row.shipmentNo}</strong>
								<span class="faint">{row.customerName}, {row.status}</span>
							</div>
							<div class="right">
								<span class="chip warn">{row.missing} missing</span>
								{#if row.promisedOn}<span class="faint">due {day(row.promisedOn, data.year)}</span>{/if}
							</div>
						</li>
					{/each}
				</ul>
				<p class="foot faint">
					A shipment cannot leave until its package is complete. The database refuses the last step
					and names what is missing, so nobody has to remember.
				</p>
			{:else}
				<p class="empty">Every shipment on the dock has the paperwork it owes.</p>
			{/if}
		</section>

		<section class="panel">
			<div class="panel-head"><h2>The model</h2></div>
			<dl class="figures">
				<div>
					<dt>Parts</dt>
					<dd>{count(board.counts.parts)}</dd>
					<span class="note">{count(board.counts.madeParts)} of them made here</span>
				</div>
				<div>
					<dt>Parts list lines</dt>
					<dd>{count(board.counts.bomLines)}</dd>
				</div>
				<div>
					<dt>Routing steps</dt>
					<dd>{count(board.counts.operations)}</dd>
				</div>
				<div>
					<dt>Lots</dt>
					<dd>{count(board.counts.lots)}</dd>
					<span class="note">{count(board.counts.certificates)} certificates on file</span>
				</div>
				<div>
					<dt>Disagree with the ERP</dt>
					<dd>{count(board.counts.disagreements)}</dd>
					<span class="note">derived shape against the imported word</span>
				</div>
			</dl>
		</section>
	{:catch}
		<p class="notice error" role="alert">
			The plant could not be loaded.
			<a class="button" href="/manufacturing" data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page-head p {
		max-width: 80ch;
		font-size: 0.92rem;
	}

	th[scope='row'] {
		font-weight: 500;
	}

	.faint {
		display: block;
		font-size: var(--fs-meta);
		color: var(--text-faint);
	}

	.num {
		text-align: right;
		font-variant-numeric: tabular-nums;
	}

	/* Flexbox rather than grid: the same two rules give the phone layout. */
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: 6px var(--space-3);
	}

	.row .right {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.load {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 160px;
	}

	.track {
		flex: 1 1 90px;
		height: 6px;
		border-radius: 3px;
		background: var(--surface-sunken);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: var(--text-muted);
		transition: width var(--speed-slow) var(--ease);
	}

	.load.tight .fill {
		background: var(--warning);
	}

	.load.over .fill {
		background: var(--danger);
	}

	.load .label {
		font-size: var(--fs-meta);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
		min-width: 52px;
		text-align: right;
	}

	.foot {
		margin: 0;
		padding: 6px var(--space-3) var(--space-3);
		font-size: var(--fs-meta);
		max-width: 92ch;
	}

	.skeleton {
		border-radius: var(--radius);
		background: var(--surface-sunken);
		animation: pulse 1.4s var(--ease) infinite;
	}

	@keyframes pulse {
		50% {
			opacity: 0.55;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.skeleton {
			animation: none;
		}

		.fill {
			transition: none;
		}
	}
</style>
