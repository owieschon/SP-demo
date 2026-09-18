<script lang="ts">
	// /policies: what every policy says, who has an exception, and why.
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import X from '@lucide/svelte/icons/x';
	import PolicyForm from '$lib/components/policy/PolicyForm.svelte';
	import PolicyGroupTable from '$lib/components/policy/PolicyGroupTable.svelte';
	import PolicyRows from '$lib/components/policy/PolicyRows.svelte';
	import PolicyTrace from '$lib/components/policy/PolicyTrace.svelte';
	import TableSkeleton from '$lib/components/policy/TableSkeleton.svelte';
	import { count } from '$lib/format';
	import { POLICY_GROUPS } from '$lib/policy/types';
	import { routes } from '$lib/routes';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const year = new Date().getFullYear();
	const today = new Date().toISOString().slice(0, 10);

	// The context boxes travel in the query string, so a link to a trace is a
	// link somebody can send to somebody else.
	function linkTo(key: string): string {
		const params = new URLSearchParams();
		if (key !== '') params.set('type', key);
		if (data.context.customerNo !== '') params.set('customer', data.context.customerNo);
		if (data.context.itemNo !== '') params.set('item', data.context.itemNo);
		if (data.context.onDate !== '') params.set('date', data.context.onDate);
		const query = params.toString();
		return query === '' ? '/policies' : `/policies?${query}`;
	}

	const answer = (from: string) => (form && form.from === from ? form : null);
	const chosen = $derived(data.chosen);
	const canEdit = $derived(
		chosen !== null && chosen.editable && (data.role === 'admin' || data.role === chosen.editRole)
	);
	const hasContext = $derived(data.context.customerNo !== '' || data.context.itemNo !== '');
</script>

<svelte:head>
	<title>Policies · Northline</title>
</svelte:head>

<main class="page">
	<header class="page-head">
		<div class="titles">
			<h1>Policies</h1>
			<p class="faint">
				The values the app reads while it works: who pays the freight, what a quote holds for, the margin
				floor, who gets stock first. Each one can be set for everyone, for a price group, for one account
				or for one part, with a date and a reason, and every answer says which policy won and what it
				beat. Policies are values; the triggers that make something happen are
				<a href={routes.rules()}>automations</a>.
			</p>
		</div>
	</header>

	<!-- The context. Everything below is answered for whatever is in here. -->
	<section class="panel">
		<div class="panel-head">
			<h2>Answer for</h2>
			<span class="faint">leave these empty for the company-wide answer</span>
		</div>
		<form class="context" method="GET">
			<input type="hidden" name="type" value={chosen?.key ?? ''} />
			<label>
				Account
				<input name="customer" value={data.context.customerNo} placeholder="1218" autocomplete="off" />
			</label>
			<label>
				Part
				<input name="item" value={data.context.itemNo} placeholder="EL-4525" autocomplete="off" />
			</label>
			<label>
				On
				<input type="date" name="date" value={data.context.onDate} />
			</label>
			<div class="go">
				<button class="button" type="submit">Work it out</button>
				{#if hasContext}
					<a class="button quiet" href={chosen ? `/policies?type=${chosen.key}` : '/policies'}>Clear</a>
				{/if}
			</div>
		</form>
	</section>

	{#if chosen}
		<section class="panel">
			<div class="panel-head">
				<h2>{chosen.name}</h2>
				<span class="head-actions">
					<!--
					  Two policies have a screen that shows what they do rather than
					  what they say. Both are worth more than any sentence here.
					-->
					{#if chosen.key === 'commercial.min_margin'}
						<a class="button quiet sm" href="/policies/backtest">
							What it would have done
							<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
						</a>
					{:else if chosen.key === 'fulfilment.allocation_priority'}
						<a class="button quiet sm" href="/policies/allocation">
							What it moves
							<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
						</a>
					{/if}
					<a class="button quiet sm" href={linkTo('')} aria-label="Close this policy">
						<X size={14} strokeWidth={1.75} aria-hidden="true" />
						Close
					</a>
				</span>
			</div>

			<div class="about">
				<p>{chosen.description}</p>
				<dl class="facts">
					<div>
						<dt>Built-in default</dt>
						<dd>{chosen.defaultWords}</dd>
					</div>
					<div>
						<dt>Can be set at</dt>
						<dd>{chosen.scopes.join(', ').replace(/_/g, ' ')}</dd>
					</div>
					<div>
						<dt>Who may change it</dt>
						<dd>
							{#if chosen.editable}
								{chosen.editRole.replace('_', ' ')} and admins
							{:else}
								nobody yet
							{/if}
						</dd>
					</div>
					<div>
						<dt>Read by</dt>
						<dd>{chosen.readBy === '' ? 'nothing yet' : chosen.readBy}</dd>
					</div>
				</dl>
			</div>

			{#await data.here}
				<div class="sentence"><span class="skeleton" style:width="60%" style:height="12px"></span></div>
			{:then here}
				{@const one = here[chosen.key]}
				{#if one}
					<p class="sentence">
						<strong>{one.valueWords}</strong>
						<span class="faint">{one.explanation}</span>
					</p>
				{/if}
			{/await}

			<div class="panel-head inner">
				<h3>The trace</h3>
				<span class="faint">
					{hasContext
						? 'every policy that could have answered, and why each of the others did not'
						: 'nothing is in the boxes above, so this is the company-wide answer'}
				</span>
			</div>
			{#await data.trace}
				<TableSkeleton rows={3} label="Working out the trace" />
			{:then trace}
				<PolicyTrace rows={trace} {year} />
			{:catch}
				<p class="notice error" role="alert">The trace could not be worked out.</p>
			{/await}

			{#await data.rows}
				<TableSkeleton rows={3} label="Loading the policies that are set" />
			{:then rows}
				<div class="panel-head inner">
					<h3>What is set</h3>
					<span class="faint">{count(rows.length)} in total, including any that have expired</span>
				</div>
				<PolicyRows
					type={chosen}
					{rows}
					{canEdit}
					requestId={data.requestIds.end}
					{today}
					{year}
				/>
				{#if canEdit}
					{@const editing = rows.find((row) => row.id === data.editId) ?? null}
					<div class="panel-head inner">
						<h3>{editing ? 'Change this policy' : 'Set a policy'}</h3>
						<span class="faint">every change is recorded with who made it and when</span>
					</div>
					<!--
					  Keyed on the row being changed, so switching between adding and
					  changing gives a form whose boxes start from the right place.
					-->
					{#key editing?.id ?? 'new'}
						<PolicyForm
							type={chosen}
							row={editing}
							requestId={data.requestIds.set}
							{today}
							message={answer('set')?.message ?? null}
							failed={answer('set') ? !answer('set')!.ok : false}
						/>
					{/key}
				{:else}
					<p class="empty">
						{chosen.editable
							? `Changing this one is for ${chosen.editRole.replace('_', ' ')} and admins.`
							: 'This policy is not editable yet: the code that reads it still has the number written in.'}
					</p>
				{/if}
			{/await}

			{#if answer('end')}
				<p class="notice" class:error={!answer('end')!.ok} role="status">{answer('end')!.message}</p>
			{/if}
		</section>
	{/if}

	{#await Promise.all([data.global, data.here])}
		{#each POLICY_GROUPS as group (group.key)}
			<PolicyGroupTable
				label={group.label}
				blurb={group.blurb}
				types={data.types.filter((type) => type.groupKey === group.key)}
				global={null}
				here={null}
				chosenKey={chosen?.key ?? ''}
				href={linkTo}
			/>
		{/each}
	{:then [globalAnswers, here]}
		{#each POLICY_GROUPS as group (group.key)}
			<PolicyGroupTable
				label={group.label}
				blurb={group.blurb}
				types={data.types.filter((type) => type.groupKey === group.key)}
				global={globalAnswers}
				{here}
				chosenKey={chosen?.key ?? ''}
				href={linkTo}
			/>
		{/each}
	{:catch}
		<p class="notice error" role="alert">
			The policies could not be worked out.
			<a class="button" href="/policies" data-sveltekit-reload>Try again</a>
		</p>
	{/await}

	{#await data.allocation then allocation}
		<section class="panel">
			<div class="panel-head">
				<h2>Allocation priority, at work</h2>
				<a class="button quiet sm" href="/policies/allocation">
					See what it moves
					<ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
				</a>
			</div>
			<p class="panel-body faint">
				{count(allocation.prioritized)} of {count(allocation.lines)} open lines sit behind an account with
				a priority, and {count(allocation.moved)}
				{allocation.moved === 1 ? 'line gets' : 'lines get'} a different quantity than plain ship-date
				order would have given
				{allocation.moved === 1 ? 'it' : 'them'}.
			</p>
		</section>
	{/await}
</main>

<style>
	.context {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	.context > label {
		flex: 1 1 150px;
		min-width: 0;
	}

	.go {
		display: flex;
		gap: var(--space-2);
	}

	.about {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		border-bottom: 1px solid var(--hairline);
	}

	.about p {
		margin: 0;
		max-width: var(--measure);
		color: var(--text-muted);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
		margin: 0;
	}

	.facts > div {
		flex: 1 1 160px;
		min-width: 0;
		display: grid;
		gap: 1px;
	}

	.facts dt {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.facts dd {
		margin: 0;
		font-size: var(--fs-body);
	}

	.sentence {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-3);
		border-bottom: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}

	.panel-head.inner {
		border-top: 1px solid var(--hairline);
	}

	.head-actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.notice {
		margin: var(--space-3);
	}
</style>
