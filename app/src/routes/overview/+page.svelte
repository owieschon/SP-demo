<script lang="ts">
	/*
	  The overview. Four questions, in the order somebody asks them.

	  The rule this page is held to, and the only one that keeps it from
	  becoming a complicated dashboard: every number on it is a link, and the
	  chain does not break. Aggregate, then segment, then the record, then the
	  evidence that produced the figure. The top numbers are a doorway.

	  Two house rules are visible in the markup. There is no tile without
	  something to compare against, which the Figure type makes impossible.
	  And there is one chart, which carries a reference line: each month
	  against the same month a year earlier.
	*/
	import { money } from '$lib/format';
	import Figures from '$lib/components/overview/Figures.svelte';
	import LeakList from '$lib/components/overview/LeakList.svelte';
	import RevenueChart from '$lib/components/overview/RevenueChart.svelte';
	import AgentTable from '$lib/components/overview/AgentTable.svelte';
	import DeskCards from '$lib/components/overview/DeskCards.svelte';
	import ValueLedger from '$lib/components/overview/ValueLedger.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Page
	title="Overview"
	documentTitle="Overview"
	subtitle="The whole business at a distance. Every number here is a link, and it keeps going until it reaches the invoice line, the run or the policy value behind it."
>
	{#snippet actions()}
		<a class="button" href={data.nav.runs}>What the agents did</a>
	{/snippet}

	<!-- 1 ------------------------------------------------------ the money -->

	{#await data.money}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={3} cols={3} height={56} label="Measuring the ledger" />
		</section>
	{:then money}
		<Panel
			title="Is the money where it should be?"
			asOf={money.today}
			thisYear={data.year}
			source="the invoice ledger"
		>
			{#snippet actions()}
				<a class="button sm" href={data.nav.revenue}>Month by month</a>
			{/snippet}
			<Figures figures={money.figures} asOf={money.today} year={data.year} />
			<div class="chart">
				<RevenueChart months={money.months} href={data.nav.revenue} />
			</div>
			{#if !money.showsMargin}
				<p class="t-meta muted">
					Cost and margin are not shown at your disclosure level, so they are not in this page at all.
				</p>
			{/if}
		</Panel>

		<Panel title="Where is it leaking?" asOf={money.today} thisYear={data.year} source="the last twelve months" flush>
			<LeakList leaks={money.leaks} />
			<p class="t-meta muted note">
				Three leaks, three questions, each drilling to the customers and parts and then to the invoice
				lines. They are reported one at a time and never added together: the frozen agreement and the cost
				rise can be the same dollar seen from the account side and from the part side.
			</p>
		</Panel>
	{:catch}
		<LoadFailed what="the money figures" />
	{/await}

	<!-- 2 --------------------------------------------------- the promises -->

	{#await data.promises}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={3} cols={4} height={56} label="Counting what we promised" />
		</section>
	{:then promises}
		<Panel
			title="Are we keeping our promises?"
			asOf={promises.today}
			thisYear={data.year}
			source="the commitment board and the open order forecast"
		>
			<Figures figures={promises.figures} asOf={promises.today} year={data.year} />
		</Panel>

		<Panel
			title="Whose windows are not holding"
			asOf={promises.today}
			thisYear={data.year}
			source="windows that closed in the last year"
			flush
		>
			{#snippet actions()}
				<a class="button sm" href={data.nav.promises}>Every window</a>
			{/snippet}
			{#if promises.slipping.length === 0}
				<p class="t-meta muted note">
					No account has had a window pushed or broken in the last year. Nothing to chase.
				</p>
			{:else}
				<ul class="rows">
					{#each promises.slipping as account (account.customerNo)}
						<li>
							<a class="slip" href={account.href}>
								<span class="tally num">{account.pushed + account.broken}</span>
								<span class="what">
									<span class="title">{account.customerName}</span>
									<span class="detail">
										{account.pushed} pushed and {account.broken} broken of {account.windows}
										{account.windows === 1 ? 'window' : 'windows'} that closed, worth
										{money(account.committed)} promised against {money(account.delivered)} delivered.
										Last one closed {account.lastClosedOn}.
									</span>
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{:catch}
		<LoadFailed what="the promise figures" />
	{/await}

	<!-- 3 ------------------------------------------------------ the agents -->

	{#await data.agents}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={5} cols={8} height={32} header label="Reading the agent harness" />
		</section>
	{:then agents}
		<Panel title="Are the agents earning trust?" source="the agent harness">
			{#snippet actions()}
				<a class="button sm" href={data.nav.runs}>The run feed</a>
			{/snippet}
			<Figures figures={agents.figures} />
			{#if agents.rows.every((row) => row.runs === 0)}
				<p class="t-meta muted">
					No agent has run in this database yet, so every number here is a zero rather than a verdict.
					The desks start a run when they read their mail.
				</p>
			{/if}
		</Panel>

		<!--
			One card per agent, side by side. The order desk and the procurement
			desk are never added together: they do different work for different
			counterparties and their trust is earned separately.
		-->
		<Panel title="Each agent on its own" source="the harness board, per agent">
			<DeskCards desks={agents.desks} />
			<div class="table">
				<AgentTable rows={agents.rows} />
			</div>
		</Panel>

		<Panel title="What the agents did this week" source="the last seven days" flush>
			<ValueLedger lines={agents.value} caveat={agents.valueCaveat} />
		</Panel>
	{:catch}
		<LoadFailed what="the agent figures" />
	{/await}

	<!-- 4 -------------------------------------------------------- the risk -->

	{#await data.risk}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={2} cols={4} height={56} label="Looking for what is at risk" />
		</section>
	{:then risk}
		<Panel
			title="What is at risk right now?"
			asOf={risk.today}
			thisYear={data.year}
			source="the forecast, the queue and the book"
		>
			<Figures figures={risk.figures} asOf={risk.today} year={data.year} />
		</Panel>

		<!--
			Left out entirely when the role model is not in this database, rather
			than shown as four zeros that would read as good news.
		-->
		{#if risk.coverage}
			<Panel
				title="Who is answering for what"
				asOf={risk.today}
				thisYear={data.year}
				source="named scope, not oversight"
			>
				<Figures figures={risk.coverage.figures} asOf={risk.today} year={data.year} />
				<p class="t-meta muted lede-note">{risk.coverage.note}</p>
			</Panel>
		{/if}
	{:catch}
		<LoadFailed what="what is at risk" />
	{/await}
</Page>

<style>
	.chart {
		margin-top: var(--space-4);
		padding-top: var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	.table {
		margin-top: var(--space-4);
	}

	.lede-note {
		margin: var(--space-3) 0 0;
		max-width: var(--measure);
	}

	.note {
		padding: var(--space-3);
		max-width: var(--measure);
	}

	/* ------------------------------------------- the accounts that slipped */

	.slip {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.slip:hover {
		background: var(--surface-hover);
	}

	.slip:active {
		background: var(--surface-press);
	}

	.tally {
		flex: none;
		min-width: 2.5ch;
		font-size: var(--fs-title);
		font-weight: 600;
		color: var(--warning);
	}

	.what {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	.title {
		font-weight: 500;
	}

	.detail {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}
</style>
