<script lang="ts">
	// A saved rule's track record: "Run now", its recent runs, and the next
	// steps and notes it wrote, each linked to what it was about.
	import { enhance } from '$app/forms';
	import Play from '@lucide/svelte/icons/play';
	import type { RuleDetail } from '$lib/automation/types';
	import { count, day, moment } from '$lib/format';

	let {
		detail,
		message = null
	}: {
		detail: RuleDetail;
		/** The answer to the last "Run now". */
		message?: { text: string; failed: boolean } | null;
	} = $props();

	let running = $state(false);
</script>

<section class="panel" aria-labelledby="activity-title">
	<header class="panel-head">
		<h2 id="activity-title">What it has done</h2>
		{#if detail.canEdit}
			<form
				method="POST"
				action="?/run"
				use:enhance={() => {
					running = true;
					return async ({ update }) => {
						// Keep the editor as it is; only the page data refreshes.
						await update({ reset: false });
						running = false;
					};
				}}
			>
				<input type="hidden" name="ruleId" value={detail.id} />
				<button class="button" disabled={running} aria-busy={running} title="Runs the saved version of this rule">
					<Play size={13} strokeWidth={1.75} aria-hidden="true" />
					{running ? 'Running' : 'Run now'}
				</button>
			</form>
		{/if}
	</header>

	{#if message}
		<p class="notice run-message" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
			{message.text}
		</p>
	{/if}

	<div class="columns">
		<div class="block">
			<h3 class="eyebrow">Recent runs</h3>
			{#if detail.runs.length === 0}
				<p class="faint">Not run yet. Switched-on rules run every morning; "Run now" runs it straight away.</p>
			{:else}
				<ul class="list">
					{#each detail.runs as run (run.id)}
						<li>
							<span class="when">
								{moment(run.startedAt)}
								<span class="faint">{run.via === 'schedule' ? 'on schedule' : `by ${run.runBy}`}</span>
							</span>
							{#if run.error}
								<span class="chip error-chip" title={run.error}>Failed</span>
								<span class="faint reason">{run.error}</span>
							{:else if run.finishedAt === null}
								<span class="chip">Running</span>
							{:else}
								<span class="counts">
									{count(run.matched ?? 0)} matched, <strong>{count(run.fired ?? 0)} new</strong>, {count(run.skipped ?? 0)} already done
								</span>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>

		<div class="block">
			<h3 class="eyebrow">
				What it wrote
				{#if detail.firingCount > detail.firings.length}
					<span class="faint">(latest {detail.firings.length} of {count(detail.firingCount)})</span>
				{/if}
			</h3>
			{#if detail.firings.length === 0}
				<p class="faint">Nothing yet.</p>
			{:else}
				<ul class="list">
					{#each detail.firings as f (f.id)}
						<li>
							<span class="what">
								<span class="chip">{f.kind === 'note' ? 'Note' : 'Next step'}</span>
								{f.text ?? 'Removed'}
							</span>
							<span class="faint about">
								{#if f.commitmentId !== null}
									<a class="link" href="/commitments/{f.commitmentId}">C-{f.commitmentId}</a>,
								{/if}
								{f.customerName ?? ''}
								{#if f.assigneeName}· for {f.assigneeName}{/if}
								{#if f.dueOn}· due {day(f.dueOn)}{/if}
								· {moment(f.firedAt)}
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</div>
</section>

<style>
	.run-message {
		margin: var(--space-3) var(--space-3) 0;
	}

	.columns {
		display: flex;
		flex-wrap: wrap;
	}

	.block {
		flex: 1 1 320px;
		min-width: 0;
		display: grid;
		align-content: start;
		gap: 6px;
		padding: var(--space-3);
	}

	.block + .block {
		border-left: 1px solid var(--hairline);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 2px 8px;
		padding: 6px 0;
		border-top: 1px solid var(--hairline);
	}

	.when {
		flex: 1 1 180px;
	}

	.what {
		flex: 1 1 100%;
		display: flex;
		align-items: baseline;
		gap: 6px;
	}

	.about,
	.reason {
		font-size: 0.85rem;
	}

	.reason {
		flex-basis: 100%;
	}

	.error-chip {
		background: var(--danger-soft);
		color: var(--danger);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--danger) 25%, transparent);
	}

	@media (max-width: 720px) {
		.block + .block {
			border-left: 0;
			border-top: 1px solid var(--hairline);
		}
	}
</style>
