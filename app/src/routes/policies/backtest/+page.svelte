<script lang="ts">
	// What the margin floor would have done. Two runs over the same window,
	// one at the floor in force and one at the floor being tried, so the only
	// difference between them is the policy.
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import TableSkeleton from '$lib/components/policy/TableSkeleton.svelte';
	import { count, money, moneyExact, percent } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const asPercent = (ratio: number) => `${Math.round(ratio * 1000) / 10}%`;
</script>

<svelte:head>
	<title>What the margin floor would have done · Northline</title>
</svelte:head>

<main class="page">
	<header class="page-head">
		<div class="titles">
			<h1>What the margin floor would have done</h1>
			<p class="faint">
				Every invoice line carries the cost that applied on the day it was posted, so the margin on every
				line ever sold is a fact rather than a model. This runs a proposed floor over a window of that
				ledger and says what was under it, what holding to it would have added, and what was riding on
				those lines in the first place.
			</p>
		</div>
		<div class="actions">
			<a class="button quiet" href="/policies?type=commercial.min_margin">
				<ArrowLeft size={14} strokeWidth={1.75} aria-hidden="true" />
				The policy
			</a>
		</div>
	</header>

	<section class="panel">
		<div class="panel-head">
			<h2>Try a floor</h2>
			<span class="faint">{data.floorExplanation}</span>
		</div>
		<form class="ask" method="GET">
			<label>
				Floor to try
				<input name="floor" value={Math.round(data.proposed * 1000) / 10} inputmode="decimal" />
				<span class="field-help">a percentage, so 25 or 0.25</span>
			</label>
			<label>
				From
				<input type="date" name="from" value={data.from} />
			</label>
			<label>
				To
				<input type="date" name="to" value={data.to} />
			</label>
			<div class="go"><button class="button primary" type="submit">Run it</button></div>
		</form>
	</section>

	{#await Promise.all([data.atNow, data.atProposed])}
		<section class="panel">
			<div class="panel-head"><h2>Working it out</h2></div>
			<TableSkeleton rows={6} label="Working out what the floor would have done" />
		</section>
	{:then [now, proposed]}
		<dl class="panel figures">
			<div>
				<dt>Sold in the window</dt>
				<dd>{money(proposed.revenue)}</dd>
				<span class="note">
					{count(proposed.lines)} lines, {count(proposed.accountCount)} accounts, margin {proposed.marginPct ===
					null
						? '·'
						: percent(proposed.marginPct)}
				</span>
			</div>
			<div>
				<dt>Under {asPercent(proposed.floor)}</dt>
				<dd>{money(proposed.revenueBelow)}</dd>
				<span class="note">
					{count(proposed.linesBelow)} lines at {count(proposed.accountsBelow)} accounts, {asPercent(
						proposed.shareOfRevenueBelow
					)} of revenue
				</span>
			</div>
			<div>
				<dt>Margin it would have added</dt>
				<dd>{money(proposed.marginGained)}</dd>
				<span class="note">if every one of them had still bought</span>
			</div>
			<div>
				<dt>Under the floor in force</dt>
				<dd>{money(now.revenueBelow)}</dd>
				<span class="note">
					{count(now.linesBelow)} lines at {data.floorNowWords}, worth {money(now.marginGained)} to hold
				</span>
			</div>
		</dl>

		<p class="notice" role="status">
			At {asPercent(proposed.floor)}, {count(proposed.linesBelow)} of {count(proposed.lines)} lines in this
			window were priced under the floor. Repricing every one of them to clear it would have added
			{moneyExact(proposed.marginGained)} of margin, taking the book from
			{proposed.marginPct === null ? '·' : percent(proposed.marginPct)} to
			{proposed.marginPctAfter === null ? '·' : percent(proposed.marginPctAfter)}. Refusing every one of
			them instead would have cost {moneyExact(proposed.revenueBelow)} of revenue and
			{moneyExact(proposed.marginBelow)} of the margin that came with it. The truth is between those two
			and nothing in this database knows where.
		</p>

		<section class="panel">
			<div class="panel-head">
				<h2>Where it lands</h2>
				<span class="faint">the accounts with the most to gain, longest first</span>
			</div>
			{#if proposed.accounts.length === 0}
				<p class="empty">Nothing was invoiced in this window.</p>
			{:else}
				<div class="table-wrap" tabindex="-1">
					<table class="sticky">
						<thead>
							<tr>
								<th scope="col">Account</th>
								<th scope="col" class="num">Revenue</th>
								<th scope="col" class="num">Margin</th>
								<th scope="col" class="num">Lines under</th>
								<th scope="col" class="num">Revenue under</th>
								<th scope="col" class="num">Would have added</th>
								<th scope="col" class="num">Worst line</th>
							</tr>
						</thead>
						<tbody>
							{#each proposed.accounts as account (account.customerNo)}
								<tr>
									<th scope="row">
										<a href="/accounts/{account.customerNo}">{account.customerName}</a>
										<span class="faint">{account.customerNo}</span>
									</th>
									<td class="num">{money(account.revenue)}</td>
									<td class="num">
										{account.marginPct === null ? '·' : percent(account.marginPct)}
									</td>
									<td class="num">
										{account.linesBelow === 0 ? '·' : count(account.linesBelow)}
										<span class="faint">of {count(account.lines)}</span>
									</td>
									<td class="num">{account.revenueBelow === 0 ? '·' : money(account.revenueBelow)}</td>
									<td class="num">
										<strong>{account.marginGained === 0 ? '·' : money(account.marginGained)}</strong>
									</td>
									<td class="num" class:negative={(account.worstMarginPct ?? 1) < 0}>
										{account.worstMarginPct === null ? '·' : percent(account.worstMarginPct)}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
			<p class="panel-body faint">
				Credit memos and price corrections are left out, because a return is not a pricing decision, and
				so is freight, which sits on the invoice header and never on a line. What is not here at all is
				whether the customer would have paid the higher price, which is the whole of the risk and is in
				nobody's database.
			</p>
		</section>
	{:catch}
		<p class="notice error" role="alert">This could not be worked out.</p>
	{/await}
</main>

<style>
	.ask {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	.ask > label {
		flex: 1 1 150px;
		min-width: 0;
	}

	.go {
		display: flex;
		gap: var(--space-2);
	}

	.notice {
		max-width: var(--measure);
		line-height: 1.5;
	}

	th[scope='row'] {
		display: grid;
		gap: 1px;
		font-weight: 500;
		color: var(--text);
		border-bottom: 1px solid var(--hairline);
		white-space: normal;
		max-width: 28ch;
	}

	th[scope='row'] .faint {
		font-size: var(--fs-meta);
	}

	td .faint {
		font-size: var(--fs-meta);
	}
</style>
