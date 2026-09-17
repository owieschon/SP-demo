<script lang="ts">
	// The accounts list: one dense row per account, hairlines between them,
	// the whole row linking to the account. The revenue column compares this
	// year with the same days last year, so a part-finished year is not
	// measured against a whole one.
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import { count, day, money, percent, place } from '$lib/format';
	import type { AccountFilters, AccountPage, AccountSort } from './types';

	let {
		accounts,
		filters,
		year,
		hrefFor
	}: {
		accounts: AccountPage;
		filters: AccountFilters;
		year: number;
		/** Builds a link that keeps the current filters and changes one thing. */
		hrefFor: (changes: Record<string, string>) => string;
	} = $props();

	const SORTS: { value: AccountSort; label: string }[] = [
		{ value: 'revenue', label: 'Revenue' },
		{ value: 'quiet', label: 'Quiet' },
		{ value: 'name', label: 'Name' }
	];

	const firstRow = $derived((accounts.page - 1) * accounts.pageSize + 1);
	const lastRow = $derived(Math.min(accounts.page * accounts.pageSize, accounts.total));
	const morePages = $derived(accounts.page * accounts.pageSize < accounts.total);

	/** How this year compares with the same part of last year. */
	function trend(now: number, before: number): { text: string; tone: 'up' | 'down' | 'flat' } {
		if (before <= 0) return { text: now > 0 ? 'new this year' : '', tone: 'flat' };
		const change = (now - before) / before;
		if (Math.abs(change) < 0.03) return { text: 'level with last year', tone: 'flat' };
		return {
			text: `${percent(Math.abs(change))} ${change > 0 ? 'up on' : 'down on'} last year`,
			tone: change > 0 ? 'up' : 'down'
		};
	}
</script>

<section class="panel" aria-labelledby="accounts-title">
	<header class="panel-head">
		<h2 id="accounts-title">
			{count(accounts.total)} {accounts.total === 1 ? 'account' : 'accounts'}
			{#if accounts.total > accounts.pageSize}
				<span class="faint">· {count(firstRow)} to {count(lastRow)}</span>
			{/if}
		</h2>
		<div class="sort">
			<span class="faint">Sort</span>
			<div class="segmented" role="group" aria-label="Sort the accounts">
				{#each SORTS as option (option.value)}
					<a
						href={hrefFor({ sort: option.value, page: '1' })}
						aria-current={filters.sort === option.value ? 'true' : undefined}
					>
						{option.label}
					</a>
				{/each}
			</div>
		</div>
	</header>

	{#if accounts.rows.length === 0}
		<p class="body muted">
			No account matches this search.
			<a class="link" href={hrefFor({ q: '', state: '', group: '', quiet: '', open: '', page: '1' })}>
				Clear the filters
			</a>
			to see the whole book.
		</p>
	{:else}
		<ul class="rows">
			{#each accounts.rows as row (row.customerNo)}
				{@const t = trend(row.revenueYtd, row.revenuePriorYtd)}
				<li class="row">
					<div class="who">
						<a class="name" href="/accounts/{row.customerNo}">{row.name}</a>
						<span class="mono faint num-id">{row.customerNo}</span>
						<div class="under muted">
							{place(row.city, row.state, row.country)}
							{#if row.parentName}<span>billed to {row.parentName}</span>{/if}
							{#if row.branchCount > 0}<span>{count(row.branchCount)} branches</span>{/if}
							{#if row.ownerName}<span>{row.ownerName}</span>{:else}<span>unowned</span>{/if}
							{#if row.primaryContact}<span>{row.primaryContact}</span>{/if}
						</div>
					</div>

					<div class="figures">
						<div class="figure">
							<span class="num strong">{money(row.revenueYtd)}</span>
							<span class="faint small">
								this year{#if t.text}, <span class={t.tone}>{t.text}</span>{/if}
							</span>
						</div>
						<div class="figure">
							{#if row.lastOrderOn}
								<span class="num">{day(row.lastOrderOn, year)}</span>
								<span class="faint small">
									{#if row.typicalGapDays}
										orders every {row.typicalGapDays}d, quiet {row.daysQuiet}d
									{:else}
										last order
									{/if}
								</span>
							{:else}
								<span class="faint">never ordered</span>
							{/if}
						</div>
						<div class="figure">
							{#if row.openCommitments > 0}
								<span class="num">{money(row.openCommitted)}</span>
								<span class="faint small">
									{row.openCommitments} open {row.openCommitments === 1 ? 'commitment' : 'commitments'}
								</span>
							{/if}
						</div>
					</div>

					<div class="chips">
						{#if row.goneQuiet}<span class="chip warn">Gone quiet</span>{/if}
						{#if row.overdueSteps > 0}<span class="chip warn">{row.overdueSteps} overdue</span>{/if}
						{#if row.blocked}<span class="chip">Blocked</span>{/if}
						{#if row.closed}<span class="chip">Closed</span>{/if}
						<span class="chip group">{row.priceGroupLabel}</span>
					</div>

					<div class="actions">
						<!--
							Decoration, not a control. The row's name is already a
							link that stretches over the whole row (.name::after), so
							this was a second link to the same account, announced
							twice and given tabindex="-1" to keep it out of the tab
							order, which left a visible control no keyboard could
							reach. A span says what it is.
						-->
						<span class="button icon action" aria-hidden="true">
							<ArrowRight size={13} strokeWidth={1.75} />
						</span>
					</div>
				</li>
			{/each}
		</ul>

		{#if accounts.total > accounts.pageSize}
			<nav class="pager" aria-label="Pages">
				{#if accounts.page > 1}
					<a class="button" href={hrefFor({ page: String(accounts.page - 1) })}>Previous</a>
				{/if}
				<span class="faint">Page {accounts.page}</span>
				{#if morePages}
					<a class="button" href={hrefFor({ page: String(accounts.page + 1) })}>Next</a>
				{/if}
			</nav>
		{/if}
	{/if}
</section>

<style>
	.body {
		padding: var(--space-3);
	}

	.sort {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	/* Flexbox, not grid: Safari on iOS handles this the same way Chrome does. */
	.row {
		position: relative;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px var(--space-3);
		padding: 8px var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.row + .row {
		border-top: 1px solid var(--hairline);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row:active {
		background: var(--surface-press);
	}

	.who {
		flex: 1 1 240px;
		min-width: 0;
	}

	.name {
		font-weight: 500;
	}

	/* The name link covers the whole row, so anywhere is clickable. */
	.name::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	.name:focus-visible {
		outline: none;
	}

	.name:focus-visible::after {
		outline: 2px solid var(--focus);
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	.num-id {
		margin-left: 6px;
		font-size: 0.85rem;
	}

	.under {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
		font-size: 0.88rem;
	}

	.under > * + *::before {
		content: '·';
		margin-right: var(--space-2);
		color: var(--text-faint);
	}

	.figures {
		display: flex;
		flex: 0 1 auto;
		gap: var(--space-4);
	}

	.figure {
		display: grid;
		justify-items: end;
		min-width: 92px;
	}

	.strong {
		font-weight: 600;
	}

	.small {
		font-size: 0.85rem;
	}

	.up {
		color: var(--status-kept);
	}

	.down {
		color: var(--danger);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-left: auto;
	}

	.chip.group {
		background: transparent;
	}

	.actions {
		position: absolute;
		top: 6px;
		right: var(--space-2);
		z-index: 1;
		opacity: 0;
		transform: translateX(2px);
		transition:
			opacity var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.action.icon {
		width: 22px;
		height: 22px;
		padding: 0;
	}

	/* The decorative chevron must not swallow the row's own click. */
	span.action {
		pointer-events: none;
	}

	.row:hover .actions,
	.row:focus-within .actions {
		opacity: 1;
		transform: none;
	}

	.pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-3);
		padding: var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	/* Touch screens have no hover, so the row action would never appear. */
	@media (hover: none) {
		.actions {
			display: none;
		}
	}

	@media (max-width: 720px) {
		.figures {
			flex-wrap: wrap;
			gap: var(--space-3);
		}

		.figure {
			justify-items: start;
			min-width: 0;
		}

		.chips {
			margin-left: 0;
		}
	}
</style>
