<script lang="ts">
	// One staged file, as the person deciding sees it: what it holds, why it
	// is held (if it is), what it would change in the live table, the rows
	// that failed, and the buttons their role allows.
	//
	//   staged -> Apply, Discard
	//   held   -> Release (with a note), Discard
	//   older than the live data -> Discard only
	//
	// The database checks all of this again (role, status, order, version).
	import Blank from '$lib/components/ui/Blank.svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { count, moment, money } from '$lib/format';
	import { EXPORT_KIND_NAME, type SnapshotReview, type SnapshotStatus } from './types';

	let {
		review,
		canDecide,
		requestId,
		message = null
	}: {
		review: SnapshotReview;
		canDecide: boolean;
		requestId: string;
		/** The answer to the last decision, from the form action. */
		message?: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	const r = $derived(review);
	const open = $derived(r.status === 'staged' || r.status === 'held');

	const STATUS_TEXT: Record<SnapshotStatus, string> = {
		staged: 'Ready to apply',
		held: 'Held for a person',
		applied: 'Applied',
		discarded: 'Discarded'
	};
	const statusText = $derived(
		r.status === 'applied' ? (r.isCurrent ? 'Live' : 'Applied, since replaced') : STATUS_TEXT[r.status]
	);

	let submitting = $state(false);
	// Discard is final, so it asks once more.
	let confirmingDiscard = $state(false);
	let note = $state('');
</script>

<section class="review panel" class:held={r.status === 'held' && !r.olderThanCurrent} aria-labelledby="review-title">
	<header class="panel-head">
		<h2 id="review-title">
			Snapshot <span class="mono">#{r.id}</span>
			<span class="file mono muted">{r.fileName}</span>
		</h2>
		<span class="state {r.status}" class:live={r.isCurrent}>{statusText}</span>
	</header>

	<dl class="figures">
		<div>
			<dt>Rows in file</dt>
			<dd class="num">{count(r.rowCount)}</dd>
		</div>
		<div>
			<dt>Good lines</dt>
			<dd class="num">{count(r.lineCount)}</dd>
		</div>
		<div>
			<dt>Rows with problems</dt>
			<dd class="num" class:bad={r.errorCount > 0}>{count(r.errorCount)}</dd>
		</div>
		<div>
			<dt>Open quantity</dt>
			<dd class="num">{count(r.totalQuantity)}</dd>
		</div>
		<div>
			<dt>Open value</dt>
			<dd class="num">{money(r.totalValue)}</dd>
		</div>
	</dl>

	<div class="body facts">
		<p>
			<span class="muted">Layout:</span> {EXPORT_KIND_NAME[r.kind]}
			{#if r.ignoredColumns.length > 0}
				<span class="faint">
					· ignored {r.ignoredColumns.length === 1 ? 'column' : 'columns'}
					{r.ignoredColumns.join(', ')}</span
				>
			{/if}
		</p>
		<p>
			<span class="muted">Loaded</span>
			{moment(r.stagedAt)} by {r.stagedBy}
			{#if r.decidedAt}
				<span class="muted">· {r.status === 'discarded' ? 'discarded' : 'applied'}</span>
				{moment(r.decidedAt)} by {r.decidedBy}
			{/if}
		</p>
		{#if r.decisionNote}
			<p><span class="muted">Note:</span> {r.decisionNote}</p>
		{/if}
	</div>

	{#if r.holdReasons.length > 0}
		<ul class="reasons" aria-label="Why it is held">
			{#each r.holdReasons as reason (reason.code)}
				<li>
					<TriangleAlert size={14} strokeWidth={1.75} aria-hidden="true" />
					<span>{reason.message}</span>
				</li>
			{/each}
		</ul>
	{/if}

	<div class="body diff">
		{#if open}
			<p>
				<span class="muted">Against the live data right now:</span>
				<strong class="num">{count(r.diff.added)}</strong> new ·
				<strong class="num">{count(r.diff.changed)}</strong> changed ·
				<strong class="num">{count(r.diff.removed)}</strong> gone (shipped or cancelled) ·
				<span class="num">{count(r.diff.unchanged)}</span> the same
			</p>
		{:else if r.applySummary}
			<p>
				<span class="muted">Applying it made</span>
				<strong class="num">{count(r.applySummary.added)}</strong> new ·
				<strong class="num">{count(r.applySummary.changed)}</strong> changed ·
				<strong class="num">{count(r.applySummary.removed)}</strong> gone
			</p>
		{:else}
			<p class="muted">Discarded: none of it reached the live data.</p>
		{/if}
	</div>

	{#if r.errors.length > 0}
		<div class="table-wrap">
			<table>
				<thead>
					<tr>
						<th scope="col" class="num">Row</th>
						<th scope="col">Document</th>
						<th scope="col" class="num">Line</th>
						<th scope="col">Problem</th>
					</tr>
				</thead>
				<tbody>
					{#each r.errors as e (e.rowNo)}
						<tr>
							<td class="num">{e.rowNo}</td>
							<td class="mono">{#if e.documentNo}{e.documentNo}{:else}<Blank word="no document number" />{/if}</td>
							<td class="num mono">{#if e.lineNo}{e.lineNo}{:else}<Blank word="no line number" />{/if}</td>
							<td class="problem">{e.reasons.join(' ')}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if r.errorCount > r.errors.length}
				<p class="body faint">Showing the first {r.errors.length} of {count(r.errorCount)} rows with problems.</p>
			{/if}
		</div>
	{/if}

	{#if message}
		<p class="body">
			<span class="notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
				<span>{message.text}</span>
				{#if message.conflict}
					<button class="button" type="button" onclick={() => invalidateAll()}>Reload</button>
				{/if}
			</span>
		</p>
	{/if}

	{#if open}
		<div class="decide">
			{#if !canDecide}
				<p class="muted">Only operations or an admin can apply, release or discard a snapshot.</p>
			{:else}
				<form
					method="POST"
					action="?/decide"
					use:enhance={() => {
						submitting = true;
						return async ({ update }) => {
							await update({ reset: false });
							submitting = false;
							confirmingDiscard = false;
						};
					}}
				>
					<input type="hidden" name="snapshotId" value={r.id} />
					<input type="hidden" name="expectedUpdatedAt" value={r.updatedAt} />
					<input type="hidden" name="requestId" value={requestId} />

					{#if r.olderThanCurrent}
						<p class="muted">A newer export is already live, so this one can only be discarded.</p>
					{:else}
						<p class="live-note"><strong>Nothing is live until you apply it.</strong></p>
					{/if}

					{#if r.status === 'held' && !r.olderThanCurrent}
						<label>
							<span>Why release it anyway? <span class="faint">(required, kept with the snapshot)</span></span>
							<textarea
								name="note"
								rows="2"
								maxlength="500"
								bind:value={note}
								placeholder="For example: the export was filtered to one warehouse on purpose."
							></textarea>
						</label>
					{/if}

					<div class="buttons">
						{#if !r.olderThanCurrent && r.status === 'staged'}
							<button class="button primary" name="decision" value="apply" disabled={submitting}>
								Apply {count(r.lineCount)} lines
							</button>
						{:else if !r.olderThanCurrent}
							<button
								class="button primary"
								name="decision"
								value="release"
								disabled={submitting || note.trim().length < 3}
								title={note.trim().length < 3 ? 'Write a note first' : undefined}
							>
								Release {count(r.lineCount)} lines
							</button>
						{/if}

						{#if confirmingDiscard}
							<span class="confirm">
								<span class="muted">Discard for good?</span>
								<button class="button danger" name="decision" value="discard" disabled={submitting}>
									Yes, discard
								</button>
								<button class="button quiet" type="button" onclick={() => (confirmingDiscard = false)}>
									Keep it
								</button>
							</span>
						{:else}
							<button class="button" type="button" onclick={() => (confirmingDiscard = true)}>Discard</button>
						{/if}
					</div>
				</form>
			{/if}
		</div>
	{/if}
</section>

<style>
	.review {
		animation: fade-in var(--speed-slow) var(--ease);
	}

	/* A held snapshot wears the same warning edge as a closed-short question. */
	.review.held {
		border-color: color-mix(in srgb, var(--warning) 35%, var(--hairline));
	}

	.review.held > .panel-head {
		background: var(--warning-soft);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
	}

	h2 {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
	}

	.file {
		font-weight: 400;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-weight: 500;
		white-space: nowrap;
		--tone: var(--status-promised);
	}

	.state::before {
		content: '';
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--tone) 30%, transparent);
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}

	.state.staged {
		--tone: var(--status-quoted);
	}

	.state.held {
		--tone: var(--status-pushed);
	}

	.state.applied.live {
		--tone: var(--status-kept);
	}

	.state.discarded {
		--tone: var(--status-broken);
	}

	.figures {
		display: flex;
		flex-wrap: wrap;
		margin: 0;
		border-bottom: 1px solid var(--hairline);
	}

	.figures div {
		flex: 1 1 120px;
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
		letter-spacing: -0.015em;
		text-align: left;
	}

	.figures dd.bad {
		color: var(--danger);
	}

	.body {
		padding: 10px var(--space-3);
	}

	.facts {
		display: grid;
		gap: 2px;
	}

	.reasons {
		list-style: none;
		margin: 0;
		padding: 10px var(--space-3);
		display: grid;
		gap: 6px;
		border-top: 1px solid var(--hairline);
		background: var(--warning-soft);
		color: var(--warning);
	}

	.reasons li {
		display: flex;
		gap: var(--space-2);
		align-items: flex-start;
	}

	.reasons li :global(svg) {
		flex: none;
		margin-top: 2px;
	}

	.diff {
		border-top: 1px solid var(--hairline);
	}

	.table-wrap {
		overflow-x: auto;
		border-top: 1px solid var(--hairline);
		max-height: 360px;
		overflow-y: auto;
	}

	.problem {
		min-width: 260px;
	}

	.decide {
		border-top: 1px solid var(--hairline);
		padding: var(--space-3);
	}

	.decide form {
		display: grid;
		gap: var(--space-3);
	}

	.buttons,
	.confirm {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	@media (max-width: 720px) {
		.figures div {
			flex-basis: 45%;
		}

		.figures div + div {
			border-left: 0;
		}

		.file {
			display: none;
		}
	}
</style>
