<script lang="ts">
	/*
	  Two claims that disagree, side by side, with both citations, and one
	  click to accept either.

	  The layout is deliberately symmetrical. The rule has a preference (the
	  left card is the one it would have picked) and it is labelled as such,
	  but it is not pre-selected and it is not styled as the answer, because
	  the whole reason this row exists is that the rule was not confident
	  enough to decide. Putting a thumb on the scale here would make the
	  queue a rubber stamp.
	*/
	import { enhance } from '$app/forms';
	import Citation from './Citation.svelte';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import { confidencePct, trustLabel } from '$lib/context/links';
	import { routes } from '$lib/routes';
	import { day } from '$lib/format';
	import type { ConflictRow, ConflictSide } from '$lib/context/types';

	let {
		conflict,
		requestId,
		thisYear
	}: { conflict: ConflictRow; requestId: string; thisYear?: number } = $props();

	let working = $state<number | null>(null);
	let note = $state('');

	const sides: { side: ConflictSide; role: string }[] = $derived([
		{ side: conflict.winner, role: 'The rule would pick this one' },
		{ side: conflict.rival, role: 'This one stopped it' }
	]);

	/** Flexbox, not grid: two columns on a desk, stacked on a phone. */
</script>

<li class="conflict">
	<header>
		<div class="what">
			<h3 class="t-section">
				{conflict.attribute_label} for
				<a class="link" href={routes.contextFor(conflict.subject_kind, conflict.subject_id)}>
					{conflict.subject_name ?? conflict.subject_id}
				</a>
			</h3>
			<p class="t-meta muted">
				{conflict.reason}
				{#if conflict.scope_key !== '*|*|*|*|*'}
					<span class="chip">scoped: {conflict.scope_key}</span>
				{/if}
			</p>
		</div>
		<span class="t-meta muted">raised {day(conflict.raised_at.slice(0, 10), thisYear)}</span>
	</header>

	<div class="sides">
		{#each sides as entry (entry.side.claim_id)}
			<section class="side">
				<p class="eyebrow">{entry.role}</p>
				<p class="value t-figure">{entry.side.value_display}</p>
				<p class="t-meta muted">
					{entry.side.source_name}
					<span aria-hidden="true">·</span>
					tier {entry.side.trust_tier} of 5, {trustLabel(entry.side.trust_tier)}
					<span aria-hidden="true">·</span>
					{confidencePct(entry.side.confidence)} sure
				</p>
				<Citation
					citation={{
						claim_id: entry.side.claim_id,
						source_key: entry.side.source_key,
						source_name: entry.side.source_name,
						trust_tier: entry.side.trust_tier,
						locator: entry.side.locator,
						snippet: entry.side.snippet,
						asserted_at: entry.side.asserted_at,
						captured_at: entry.side.captured_at,
						extractor: entry.side.extractor,
						extractor_version: entry.side.extractor_version,
						ref_table: entry.side.ref_table,
						ref_id: entry.side.ref_id,
						document_title: entry.side.document_title
					}}
					{thisYear}
				/>
				<form
					method="POST"
					action="?/resolve"
					use:enhance={() => {
						working = entry.side.claim_id;
						return async ({ update }) => {
							working = null;
							await update({ reset: false });
						};
					}}
				>
					<input type="hidden" name="conflictId" value={conflict.id} />
					<input type="hidden" name="claimId" value={entry.side.claim_id} />
					<input type="hidden" name="rowVersion" value={conflict.row_version} />
					<input type="hidden" name="requestId" value="{requestId}-{conflict.id}-{entry.side.claim_id}" />
					<input type="hidden" name="note" value={note} />
					<SubmitButton
						label="This one is right"
						workingLabel="Recording"
						working={working === entry.side.claim_id}
						record="{entry.side.value_display} for {conflict.subject_name ?? conflict.subject_id}"
					/>
				</form>
			</section>
		{/each}
	</div>

	<label class="note-field">
		<span class="t-meta muted">Why, for the record (optional)</span>
		<input type="text" bind:value={note} maxlength="500" placeholder="Their controller confirmed it on the phone" />
	</label>
</li>

<style>
	.conflict {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	h3 {
		margin: 0;
	}

	.what p {
		margin: 2px 0 0;
	}

	/* Two columns on a desk, stacked on a phone. Flexbox rather than grid
	   because mobile Safari and Chromium have disagreed about grid gaps
	   inside a list item before, and this needs one axis. */
	.sides {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.side {
		flex: 1 1 280px;
		min-width: 0;
		display: grid;
		gap: 4px;
		padding: var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius-lg);
	}

	.value {
		margin: 0;
	}

	.side p {
		margin: 0;
	}

	.side form {
		margin-top: 4px;
	}

	.note-field {
		display: grid;
		gap: 2px;
	}
</style>
