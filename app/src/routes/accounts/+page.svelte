<script lang="ts">
	// The accounts list. The search and filter bar is a plain GET form, so the
	// state of the list lives in the URL: it can be shared, bookmarked and
	// walked back through with the browser's own buttons.
	import Search from '@lucide/svelte/icons/search';
	import { page } from '$app/state';
	import AccountsTable from '$lib/components/accounts/AccountsTable.svelte';
	import SectionSkeleton from '$lib/components/accounts/SectionSkeleton.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** The current URL with a few parameters changed; an empty value drops one. */
	function hrefFor(changes: Record<string, string>): string {
		const params = new URLSearchParams(page.url.search);
		for (const [key, value] of Object.entries(changes)) {
			if (value === '') params.delete(key);
			else params.set(key, value);
		}
		const query = params.toString();
		return query ? `?${query}` : '/accounts';
	}

	const filters = $derived(data.filters);
	const filtered = $derived(
		Boolean(filters.q || filters.state || filters.group || filters.quiet || filters.open)
	);
</script>

<svelte:head>
	<title>Accounts · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1 class="sr-only">Accounts</h1>
		<!-- No JavaScript needed: this form navigates, it does not post. -->
		<form class="bar" method="GET" action="/accounts" role="search">
			<!-- Keep the switches that are not fields of this form. -->
			<input type="hidden" name="who" value={filters.who} />
			<input type="hidden" name="sort" value={filters.sort} />

			<label class="find">
				<span class="sr-only">Search by name, number or city</span>
				<span class="with-icon">
					<Search size={13} strokeWidth={1.75} aria-hidden="true" />
					<input
						type="search"
						name="q"
						value={filters.q}
						maxlength="80"
						placeholder="Name, customer number or city"
					/>
				</span>
			</label>

			<label class="pick">
				<span class="sr-only">State</span>
				<select name="state" value={filters.state}>
					<option value="">Any state</option>
					{#each data.options.states as state (state)}
						<option value={state}>{state}</option>
					{/each}
				</select>
			</label>

			<label class="pick">
				<span class="sr-only">Price group</span>
				<select name="group" value={filters.group}>
					<option value="">Any price group</option>
					{#each data.options.groups as group (group.code)}
						<option value={group.code}>{group.label}</option>
					{/each}
				</select>
			</label>

			<label class="tick">
				<input type="checkbox" name="quiet" value="1" checked={filters.quiet} />
				<span>Gone quiet</span>
			</label>

			<label class="tick">
				<input type="checkbox" name="open" value="1" checked={filters.open} />
				<span>Open commitments</span>
			</label>

			<button class="button">Search</button>
			{#if filtered}
				<a class="button quiet" href={hrefFor({ q: '', state: '', group: '', quiet: '', open: '', page: '1' })}>
					Clear
				</a>
			{/if}
		</form>
	</header>

	<!-- The rows arrive a moment after the page (see +page.server.ts). -->
	{#await data.accounts}
		<SectionSkeleton title="accounts" rows={8} wide />
	{:then accounts}
		<AccountsTable {accounts} {filters} year={data.year} {hrefFor} />
	{:catch}
		<p class="notice error" role="alert">
			The accounts could not be loaded.
			<a class="button" href={page.url.search || '/accounts'} data-sveltekit-reload>Try again</a>
		</p>
	{/await}
</main>

<style>
	.page {
		padding: var(--space-3) var(--space-4) var(--space-5);
		display: grid;
		gap: var(--space-3);
	}

	/* Flexbox, so the bar wraps down to one control per line on a phone. */
	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.find {
		flex: 1 1 260px;
	}

	.with-icon {
		position: relative;
		display: block;
	}

	.with-icon :global(svg) {
		position: absolute;
		top: 50%;
		left: 8px;
		transform: translateY(-50%);
		color: var(--text-faint);
		pointer-events: none;
	}

	.with-icon input {
		width: 100%;
		height: var(--control-h);
		padding-left: 26px;
	}

	.pick {
		flex: 0 0 auto;
	}

	.tick {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		white-space: nowrap;
	}

	.tick input {
		width: 14px;
		height: 14px;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
