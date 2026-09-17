<script lang="ts">
	import TableSkeleton from '$lib/components/catalog/TableSkeleton.svelte';
	import { accountHref, partHref, vendorHref } from '$lib/components/catalog/types';
	import { count, place } from '$lib/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// "3 of 41" when a group was capped, otherwise just the count.
	function shown(group: { rows: unknown[]; total: number }): string {
		return group.total > group.rows.length ? `${group.rows.length} of ${group.total}` : String(group.total);
	}
</script>

<svelte:head>
	<title>{data.q ? `${data.q} · Search` : 'Search'} · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>Search</h1>
		<!-- The page carries its own box, so a search can be changed here too. -->
		<form class="big" method="GET" role="search">
			<label class="grow">
				<span class="sr-only">Search accounts, parts and vendors</span>
				<input
					name="q"
					type="search"
					value={data.q}
					placeholder="Account, part number, description or vendor"
					autocomplete="off"
					spellcheck="false"
				/>
			</label>
			<button class="button primary">Search</button>
		</form>
	</header>

	{#if !data.results}
		<p class="panel body muted">
			Type a number or a few words. A number finds an account, a part or a vendor straight away;
			words match names and part descriptions, for example "8 chrome stack".
		</p>
	{:else}
		{#await data.results}
			<div class="groups">
				<TableSkeleton rows={4} title="Searching accounts" />
				<TableSkeleton rows={4} title="Searching parts" />
				<TableSkeleton rows={4} title="Searching vendors" />
			</div>
		{:then results}
			{@const nothing =
				results.accounts.total + results.parts.total + results.vendors.total === 0}
			{#if nothing}
				<p class="panel body muted">
					Nothing matches "{results.q}". A part number looks like L3515-630SC, an account number like
					10012, a vendor number like V10010.
				</p>
			{:else}
				<div class="groups">
					<section class="panel" aria-labelledby="accounts">
						<header class="panel-head">
							<h2 id="accounts">Accounts</h2>
							<span class="faint">{shown(results.accounts)}</span>
						</header>
						{#if results.accounts.rows.length === 0}
							<p class="body muted">No account matches.</p>
						{:else}
							<ul class="list">
								{#each results.accounts.rows as account (account.customerNo)}
									<li>
										<a class="row" href={accountHref(account.customerNo)}>
											<span class="name">{account.name}</span>
											<span class="mono faint">{account.customerNo}</span>
											<span class="muted where">
												{place(account.city, account.state, account.country)}
											</span>
											{#if account.closed}<span class="chip">closed</span>{/if}
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</section>

					<section class="panel" aria-labelledby="parts">
						<header class="panel-head">
							<h2 id="parts">Parts</h2>
							<span class="faint">{shown(results.parts)}</span>
						</header>
						{#if results.parts.rows.length === 0}
							<p class="body muted">No part matches.</p>
						{:else}
							<ul class="list">
								{#each results.parts.rows as part (part.itemNo)}
									<li>
										<a class="row" href={partHref(part.itemNo)}>
											<span class="mono name">{part.itemNo}</span>
											<span class="muted where">{part.description}</span>
											{#if part.blocked}<span class="chip warn">blocked</span>{/if}
										</a>
									</li>
								{/each}
							</ul>
						{/if}
						{#if results.parts.total > results.parts.rows.length}
							<p class="body">
								<a class="link" href="/parts?q={encodeURIComponent(results.q)}">
									See all {count(results.parts.total)} in the parts list
								</a>
							</p>
						{/if}
					</section>

					<section class="panel" aria-labelledby="vendors">
						<header class="panel-head">
							<h2 id="vendors">Vendors</h2>
							<span class="faint">{shown(results.vendors)}</span>
						</header>
						{#if results.vendors.rows.length === 0}
							<p class="body muted">No vendor matches.</p>
						{:else}
							<ul class="list">
								{#each results.vendors.rows as vendor (vendor.vendorNo)}
									<li>
										<a class="row" href={vendorHref(vendor.vendorNo)}>
											<span class="name">{vendor.name}</span>
											<span class="mono faint">{vendor.vendorNo}</span>
											<span class="muted where">{place(vendor.city, vendor.state, 'US')}</span>
										</a>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				</div>
			{/if}
		{:catch}
			<p class="notice error" role="alert">The search could not be run. Try again.</p>
		{/await}
	{/if}
</main>

<style>
	.page {
		max-width: 900px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: var(--space-3);
	}

	.big {
		display: flex;
		gap: var(--space-2);
	}

	.big .grow {
		flex: 1 1 auto;
	}

	.big input {
		width: 100%;
		height: 34px;
		font-size: 1rem;
	}

	.groups {
		display: grid;
		gap: var(--space-3);
	}

	.body {
		padding: var(--space-3);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li + li {
		border-top: 1px solid var(--hairline);
	}

	/* The whole row is the link, so it is easy to hit on a phone. */
	.row {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		padding: 8px var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.name {
		font-weight: 500;
		white-space: nowrap;
	}

	.where {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-4) var(--space-3);
		}
	}
</style>
