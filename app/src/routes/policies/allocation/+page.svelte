<script lang="ts">
	// The allocation priority policy, and the lines it moves.
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import TableSkeleton from '$lib/components/policy/TableSkeleton.svelte';
	import { count, day } from '$lib/format';
	import { SCOPE_LABEL } from '$lib/policy/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const year = new Date().getFullYear();

	const BUCKET_WORDS: Record<string, string> = {
		past_due: 'past due',
		at_risk: 'at risk',
		on_pace: 'on pace',
		later: 'later'
	};
</script>

<svelte:head>
	<title>Allocation priority · Northline</title>
</svelte:head>

<main class="page">
	<header class="page-head">
		<div class="titles">
			<h1>Allocation priority</h1>
			<p class="faint">
				Stock goes to the oldest ship date, per part. That is fair, and it is not what a parts business
				does when a fleet is off the road. The priority list is a policy now, so it is data with a date
				and a reason on it, and this page shows exactly which lines it moves.
			</p>
		</div>
		<div class="actions">
			<a class="button quiet" href="/policies?type=fulfilment.allocation_priority">
				<ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
				The policy
			</a>
		</div>
	</header>

	{#await data.summary then summary}
		<dl class="panel figures">
			<div>
				<dt>Open lines</dt>
				<dd>{count(summary.lines)}</dd>
				<span class="note">from the last applied export</span>
			</div>
			<div>
				<dt>Behind a priority</dt>
				<dd>{count(summary.prioritized)}</dd>
				<span class="note">an account or its price group has one</span>
			</div>
			<div>
				<dt>Lines that move</dt>
				<dd>{count(summary.moved)}</dd>
				<span class="note">a different quantity than ship-date order gives</span>
			</div>
		</dl>
	{/await}

	<section class="panel">
		<div class="panel-head">
			<h2>The list</h2>
			<span class="faint">higher goes first; nothing set means the ship date decides</span>
		</div>
		{#await data.priorities}
			<TableSkeleton rows={3} label="Loading the priority list" />
		{:then priorities}
			{#if priorities.length === 0}
				<p class="empty">
					Nobody has a priority, so allocation is plain ship-date order.
					<a class="button" href="/policies?type=fulfilment.allocation_priority">Set one</a>
				</p>
			{:else}
				<div class="table-wrap" tabindex="-1">
					<table>
						<thead>
							<tr>
								<th scope="col">Applies to</th>
								<th scope="col" class="num">Priority</th>
								<th scope="col">From</th>
								<th scope="col">Why</th>
							</tr>
						</thead>
						<tbody>
							{#each priorities as row (row.id)}
								<tr>
									<th scope="row">
										<span>{SCOPE_LABEL[row.scopeKind]}</span>
										<span class="faint">{row.scopeLabel}</span>
									</th>
									<td class="num"><strong>{row.valueWords}</strong></td>
									<td class="nowrap faint">{day(row.effectiveFrom, year)}</td>
									<td class="why">{row.note}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		{/await}
	</section>

	<section class="panel">
		<div class="panel-head">
			<h2>What it moves</h2>
			<span class="faint">against plain ship-date order, part by part</span>
		</div>
		{#await data.moves}
			<TableSkeleton rows={6} label="Working out what the priority moves" />
		{:then moves}
			{#if moves.length === 0}
				<p class="empty">
					Nothing moves today. Either nobody has a priority, or there is enough stock for every line
					that wants it.
				</p>
			{:else}
				<div class="table-wrap" tabindex="-1">
					<table class="sticky">
						<thead>
							<tr>
								<th scope="col">Part</th>
								<th scope="col">Line</th>
								<th scope="col">Account</th>
								<th scope="col">Ships</th>
								<th scope="col" class="num">Wanted</th>
								<th scope="col" class="num">By date</th>
								<th scope="col" class="num">By priority</th>
								<th scope="col">Bucket</th>
							</tr>
						</thead>
						<tbody>
							{#each moves as move (move.documentNo + ':' + move.lineNo)}
								<tr>
									<th scope="row">
										<span class="mono">{move.itemNo}</span>
										<span class="faint">{move.description}</span>
									</th>
									<td class="mono faint nowrap">{move.documentNo}:{move.lineNo}</td>
									<td>
										<span>{move.customerName}</span>
										<span class="faint">
											{move.priorityRank > 0 ? `priority ${move.priorityRank}` : 'no priority'}
										</span>
									</td>
									<td class="nowrap faint">{day(move.shipDate, year)}</td>
									<td class="num">{count(move.quantity)}</td>
									<td class="num faint">{count(move.allocatedByDate)}</td>
									<td class="num">
										<strong class:negative={move.change < 0}>{count(move.allocatedByPriority)}</strong>
										<span class="faint">
											{move.change > 0 ? `+${count(move.change)}` : count(move.change)}
										</span>
									</td>
									<td class="nowrap">
										{#if move.bucketByDate === move.bucketByPriority}
											<span class="chip">{BUCKET_WORDS[move.bucketByPriority]}</span>
										{:else}
											<span class="chip warn">
												{BUCKET_WORDS[move.bucketByDate]} to {BUCKET_WORDS[move.bucketByPriority]}
											</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
				<p class="panel-body faint">
					A line that gains pieces takes them from a line further down the same part, which is the whole
					of what a priority list does: it does not make stock, it decides who waits.
				</p>
			{/if}
		{:catch}
			<p class="notice error" role="alert">This could not be worked out.</p>
		{/await}
	</section>
</main>

<style>
	th[scope='row'],
	td {
		white-space: normal;
	}

	th[scope='row'] {
		display: grid;
		gap: 1px;
		font-weight: 500;
		color: var(--text);
		border-bottom: 1px solid var(--hairline);
		max-width: 28ch;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: var(--fs-meta);
	}

	.why {
		max-width: 46ch;
		font-size: var(--fs-meta);
	}

	.nowrap {
		white-space: nowrap;
	}

	td span.faint {
		display: block;
		font-size: var(--fs-meta);
	}
</style>
