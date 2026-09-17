<script lang="ts">
	import { STATUS_LABEL, type CommitmentStatus } from '$lib/types';

	let { status }: { status: CommitmentStatus } = $props();
</script>

<span class="badge" style:--tone="var(--status-{status})">{STATUS_LABEL[status]}</span>

<style>
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.92rem;
		font-weight: 500;
		color: var(--text);
		white-space: nowrap;
	}

	/* The color is on a small ring, not the text: calm, still easy to scan. */
	.badge::before {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--tone) 30%, transparent);
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}
</style>
