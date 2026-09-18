<script lang="ts">
	/*
	  What the agents did in the last seven days, each line a count of rows a
	  person can open.

	  There is no money column, and that is the point. This database records
	  that the desk drafted a reply and that somebody sent it as written; it
	  does not record what the same work would have cost otherwise, so a dollar
	  figure here would be the most impressive number on the page and the only
	  invented one. The caveat is rendered, not buried in a comment.

	  A zero line stays. "Nothing was undone this week" is the sort of thing a
	  ledger exists to say, and a ledger that hides its zeros is one nobody
	  should trust.
	*/
	import { count } from '$lib/format';
	import type { ValueLine } from '$lib/server/overview/types';

	let { lines, caveat }: { lines: ValueLine[]; caveat: string } = $props();
</script>

<ul class="rows">
	{#each lines as line (line.id)}
		<li>
			<a class="row" href={line.href} data-value-line={line.id}>
				<span class="count num" class:zero={line.count === 0}>{count(line.count)}</span>
				<span class="what">
					<span class="title">{line.what}</span>
					<span class="basis">{line.basis}</span>
				</span>
			</a>
		</li>
	{/each}
</ul>

<p class="t-meta muted caveat">{caveat}</p>

<style>
	.row {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.row:hover {
		background: var(--surface-hover);
	}

	.row:active {
		background: var(--surface-press);
	}

	.count {
		flex: none;
		min-width: 4ch;
		font-size: var(--fs-section);
		font-weight: 600;
	}

	.count.zero {
		color: var(--text-faint);
	}

	.what {
		flex: 1 1 auto;
		min-width: 0;
		display: grid;
		gap: 1px;
	}

	.basis {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.caveat {
		padding: var(--space-3);
		max-width: var(--measure);
	}
</style>
