<script lang="ts">
	/*
	  The named leaks. One row each: what it is, what it is worth, how it was
	  worked out, and the way in.

	  A leak with nothing behind it is not an empty table and not a hidden row.
	  It says so, in its own words, and keeps its link, because "nothing to
	  recover here" is the most useful thing this page can tell a chief
	  executive and it only counts if it is the same row that would have shown
	  the money.
	*/
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Check from '@lucide/svelte/icons/check';
	import { count, money } from '$lib/format';
	import type { LeakSummary } from '$lib/server/overview/types';

	let { leaks }: { leaks: LeakSummary[] } = $props();
</script>

<ul class="rows">
	{#each leaks as leak (leak.id)}
		<li>
			<a class="row" href={leak.href} data-leak={leak.id}>
				<span class="amount num" class:warn={leak.tone === 'warn'} class:danger={leak.tone === 'danger'}>
					{#if leak.count === 0}
						<span class="clear" aria-hidden="true"><Check size={16} strokeWidth={2} /></span>
					{:else}
						{leak.unit === 'money' ? money(leak.value) : count(leak.value)}
					{/if}
				</span>
				<span class="what">
					<span class="title">{leak.name}</span>
					<span class="detail">{leak.count === 0 ? leak.nothing : leak.detail}</span>
					<span class="question">{leak.question}</span>
				</span>
				<ArrowRight size={15} strokeWidth={1.75} class="go" aria-hidden="true" />
			</a>
		</li>
	{/each}
</ul>

<style>
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row:active {
		background: var(--surface-press);
	}

	/* The money is the first thing read, so it leads the row and it is
	   tabular, so three of them line up. */
	.amount {
		flex: none;
		min-width: 9ch;
		font-size: var(--fs-title);
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.amount.warn {
		color: var(--warning);
	}

	.amount.danger {
		color: var(--danger);
	}

	/* Nothing to recover: a tick where the money would be, so a clear leak
	   reads as clear at a glance rather than as a zero somebody has to
	   interpret. */
	.clear {
		display: inline-grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: var(--radius-full);
		background: var(--surface-sunken);
		color: var(--status-kept);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.what {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	.title {
		font-weight: 500;
	}

	.detail,
	.question {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.question {
		color: var(--text-faint);
	}

	.row :global(.go) {
		flex: none;
		color: var(--text-faint);
		transition: transform var(--speed) var(--ease);
	}

	.row:hover :global(.go) {
		color: var(--text);
		transform: translateX(2px);
	}

	@media (max-width: 720px) {
		.row {
			flex-wrap: wrap;
		}

		.amount {
			flex: 1 1 100%;
		}
	}
</style>
