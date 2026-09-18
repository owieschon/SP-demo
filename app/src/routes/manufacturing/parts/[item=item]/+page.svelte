<script lang="ts">
	import { count, day, moneyExact, percent } from '$lib/format';
	import { COST_ELEMENTS } from '$lib/server/manufacturing/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const part = $derived(data.part);

	// The cost bar: one segment per element that has anything in it, in a
	// fixed order so the same part always reads the same way.
	const segments = $derived(
		COST_ELEMENTS.map((element) => ({
			element,
			amount: part.cost.elements[element],
			share: part.cost.rolled > 0 ? part.cost.elements[element] / part.cost.rolled : 0
		})).filter((s) => s.amount > 0)
	);

	const ELEMENT_LABELS: Record<string, string> = {
		material: 'Material',
		component: 'Bought components',
		labor: 'Labour, loaded',
		machine: 'Machine time',
		overhead: 'Absorbed overhead',
		outside: 'Outside processing',
		scrap: 'Scrap allowance',
		packaging: 'Packaging',
		expedite: 'Expediting'
	};

	// Indent a tree row by its level without a nested list, which is what
	// makes the rows scannable on a phone.
	function indent(level: number): string {
		return `padding-left: calc(var(--space-3) + ${level} * 18px)`;
	}
</script>

<svelte:head>
	<title>{part.itemNo} · Plant · Northline</title>
</svelte:head>

<main class="page">
	<header class="page-head">
		<div class="titles">
			<h1>{part.itemNo}</h1>
			<p class="lede">{part.description}</p>
			<p class="sentence">{part.shape.sentence}</p>
		</div>
		<div class="actions">
			<a class="chip" href="/parts/{part.itemNo}">Part page</a>
			<a class="chip" href="/manufacturing">Plant</a>
		</div>
	</header>

	{#if !part.shape.erpAgrees}
		<p class="notice warning">
			The parts list and the routing say this part is <strong>{part.shape.shape}</strong>, and the
			ERP's item card says <strong>{part.shape.erpReplenishment}</strong>. Nothing here has changed
			the item card: the ERP is the field we import, so the disagreement is shown rather than
			settled.
		</p>
	{/if}

	<!-- The two figures the whole model exists to produce. -->
	<section class="panel">
		<div class="panel-head">
			<h2>True cost and true lead time</h2>
			<span class="chip">measured {part.cost.measuredAt.slice(0, 10)}</span>
		</div>
		<dl class="figures">
			<div>
				<dt>Rolled cost</dt>
				<dd>{moneyExact(part.cost.rolled)}</dd>
				{#if part.cost.card !== null}
					<span class="note">
						item card {moneyExact(part.cost.card)}
						{#if part.cost.difference !== null}
							({part.cost.difference >= 0 ? '+' : ''}{moneyExact(part.cost.difference)})
						{/if}
					</span>
				{/if}
			</div>
			<div>
				<dt>Lead time</dt>
				<dd>{count(part.lead.days)} days</dd>
				<span class="note">ready {day(part.lead.readyOn, data.year)} if started today</span>
			</div>
			<div>
				<dt>Levels deep</dt>
				<dd>{count(part.cost.levels)}</dd>
				<span class="note">{count(part.shape.bomLines)} lines, {count(part.shape.operations)} steps</span>
			</div>
			<div>
				<dt>On hand</dt>
				<dd>{count(part.onHand)}</dd>
				<span class="note">{count(part.available)} not promised to anybody</span>
			</div>
			<div>
				<dt>Margin at list</dt>
				<dd>{part.cost.rolledMargin === null ? 'n/a' : percent(part.cost.rolledMargin)}</dd>
				<span class="note">list {moneyExact(part.cost.listPrice)}, at rolled cost</span>
			</div>
		</dl>

		<div class="bar-wrap">
			<div class="bar" role="img" aria-label="Cost by element">
				{#each segments as seg (seg.element)}
					<div
						class="seg {seg.element}"
						style="flex-grow: {Math.max(seg.share, 0.005)}"
						title="{ELEMENT_LABELS[seg.element]}: {moneyExact(seg.amount)}"
					></div>
				{/each}
			</div>
			<ul class="legend">
				{#each segments as seg (seg.element)}
					<li>
						<span class="dot {seg.element}"></span>
						{ELEMENT_LABELS[seg.element]}
						<strong>{moneyExact(seg.amount)}</strong>
						<span class="faint">{percent(seg.share)}</span>
					</li>
				{/each}
			</ul>
		</div>

		<p class="foot faint">
			Critical path: {part.lead.criticalPath.join(' then ')}. Shorten any other branch and the date
			does not move.
		</p>
	</section>

	<!-- The parts list, with each child's own rolled cost. -->
	{#if part.bom.length > 1}
		<section class="panel">
			<div class="panel-head">
				<h2>Parts list</h2>
				<span class="chip">{part.bom.length - 1} below this part</span>
			</div>
			<div class="table-wrap" tabindex="-1">
				<table>
					<thead>
						<tr>
							<th scope="col">Part</th>
							<th scope="col" class="num">Per</th>
							<th scope="col">Unit</th>
							<th scope="col" class="num">Scrap</th>
							<th scope="col" class="num">Rolled cost</th>
							<th scope="col" class="num">Extended</th>
							<th scope="col" class="num">Lead</th>
							<th scope="col" class="num">On hand</th>
						</tr>
					</thead>
					<tbody>
						{#each part.bom as node (`${node.parentItem ?? 'root'}-${node.itemNo}-${node.lineNo ?? 0}`)}
							<tr class:sub={node.isSubstitute}>
								<th scope="row" style={indent(node.level)}>
									{#if node.level === 0}
										<strong>{node.itemNo}</strong>
									{:else}
										<a href="/manufacturing/parts/{node.itemNo}">{node.itemNo}</a>
									{/if}
									<span class="faint">
										{node.description}
										{#if node.isSubstitute}<span class="chip">substitute, not costed</span>{/if}
										{#if node.isPhantom}<span class="chip">phantom, passes through</span>{/if}
									</span>
								</th>
								<td class="num">{node.level === 0 ? '' : node.quantityPer}</td>
								<td>{node.uom}</td>
								<td class="num">{node.scrapPct > 0 ? percent(node.scrapPct) : ''}</td>
								<td class="num">{node.rolledCost === null ? '' : moneyExact(node.rolledCost)}</td>
								<td class="num">
									{node.level === 0 || node.extendedCost === null || node.isSubstitute
										? ''
										: moneyExact(node.extendedCost)}
								</td>
								<td class="num">{node.leadDays === null ? '' : node.leadDays}</td>
								<td class="num">{count(node.onHand)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- The routing, and whether each step could run today. -->
	{#if part.operations.length}
		<section class="panel">
			<div class="panel-head"><h2>Routing</h2></div>
			<div class="table-wrap" tabindex="-1">
				<table>
					<thead>
						<tr>
							<th scope="col">Step</th>
							<th scope="col">Cell</th>
							<th scope="col" class="num">Setup</th>
							<th scope="col" class="num">Run</th>
							<th scope="col" class="num">Queue and move</th>
							<th scope="col" class="num">Yield</th>
							<th scope="col">Ready</th>
						</tr>
					</thead>
					<tbody>
						{#each part.operations as op (op.seq)}
							<tr>
								<th scope="row">
									{op.seq}
									<span class="faint">{op.description}</span>
								</th>
								<td>
									{#if op.isOutside}
										<span class="chip">outside, {op.vendorNo}</span>
									{:else}
										{op.workCenter}
										<span class="faint">{op.machine ?? ''} {op.laborClass ?? ''}</span>
									{/if}
								</td>
								<td class="num">{op.setupMinutes ? `${op.setupMinutes} min` : ''}</td>
								<td class="num">
									{op.isOutside && op.outsidePrice !== null
										? moneyExact(op.outsidePrice)
										: op.runMinutes
											? `${op.runMinutes} min`
											: ''}
								</td>
								<td class="num">{op.queueMinutes + op.moveMinutes || ''}</td>
								<td class="num" class:negative={op.yieldPct < 1}>
									{op.yieldPct < 1 ? percent(op.yieldPct) : ''}
								</td>
								<td>
									{#if op.ready}
										<span class="faint">yes</span>
									{:else}
										<span class="chip warn">{op.blockedReason}</span>
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}

	<!-- Where every dollar of the rolled cost came from. -->
	<section class="panel">
		<div class="panel-head">
			<h2>Where the cost comes from</h2>
			<span class="chip">{part.costLines.length} lines</span>
		</div>
		<div class="table-wrap" tabindex="-1">
			<table class="sticky">
				<thead>
					<tr>
						<th scope="col">Level</th>
						<th scope="col">Part</th>
						<th scope="col">Element</th>
						<th scope="col">What it is</th>
						<th scope="col" class="num">Each</th>
						<th scope="col" class="num">Amount</th>
					</tr>
				</thead>
				<tbody>
					{#each part.costLines as line, i (`${line.itemNo}-${line.element}-${line.source}-${i}`)}
						<tr>
							<td class="num">{line.level}</td>
							<td>{line.itemNo}</td>
							<td><span class="dot {line.element}"></span> {ELEMENT_LABELS[line.element]}</td>
							<td class="detail">{line.detail}</td>
							<td class="num">{moneyExact(line.unitAmount)}</td>
							<td class="num">{moneyExact(line.amount)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</section>

	<div class="two">
		<!-- Where used, ordered by the dollars riding on each parent. -->
		<section class="panel">
			<div class="panel-head">
				<h2>Where used</h2>
				<span class="chip">{part.whereUsed.length}</span>
			</div>
			{#if part.whereUsed.length}
				<ul class="rows">
					{#each part.whereUsed.slice(0, 25) as row (row.parentItem)}
						<li class="row">
							<div>
								<a href="/manufacturing/parts/{row.parentItem}">{row.parentItem}</a>
								<span class="faint">
									{row.description} · {row.quantityPer} per, {row.depth} level{row.depth === 1
										? ''
										: 's'} up
								</span>
							</div>
							{#if row.openOrderValue > 0}
								<span class="chip">{moneyExact(row.openOrderValue)} on order</span>
							{/if}
						</li>
					{/each}
				</ul>
			{:else}
				<p class="empty">Nothing is made from this part.</p>
			{/if}
		</section>

		<!-- The lots, with their certificates. -->
		<section class="panel">
			<div class="panel-head">
				<h2>Lots</h2>
				<span class="chip">{part.lots.length}</span>
			</div>
			{#if part.lots.length}
				<ul class="rows">
					{#each part.lots.slice(0, 15) as lot (lot.lotNo)}
						<li class="row">
							<div>
								<a href="/manufacturing/lots/{lot.lotNo}">{lot.lotNo}</a>
								<span class="faint">
									{#if lot.heatNo}heat {lot.heatNo}, {lot.mill}, melted in {lot.countryOfMelt}{:else}
										received {day(lot.receivedOn, data.year)}
									{/if}
									· {count(lot.quantityRemaining)} of {count(lot.quantityReceived)} left
								</span>
							</div>
							<div class="right">
								{#each lot.certificates as cert (cert.reference_no)}
									<span class="chip" class:warn={cert.expired}>{cert.kind}</span>
								{/each}
								{#if lot.status !== 'available'}<span class="chip warn">{lot.status}</span>{/if}
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="empty">No lots of this part have been received or made.</p>
			{/if}
		</section>
	</div>

	<div class="two">
		<!-- Sourcing: every way this part can be got. -->
		<section class="panel">
			<div class="panel-head">
				<h2>Ways to get it</h2>
				<span class="chip">{part.sources.length}</span>
			</div>
			{#if part.sources.length}
				<ul class="rows">
					{#each part.sources as source, i (`${source.sourceKind}-${source.priority}-${i}`)}
						<li class="row">
							<div>
								<strong>{source.sourceKind}</strong>
								<span class="faint">
									{source.vendorNo ?? source.workCenter ?? source.fromLocation ?? ''}
									{#if source.minQty !== null || source.maxQty !== null}
										· {source.minQty ?? 0} to {source.maxQty ?? 'any'} pieces
									{/if}
									{#if source.leadTime}· {source.leadTime}{/if}
								</span>
							</div>
							<span class="chip">priority {source.priority}</span>
						</li>
					{/each}
				</ul>
				<p class="foot faint">
					More than one row is not a contradiction. It is how a part that is bought in small
					quantities and made in large ones gets written down.
				</p>
			{:else}
				<p class="empty">No source is recorded for this part.</p>
			{/if}
		</section>

		<!-- Planning policy and the selling units. -->
		<section class="panel">
			<div class="panel-head"><h2>Policy and selling units</h2></div>
			<dl class="figures">
				{#if part.planning}
					<div>
						<dt>Demand policy</dt>
						<dd class="small">{part.planning.demandPolicy}</dd>
						<span class="note">{part.planning.lotSizing}</span>
					</div>
					<div>
						<dt>Order quantity</dt>
						<dd class="small">
							{part.planning.minOrderQty ?? 1}
							{#if part.planning.orderMultiple}in {part.planning.orderMultiple}s{/if}
						</dd>
						{#if part.planning.maxOrderQty}
							<span class="note">up to {count(part.planning.maxOrderQty)}</span>
						{/if}
					</div>
					<div>
						<dt>Reorder point</dt>
						<dd class="small">{part.planning.reorderPoint ?? 'not stocked to one'}</dd>
						{#if part.planning.safetyStock}
							<span class="note">{count(part.planning.safetyStock)} safety stock</span>
						{/if}
					</div>
				{/if}
				<div>
					<dt>Promise for {count(data.quantity)}</dt>
					<dd class="small">{day(part.promise.earliestDate, data.year)}</dd>
					<span class="note">
						{part.promise.earliestBasis === 'stock'
							? 'off the shelf'
							: part.promise.earliestBasis === 'supply'
								? 'from an order already placed'
								: `${part.promise.leadDays} days from a standing start`}
					</span>
				</div>
			</dl>
			{#if part.skus.length}
				<ul class="rows">
					{#each part.skus as sku (sku.skuCode)}
						<li class="row">
							<div>
								<strong>{sku.skuCode}</strong>
								<span class="faint">
									{sku.packQuantity} per {sku.uom}
									{#if sku.weightLb}· {sku.weightLb} lb{/if}
								</span>
							</div>
							{#if sku.isDefault}<span class="chip">default</span>{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	</div>
</main>

<style>
	.lede {
		font-size: 0.95rem;
		color: var(--text-muted);
		margin: 0;
	}

	.sentence {
		margin: 0;
		font-size: 0.92rem;
		max-width: 80ch;
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

	.detail {
		font-size: var(--fs-meta);
		color: var(--text-muted);
		min-width: 24ch;
	}

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
		gap: 4px;
		flex-wrap: wrap;
	}

	.sub td,
	.sub th {
		color: var(--text-faint);
	}

	.bar-wrap {
		padding: 0 var(--space-3) var(--space-3);
		display: grid;
		gap: var(--space-2);
	}

	/* Flexbox, not grid: one rule and it works at phone width. */
	.bar {
		display: flex;
		height: 10px;
		border-radius: 5px;
		overflow: hidden;
		background: var(--surface-sunken);
	}

	.seg {
		flex-basis: 0;
		min-width: 2px;
	}

	.legend {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.legend li {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.dot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		background: var(--text-muted);
	}

	/*
	  One colour per cost element, used by both the bar and the breakdown, so
	  the same element reads the same way in both places.
	*/
	.seg.material,
	.dot.material {
		background: light-dark(#4a6fa5, #7ea3d8);
	}
	.seg.component,
	.dot.component {
		background: light-dark(#5b8c6a, #86bf96);
	}
	.seg.labor,
	.dot.labor {
		background: light-dark(#a56a3c, #d19a68);
	}
	.seg.machine,
	.dot.machine {
		background: light-dark(#7a5ba5, #ad93d8);
	}
	.seg.overhead,
	.dot.overhead {
		background: light-dark(#8a8578, #b3ada0);
	}
	.seg.outside,
	.dot.outside {
		background: light-dark(#3f8f93, #74c3c7);
	}
	.seg.scrap,
	.dot.scrap {
		background: light-dark(#a4484b, #d98184);
	}
	.seg.packaging,
	.dot.packaging {
		background: light-dark(#9a8f4a, #c8bc7c);
	}
	.seg.expedite,
	.dot.expedite {
		background: light-dark(#8e5a8f, #c28ec3);
	}

	.figures dd.small {
		font-size: 0.95rem;
		font-weight: 500;
	}

	.foot {
		margin: 0;
		padding: 0 var(--space-3) var(--space-3);
		font-size: var(--fs-meta);
		max-width: 92ch;
	}

	.two {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		align-items: start;
	}

	.two > :global(*) {
		flex: 1 1 380px;
		min-width: 0;
	}
</style>
