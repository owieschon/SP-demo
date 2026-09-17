<script lang="ts">
	// The late-order forecast: the headline numbers, every line that will miss
	// its promised date and why, and the panels that say who to call.
	//
	// Nothing here computes a date or a status: they come from
	// nl.open_line_projection and the four aggregates beside it (migration
	// 0016), so the page and the database can never disagree.
	import { count, day, money } from '$lib/format';
	import { reasonFor } from './reason';
	import { LINE_STATUS_LABEL, type Forecast, type LineStatus } from './types';

	let { forecast, year }: { forecast: Forecast; year: number } = $props();

	const f = $derived(forecast);

	// One quiet color per status, the same family the operations buckets use.
	const TONE: Record<LineStatus, string> = {
		past_due: 'var(--status-broken)',
		no_supply: 'var(--status-broken)',
		late_supply_overdue: 'var(--status-pushed)',
		late_waiting_supply: 'var(--status-pushed)',
		on_time: 'var(--status-kept)'
	};

	const SUPPLY_CHANGE_LABEL = {
		due_later: 'Pushed out',
		due_sooner: 'Pulled in',
		new: 'New order',
		received: 'Received'
	} as const;

	// The part of the URL that keeps the current filters while changing one.
	function withFilter(name: string, value: string): string {
		const params = new URLSearchParams({
			status: f.filters.status,
			...(f.filters.vendor ? { vendor: f.filters.vendor } : {}),
			...(f.filters.workCenter ? { wc: f.filters.workCenter } : {}),
			...(f.filters.customer ? { customer: f.filters.customer } : {}),
			...(f.filters.who === 'mine' ? { who: 'mine' } : {})
		});
		if (value) params.set(name, value);
		else params.delete(name);
		return `/operations/forecast?${params.toString()}`;
	}
</script>

<section class="panel" aria-labelledby="totals-title">
	<header class="panel-head">
		<h2 id="totals-title">The order book, projected</h2>
		<span class="faint">
			{#if f.sources.length > 0}
				From
				{#each f.sources as s, i (s.kind)}<a class="link" href="/operations?snapshot={s.id}"
						>#{s.id}</a
					>{#if i < f.sources.length - 1}{', '}{/if}{/each}
				· late supply counts {f.overdueSupplyDays} days out
			{:else}
				No export applied yet
			{/if}
		</span>
	</header>

	<dl class="figures">
		<div class="figure">
			<dt>Open order value</dt>
			<dd><span class="big num">{money(f.totals.openValue)}</span></dd>
			<dd class="faint small">{count(f.totals.openLines)} lines</dd>
		</div>
		<div class="figure" style:--tone="var(--status-pushed)">
			<dt><span class="swatch" aria-hidden="true"></span>Projected late</dt>
			<dd><span class="big num">{money(f.totals.lateValue)}</span></dd>
			<dd class="faint small">{count(f.totals.lateLines)} lines, worst {f.totals.worstDaysLate} days</dd>
		</div>
		<div class="figure" style:--tone="var(--status-broken)">
			<dt><span class="swatch" aria-hidden="true"></span>Nothing on order</dt>
			<dd><span class="big num">{count(f.totals.noSupplyLines)}</span></dd>
			<dd class="faint small">{money(f.totals.noSupplyValue)} to buy or make</dd>
		</div>
		<div class="figure">
			<dt>Late supply orders</dt>
			<dd><span class="big num">{count(f.totals.overdueSupplyOrders)}</span></dd>
			<dd class="faint small">purchase and production orders past their own due date</dd>
		</div>
	</dl>
</section>

<section class="panel" aria-labelledby="lines-title">
	<header class="panel-head">
		<h2 id="lines-title">Lines that will miss the date</h2>
		<span class="faint num">
			{#if f.lineCount > f.lines.length}{f.lines.length} of {count(f.lineCount)}{:else}{count(f.lineCount)}{/if}
		</span>
	</header>

	{#if f.lines.length === 0}
		<p class="body muted">
			Nothing matches these filters. Widen the status filter to
			<a class="link" href={withFilter('status', 'all')}>every open line</a>, or clear the filters.
		</p>
	{:else}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th>Customer</th>
						<th>Part</th>
						<th>Promised</th>
						<th>Projected</th>
						<th class="num">Days</th>
						<th>Why</th>
						<th class="num">Value</th>
					</tr>
				</thead>
				<tbody>
					{#each f.lines as l (l.documentNo + ':' + l.lineNo)}
						<tr>
							<td class="customer">
								<span class="swatch" style:--tone={TONE[l.status]} title={LINE_STATUS_LABEL[l.status]}></span>
								<a class="link" href="/accounts/{encodeURIComponent(l.customerNo)}">{l.customerName}</a>
								<span class="faint doc mono">{l.documentNo}/{l.lineNo}</span>
							</td>
							<td>
								<a class="link mono" href="/parts/{encodeURIComponent(l.itemNo)}">{l.itemNo}</a>
								<span class="faint desc">{count(l.quantity)} pcs · {l.description}</span>
							</td>
							<td class="nowrap">{day(l.shipDate, year)}</td>
							<td class="nowrap" class:late={l.daysLate > 0}>{day(l.projectedDate, year)}</td>
							<td class="num" class:late={l.daysLate > 0}>{l.daysLate > 0 ? l.daysLate : '·'}</td>
							<td class="why">
								<span class="chip" class:warn={l.daysLate > 0}>{LINE_STATUS_LABEL[l.status]}</span>
								<span class="reason">{reasonFor(l, year)}</span>
							</td>
							<td class="num">{money(l.openValue)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</section>

<div class="side">
	<section class="panel" aria-labelledby="vendor-title">
		<header class="panel-head">
			<h2 id="vendor-title">Vendor call sheet</h2>
			<span class="faint">Customer dollars waiting on each vendor</span>
		</header>
		{#if f.vendors.length === 0}
			<p class="body muted">No purchase order is holding up a customer order.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Vendor</th>
							<th>Who to call</th>
							<th class="num">POs</th>
							<th class="num">Lines</th>
							<th class="num">Waiting</th>
						</tr>
					</thead>
					<tbody>
						{#each f.vendors as v (v.vendorNo)}
							<tr>
								<td>
									<a class="link" href="/vendors/{encodeURIComponent(v.vendorNo)}">{v.vendorName}</a>
									<span class="faint desc">{v.place}{v.leadTime ? ` · lead time ${v.leadTime}` : ''}</span>
								</td>
								<td>
									{#if v.contactName}
										{v.contactName}
										<span class="faint desc">{v.contactPhone ?? v.contactEmail ?? ''}</span>
									{:else}
										<a class="link" href="/vendors/{encodeURIComponent(v.vendorNo)}">Name a contact</a>
									{/if}
								</td>
								<td class="num">
									{count(v.purchaseOrders)}
									{#if v.overduePurchaseOrders > 0}
										<span class="chip warn">{v.overduePurchaseOrders} past due</span>
									{/if}
								</td>
								<td class="num">
									<a class="link" href={withFilter('vendor', v.vendorNo)}>{count(v.lateLines)}</a>
								</td>
								<td class="num">{money(v.valueWaiting)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel" aria-labelledby="wc-title">
		<header class="panel-head">
			<h2 id="wc-title">Production backlog</h2>
			<span class="faint">By work center</span>
		</header>
		{#if f.workCenters.length === 0}
			<p class="body muted">No production order is holding up a customer order.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Work center</th>
							<th class="num">Orders</th>
							<th class="num">Lines</th>
							<th>First due</th>
							<th class="num">Waiting</th>
						</tr>
					</thead>
					<tbody>
						{#each f.workCenters as w (w.workCenter)}
							<tr>
								<td class="mono">{w.workCenter || 'Unassigned'}</td>
								<td class="num">
									{count(w.productionOrders)}
									{#if w.overdueProductionOrders > 0}
										<span class="chip warn">{w.overdueProductionOrders} past due</span>
									{/if}
								</td>
								<td class="num">
									<a class="link" href={withFilter('wc', w.workCenter)}>{count(w.lateLines)}</a>
								</td>
								<td class="nowrap">{w.firstDue ? day(w.firstDue, year) : '·'}</td>
								<td class="num">{money(w.valueWaiting)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel" aria-labelledby="customer-title">
		<header class="panel-head">
			<h2 id="customer-title">Customers to call</h2>
			<span class="faint">Worst dollars first</span>
		</header>
		{#if f.customers.length === 0}
			<p class="body muted">Every open line is projected to ship on time.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Customer</th>
							<th>Owner</th>
							<th class="num">Lines</th>
							<th class="num">Worst</th>
							<th class="num">Late value</th>
						</tr>
					</thead>
					<tbody>
						{#each f.customers as c (c.customerNo)}
							<tr>
								<td>
									<a class="link" href="/accounts/{encodeURIComponent(c.customerNo)}">{c.customerName}</a>
									{#if c.noSupplyLines > 0}
										<span class="faint desc">{c.noSupplyLines} with nothing on order</span>
									{/if}
								</td>
								<td>{c.ownerName ?? 'Unassigned'}</td>
								<td class="num">
									<a class="link" href={withFilter('customer', c.customerNo)}>{count(c.lateLines)}</a>
								</td>
								<td class="num">{c.worstDaysLate} d</td>
								<td class="num">{money(c.valueLate)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel" aria-labelledby="moved-title">
		<header class="panel-head">
			<h2 id="moved-title">Promises that moved</h2>
			<span class="faint">Measured across applied exports</span>
		</header>
		{#if f.promiseMoves.length === 0}
			<p class="body muted">No open line has had its ship date changed since the exports began.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Customer</th>
							<th>Part</th>
							<th>First promise</th>
							<th>Now</th>
							<th class="num">Moves</th>
							<th class="num">Days</th>
						</tr>
					</thead>
					<tbody>
						{#each f.promiseMoves as m (m.documentNo + ':' + m.lineNo)}
							<tr>
								<td>
									<a class="link" href="/accounts/{encodeURIComponent(m.customerNo)}">{m.customerName}</a>
									<span class="faint doc mono">{m.documentNo}/{m.lineNo}</span>
								</td>
								<td><a class="link mono" href="/parts/{encodeURIComponent(m.itemNo)}">{m.itemNo}</a></td>
								<td class="nowrap">{day(m.firstPromised, year)}</td>
								<td class="nowrap">{day(m.currentPromise, year)}</td>
								<td class="num">{m.moves}</td>
								<td class="num" class:late={m.daysMoved > 0}>{m.daysMoved > 0 ? `+${m.daysMoved}` : m.daysMoved}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>

	<section class="panel" aria-labelledby="supply-title">
		<header class="panel-head">
			<h2 id="supply-title">Supply dates that moved</h2>
			<span class="faint">Since the last supply export</span>
		</header>
		{#if f.supplyMoves.length === 0}
			<p class="body muted">No purchase or production date changed in the last export.</p>
		{:else}
			<div class="table-wrap">
				<table>
					<thead>
						<tr>
							<th>Change</th>
							<th>Order</th>
							<th>Part</th>
							<th>From</th>
							<th>To</th>
							<th class="num">Days</th>
						</tr>
					</thead>
					<tbody>
						{#each f.supplyMoves as m (m.kind + m.documentNo + ':' + (m.lineNo ?? 0))}
							<tr>
								<td>
									<span class="chip" class:warn={m.change === 'due_later'}>{SUPPLY_CHANGE_LABEL[m.change]}</span>
								</td>
								<td class="mono nowrap">
									{m.documentNo}{#if m.lineNo}<span class="faint">/{m.lineNo}</span>{/if}
									<span class="faint desc">{m.partyName ?? m.party}</span>
								</td>
								<td><a class="link mono" href="/parts/{encodeURIComponent(m.itemNo)}">{m.itemNo}</a></td>
								<td class="nowrap">{m.dueBefore ? day(m.dueBefore, year) : '·'}</td>
								<td class="nowrap">{m.dueNow ? day(m.dueNow, year) : '·'}</td>
								<td class="num" class:late={(m.daysMoved ?? 0) > 0}>
									{m.daysMoved === null ? '·' : m.daysMoved > 0 ? `+${m.daysMoved}` : m.daysMoved}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>

<style>
	.body {
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.92rem;
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
	}

	.figure {
		flex: 1 1 190px;
		display: grid;
		gap: 2px;
		align-content: start;
		padding: 10px var(--space-3);
	}

	.figure + .figure {
		border-left: 1px solid var(--hairline);
	}

	.figures dt {
		display: flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
	}

	.figures dd {
		margin: 0;
	}

	.big {
		font-size: 1.35rem;
		font-weight: 600;
		letter-spacing: -0.015em;
	}

	.swatch {
		display: inline-block;
		flex: none;
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--tone) 30%, transparent);
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}

	/* The side panels sit two across on a wide screen, one on a phone. */
	.side {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.side > :global(section) {
		flex: 1 1 460px;
		min-width: 0;
	}

	.table-wrap {
		overflow-x: auto;
		max-height: 460px;
		overflow-y: auto;
	}

	/* Column headings stay put while the rows scroll. */
	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
		z-index: 1;
	}

	.nowrap {
		white-space: nowrap;
	}

	.customer {
		min-width: 190px;
	}

	.customer .swatch {
		margin-right: 4px;
	}

	.desc,
	.doc {
		display: block;
		font-size: 0.85rem;
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.why {
		min-width: 260px;
	}

	.reason {
		display: block;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.late {
		color: var(--danger);
	}

	@media (max-width: 720px) {
		.figure {
			flex-basis: 45%;
		}

		.figure + .figure {
			border-left: 0;
		}

		.desc,
		.doc {
			max-width: 180px;
		}
	}
</style>
