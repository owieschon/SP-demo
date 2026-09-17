<script lang="ts">
	/*
	  One figure, with everything that makes it arguable: its label, its
	  units already in the string, what it is being compared with, and where
	  it came from.

	    <Figure label="Delivered" value={money(c.delivered)}
	            compare="68% of the $1.2M committed"
	            source="invoice ledger" asOf={c.today} />

	  Put several inside a <dl class="figures">. `tone="warn"` adds the word
	  as well as the color, because color on its own says nothing in
	  greyscale or to a screen reader.
	*/
	let {
		label,
		value,
		/** What this figure is measured against. Never leave a figure bare. */
		compare,
		/** Where the figure came from, in a person's words. */
		source,
		/** ISO date the figure is true as of. */
		asOf,
		tone = 'plain',
		/** The word that goes with the tone, e.g. 'below reorder point'. */
		toneWord,
		/** A link to the screen that proves the figure. */
		href
	}: {
		label: string;
		value: string;
		compare?: string;
		source?: string;
		asOf?: string;
		tone?: 'plain' | 'warn' | 'danger';
		toneWord?: string;
		href?: string;
	} = $props();

	const note = $derived(
		[compare, source ? `from the ${source}` : null, asOf ? `as of ${asOf}` : null]
			.filter(Boolean)
			.join(' · ')
	);
</script>

<div class:warn={tone === 'warn'} class:danger={tone === 'danger'}>
	<dt>{label}</dt>
	<dd>
		{value}
		{#if toneWord && tone !== 'plain'}
			<span class="word">{toneWord}</span>
		{/if}
	</dd>
	{#if note}
		<span class="note">
			{note}
			{#if href}
				<a class="link" {href}>See why</a>
			{/if}
		</span>
	{/if}
</div>

<style>
	div {
		flex: 1 1 160px;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	dt {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	dd {
		margin: 0;
		font-size: var(--fs-section);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.warn dd {
		color: var(--warning);
	}

	.danger dd {
		color: var(--danger);
	}

	/* The tone said in words, so the color is never the only signal. */
	.word {
		font-size: var(--fs-meta);
		font-weight: 500;
	}

	.note {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}
</style>
