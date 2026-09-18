<script lang="ts">
	/*
	  Revenue, month by month, then one month's accounts, then one account's
	  invoice lines. The second, third and fourth links in the money chain.

	  Every month row says what it is against: the same month a year earlier,
	  and the difference in words as well as in a colour.
	*/
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { count, money, percent } from '$lib/format';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import EvidenceTable from '$lib/components/overview/EvidenceTable.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import type { RevenueAccount, RevenueMonth } from '$lib/server/overview/money';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function monthName(iso: string): string {
		const [year, monthNo] = iso.split('-').map(Number);
		const names = ['January', 'February', 'March', 'April', 'May', 'June',
			'July', 'August', 'September', 'October', 'November', 'December'];
		return `${names[monthNo - 1]} ${year}`;
	}

	/** "up $12,003 (8%)", or "the first year of this month" when there is no prior. */
	function against(now: number, before: number): string {
		if (before === 0) return 'nothing a year earlier';
		const change = now - before;
		const share = Math.abs(change / before);
		if (Math.abs(change) < 1) return `level with ${money(before)}`;
		return `${change > 0 ? 'up' : 'down'} ${money(Math.abs(change))} on ${money(before)}, ${percent(share)}`;
	}
</script>

<Page title="Revenue by month" documentTitle="Revenue by month">
	{#snippet breadcrumb()}
		<a class="link-quiet" href={data.nav.overview}>
			<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
			Overview
		</a>
	{/snippet}

	{#await data.revenue}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={12} cols={5} height={32} header label="Reading the month roll-up" />
		</section>
	{:then revenue}
		<Panel
			title="Two years of months"
			asOf={revenue.today}
			thisYear={data.year}
			source="nl.ledger_month, kept current by triggers"
			flush
		>
			<DataTable
				columns={[
					{ key: 'month', header: 'Month' },
					{ key: 'revenue', header: 'Revenue', align: 'right' },
					{ key: 'prior', header: 'A year earlier', align: 'right' },
					...(revenue.showsMargin
						? [{ key: 'margin', header: 'Gross margin', align: 'right' as const }]
						: []),
					{ key: 'lines', header: 'Lines', align: 'right' },
					{ key: 'change', header: 'Against last year' }
				]}
				rows={revenue.months}
				rowKey={(row: RevenueMonth) => row.month}
				caption="Revenue per month for two years, each against the same month a year earlier"
				shown={revenue.months.length}
				total={revenue.months.length}
				noun="months"
				order="newest first"
				emptyLine="The ledger has no months in it yet."
			>
				{#snippet row(item: RevenueMonth)}
					<td>
						<a class="link" href={item.href}>{monthName(item.month)}</a>
						{#if item.partial}<span class="t-meta muted">still running</span>{/if}
					</td>
					<td class="num">{money(item.revenue)}</td>
					<td class="num">{money(item.priorRevenue)}</td>
					{#if revenue.showsMargin}
						<td class="num">{money(item.revenue - (item.costOfGoods ?? 0))}</td>
					{/if}
					<td class="num">{count(item.lines)}</td>
					<td class:down={item.revenue < item.priorRevenue}>
						{against(item.revenue, item.priorRevenue)}
					</td>
				{/snippet}
			</DataTable>
		</Panel>

		{#if revenue.month}
			<Panel
				title="{monthName(revenue.month)}: who bought"
				asOf={revenue.today}
				thisYear={data.year}
				source="invoice lines posted in the month"
				flush
			>
				<DataTable
					columns={[
						{ key: 'account', header: 'Account' },
						{ key: 'revenue', header: 'Revenue', align: 'right' },
						{ key: 'prior', header: 'Same month last year', align: 'right' },
						{ key: 'lines', header: 'Lines', align: 'right' },
						{ key: 'go', header: 'Evidence', hideHeader: true }
					]}
					rows={revenue.accounts}
					rowKey={(row: RevenueAccount) => row.customerNo}
					caption="Accounts by revenue in the month, with the same month a year earlier"
					shown={revenue.accounts.length}
					total={revenue.accounts.length}
					noun="accounts"
					order="biggest first"
					emptyLine="No invoice line was posted in this month."
				>
					{#snippet row(account: RevenueAccount)}
						<td>
							<a class="link" href={account.href}>{account.customerName}</a>
							<span class="t-meta muted block mono">{account.customerNo}</span>
						</td>
						<td class="num">{money(account.revenue)}</td>
						<td class="num">{money(account.priorRevenue)}</td>
						<td class="num">{count(account.lines)}</td>
						<td><a class="link" href={account.linesHref}>Its lines</a></td>
					{/snippet}
				</DataTable>
			</Panel>
		{/if}

		{#if revenue.evidence}
			<Panel title={revenue.evidence.title} asOf={revenue.today} thisYear={data.year} flush>
				<p class="t-meta muted note">{revenue.evidence.note}</p>
				<EvidenceTable
					rows={revenue.evidence.rows}
					caption={revenue.evidence.title}
					refHeader="Invoice"
					labelHeader="Part"
				/>
			</Panel>
		{/if}
	{:catch}
		<LoadFailed what="revenue by month" />
	{/await}
</Page>

<style>
	.block {
		display: block;
	}

	.down {
		color: var(--warning);
	}

	.note {
		padding: var(--space-3) var(--space-3) 0;
		max-width: var(--measure);
	}
</style>
