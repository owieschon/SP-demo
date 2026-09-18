<script lang="ts">
	/*
	  A dollar figure, never bare.

	    <Money value={line.openValue} />
	    <Money value={c.delivered} compare="68% of the $1.2M committed" />
	    <Money value={credit} cents sign />

	  It is a span with `.num`, so it is tabular and right aligns in a column,
	  and it is in the brand sans: monospace money makes a sales screen look
	  like a developer tool. A figure below zero gets the danger color AND a
	  minus sign, so the sign is never the color's job alone.

	  `zero` is the word to show instead of "$0" when nothing has happened
	  yet, which is a different fact from a balance of zero.
	*/
	import { money, moneyExact } from '$lib/format';

	let {
		value,
		/** Show cents. One precision per screen: mixing them made a running total disagree with its own headline. */
		cents = false,
		/** Show a + on a positive figure, for a change rather than an amount. */
		sign = false,
		/** What this figure is measured against, shown after it. */
		compare,
		/** The word for "there is nothing here yet". */
		zero
	}: {
		value: number;
		cents?: boolean;
		sign?: boolean;
		compare?: string;
		zero?: string;
	} = $props();

	const text = $derived.by(() => {
		if (zero && value === 0) return zero;
		const formatted = cents ? moneyExact(value) : money(value);
		return sign && value > 0 ? `+${formatted}` : formatted;
	});
	const below = $derived(value < 0);
</script>

<span class="num" class:negative={below}>{text}</span>{#if compare}<span class="compare">{compare}</span>{/if}

<style>
	.compare {
		margin-left: 6px;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		white-space: normal;
	}
</style>
