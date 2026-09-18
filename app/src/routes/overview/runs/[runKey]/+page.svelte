<script lang="ts">
	/*
	  One run, in the order it happened: woken, read, decided, refused, acted.

	  Four panels rather than one table, because these are four different
	  questions and a reader arriving from "approval rate 88%" wants to know
	  what one of the twelve percent actually looked like.
	*/
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { count, moment } from '$lib/format';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const run = $derived(data.detail.run);

	const REVIEW_WORD: Record<string, string> = {
		none: 'Nobody was asked to look at this one.',
		waiting: 'Waiting on a person.',
		approved: 'A person approved it as drafted.',
		edited_approved: 'A person corrected it and then approved it.',
		rejected: 'A person rejected it.'
	};

	/** The ids the run was given to work from, as name and value pairs. */
	const inputs = $derived(
		Object.entries(run.inputIds).filter(([, value]) => value !== null && value !== undefined)
	);
	const produced = $derived(
		Object.entries(run.producedRef).filter(([, value]) => value !== null && value !== undefined)
	);
</script>

<Page
	title="{run.agent}: {run.workKind}"
	documentTitle="Run {run.runKey}"
	subtitle="Run {run.runKey}, started {moment(run.startedAt)}, {count(run.ms)} ms."
	width="read"
>
	{#snippet breadcrumb()}
		<a class="link-quiet" href={data.nav.overview}>
			<ArrowLeft size={13} strokeWidth={1.75} aria-hidden="true" />
			Overview
		</a>
		<span class="sep" aria-hidden="true">/</span>
		<a class="link-quiet" href={data.nav.runs}>Agent runs</a>
	{/snippet}

	{#snippet actions()}
		<a class="button sm" href={data.detail.agentHref}>Every run by this agent</a>
	{/snippet}

	<Panel title="What woke it">
		<dl class="pairs">
			<dt>Trigger</dt>
			<dd>{run.wokeBy}{run.wakeDetail ? `: ${run.wakeDetail}` : ''}</dd>
			<dt>About</dt>
			<dd>
				{#if data.detail.subjectHref && run.subjectNo}
					<a class="link" href={data.detail.subjectHref}>{run.subjectNo}</a>
					<span class="muted">({run.subjectKind})</span>
				{:else}
					<span class="muted">nothing in particular</span>
				{/if}
			</dd>
			{#if inputs.length}
				<dt>Given</dt>
				<dd class="mono small">
					{#each inputs as [name, value] (name)}
						<span class="pill">{name}: {String(value)}</span>
					{/each}
				</dd>
			{/if}
			<dt>Allowed to</dt>
			<dd>
				{#if data.detail.levelLabel}
					<a class="link" href={data.detail.levelHref}>{data.detail.levelLabel}</a>
					<span class="muted block">{data.detail.levelMeaning}</span>
				{:else}
					<span class="muted">no level is recorded for this kind of work</span>
				{/if}
			</dd>
			<dt>Model</dt>
			<dd>
				{run.mode}{run.model ? `, ${run.model}` : ''}
				{#if run.inputTokens || run.outputTokens}
					<span class="muted">
						({count(run.inputTokens)} in, {count(run.outputTokens)} out)
					</span>
				{/if}
			</dd>
		</dl>
	</Panel>

	<Panel title="What it read" source="the lookups the run made" flush>
		{#if run.toolCalls.length === 0}
			<p class="t-meta muted note">It made no lookups: nothing in the database was read for this run.</p>
		{:else}
			<ul class="rows">
				{#each run.toolCalls as call, i (`${call.name}-${i}`)}
					<li class="call">
						<span class="mono">{call.name ?? 'unnamed lookup'}</span>
						<span class="t-meta muted">
							{#if call.rows !== null && call.rows !== undefined}{count(Number(call.rows))} rows{/if}
							{#if call.ms !== null && call.ms !== undefined}· {count(Number(call.ms))} ms{/if}
							{#if call.risk}· risk {call.risk}{/if}
							{#if call.outcome}· {call.outcome}{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>

	<Panel title="What it decided">
		<dl class="pairs">
			<dt>Produced</dt>
			<dd>
				{run.produced}
				{#if produced.length}
					<span class="mono small block">
						{#each produced as [name, value] (name)}
							<span class="pill">{name}: {String(value)}</span>
						{/each}
					</span>
				{/if}
			</dd>
			<dt>Outcome</dt>
			<dd>{run.outcome}</dd>
			<dt>Review</dt>
			<dd>
				{REVIEW_WORD[run.reviewState] ?? run.reviewState}
				{#if run.reviewedByName}
					<span class="muted">{run.reviewedByName}, {run.reviewedAt ? moment(run.reviewedAt) : ''}</span>
				{/if}
				{#if run.editDeltaChars !== null}
					<span class="muted block">The correction changed {count(run.editDeltaChars)} characters.</span>
				{/if}
			</dd>
			{#if run.degraded}
				<dt>Degraded</dt>
				<dd class="warnword">
					{run.degradedReason ?? 'it fell back to a cheaper path'}. A degraded run never acts on its own.
				</dd>
			{/if}
		</dl>
	</Panel>

	<Panel title="What it was refused, and what it did anyway" source="guardrails and the autonomy ladder">
		{#if run.guardrail}
			<p class="notice warning" role="status">
				<span><strong>{run.guardrail}</strong>: {run.guardrailReason}</span>
			</p>
		{:else}
			<p class="t-meta muted">No guardrail stopped this run.</p>
		{/if}

		{#if run.action}
			<dl class="pairs">
				<dt>Acted</dt>
				<dd>
					{run.action.action} on {run.action.entity} {run.action.entityId}, at level
					{run.action.atLevel}, as {run.action.actedByName}, {moment(run.action.actedAt)}.
				</dd>
				<dt>Undo</dt>
				<dd>
					{#if run.action.status === 'undone'}
						Undone by {run.action.undoneByName}
						{run.action.undoneAt ? moment(run.action.undoneAt) : ''}{run.action.undoReason
							? `: ${run.action.undoReason}`
							: ''}.
					{:else if run.action.undoable}
						Still undoable until {run.action.undoUntil ? moment(run.action.undoUntil) : 'unknown'}.
					{:else if run.action.status === 'irreversible'}
						This one cannot be undone.
					{:else}
						The undo window has closed.
					{/if}
				</dd>
				{#if run.action.sampled}
					<dt>Sampled</dt>
					<dd>
						Picked for review after the fact.
						{run.action.sampleVerdict ? `Verdict: ${run.action.sampleVerdict}.` : 'Nobody has looked yet.'}
					</dd>
				{/if}
			</dl>
		{:else}
			<p class="t-meta muted">It took no action on its own authority.</p>
		{/if}

		{#if run.events.length > 0}
			<h3 class="sub">Every check on this run, oldest first</h3>
			<ul class="rows">
				{#each run.events as event, i (`${event.kind}-${event.check_id}-${i}`)}
					<li class="event">
						<span class="mono">{event.check_id}</span>
						<span class="t-meta muted">{event.kind} · {event.verdict} · {event.detail}</span>
					</li>
				{/each}
			</ul>
		{/if}
	</Panel>
</Page>

<style>
	.pairs {
		display: grid;
		grid-template-columns: 9rem 1fr;
		gap: var(--space-2) var(--space-3);
		margin: 0;
	}

	.pairs dt {
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.pairs dd {
		margin: 0;
		min-width: 0;
	}

	.block {
		display: block;
	}

	.small {
		font-size: var(--fs-meta);
	}

	.pill {
		display: inline-block;
		margin: 1px 4px 1px 0;
		padding: 0 5px;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.call,
	.event {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		flex-wrap: wrap;
	}

	.note {
		padding: var(--space-3);
	}

	.warnword {
		color: var(--warning);
	}

	.sub {
		font-size: var(--fs-meta);
		color: var(--text-muted);
		margin: var(--space-3) 0 0;
	}

	/* On a phone the label stacks above its value rather than squeezing it. */
	@media (max-width: 720px) {
		.pairs {
			grid-template-columns: 1fr;
			gap: 2px;
		}

		.pairs dd {
			margin-bottom: var(--space-2);
		}
	}
</style>
