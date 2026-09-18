<script lang="ts">
	// What the agent did, step by step.
	//
	// This is the thing that makes a person comfortable approving a draft
	// without doing the work again: what it read, what it called, what it
	// decided, and what it would not do. Refusals are marked, because a reply
	// that was not sent and the rule that stopped it is the most persuasive
	// line in the record.
	//
	// A withheld step shows its label and why the detail is not here. A trail
	// that quietly dropped a step would be worth nothing.
	import Ban from '@lucide/svelte/icons/ban';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import type { RunTrail } from '$lib/agentruns/types';
	import { OUTCOME_LABEL, REVIEW_LABEL, STEP_LABEL, WOKE_LABEL } from '$lib/agentruns/types';
	import { count, moment } from '$lib/format';

	let {
		run,
		open = false,
		heading = 'What the agent did'
	}: { run: RunTrail; open?: boolean; heading?: string } = $props();

	/** "1.4s", "820ms". */
	function took(ms: number | null): string {
		if (ms === null) return 'not timed';
		return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
	}

	const tokens = $derived(run.inputTokens + run.outputTokens);
</script>

<details class="trail" {open}>
	<summary>
		<span class="what">{heading}</span>
		<span class="meta faint">
			{run.stepCount}
			{run.stepCount === 1 ? 'step' : 'steps'}
			{#if run.refusals > 0}
				· <strong class="refused">{run.refusals} {run.refusals === 1 ? 'refusal' : 'refusals'}</strong>
			{/if}
			· {took(run.ms)}
			· {tokens === 0 ? 'no model tokens' : `${count(tokens)} tokens`}
		</span>
	</summary>

	<dl class="head">
		<div>
			<dt>Woke</dt>
			<dd>{WOKE_LABEL[run.wokeBy]}{run.wokeNote ? `: ${run.wokeNote}` : ''}</dd>
		</div>
		<div>
			<dt>Ended</dt>
			<dd>
				{OUTCOME_LABEL[run.outcome] ?? run.outcome}{run.finishedAt ? ` · ${moment(run.finishedAt)}` : ''}
			</dd>
		</div>
		<div>
			<dt>Model</dt>
			<dd>{run.mode === 'mock' ? 'scripted demo classifier, no model call' : (run.model ?? 'live')}</dd>
		</div>
		{#if run.bundleVersion}
			<div>
				<dt>Context bundle</dt>
				<dd class="mono">{run.bundleVersion}</dd>
			</div>
		{/if}
		<div>
			<dt>Since then</dt>
			<dd>{REVIEW_LABEL[run.reviewState] ?? run.reviewState}</dd>
		</div>
		{#if run.guardrail}
			<div>
				<dt>Guardrail</dt>
				<dd class="refused">{run.guardrail}{run.guardrailReason ? `: ${run.guardrailReason}` : ''}</dd>
			</div>
		{/if}
	</dl>

	{#if run.decision}
		<p class="decision">{run.decision}</p>
	{/if}

	<ol class="steps">
		{#each run.steps as step (step.id)}
			<li class="step {step.kind}">
				<span class="kind">
					{#if step.kind === 'refusal'}<Ban size={12} aria-hidden="true" />{/if}
					{#if step.withheld}<EyeOff size={12} aria-hidden="true" />{/if}
					{STEP_LABEL[step.kind]}
				</span>
				<span class="body">
					<span class="label">{step.label}</span>
					{#if step.withheld}
						<!--
							The withholding is the point of showing it. The step is
							still numbered and still labelled; this line says what
							is missing and why, so a reader knows to ask rather
							than never knowing there was anything to ask about.
						-->
						<span class="withheld">Withheld: {step.withheldReason}</span>
						{#if step.factKinds.length > 0}
							<span class="kinds faint">
								Rests on: {step.factKinds.join(', ')}
							</span>
						{/if}
					{:else}
						{#if step.args}
							<code class="args">{JSON.stringify(step.args)}</code>
						{/if}
						{#if step.result}
							<span class="result">{step.result}</span>
						{/if}
					{/if}
					{#if step.rule}
						<span class="rule">
							<span class="mono">{step.rule}</span>
							{#if step.ruleNote}<span class="faint">{step.ruleNote}</span>{/if}
						</span>
					{/if}
				</span>
				<span class="numbers faint">
					{#if step.rows !== null}{step.rows} {step.rows === 1 ? 'row' : 'rows'}{/if}
					{#if step.ms !== null}· {step.ms}ms{/if}
				</span>
			</li>
		{/each}
	</ol>

	{#if run.steps.length === 0}
		<p class="empty muted">This run recorded no steps.</p>
	{/if}
</details>

<style>
	.trail {
		border: 1px solid var(--hairline);
		border-radius: var(--radius-lg);
		background: var(--surface);
	}

	summary {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-2);
		padding: 8px var(--space-3);
		cursor: pointer;
		border-radius: var(--radius-lg);
		transition: background-color var(--speed) var(--ease);
	}

	summary:hover {
		background: var(--surface-hover);
	}

	.what {
		font-weight: 500;
	}

	.meta {
		font-size: 0.85rem;
	}

	.refused {
		color: var(--warning);
		font-weight: 500;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 4px var(--space-4);
		margin: 0;
		padding: var(--space-2) var(--space-3);
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		font-size: 0.88rem;
	}

	.head dt {
		color: var(--text-muted);
		font-size: 0.82rem;
	}

	.head dd {
		margin: 0;
	}

	.decision {
		padding: var(--space-2) var(--space-3);
		border-top: 1px solid var(--hairline);
		max-width: 84ch;
	}

	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.step {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
		padding: 6px var(--space-3);
		border-top: 1px solid var(--hairline);
		font-size: 0.9rem;
	}

	.step.refusal {
		background: var(--warning-soft);
	}

	.kind {
		flex: none;
		width: 84px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		color: var(--text-faint);
		font-size: 0.8rem;
		text-transform: lowercase;
	}

	.step.refusal .kind {
		color: var(--warning);
	}

	.body {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	.label {
		font-weight: 500;
	}

	.result,
	.withheld,
	.kinds,
	.rule {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.kinds {
		font-family: var(--font-mono);
		font-size: 0.78rem;
	}

	.result {
		color: var(--text-muted);
	}

	.withheld {
		color: var(--warning);
	}

	.args {
		font-family: var(--font-mono);
		font-size: 0.78rem;
		color: var(--text-muted);
		overflow-wrap: anywhere;
	}

	.rule {
		font-size: 0.82rem;
		display: grid;
		gap: 1px;
	}

	.numbers {
		flex: none;
		font-size: 0.8rem;
		white-space: nowrap;
	}

	.empty {
		padding: var(--space-3);
	}

	@media (max-width: 720px) {
		.step {
			flex-wrap: wrap;
			gap: 4px;
		}

		.kind {
			width: auto;
		}

		.numbers {
			width: 100%;
		}
	}
</style>
