<script lang="ts">
	import { count, day, moment } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const trace = $derived(data.trace);
	const lot = $derived(trace.lot);

	// The forward walk lists a lot once per shipment it reached, so the tree
	// shows each lot once and the shipments hang off it.
	const forwardLots = $derived.by(() => {
		const byLot = new Map<
			string,
			{ depth: number; itemNo: string; description: string; shipments: typeof trace.forward }
		>();
		for (const row of trace.forward) {
			const found = byLot.get(row.lotNo);
			if (found) {
				if (row.shipmentNo) found.shipments.push(row);
			} else {
				byLot.set(row.lotNo, {
					depth: row.depth,
					itemNo: row.itemNo,
					description: row.description,
					shipments: row.shipmentNo ? [row] : []
				});
			}
		}
		return [...byLot.entries()]
			.map(([lotNo, v]) => ({ lotNo, ...v }))
			.sort((a, b) => a.depth - b.depth || a.lotNo.localeCompare(b.lotNo));
	});

	function indent(level: number): string {
		return `padding-left: calc(var(--space-3) + ${level} * 18px)`;
	}
</script>

<svelte:head>
	<title>{lot.lotNo} · Plant · Northline</title>
</svelte:head>

<main class="page">
	<header class="page-head">
		<div class="titles">
			<h1>{lot.lotNo}</h1>
			<p class="lede">
				{lot.itemNo} · {lot.description}
			</p>
			<p class="sentence">
				{#if lot.heatNo}
					Heat {lot.heatNo} from {lot.mill}, melted in {lot.countryOfMelt}, received
					{day(lot.receivedOn, data.year)}.
				{:else}
					Made or picked on {day(lot.receivedOn, data.year)}.
				{/if}
				{count(lot.quantityRemaining)} of {count(lot.quantityReceived)} left.
			</p>
		</div>
		<div class="actions">
			{#each lot.certificates as cert (cert.reference_no)}
				<span class="chip" class:warn={cert.expired}>{cert.kind} {cert.reference_no}</span>
			{/each}
			<a class="chip" href="/manufacturing/parts/{lot.itemNo}">The part</a>
		</div>
	</header>

	{#if lot.status !== 'available' && lot.status !== 'consumed'}
		<p class="notice warning">
			This lot is <strong>{lot.status}</strong>. Nothing made from it may ship until that changes.
		</p>
	{/if}

	<!-- The recall answer, first, because it is the question that matters. -->
	<section class="panel">
		<div class="panel-head">
			<h2>Who received metal from this lot</h2>
			<span class="chip" class:warn={trace.customers.length > 0}>{trace.customers.length} accounts</span>
		</div>
		{#if trace.customers.length}
			<div class="table-wrap" tabindex="-1">
				<table>
					<thead>
						<tr>
							<th scope="col">Account</th>
							<th scope="col" class="num">Shipments</th>
							<th scope="col" class="num">Pieces</th>
							<th scope="col">Parts</th>
							<th scope="col">Last shipped</th>
						</tr>
					</thead>
					<tbody>
						{#each trace.customers as row (row.customerNo)}
							<tr>
								<th scope="row">
									<a href="/accounts/{row.customerNo}">{row.customerName}</a>
									<span class="faint">{row.customerNo}</span>
								</th>
								<td class="num">{count(row.shipments)}</td>
								<td class="num">{count(row.quantity)}</td>
								<td>
									{#each row.itemNumbers.slice(0, 4) as itemNo (itemNo)}
										<a class="chip" href="/manufacturing/parts/{itemNo}">{itemNo}</a>
									{/each}
									{#if row.itemNumbers.length > 4}
										<span class="faint">and {row.itemNumbers.length - 4} more</span>
									{/if}
								</td>
								<td>{row.lastShipped ? moment(row.lastShipped) : 'not shipped yet'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{:else}
			<p class="empty">Nothing made from this lot has shipped to anybody.</p>
		{/if}
	</section>

	<div class="two">
		<!-- Backwards: what this was made from. -->
		<section class="panel">
			<div class="panel-head">
				<h2>What it was made from</h2>
				<span class="chip">{trace.back.length} lots</span>
			</div>
			<ul class="rows">
				{#each trace.back as row (row.lotNo)}
					<li class="tree" style={indent(row.depth)}>
						<div>
							{#if row.depth === 0}
								<strong>{row.lotNo}</strong>
							{:else}
								<a href="/manufacturing/lots/{row.lotNo}">{row.lotNo}</a>
							{/if}
							<span class="faint">
								{row.itemNo} · {row.description}
								{#if row.heatNo}· heat {row.heatNo}, {row.mill}, {row.countryOfMelt}{/if}
								{#if row.depth > 0}· {count(row.quantityUsed)} used{/if}
							</span>
						</div>
						<div class="right">
							{#each row.certificates as cert (cert.reference_no)}
								<span class="chip" class:warn={cert.expired} title={cert.issued_by}>{cert.kind}</span>
							{/each}
							{#if row.heatNo && !row.certificates.some((c) => c.kind === 'MTR')}
								<span class="chip warn">no mill certificate</span>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
		</section>

		<!-- Forwards: what was made from this. -->
		<section class="panel">
			<div class="panel-head">
				<h2>What was made from it</h2>
				<span class="chip">{forwardLots.length} lots</span>
			</div>
			{#if forwardLots.length > 1}
				<ul class="rows">
					{#each forwardLots as row (row.lotNo)}
						<li class="tree" style={indent(row.depth)}>
							<div>
								{#if row.lotNo === lot.lotNo}
									<strong>{row.lotNo}</strong>
								{:else}
									<a href="/manufacturing/lots/{row.lotNo}">{row.lotNo}</a>
								{/if}
								<span class="faint">{row.itemNo} · {row.description}</span>
							</div>
							<div class="right">
								{#each row.shipments as ship (ship.shipmentNo)}
									<span class="chip">{ship.shipmentNo} · {ship.customerName}</span>
								{/each}
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="empty">Nothing has been made from this lot yet.</p>
			{/if}
		</section>
	</div>

	<p class="foot faint">
		Both walks come from one table of consumptions, so a lot that went into two parents is counted
		once in each and never twice in either. A certificate on the metal counts for everything made
		from it, at any depth, which is why a finished part can carry a mill certificate it does not
		itself own.
	</p>
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

	.tree {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: 6px var(--space-3);
	}

	.tree .right {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
	}

	.foot {
		margin: 0;
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
