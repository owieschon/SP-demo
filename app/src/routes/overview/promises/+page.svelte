<script lang="ts">
	/*
	  The windows behind the promise figures, and the accounts whose windows
	  keep not holding. Each row reaches the commitment itself, and that page
	  lists the invoice lines that counted, which is where the chain ends.
	*/
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { money, percentFloor } from '$lib/format';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import type { SlippingAccount } from '$lib/server/overview/types';
	import type { WindowRowOut } from '$lib/server/overview/promises';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Page title="Commitment windows" documentTitle="Commitment windows">
	{#snippet breadcrumb()}
		<a class="link-quiet" href={data.nav.overview}>
			<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
			Overview
		</a>
	{/snippet}

	{#snippet actions()}
		<a class="button sm" href={data.nav.all}>All</a>
		<a class="button sm" href={data.nav.kept}>Kept</a>
		<a class="button sm" href={data.nav.pushed}>Pushed</a>
		<a class="button sm" href={data.nav.broken}>Broken</a>
	{/snippet}

	{#await data.promises}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={10} cols={6} height={32} header label="Reading the commitment board" />
		</section>
	{:then promises}
		<Panel
			title={promises.customerName ? `Windows for ${promises.customerName}` : 'Windows that closed'}
			asOf={promises.today}
			thisYear={data.year}
			source="the commitment board"
			flush
		>
			<p class="t-meta muted note">{promises.note}</p>
			<DataTable
				columns={[
					{ key: 'window', header: 'Commitment' },
					{ key: 'account', header: 'Account' },
					{ key: 'status', header: 'Outcome' },
					{ key: 'committed', header: 'Committed', align: 'right' },
					{ key: 'delivered', header: 'Delivered', align: 'right' },
					{ key: 'closed', header: 'Closed' }
				]}
				rows={promises.rows}
				rowKey={(row: WindowRowOut) => row.id}
				caption="Commitment windows that closed in the last year, with what landed against each"
				shown={promises.rows.length}
				total={promises.rows.length}
				noun="windows"
				order="most recently closed first"
				emptyLine="No window closed in this window of time."
			>
				{#snippet row(item: WindowRowOut)}
					<td>
						<a class="link" href={item.href}>{item.title}</a>
						<span class="t-meta muted block">{item.startsOn} to {item.endsOn}</span>
					</td>
					<td><a class="link" href={item.accountHref}>{item.customerName}</a></td>
					<td>
						<span class="status status-{item.status}">{item.status}</span>
						{#if item.needsOutcome}
							<span class="t-meta warnword block">nobody has answered</span>
						{:else if item.outcomeNote}
							<span class="t-meta muted block">{item.outcomeNote}</span>
						{/if}
					</td>
					<td class="num">{money(item.committed)}</td>
					<td class="num">
						{money(item.delivered)}
						<span class="t-meta muted block">{percentFloor(item.deliveredRatio)}</span>
					</td>
					<td>
						{item.endsOn}
						{#if item.daysSinceClose !== null}
							<span class="t-meta muted block">{item.daysSinceClose} days ago</span>
						{/if}
					</td>
				{/snippet}
			</DataTable>
		</Panel>

		<Panel
			title="Accounts whose windows keep not holding"
			asOf={promises.today}
			thisYear={data.year}
			source="windows that closed in the last year"
			flush
		>
			{#if promises.slipping.length === 0}
				<p class="t-meta muted note">
					No account has had a window pushed or broken in the last year.
				</p>
			{:else}
				<DataTable
					columns={[
						{ key: 'account', header: 'Account' },
						{ key: 'missed', header: 'Missed', align: 'right' },
						{ key: 'windows', header: 'Windows closed', align: 'right' },
						{ key: 'committed', header: 'Promised', align: 'right' },
						{ key: 'delivered', header: 'Delivered', align: 'right' },
						{ key: 'last', header: 'Last closed' }
					]}
					rows={promises.slipping}
					rowKey={(row: SlippingAccount) => row.customerNo}
					caption="Accounts by how many of their recent windows were pushed or broken"
					shown={promises.slipping.length}
					total={promises.slipping.length}
					noun="accounts"
					order="worst first"
					emptyLine="Nobody is slipping."
				>
					{#snippet row(account: SlippingAccount)}
						<td>
							<a class="link" href={account.href}>{account.customerName}</a>
							<span class="t-meta muted block mono">{account.customerNo}</span>
						</td>
						<td class="num">
							{account.pushed + account.broken}
							<span class="t-meta muted block">{account.pushed} pushed, {account.broken} broken</span>
						</td>
						<td class="num">{account.windows}</td>
						<td class="num">{money(account.committed)}</td>
						<td class="num">{money(account.delivered)}</td>
						<td>
							{account.lastClosedOn}
							<span class="t-meta block"><a class="link" href={account.accountHref}>The account</a></span>
						</td>
					{/snippet}
				</DataTable>
			{/if}
		</Panel>
	{:catch}
		<LoadFailed what="the commitment windows" />
	{/await}
</Page>

<style>
	.block {
		display: block;
	}

	.note {
		padding: var(--space-3) var(--space-3) 0;
		max-width: var(--measure);
	}

	.warnword {
		color: var(--warning);
	}

	.status {
		font-weight: 500;
	}

	.status-kept {
		color: var(--status-kept);
	}

	.status-pushed {
		color: var(--status-pushed);
	}

	.status-broken {
		color: var(--status-broken);
	}
</style>
