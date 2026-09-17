<script lang="ts">
	// Delivered against committed, with two marks:
	//   the kept line at 95%, and a pace tick showing how far through its
	//   window the commitment is (on pace means the bar reaches the tick).
	import { percent } from '$lib/format';
	import type { CommitmentStatus } from '$lib/types';

	let {
		ratio,
		pace = null,
		status,
		label,
		size = 'sm'
	}: {
		ratio: number;
		pace?: number | null;
		status: CommitmentStatus;
		label: string;
		size?: 'sm' | 'md';
	} = $props();

	const shown = $derived(Math.max(0, Math.min(1, ratio)));
</script>

<div
	class="bar {size}"
	role="progressbar"
	aria-label={label}
	aria-valuemin={0}
	aria-valuemax={100}
	aria-valuenow={Math.round(shown * 100)}
	aria-valuetext="{percent(ratio)} delivered"
	style:--tone="var(--status-{status})"
>
	<div class="track">
		<div class="fill" style:transform="scaleX({shown})"></div>
	</div>
	<div class="kept" title="Kept at 95%"></div>
	{#if pace !== null && pace > 0 && pace < 1}
		<div class="pace" style:left="{pace * 100}%" title="Where the window is today"></div>
	{/if}
</div>

<style>
	.bar {
		position: relative;
		height: 4px;
	}

	.bar.md {
		height: 6px;
	}

	.track {
		height: 100%;
		border-radius: 999px;
		overflow: hidden;
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	/* scaleX animates on the compositor, so it stays smooth. */
	.fill {
		height: 100%;
		background: var(--tone);
		transform-origin: left;
		transition: transform 420ms var(--ease);
	}

	.kept {
		position: absolute;
		top: -2px;
		bottom: -2px;
		left: 95%;
		width: 1px;
		background: var(--text-faint);
		opacity: 0.7;
	}

	.pace {
		position: absolute;
		top: -3px;
		bottom: -3px;
		width: 2px;
		margin-left: -1px;
		border-radius: 1px;
		background: var(--text);
		opacity: 0.5;
	}
</style>
