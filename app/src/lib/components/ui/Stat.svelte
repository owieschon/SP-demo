<script lang="ts">
	/*
	  One figure, with everything that makes it arguable: its label, its unit,
	  what it is being compared with, where it came from and when it was true.

	    <Stat label="Delivered" value={money(c.delivered)} unit="invoiced"
	          compare="68% of the $1.2M committed"
	          source="invoice ledger" asOf={c.today} />

	  Thirteen stat tiles were built by hand in this app, in thirteen designs,
	  four of them under the same class name. This is the one. Put several
	  inside a <dl class="figures">.

	  `tone` adds a word as well as a color, because a color says nothing in
	  greyscale or to a screen reader, and `href` points at the screen that
	  proves the number.
	*/
	import { day, dayFull } from '$lib/format';

	let {
		label,
		value,
		/** What the figure is measured in, when the value does not say. */
		unit,
		/** What this figure is measured against. Never leave a figure bare. */
		compare,
		/** Where it came from, in a person's words: 'the invoice ledger'. */
		source,
		/** ISO date the figure is true as of. */
		asOf,
		/** The year that does not need saying in the as-of date. */
		thisYear,
		tone = 'plain',
		/** The word that goes with the tone: 'below reorder point'. */
		toneWord,
		/** A link to the screen that proves the figure. */
		href,
		/** What the link says. */
		hrefLabel = 'See why'
	}: {
		label: string;
		value: string;
		unit?: string;
		compare?: string;
		source?: string;
		asOf?: string;
		thisYear?: number;
		tone?: 'plain' | 'warn' | 'danger';
		toneWord?: string;
		href?: string;
		hrefLabel?: string;
	} = $props();

	const note = $derived(
		[compare, source ? `from ${source}` : null, asOf ? `as of ${thisYear === undefined ? dayFull(asOf) : day(asOf, thisYear)}` : null]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<div class:warn={tone === 'warn'} class:danger={tone === 'danger'}>
	<dt>{label}</dt>
	<dd>
		<span class="figure">{value}</span>
		{#if unit}<span class="unit">{unit}</span>{/if}
		{#if toneWord && tone !== 'plain'}
			<span class="word">{toneWord}</span>
		{/if}
	</dd>
	{#if note || href}
		<span class="note">
			{note}
			{#if href}
				<a class="link" {href}>{hrefLabel}</a>
			{/if}
		</span>
	{/if}
</div>

<style>
	div {
		flex: 1 1 170px;
		min-width: 0;
		display: grid;
		gap: 2px;
		align-content: start;
	}

	dt {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		display: flex;
		align-items: baseline;
		gap: 5px;
		flex-wrap: wrap;
	}

	.figure {
		font-size: var(--fs-title);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		letter-spacing: -0.01em;
	}

	.warn .figure {
		color: var(--warning);
	}

	.danger .figure {
		color: var(--danger);
	}

	.unit,
	.word {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	/* The tone said in words, so the color is never the only signal. */
	.warn .word {
		color: var(--warning);
	}

	.danger .word {
		color: var(--danger);
	}

	.note {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}
</style>
