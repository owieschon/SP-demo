<script lang="ts">
	/*
	  One leak: what it is worth, how it was worked out, who and what is behind
	  it, and then the rows the figure is a sum over.

	  The method is on the page, not in a comment. A chief executive who is
	  going to act on a number is entitled to argue with the way it was
	  arrived at, and a leak nobody can argue with is a leak nobody will act
	  on. An empty leak says "nothing to recover" where the table would be.
	*/
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Check from '@lucide/svelte/icons/check';
	import { count, money, moneyExact, percent } from '$lib/format';
	import EvidenceTable from '$lib/components/overview/EvidenceTable.svelte';
	import LoadFailed from '$lib/components/ui/LoadFailed.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SkeletonRows from '$lib/components/ui/SkeletonRows.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function show(value: number, unit: string): string {
		if (unit === 'money') return Math.abs(value) < 1000 ? moneyExact(value) : money(value);
		if (unit === 'percent') return percent(value);
		return count(value);
	}
</script>

{#await data.leak}
	<Page title="Where is it leaking?" documentTitle="Leak">
		{#snippet breadcrumb()}
			<a class="link-quiet" href={data.nav.overview}>
				<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
				Overview
			</a>
		{/snippet}
		<section class="panel" aria-busy="true">
			<SkeletonRows rows={8} cols={4} height={56} label="Working out the leak" />
		</section>
	</Page>
{:then leak}
	<Page title={leak.name} documentTitle={leak.name} subtitle={leak.question}>
		{#snippet breadcrumb()}
			<a class="link-quiet" href={data.nav.overview}>
				<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
				Overview
			</a>
		{/snippet}

		<Panel title="The figure, and how it was worked out" thisYear={data.year}>
			<p class="headline num" class:clear={leak.rows.length === 0}>
				{#if leak.rows.length === 0}
					<span class="tick" aria-hidden="true"><Check size={20} strokeWidth={2} /></span>
					Nothing to recover
				{:else}
					{money(leak.total)}
				{/if}
			</p>
			<p class="prose">{leak.rows.length === 0 ? leak.nothing : leak.method}</p>
		</Panel>

		{#if leak.rows.length > 0}
			<Panel title="Who and what is behind it" thisYear={data.year} source="biggest first" flush>
				<ul class="rows">
					{#each leak.rows as row (row.key)}
						<li>
							<div class="seg">
								<span class="amount num">{money(row.value)}</span>
								<span class="what">
									<span class="title">{row.title}</span>
									<span class="detail">{row.subtitle}</span>
									<span class="facts">
										{#each row.facts as fact (fact.label)}
											<span class="fact">
												<span class="fact-label">{fact.label}</span>
												<span class="fact-value num">{show(fact.value, fact.unit)}</span>
											</span>
										{/each}
									</span>
								</span>
								<span class="ways">
									<a class="button sm" href={row.evidenceHref}>The lines behind it</a>
									<a class="link" href={row.recordHref}>{row.recordLabel}</a>
								</span>
							</div>
						</li>
					{/each}
				</ul>
			</Panel>
		{/if}

		{#if leak.evidence}
			<Panel title={leak.evidence.title} thisYear={data.year} flush>
				<p class="t-meta muted note">{leak.evidence.note}</p>
				<EvidenceTable
					rows={leak.evidence.rows}
					caption={leak.evidence.title}
					refHeader="Invoice"
					labelHeader={leak.id === 'freight' ? 'Freight policy' : 'What'}
				/>
			</Panel>
		{/if}
	</Page>
{:catch}
	<Page title="Where is it leaking?" documentTitle="Leak">
		<LoadFailed what="this leak" />
	</Page>
{/await}

<style>
	.headline {
		font-size: var(--fs-figure);
		font-weight: 600;
		letter-spacing: -0.02em;
		margin: 0 0 var(--space-2);
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.headline.clear {
		font-size: var(--fs-title);
		color: var(--status-kept);
	}

	.tick {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-full);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.prose {
		max-width: var(--measure);
		margin: 0;
		color: var(--text-muted);
		font-size: var(--fs-meta);
	}

	/* ---------------------------------------------------------- a segment */

	.seg {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	.amount {
		flex: none;
		min-width: 9ch;
		font-size: var(--fs-title);
		font-weight: 600;
		color: var(--warning);
	}

	.what {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		gap: 3px;
	}

	.title {
		font-weight: 500;
	}

	.detail {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	/* The numbers behind the row, each named, so the row needs no legend. */
	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin-top: 2px;
	}

	.fact {
		display: flex;
		align-items: baseline;
		gap: 4px;
		font-size: var(--fs-meta);
	}

	.fact-label {
		color: var(--text-faint);
	}

	.fact-value {
		font-weight: 500;
	}

	.ways {
		flex: none;
		display: grid;
		gap: 4px;
		justify-items: end;
		text-align: right;
	}

	.note {
		padding: var(--space-3) var(--space-3) 0;
		max-width: var(--measure);
	}

	@media (max-width: 720px) {
		.seg {
			flex-wrap: wrap;
		}

		.ways {
			flex: 1 1 100%;
			justify-items: start;
			text-align: left;
		}
	}
</style>
