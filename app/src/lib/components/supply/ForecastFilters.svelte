<script lang="ts">
	// The filter bar. It is a plain GET form, so every view of the forecast has
	// its own URL that can be shared, bookmarked and reloaded, and it works
	// with JavaScript switched off. Changing a select submits the form.
	import { count } from '$lib/format';
	import { LINE_STATUS_LABEL, LINE_STATUS_ORDER, type FilterOption, type ForecastFilters } from './types';

	let {
		filters,
		options,
		lineCount
	}: {
		filters: ForecastFilters;
		options: { vendors: FilterOption[]; workCenters: FilterOption[]; customers: FilterOption[] };
		/*
		  How many lines the projection matched, or null while it is still
		  being worked out. It used to be 0 during the wait, so the bar
		  stated "0 lines" as a confident figure about a projection that had
		  not finished, on a page whose whole subject is that figure.
		*/
		lineCount: number | null;
	} = $props();

	/*
	  The three lists below come with the projection, so until it arrives
	  they are empty. An empty select that looks operable says "this vendor
	  filter has no vendors", which is not true, so they are disabled and
	  say why instead.
	*/
	const loading = $derived(lineCount === null);

	const STATUS_CHOICES: { value: ForecastFilters['status']; label: string }[] = [
		{ value: 'late', label: 'Late, any reason' },
		{ value: 'all', label: 'Every open line' },
		...LINE_STATUS_ORDER.map((s) => ({ value: s, label: LINE_STATUS_LABEL[s] }))
	];

	// Submitting on change keeps the page and the URL in step without a button.
	function submit(event: Event) {
		(event.currentTarget as HTMLElement).closest('form')?.requestSubmit();
	}
</script>

<form class="filters panel" method="GET" action="/operations/forecast" data-sveltekit-keepfocus>
	<label>
		<span>Status</span>
		<select name="status" value={filters.status} onchange={submit}>
			{#each STATUS_CHOICES as c (c.value)}
				<option value={c.value}>{c.label}</option>
			{/each}
		</select>
	</label>

	<label>
		<span>Vendor</span>
		<select name="vendor" value={filters.vendor ?? ''} onchange={submit} disabled={loading}>
			<option value="">Any vendor</option>
			{#each options.vendors as v (v.value)}
				<option value={v.value}>{v.label} ({v.lines})</option>
			{/each}
		</select>
	</label>

	<label>
		<span>Work center</span>
		<select name="wc" value={filters.workCenter ?? ''} onchange={submit} disabled={loading}>
			<option value="">Any work center</option>
			{#each options.workCenters as w (w.value)}
				<option value={w.value}>{w.label} ({w.lines})</option>
			{/each}
		</select>
	</label>

	<label>
		<span>Customer</span>
		<select name="customer" value={filters.customer ?? ''} onchange={submit} disabled={loading}>
			<option value="">Any customer</option>
			{#each options.customers as c (c.value)}
				<option value={c.value}>{c.label} ({c.lines})</option>
			{/each}
		</select>
	</label>

	<label>
		<span>Accounts</span>
		<select name="who" value={filters.who} onchange={submit}>
			<option value="all">Everyone's</option>
			<option value="mine">Mine</option>
		</select>
	</label>

	<div class="tail">
		<!-- Tested against null here, not against `loading`, so the compiler
		     can see that lineCount is a number in the second branch. -->
		{#if lineCount === null}
			<span class="skeleton" style:width="52px" style:height="11px" aria-hidden="true"></span>
		{:else}
			<span class="muted num">{count(lineCount)} {lineCount === 1 ? 'line' : 'lines'}</span>
		{/if}
		<button class="button quiet">Apply</button>
		<a class="button quiet" href="/operations/forecast">Clear</a>
	</div>
</form>

<style>
	.filters {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) var(--space-3);
	}

	.filters label {
		flex: 1 1 170px;
		min-width: 0;
	}

	.filters label span {
		font-size: var(--fs-meta);
	}

	select {
		width: 100%;
	}

	.tail {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}

	/* With JavaScript on, the selects submit themselves; the button stays for
	   keyboards and for when it is off. */
	@media (max-width: 720px) {
		.tail {
			width: 100%;
			margin-left: 0;
		}
	}
</style>
