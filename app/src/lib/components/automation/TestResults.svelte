<script lang="ts">
	// What "Test this rule" found: how many things match right now, and for
	// the first of them, the values that made them match and the exact text
	// the rule would write. Nothing was written to find this out.
	import { TRIGGERS, type TriggerKey } from '$lib/automation/catalog';
	import { formatValue } from '$lib/automation/describe';
	import type { TestResult } from '$lib/automation/types';
	import { count } from '$lib/format';

	let {
		result,
		trigger,
		kind
	}: {
		result: TestResult;
		trigger: TriggerKey;
		kind: 'next_step' | 'note';
	} = $props();

	const columns = $derived(
		result.fields
			.map((key) => TRIGGERS[trigger].fields.find((f) => f.key === key))
			.filter((f) => f !== undefined)
	);
	const fresh = $derived(result.total - result.alreadyFired);
</script>

<section class="panel results" aria-labelledby="test-title" aria-live="polite">
	<header class="panel-head">
		<h2 id="test-title">
			Would match {count(result.total)} right now
		</h2>
		<span class="faint">
			{#if result.total === 0}
				Nothing to do today. Try looser conditions to see what it would catch.
			{:else if result.alreadyFired > 0}
				{count(fresh)} new, {count(result.alreadyFired)} already done. A rule acts once per {TRIGGERS[trigger].subject}.
			{:else}
				A run would write {count(result.total)} {kind === 'note' ? 'notes' : 'next steps'}. Nothing was written by this test.
			{/if}
		</span>
	</header>

	{#if result.matches.length > 0}
		<div class="scroll">
			<table>
				<thead>
					<tr>
						<th>Match</th>
						{#each columns as f (f.key)}
							<th class="num">{f.label}</th>
						{/each}
						<th>It would write</th>
					</tr>
				</thead>
				<tbody>
					{#each result.matches as m (m.subjectKey)}
						<tr class:done={m.alreadyFired}>
							<td>
								<div class="match">
									{#if m.commitmentId !== null}
										<span><a class="link" href="/commitments/{m.commitmentId}">C-{m.commitmentId}</a> {m.headline}</span>
									{:else}
										<span>{m.headline}</span>
									{/if}
									<span class="faint small">{m.customerName} <span class="mono">{m.customerNo}</span></span>
								</div>
							</td>
							{#each columns as f (f.key)}
								<td class="num">{formatValue(f.type, m.values[f.key])}</td>
							{/each}
							<td>
								<div class="text">
									<span>{m.text}</span>
									<span class="small faint">
										{#if m.alreadyFired}
											<span class="chip">Already done</span>
										{/if}
										{#if m.assigneeName}for {m.assigneeName}{/if}
									</span>
								</div>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if result.total > result.matches.length}
			<p class="faint more">Showing the first {result.matches.length} of {count(result.total)}.</p>
		{/if}
	{/if}
</section>

<style>
	.results {
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.panel-head {
		flex-wrap: wrap;
	}

	/* A wide table scrolls inside its panel instead of widening the page. */
	.scroll {
		overflow-x: auto;
	}

	table {
		min-width: 640px;
	}

	td {
		vertical-align: top;
		padding-top: 7px;
		padding-bottom: 7px;
	}

	.match,
	.text {
		display: grid;
		gap: 2px;
	}

	.match {
		min-width: 200px;
	}

	.text {
		min-width: 240px;
	}

	.small {
		font-size: 0.85rem;
	}

	tr.done {
		color: var(--text-muted);
	}

	.more {
		padding: 8px var(--space-3);
		border-top: 1px solid var(--hairline);
	}
</style>
