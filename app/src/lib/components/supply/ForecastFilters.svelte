<script lang="ts">
	// The filter bar. It is a plain GET form, so every view of the forecast has
	// its own URL that can be shared, bookmarked and reloaded, and it works
	// with JavaScript switched off. Changing a select submits the form.
	import { LINE_STATUS_LABEL, LINE_STATUS_ORDER, type FilterOption, type ForecastFilters } from './types';

	let {
		filters,
		options,
		lineCount
	}: {
		filters: ForecastFilters;
		options: { vendors: FilterOption[]; workCenters: FilterOption[]; customers: FilterOption[] };
		lineCount: number;
	} = $props();

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
		<select name="vendor" value={filters.vendor ?? ''} onchange={submit}>
			<option value="">Any vendor</option>
			{#each options.vendors as v (v.value)}
				<option value={v.value}>{v.label} ({v.lines})</option>
			{/each}
		</select>
	</label>

	<label>
		<span>Work center</span>
		<select name="wc" value={filters.workCenter ?? ''} onchange={submit}>
			<option value="">Any work center</option>
			{#each options.workCenters as w (w.value)}
				<option value={w.value}>{w.label} ({w.lines})</option>
			{/each}
		</select>
	</label>

	<label>
		<span>Customer</span>
		<select name="customer" value={filters.customer ?? ''} onchange={submit}>
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
		<span class="faint num">{lineCount} lines</span>
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
		font-size: 0.85rem;
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
