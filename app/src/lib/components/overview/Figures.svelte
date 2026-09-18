<script lang="ts">
	/*
	  A row of figures, each one a link.

	    <Figures figures={money.figures} asOf={money.today} {year} />

	  The server decides what a figure is called, what it is compared against
	  and where it proves itself; this only formats the number and hands the
	  rest to Stat, which is the app's one figure tile. There is no branch here
	  for a figure with no comparison and no branch for one with no link,
	  because the Figure type has neither.
	*/
	import { count, money, percent } from '$lib/format';
	import Stat from '$lib/components/ui/Stat.svelte';
	import type { Figure } from '$lib/server/overview/types';

	let {
		figures,
		/** The date the figures are true as of. */
		asOf,
		/** The year that does not need saying in the as-of date. */
		year
	}: { figures: Figure[]; asOf?: string; year?: number } = $props();

	function show(figure: Figure): string {
		if (figure.unit === 'money') return money(figure.value);
		if (figure.unit === 'percent') return percent(figure.value);
		if (figure.unit === 'days') return count(figure.value);
		if (figure.unit === 'hours') return count(Math.round(figure.value));
		return count(figure.value);
	}

	// The unit only goes beside the number when the number does not say it.
	function unitOf(figure: Figure): string | undefined {
		if (figure.unit === 'days') return figure.value === 1 ? 'day' : 'days';
		if (figure.unit === 'hours') return figure.value === 1 ? 'hour' : 'hours';
		return undefined;
	}
</script>

<dl class="figures">
	{#each figures as figure (figure.id)}
		<Stat
			label={figure.label}
			value={show(figure)}
			unit={unitOf(figure)}
			compare={figure.compare}
			source={figure.source}
			{asOf}
			thisYear={year}
			tone={figure.tone}
			toneWord={figure.toneWord}
			href={figure.href}
			hrefLabel={figure.hrefLabel}
		/>
	{/each}
</dl>
