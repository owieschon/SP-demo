<script lang="ts">
	/*
	  An account's record as one inline mark: a short row of ticks, oldest on
	  the left, one per settled window, colored by how it ended.

	  It is deliberately not a chart. It sits in a line of text beside the
	  counts, it is read in about a second, and the sentence next to it says
	  the same thing in words, so the color is never the only signal.
	*/
	import type { AccountRecord } from './types';

	let {
		pattern,
		/** The whole record, so the label can say what the ticks add up to. */
		record
	}: { pattern: AccountRecord['pattern']; record: Pick<AccountRecord, 'kept' | 'pushed' | 'broken'> } = $props();

	const label = $derived(
		`Last ${pattern.length} settled: ${pattern.join(', ')}. ` +
			`${record.kept} kept, ${record.pushed} pushed, ${record.broken} broken.`
	);
</script>

{#if pattern.length > 0}
	<span class="pattern" role="img" aria-label={label} title={label}>
		{#each pattern as outcome, i (i)}
			<i class="tick" style:--tone="var(--status-{outcome})"></i>
		{/each}
	</span>
{/if}

<style>
	.pattern {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		vertical-align: middle;
	}

	.tick {
		width: 5px;
		height: 13px;
		border-radius: 1.5px;
		background: color-mix(in srgb, var(--tone) 55%, transparent);
		box-shadow: inset 0 0 0 1px var(--tone);
	}
</style>
