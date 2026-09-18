<script lang="ts">
	/*
	  Who is answering for what, and what nobody is answering for.

	  The distinction this page exists to make is said at the top, because it
	  is the one a reader will get wrong: scope decides who may see and touch a
	  thing, and the chief executive holds every dimension, so by scope nothing
	  is uncovered. Accountability is somebody named against that particular
	  account, family or inbox. Oversight is not accountability.
	*/
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Check from '@lucide/svelte/icons/check';
	import { count, money } from '$lib/format';
	import DataTable from '$lib/components/ui/DataTable.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import type { BeyondAuthorityRow, GapRow } from '$lib/server/overview/types';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const KIND_TITLE: Record<string, string> = {
		account: 'Accounts nobody is answerable for',
		part_family: 'Part families nobody plans',
		mailbox: 'Inboxes nobody reads'
	};
</script>

<Page
	title="Coverage of responsibility"
	documentTitle="Coverage of responsibility"
	subtitle={data.coverage.note}
>
	{#snippet breadcrumb()}
		<a class="link-quiet" href={data.nav.overview}>
			<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
			Overview
		</a>
	{/snippet}

	{#snippet actions()}
		<a class="button sm" href={data.coverage.peopleHref}>Who may decide what</a>
	{/snippet}

	<Panel title="The three gaps" asOf={data.coverage.today} thisYear={data.year} flush>
		<ul class="rows">
			{#each data.coverage.counts as gap (gap.kind)}
				<li>
					<a class="row" href={gap.href} class:current={gap.kind === data.coverage.kind}>
						<span class="tally num" class:zero={gap.count === 0}>
							{#if gap.count === 0}
								<span class="tick" aria-hidden="true"><Check size={16} strokeWidth={2} /></span>
							{:else}
								{count(gap.count)}
							{/if}
						</span>
						<span class="what">
							<span class="title">{gap.label}</span>
							<span class="detail">
								{#if gap.count === 0}
									Every one of them has somebody named against it.
								{:else if gap.amount > 0}
									{money(gap.amount)} of invoice lines behind them in the last year.
								{:else}
									Nothing has been billed against them in the last year.
								{/if}
							</span>
						</span>
					</a>
				</li>
			{/each}
		</ul>
	</Panel>

	<Panel
		title="Decisions above every ceiling"
		asOf={data.coverage.today}
		thisYear={data.year}
		source="live authority grants"
		flush
	>
		<DataTable
			columns={[
				{ key: 'authority', header: 'Authority' },
				{ key: 'ceiling', header: 'Highest ceiling anybody holds', align: 'right' },
				{ key: 'waiting', header: 'Waiting above it', align: 'right' },
				{ key: 'value', header: 'Worth', align: 'right' },
				{ key: 'go', header: 'Queue', hideHeader: true }
			]}
			rows={data.coverage.beyondAuthority}
			rowKey={(row: BeyondAuthorityRow) => row.authority}
			caption="For each amount authority, the highest ceiling anybody active holds and what is waiting above it"
			shown={data.coverage.beyondAuthority.length}
			total={data.coverage.beyondAuthority.length}
			noun="authorities"
			order="as the model lists them"
			emptyLine="No amount authority is defined."
		>
			{#snippet row(item: BeyondAuthorityRow)}
				<td>
					{item.label}
					<span class="t-meta muted block">{item.what}</span>
				</td>
				<td class="num">
					{#if item.ceiling === null}
						<span class="muted">no ceiling</span>
					{:else}
						{money(item.ceiling)}
					{/if}
				</td>
				<td class="num" class:dangerword={item.waiting > 0}>{count(item.waiting)}</td>
				<td class="num">{item.waiting === 0 ? '-' : money(item.value)}</td>
				<td><a class="link" href={item.href}>The queue</a></td>
			{/snippet}
		</DataTable>
	</Panel>

	{#if data.coverage.kind}
		<Panel
			title={KIND_TITLE[data.coverage.kind]}
			asOf={data.coverage.today}
			thisYear={data.year}
			source="named scope, not oversight"
			flush
		>
			<DataTable
				columns={[
					{ key: 'thing', header: 'What' },
					{ key: 'why', header: 'Why nobody answers for it' },
					{ key: 'amount', header: 'Last year', align: 'right' },
					{ key: 'lines', header: data.coverage.kind === 'account' ? 'Lines' : 'Behind it', align: 'right' },
					{ key: 'go', header: 'Record', hideHeader: true }
				]}
				rows={data.coverage.rows}
				rowKey={(row: GapRow) => `${row.kind}:${row.ref}`}
				caption="Things nobody is answerable for, by what has been billed against them in the last year"
				shown={data.coverage.rows.length}
				total={data.coverage.rows.length}
				noun="things"
				order="biggest first"
				emptyLine="Nothing of this kind is uncovered."
			>
				{#snippet row(gap: GapRow)}
					<td>
						{gap.subject}
						<span class="t-meta muted block mono">{gap.ref}</span>
					</td>
					<td>{gap.why}</td>
					<td class="num">{gap.amount === 0 ? '-' : money(gap.amount)}</td>
					<td class="num">{count(gap.lines)}</td>
					<td>
						{#if gap.href}
							<a class="link" href={gap.href}>{gap.hrefLabel}</a>
						{:else}
							<a class="link" href={data.coverage.peopleHref}>Assign somebody</a>
						{/if}
					</td>
				{/snippet}
			</DataTable>
		</Panel>
	{/if}
</Page>

<style>
	.block {
		display: block;
	}

	.dangerword {
		color: var(--danger);
		font-weight: 500;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row.current {
		background: var(--surface-selected);
	}

	.tally {
		flex: none;
		min-width: 3ch;
		font-size: var(--fs-title);
		font-weight: 600;
		color: var(--warning);
	}

	.tally.zero {
		color: var(--status-kept);
	}

	.tick {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-full);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
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
