<script lang="ts">
	/*
	  Purchase and production orders that are late or that moved after they
	  were promised, each one reaching the part and the vendor behind it.

	  Two dates per row, because they answer two different questions: due_on is
	  when the vendor now says it will arrive, and the original promise is what
	  they said first. A row where those differ is a supplier moving the
	  goalposts, which is a conversation; a row that is simply past due is a
	  phone call.
	*/
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { count } from '$lib/format';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import type { LateSupplyRow } from '$lib/server/overview/risk';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<Page title="Late supply" documentTitle="Late supply">
	{#snippet breadcrumb()}
		<a class="link-quiet" href={data.nav.overview}>
			<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
			Overview
		</a>
	{/snippet}

	{#snippet actions()}
		<a class="button sm" href={data.nav.forecast}>The order lines waiting on them</a>
	{/snippet}

	{#await data.lateSupply}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={12} cols={7} height={32} header label="Reading the supply orders" />
		</section>
	{:then late}
		<Panel
			title="Purchase and production orders that are late"
			asOf={late.today}
			thisYear={data.year}
			source="the ERP export and the procurement desk"
			flush
		>
			<p class="t-meta muted note">{late.note}</p>
			<DataTable
				columns={[
					{ key: 'doc', header: 'Order' },
					{ key: 'part', header: 'Part' },
					{ key: 'qty', header: 'Quantity', align: 'right' },
					{ key: 'due', header: 'Due now' },
					{ key: 'promised', header: 'First promised' },
					{ key: 'state', header: 'What is wrong' },
					{ key: 'vendor', header: 'Vendor' }
				]}
				rows={late.rows}
				rowKey={(row: LateSupplyRow) => `${row.source}:${row.documentNo}:${row.lineNo ?? 0}`}
				caption="Supply orders past their due date or moved after they were promised, worst first"
				shown={late.rows.length}
				total={late.rows.length}
				noun="supply orders"
				order="past due first, then by how late"
				emptyLine="No purchase or production order is late or has slipped."
			>
				{#snippet row(order: LateSupplyRow)}
					<td>
						<span class="mono">{order.documentNo}</span>
						<span class="t-meta muted block">{order.source}</span>
					</td>
					<td>
						<a class="link mono" href={order.partHref}>{order.itemNo}</a>
						<span class="t-meta muted block">{order.description}</span>
					</td>
					<td class="num">{count(order.quantity)}</td>
					<td>{order.dueOn}</td>
					<td>{order.originalPromisedOn ?? '-'}</td>
					<td>
						{#if order.pastDue}
							<span class="dangerword">
								past due{order.daysLate ? ` by ${order.daysLate} days` : ''}
							</span>
						{/if}
						{#if order.slipped}
							<span class="t-meta warnword block">
								moved{order.daysSlipped ? ` ${order.daysSlipped} days later` : ''} than promised
							</span>
						{/if}
					</td>
					<td>
						{#if order.vendorHref && order.vendorName}
							<a class="link" href={order.vendorHref}>{order.vendorName}</a>
						{:else}
							<span class="muted">made here</span>
						{/if}
					</td>
				{/snippet}
			</DataTable>
		</Panel>
	{:catch}
		<LoadFailed what="the late supply orders" />
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

	.dangerword {
		color: var(--danger);
		font-weight: 500;
	}

	.warnword {
		color: var(--warning);
	}
</style>
