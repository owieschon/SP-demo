<script lang="ts">
	/*
	  A count, with the thing it counts.

	    <Qty value={line.quantity} unit="pieces" />
	    <Qty value={board.newLines} unit="lines" />
	    <Qty value={0} unit="shipments" zero="None waiting" />

	  "New: 34" appeared on the operations board with no unit anywhere near
	  it. 34 what? A count without its noun is not a figure, it is a digit,
	  so the noun is a required prop and it agrees with the number.
	*/
	import { count } from '$lib/format';

	let {
		value,
		/** The plural noun: 'lines', 'pieces'. The singular is derived. */
		unit,
		/** A different singular, when dropping the s is wrong. */
		singular,
		/** Show a + on a positive figure, for a change rather than an amount. */
		sign = false,
		/** What to say instead of "0 lines". */
		zero,
		/** Leave the noun out: the column header already says it. */
		bare = false
	}: {
		value: number;
		unit: string;
		singular?: string;
		sign?: boolean;
		zero?: string;
		bare?: boolean;
	} = $props();

	const one = $derived(singular ?? unit.replace(/s$/, ''));
	const noun = $derived(Math.abs(value) === 1 ? one : unit);
	const figure = $derived(sign && value > 0 ? `+${count(value)}` : count(value));
</script>

{#if zero && value === 0}
	<span class="muted">{zero}</span>
{:else}
	<span class="num" class:negative={value < 0}>{figure}</span>{#if !bare}<span class="unit">
			{noun}</span>{/if}
{/if}

<style>
	.unit {
		color: var(--text-muted);
	}
</style>
