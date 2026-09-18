<script lang="ts">
	/*
	  What we know about one subject: every fact with its value, its date, how
	  sure we are, who decided it, and the words it came from.

	  The rule this component follows: a fact is never shown without its
	  citation. Not behind a click, not in a tooltip. The snippet is the
	  reason to believe the row, so it is part of the row.

	  A stale fact stays on the list, marked, with how far past its horizon it
	  is and what to do about it. Hiding it would turn "we last heard this
	  three years ago" into "we do not know", which is a different and worse
	  answer.
	*/
	import { enhance } from '$app/forms';
	import Citation from './Citation.svelte';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import { confidencePct, stalenessLabel } from '$lib/context/links';
	import { day } from '$lib/format';
	import { SURFACE_LABEL, type Citation as CitationType, type Surface } from '$lib/context/types';
	import type { EntityFactRow } from '$lib/server/context/read';

	let {
		facts,
		subject,
		requestId,
		thisYear
	}: {
		facts: EntityFactRow[];
		subject: { kind: string; id: string; name: string | null };
		requestId: string;
		thisYear?: number;
	} = $props();

	let working = $state<string | null>(null);

	function citationsOf(fact: EntityFactRow): CitationType[] {
		return Array.isArray(fact.citations) ? (fact.citations as CitationType[]) : [];
	}

	function surfaceWords(surfaces: string[]): string {
		return surfaces.map((surface) => SURFACE_LABEL[surface as Surface] ?? surface).join(', ');
	}

	/** The scope in a person's words, because "*|*|L760-128B|*|*" is not one. */
	function scopeWords(fact: EntityFactRow): string {
		const parts: string[] = [];
		if (fact.scope_item_no) parts.push(`part ${fact.scope_item_no}`);
		if (fact.scope_item_family) parts.push(`${fact.scope_item_family} parts`);
		if (fact.scope_ship_to_no) parts.push(`ship-to ${fact.scope_ship_to_no}`);
		return parts.length === 0 ? 'everything for this account' : `only ${parts.join(' and ')}`;
	}
</script>

<ul class="rows">
	{#each facts as fact (fact.fact_id)}
		<li class:stale={fact.stale} class:expired={fact.expired}>
			<div class="head">
				<span class="label">{fact.attribute_label}</span>
				<span class="value t-figure">{fact.value_display}</span>
				{#if fact.stale}
					<span class="chip warn">stale, {stalenessLabel(fact.days_stale)}</span>
				{/if}
				{#if fact.expired}
					<span class="chip warn">expired {day(fact.valid_to ?? '', thisYear)}</span>
				{/if}
				{#if fact.decided_via === 'person'}
					<span class="chip">decided by {fact.decided_by_name ?? 'a person'}</span>
				{/if}
				{#if fact.disclosure === 'internal'}
					<span class="chip">internal only</span>
				{/if}
			</div>

			<p class="t-meta muted">
				{confidencePct(fact.confidence)} sure
				<span aria-hidden="true">·</span>
				said {day(fact.asserted_at, thisYear)}
				<span aria-hidden="true">·</span>
				{fact.claim_count} claim{fact.claim_count === 1 ? '' : 's'} behind it
				<span aria-hidden="true">·</span>
				{scopeWords(fact)}
				<span aria-hidden="true">·</span>
				used for {surfaceWords(fact.surfaces)}
			</p>
			<p class="t-meta muted">
				{fact.decided_via === 'person'
					? 'A person chose this between two claims, so the rule will not change it back.'
					: `Chosen by the rule: ${fact.decided_rule}`}
			</p>

			{#each citationsOf(fact) as citation (citation.claim_id)}
				<Citation {citation} {thisYear} />
			{/each}

			{#if fact.stale || fact.expired}
				<form
					method="POST"
					action="?/explore"
					use:enhance={() => {
						working = `${fact.fact_id}`;
						return async ({ update }) => {
							working = null;
							await update({ reset: false });
						};
					}}
				>
					<input type="hidden" name="entityKind" value={subject.kind} />
					<input type="hidden" name="entityId" value={subject.id} />
					<input type="hidden" name="attribute" value={fact.attribute} />
					<input type="hidden" name="requestId" value="{requestId}-verify-{fact.fact_id}" />
					<SubmitButton
						label="Look for something newer"
						workingLabel="Looking"
						working={working === `${fact.fact_id}`}
						record="{fact.attribute_label} for {subject.name ?? subject.id}"
						tone="plain"
					/>
				</form>
			{/if}
		</li>
	{/each}
</ul>

<style>
	li {
		display: grid;
		gap: 4px;
		padding: var(--space-3);
	}

	/* A stale row is marked in words and with a rule down its edge, never by
	   colour alone. */
	li.stale,
	li.expired {
		box-shadow: inset 2px 0 0 var(--warning);
	}

	.head {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.label {
		font-weight: 500;
	}

	.value {
		font-variant-numeric: tabular-nums;
	}

	p {
		margin: 0;
	}

	.chip.warn {
		color: var(--warning);
	}
</style>
