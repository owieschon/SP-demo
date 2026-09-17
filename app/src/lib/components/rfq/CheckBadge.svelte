<script lang="ts">
	// One validation result: a colored dot, a word, and (unless compact) the
	// plain-English reason under it.
	import type { Check, CheckStatus } from '$lib/server/rfq/schema';

	let { check, compact = false }: { check: Check; compact?: boolean } = $props();

	const LABEL: Record<CheckStatus, string> = {
		ok: 'OK',
		corrected: 'Corrected',
		needs_review: 'Needs review'
	};
</script>

<span class="check {check.status}" title={compact ? check.reason : undefined}>
	<span class="badge">{LABEL[check.status]}</span>
	{#if !compact && check.reason}
		<span class="reason">{check.reason}</span>
	{/if}
</span>

<style>
	.check {
		display: inline-grid;
		gap: 2px;
		min-width: 0;
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 0.88rem;
		font-weight: 500;
		white-space: nowrap;
		color: var(--text);
	}

	/* Same ring style as the commitment status badge. */
	.badge::before {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--tone) 30%, transparent);
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}

	.ok {
		--tone: var(--status-kept);
	}

	.corrected {
		--tone: var(--status-quoted);
	}

	.needs_review {
		--tone: var(--status-pushed);
	}

	.needs_review .badge {
		color: var(--warning);
	}

	.reason {
		font-size: 0.88rem;
		color: var(--text-muted);
		text-wrap: pretty;
	}
</style>
