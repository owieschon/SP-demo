<script lang="ts">
	// One account. The header is here when the page arrives; the numbers, the
	// people, the activity, the next steps, the commitments and the orders
	// each stream in behind it, each with its own skeleton.
	import { invalidateAll } from '$app/navigation';
	import AccountDeals from '$lib/components/accounts/AccountDeals.svelte';
	import AccountOrders from '$lib/components/accounts/AccountOrders.svelte';
	import AccountRecordPanel from '$lib/components/commitments/AccountRecordPanel.svelte';
	import ContactList from '$lib/components/accounts/ContactList.svelte';
	import NextStepList from '$lib/components/accounts/NextStepList.svelte';
	import RevenueBars from '$lib/components/accounts/RevenueBars.svelte';
	import SectionSkeleton from '$lib/components/accounts/SectionSkeleton.svelte';
	import Timeline from '$lib/components/accounts/Timeline.svelte';
	import { count, day, money, percent, place } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const a = $derived(data.account);
	const where = $derived(place(a.city, a.state, a.country));

	/** The answer from a form action, for the form that sent it and no other. */
	function answerFor(source: 'contact' | 'activity' | 'step') {
		if (!form || form.from !== source) return null;
		return { text: form.message, failed: form.failed, conflict: form.conflict };
	}

	const conflict = $derived(Boolean(form?.conflict));

	/** This year against the same days last year. */
	function trend(now: number, before: number): string {
		if (before <= 0) return now > 0 ? 'first year of business' : '';
		const change = (now - before) / before;
		const words = change > 0 ? 'up on' : 'down on';
		return `${percent(Math.abs(change))} ${words} the same days last year (${money(before)})`;
	}
</script>

<svelte:head>
	<title>{a.name} · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div class="title-row">
			<h1>{a.name}</h1>
			<span class="mono faint">{a.customerNo}</span>
			{#if a.blocked}<span class="chip warn">Blocked</span>{/if}
			{#if a.closed}<span class="chip warn">Closed</span>{/if}
			{#if a.shipsOwnCarrier}<span class="chip">Own carrier</span>{/if}
		</div>

		<dl class="facts">
			{#if where}
				<div>
					<dt>Where</dt>
					<dd>{where}</dd>
				</div>
			{/if}
			<div>
				<dt>Owner</dt>
				<dd>
					{a.ownerName ?? 'Nobody yet'}
					{#if a.agencyName}<span class="muted">· {a.agencyName}</span>{/if}
				</dd>
			</div>
			<div>
				<dt>Price group</dt>
				<dd>{a.priceGroupLabel} <span class="faint">{percent(a.discount)} off list</span></dd>
			</div>
			<div>
				<dt>Customer since</dt>
				<dd>{day(a.customerSince)}</dd>
			</div>
			{#if a.billToNo}
				<div>
					<dt>Billed to</dt>
					<dd><a class="link" href="/accounts/{a.billToNo}">{a.parentName ?? a.billToNo}</a></dd>
				</div>
			{/if}
			{#if a.branchCount > 0}
				<div>
					<dt>Branches</dt>
					<dd>{count(a.branchCount)}</dd>
				</div>
			{/if}
		</dl>
	</header>

	{#if conflict}
		<p class="notice error" role="alert">
			<span>{form?.message}</span>
			<button class="button" onclick={() => invalidateAll()}>Reload</button>
		</p>
	{/if}

	<!-- Key numbers, with 24 months of revenue as bars. -->
	{#await data.numbers}
		<SectionSkeleton title="the numbers" rows={2} wide />
	{:then numbers}
		<section class="panel" aria-labelledby="numbers-title">
			<header class="panel-head">
				<h2 id="numbers-title">The numbers</h2>
				{#if numbers.goneQuiet}<span class="chip warn">Gone quiet</span>{/if}
			</header>
			<dl class="figures">
				<div>
					<dt>This year</dt>
					<dd class="num">{money(numbers.revenueYtd)}</dd>
					<dd class="faint small">{trend(numbers.revenueYtd, numbers.revenuePriorYtd)}</dd>
				</div>
				<div>
					<dt>Last year</dt>
					<dd class="num">{money(numbers.revenueLastYear)}</dd>
					<dd class="faint small">all twelve months</dd>
				</div>
				{#if numbers.familyRevenueYtd !== null}
					<div>
						<dt>With branches</dt>
						<dd class="num">{money(numbers.familyRevenueYtd)}</dd>
						<dd class="faint small">this year, whole family</dd>
					</div>
				{/if}
				<div>
					<dt>Last order</dt>
					<dd class="num">{numbers.lastOrderOn ? day(numbers.lastOrderOn, data.year) : 'never'}</dd>
					<dd class="faint small">
						{#if numbers.typicalGapDays}
							usually orders every {numbers.typicalGapDays} days, quiet {numbers.daysQuiet} days
						{:else if numbers.daysQuiet !== null}
							{numbers.daysQuiet} days ago
						{:else}
							nothing on the ledger
						{/if}
					</dd>
				</div>
				<div>
					<dt>Open commitments</dt>
					<dd class="num">{money(numbers.openCommitted)}</dd>
					<dd class="faint small">
						{#if numbers.openCommitments > 0}
							{numbers.openCommitments} open, {money(numbers.openExpected)} expected
						{:else}
							nothing open
						{/if}
					</dd>
				</div>
			</dl>
			<div class="chart">
				<RevenueBars months={numbers.months} />
			</div>
		</section>
	{:catch}
		<p class="notice error" role="alert">The numbers could not be loaded.</p>
	{/await}

	<div class="columns">
		<div class="main-column">
			<!-- Activity needs the people, so both arrive together. -->
			{#await Promise.all([data.timeline, data.contacts])}
				<SectionSkeleton title="the activity" rows={6} wide />
			{:then [timeline, contacts]}
				<Timeline
					{timeline}
					{contacts}
					customerNo={a.customerNo}
					requestId={data.requestIds.activity}
					message={answerFor('activity')}
				/>
			{:catch}
				<p class="notice error" role="alert">The activity could not be loaded.</p>
			{/await}

			{#await data.deals}
				<SectionSkeleton title="the commitments" rows={3} wide />
			{:then deals}
				<AccountDeals {deals} customerNo={a.customerNo} year={data.year} />
			{:catch}
				<p class="notice error" role="alert">The commitments could not be loaded.</p>
			{/await}

			{#await data.record}
				<SectionSkeleton title="their record" rows={2} wide />
			{:then record}
				<AccountRecordPanel {record} year={data.year} />
			{:catch}
				<p class="notice error" role="alert">Their record could not be loaded.</p>
			{/await}

			{#await data.orders}
				<SectionSkeleton title="the orders" rows={5} wide />
			{:then orders}
				<AccountOrders {orders} year={data.year} />
			{:catch}
				<p class="notice error" role="alert">The orders could not be loaded.</p>
			{/await}
		</div>

		<div class="side-column">
			{#await data.contacts}
				<SectionSkeleton title="the people" rows={3} />
			{:then contacts}
				<ContactList
					{contacts}
					customerNo={a.customerNo}
					emailDomain={a.emailDomain}
					year={data.year}
					addRequestId={data.requestIds.addContact}
					editRequestId={data.requestIds.editContact}
					message={answerFor('contact')}
				/>
			{:catch}
				<p class="notice error" role="alert">The people could not be loaded.</p>
			{/await}

			{#await data.steps}
				<SectionSkeleton title="the next steps" rows={3} />
			{:then steps}
				<NextStepList
					{steps}
					customerNo={a.customerNo}
					people={a.people}
					defaultOwnerId={a.ownerId ?? data.user?.id ?? a.people[0]?.id ?? 1}
					year={data.year}
					today={a.today}
					addRequestId={data.requestIds.addStep}
					completeRequestId={data.requestIds.completeStep}
					message={answerFor('step')}
				/>
			{:catch}
				<p class="notice error" role="alert">The next steps could not be loaded.</p>
			{/await}

			{#if a.branches.length > 0}
				<section class="panel" aria-labelledby="branches-title">
					<header class="panel-head">
						<h2 id="branches-title">Branches</h2>
						<span class="faint">
							{count(a.branchCount)} billed here{#if a.branchCount > a.branches.length}, first
								{a.branches.length} shown{/if}
						</span>
					</header>
					<ul class="branches">
						{#each a.branches as branch (branch.customerNo)}
							<li>
								<a class="link" href="/accounts/{branch.customerNo}">{branch.name}</a>
								<span class="muted small">{branch.place}</span>
								{#if branch.blocked}<span class="chip">Blocked</span>{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>
	</div>
</main>

<style>
	.page {
		max-width: 1180px;
		margin: 0 auto;
		padding: var(--space-4) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: var(--space-3);
	}

	.title-row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
		margin: 0;
	}

	.facts dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.facts dd {
		margin: 0;
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
		border-bottom: 1px solid var(--hairline);
	}

	.figures div {
		flex: 1 1 150px;
		padding: 10px var(--space-3);
	}

	.figures div + div {
		border-left: 1px solid var(--hairline);
	}

	.figures dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.figures dd {
		margin: 2px 0 0;
		font-size: 1.15rem;
		font-weight: 600;
		letter-spacing: -0.015em;
		text-align: left;
	}

	.figures dd.small {
		font-size: 0.85rem;
		font-weight: 400;
	}

	.chart {
		padding: var(--space-3);
	}

	/* Two columns on a wide screen, one on a phone. Flexbox, because iOS
	   Safari and Chrome do not always agree about grid. */
	.columns {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		align-items: flex-start;
	}

	.main-column {
		flex: 1 1 520px;
		min-width: 0;
		display: grid;
		gap: var(--space-3);
	}

	.side-column {
		flex: 1 1 320px;
		min-width: 0;
		display: grid;
		gap: var(--space-3);
	}

	.branches {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.branches li {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		padding: 6px var(--space-3);
	}

	.branches li + li {
		border-top: 1px solid var(--hairline);
	}

	.small {
		font-size: 0.88rem;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}

		.figures div {
			flex-basis: 45%;
		}

		.figures div + div {
			border-left: 0;
		}
	}
</style>
