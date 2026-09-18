<script lang="ts">
	// The count sheet on the clipboard: what the system expected, what the
	// person found, and what posting it would do. Posting turns every variance
	// into one stock move and moves the on-hand figure by exactly that much,
	// which is why the total is stated before the button is pressed.
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import ClipboardCheck from '@lucide/svelte/icons/clipboard-check';
	import { count, day } from '$lib/format';
	import type { OpenCount } from './types';

	let {
		session,
		today,
		year,
		canRun,
		requestId,
		message
	}: {
		session: OpenCount;
		today: string;
		year: number;
		canRun: boolean;
		requestId: string;
		message: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	let busy = $state(false);

	const submitting: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			await update();
			busy = false;
		};
	};

	const due = $derived(session.dueOn <= today);
	// Counted lines first: those are the ones posting will act on.
	const ordered = $derived(
		[...session.lines].sort((a, b) => {
			const av = a.countedQty === null ? 1 : 0;
			const bv = b.countedQty === null ? 1 : 0;
			if (av !== bv) return av - bv;
			return Math.abs(b.variance ?? 0) - Math.abs(a.variance ?? 0) || a.lineNo - b.lineNo;
		})
	);
</script>

<section class="panel" aria-labelledby="count-title">
	<header class="panel-head">
		<h2 id="count-title">Cycle count</h2>
		<span class="faint">
			<span class="mono">{session.sessionNo}</span> · {session.zone} at {session.locationCode} · due
			{day(session.dueOn, year)}{#if due}<span class="chip warn">today</span>{/if}
		</span>
	</header>

	{#if message}
		<p class="body notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
			{message.text}
		</p>
	{/if}

	<dl class="figures">
		<div>
			<dt>Counted</dt>
			<dd class="num">{count(session.counted)} <span class="muted small">of {count(session.lines.length)}</span></dd>
		</div>
		<div>
			<dt>Off by something</dt>
			<dd class="num" class:warn={session.withVariance > 0}>{count(session.withVariance)}</dd>
		</div>
		<div>
			<dt>Posting moves on hand</dt>
			<dd class="num" class:warn={session.netChange !== 0}>
				{session.netChange > 0 ? '+' : ''}{count(session.netChange)}
				<span class="muted small">pcs</span>
			</dd>
		</div>
		<div class="act">
			{#if canRun}
				<form method="POST" action="?/count" use:enhance={submitting}>
					<input type="hidden" name="sessionId" value={session.id} />
					<input type="hidden" name="expectedUpdatedAt" value={session.updatedAt} />
					<input type="hidden" name="requestId" value={requestId} />
					<button class="button primary" disabled={busy || session.counted === 0}>
						<ClipboardCheck size={13} strokeWidth={2} aria-hidden="true" />
						Post the count
					</button>
				</form>
				{#if session.counted === 0}
					<span class="faint small">Nothing counted yet, so there is nothing to post.</span>
				{:else if session.notCounted > 0}
					<span class="faint small">
						{count(session.notCounted)} lines have not been counted. Posting leaves those bins alone.
					</span>
				{/if}
			{:else}
				<span class="faint small">Read only: operations and admins post a count.</span>
			{/if}
		</div>
	</dl>

	{#if session.note}<p class="note muted">{session.note}</p>{/if}

	<div class="table-wrap">
		<table>
			<thead>
				<tr>
					<th scope="col">Bin</th>
					<th scope="col">Item</th>
					<th scope="col" class="num">Expected</th>
					<th scope="col" class="num">Counted</th>
					<th scope="col" class="num">Off by</th>
					<th scope="col">Why</th>
				</tr>
			</thead>
			<tbody>
				{#each ordered as l (l.lineNo)}
					<tr class:pending={l.countedQty === null}>
						<td class="mono nowrap">{l.bin || '·'}</td>
						<td>
							<a class="link mono" href="/warehouse?part={encodeURIComponent(l.itemNo)}">{l.itemNo}</a>
							<span class="faint desc">{l.description}</span>
						</td>
						<td class="num">{count(l.expectedQty)}</td>
						<td class="num">
							{#if l.countedQty === null}
								<span class="faint">not counted</span>
							{:else}
								{count(l.countedQty)}
							{/if}
						</td>
						<td class="num" class:warn={(l.variance ?? 0) !== 0}>
							{#if l.variance === null || l.variance === 0}
								<span class="faint">·</span>
							{:else}
								{l.variance > 0 ? '+' : ''}{count(l.variance)}
							{/if}
						</td>
						<td>
							{#if l.reason}<span class="chip">{l.reason}</span>{/if}
							{#if l.note}<span class="faint desc">{l.note}</span>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<style>
	.body,
	.note {
		margin: 0;
		padding: 10px var(--space-3);
	}

	.small {
		font-size: 0.9rem;
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		margin: 0;
		border-bottom: 1px solid var(--hairline);
	}

	.figures div {
		flex: 1 1 130px;
		padding: 10px var(--space-3);
	}

	.figures div + div {
		border-left: 1px solid var(--hairline);
	}

	.figures dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.figures dd {
		margin: 2px 0 0;
		font-size: 1.2rem;
		font-weight: 600;
	}

	.figures .act {
		flex: 2 1 240px;
		display: grid;
		gap: 4px;
		justify-items: start;
	}

	.act form {
		margin: 0;
	}

	.warn {
		color: var(--warning);
	}

	.table-wrap {
		overflow-x: auto;
		max-height: 380px;
		overflow-y: auto;
	}

	thead th {
		position: sticky;
		top: 0;
		background: var(--surface);
		z-index: 1;
	}

	.pending td {
		color: var(--text-muted);
	}

	.nowrap {
		white-space: nowrap;
	}

	.desc {
		display: block;
		font-size: 0.85rem;
		max-width: 280px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chip + .desc {
		margin-top: 2px;
	}

	@media (max-width: 720px) {
		.figures div + div {
			border-left: 0;
		}

		.desc {
			max-width: 150px;
		}
	}
</style>
