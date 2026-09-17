<script lang="ts">
	// The morning upload: pick the ERP's open sales lines CSV and send it for
	// checking. A file that passes is staged (the page then opens it); a wrong
	// report is refused on the spot; data already loaded is recognized.
	// Sample files to try it with sit beside the form.
	import { enhance } from '$app/forms';
	import Download from '@lucide/svelte/icons/download';
	import Upload from '@lucide/svelte/icons/upload';
	import { day } from '$lib/format';
	import type { SAMPLE_KINDS, UploadOutcome } from './types';

	let {
		requestId,
		canRunImports,
		outcome,
		samples,
		year
	}: {
		requestId: string;
		canRunImports: boolean;
		/** What happened to the last upload, when it did not open a snapshot. */
		outcome: UploadOutcome | null;
		samples: typeof SAMPLE_KINDS;
		year: number;
	} = $props();

	let submitting = $state(false);
	let fileName = $state('');
</script>

<section class="upload panel" aria-labelledby="upload-title">
	<header class="panel-head">
		<h2 id="upload-title">Load this morning's export</h2>
		<span class="faint">Nothing is live until you apply it.</span>
	</header>

	<div class="body">
		{#if canRunImports}
			<form
				method="POST"
				action="?/upload"
				enctype="multipart/form-data"
				class="pick"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
						fileName = '';
					};
				}}
			>
				<input type="hidden" name="requestId" value={requestId} />
				<label class="drop" class:chosen={fileName !== ''}>
					<Upload size={16} strokeWidth={1.75} aria-hidden="true" />
					<span class="drop-text">
						{#if fileName}
							<span class="mono">{fileName}</span>
						{:else}
							Choose the <strong>open sales lines</strong> CSV
						{/if}
					</span>
					<input
						class="sr-only"
						type="file"
						name="file"
						accept=".csv,.txt,text/csv"
						required
						onchange={(event) => (fileName = event.currentTarget.files?.[0]?.name ?? '')}
					/>
				</label>
				<button class="button primary" disabled={submitting || fileName === ''} aria-busy={submitting}>
					{#if submitting}<span class="spinner" aria-hidden="true"></span>{/if}
					Check file
				</button>
			</form>
		{:else}
			<p class="muted">Only operations or an admin can load an export. You can look at everything below.</p>
		{/if}

		{#if outcome?.kind === 'refused'}
			{@const r = outcome.refusal}
			<div class="result notice error" role="alert">
				<div class="result-body">
					<p><strong>Refused {r.fileName}.</strong> {r.message} Nothing was written.</p>
					{#if r.looksLike}
						<p>It looks like {r.looksLike}.</p>
					{/if}
					{#if r.headers.length > 0}
						<p class="columns">
							<span>Its columns:</span>
							{#each r.headers.slice(0, 16) as h (h)}<span class="chip">{h}</span>{/each}
							{#if r.headers.length > 16}<span>and {r.headers.length - 16} more</span>{/if}
						</p>
					{/if}
					{#if r.missing.length > 0}
						<p class="columns">
							<span>Needed:</span>
							{#each r.missing as m (m)}<span class="chip">{m}</span>{/each}
						</p>
					{/if}
				</div>
			</div>
		{:else if outcome?.kind === 'duplicate'}
			<div class="result notice warning" role="status">
				<p>
					<strong>Already loaded.</strong>
					{outcome.fileName} holds the same data as snapshot
					<a class="link" href="/operations?snapshot={outcome.snapshotId}">#{outcome.snapshotId}</a>
					({outcome.status}), loaded {day(outcome.stagedOn, year)} by {outcome.stagedBy}. Nothing new was written.
				</p>
			</div>
		{/if}
	</div>

	<footer class="samples">
		<span class="eyebrow">Download a sample file</span>
		<ul>
			{#each samples as s (s.kind)}
				<li>
					<a class="sample pressable" href="/operations/samples/{s.kind}" download title={s.hint}>
						<Download size={13} strokeWidth={1.75} aria-hidden="true" />
						<span>{s.label}</span>
					</a>
					<span class="faint hint">{s.hint}</span>
				</li>
			{/each}
		</ul>
	</footer>
</section>

<style>
	.body {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	.pick {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: stretch;
	}

	/* The whole box is the file picker; the real input is hidden inside it. */
	.drop {
		flex: 1 1 260px;
		display: flex;
		flex-direction: row;
		align-items: center;
		gap: var(--space-2);
		min-height: 40px;
		padding: 0 var(--space-3);
		border: 1px dashed var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface-sunken);
		color: var(--text-muted);
		font-size: 1rem;
		cursor: pointer;
		transition:
			border-color var(--speed) var(--ease),
			background-color var(--speed) var(--ease);
	}

	.drop:hover {
		border-color: var(--text-faint);
		background: var(--surface-hover);
	}

	/* The hidden input still takes keyboard focus; show it on the box. */
	.drop:focus-within {
		border-color: var(--focus);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 22%, transparent);
	}

	.drop.chosen {
		border-style: solid;
		color: var(--text);
	}

	.drop-text {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.pick .button {
		height: auto;
		min-height: 40px;
		padding: 0 14px;
	}

	.spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 1.5px solid color-mix(in srgb, var(--primary-text) 40%, transparent);
		border-top-color: var(--primary-text);
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	.result {
		align-items: flex-start;
	}

	.result-body {
		display: grid;
		gap: 6px;
	}

	.columns {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}

	.samples {
		display: grid;
		gap: 6px;
		padding: 10px var(--space-3) var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	.samples ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 4px var(--space-2);
	}

	.samples li {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.sample {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		height: 24px;
		padding: 0 8px;
		border-radius: var(--radius-sm);
		box-shadow: inset 0 0 0 1px var(--hairline-strong);
		font-weight: 500;
		transition:
			background-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.sample:hover {
		background: var(--surface-hover);
	}

	.hint {
		font-size: 0.85rem;
	}

	/* On a phone the hints take too much room; the title attribute keeps them. */
	@media (max-width: 720px) {
		.hint {
			display: none;
		}
	}
</style>
