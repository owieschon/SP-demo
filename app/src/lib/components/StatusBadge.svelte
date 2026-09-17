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
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--tone);
		white-space: nowrap;
	}

	.badge::before {
		content: '';
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--tone);
	}
</style>
