<script lang="ts">
	/*
	  A calendar date that always says enough.

	    <WhenDate iso={line.shipDate} thisYear={data.year} />
	    <WhenDate iso={answer.earliestDate} />          prints the year
	    <WhenDate iso={part.lastSoldOn} fallback="never" />

	  Two rules. A date in a year other than `thisYear` prints its year, and
	  a date with no `thisYear` given prints its year too, through dayFull:
	  five dates on the ship-check screen used to render as a bare "Mar 3", so
	  next March and this March looked the same on the one screen whose job is
	  telling a customer when their parts arrive.

	  It renders a real <time>, so the machine-readable date is in the DOM
	  next to the human one.
	*/
	import { day, dayFull } from '$lib/format';

	let {
		iso,
		/** The year that does not need saying, usually the world's today. */
		thisYear,
		/** What to show when there is no date. Never a bare middle dot. */
		fallback = 'not set',
		/** A reason the date is what it is: "waiting on PO-104471". */
		because,
		/** Late dates read as late, in words as well as color. */
		late = false
	}: {
		iso: string | null | undefined;
		thisYear?: number;
		fallback?: string;
		because?: string;
		late?: boolean;
	} = $props();
</script>

{#if iso}
	<time datetime={iso} class:late>{thisYear === undefined ? dayFull(iso) : day(iso, thisYear)}</time>{#if late}<span class="sr-only">
			, late</span>{/if}{#if because}<span class="because">{because}</span>{/if}
{:else}
	<span class="muted">{fallback}</span>
{/if}

<style>
	time {
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.late {
		color: var(--danger);
	}

	.because {
		margin-left: 6px;
		font-size: var(--fs-meta);
		color: var(--text-muted);
		white-space: normal;
	}
</style>
