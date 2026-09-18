<script lang="ts">
	// Where a person decides.
	//
	// The engine promotes what its rules can settle and stops where they
	// cannot. Everything it stopped on is here, in three kinds: two claims
	// that disagree, something it could not read, and a claim it cannot
	// attach to an account. A person's answer to any of them beats the rule
	// and is recorded as theirs.
	import { enhance } from '$app/forms';
	import ConflictCard from '$lib/components/context/ConflictCard.svelte';
	import ReviewList from '$lib/components/context/ReviewList.svelte';
	import EmptyState from '$lib/components/ui/EmptyState.svelte';
	import Page from '$lib/components/ui/Page.svelte';
	import Panel from '$lib/components/ui/Panel.svelte';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import { day } from '$lib/format';
	import { routes } from '$lib/routes';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let working = $state<string | null>(null);

	const message = $derived(form && 'message' in form ? form.message : null);
	const failed = $derived(Boolean(form && 'conflict' in form));
	const thisYear = 2026;
</script>

<Page
	title="Conflicts and queries"
	subtitle="What the rules would not settle on their own. Your answer beats the rule and stays."
>
	<nav class="segmented" aria-label="Which context view">
		<a href={routes.context()}>Coverage</a>
		<a href={routes.contextConflicts()} aria-current="page">Conflicts and queries</a>
	</nav>

	{#if message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>{message}</p>
	{/if}

	<nav class="segmented" aria-label="Which queue">
		<a href="?tab=conflicts" aria-current={data.tab === 'conflicts' ? 'page' : undefined}>
			Disagreements
			{#if data.conflicts.length > 0}<span class="count">{data.conflicts.length}</span>{/if}
		</a>
		<a href="?tab=queries" aria-current={data.tab === 'queries' ? 'page' : undefined}>
			Could not tell
			{#if data.reviewItems.length + data.unresolved.length > 0}
				<span class="count">{data.reviewItems.length + data.unresolved.length}</span>
			{/if}
		</a>
	</nav>

	{#if data.tab === 'conflicts'}
		<Panel title="Two claims, and nothing to choose between them" flush>
			{#if data.conflicts.length === 0}
				<EmptyState
					line="Nothing is waiting on a decision. Everything the sources say either agrees or is settled by trust."
					action="See the coverage list"
					href={routes.context()}
				/>
			{:else}
				<ul class="rows">
					{#each data.conflicts as conflict (conflict.id)}
						<ConflictCard {conflict} requestId={data.requestId} {thisYear} />
					{/each}
				</ul>
			{/if}
		</Panel>
	{:else}
		<Panel
			title="Could not tell what it means"
			source="extractions that did not land on a dictionary attribute, and values we did not believe"
			flush
		>
			{#if data.reviewItems.length === 0}
				<EmptyState line="Nothing unread. Everything an extractor found landed on an attribute." />
			{:else}
				<ReviewList items={data.reviewItems} requestId={data.requestId} {thisYear} />
			{/if}
		</Panel>

		<Panel title="Claims with nobody to attach them to" flush>
			{#if data.unresolved.length === 0}
				<EmptyState line="Every claim has a subject. Nothing is waiting on a match." />
			{:else}
				<ul class="rows">
					{#each data.unresolved as row (`${row.subject_kind}|${row.subject_raw}`)}
						<li class="unresolved">
							<div class="head">
								<span class="label">{row.subject_raw}</span>
								<span class="t-meta muted">
									{row.claims} claim{row.claims === 1 ? '' : 's'} waiting
									<span aria-hidden="true">·</span>
									{row.attributes.join(', ')}
									<span aria-hidden="true">·</span>
									first seen {day(row.first_seen.slice(0, 10), thisYear)}
								</span>
							</div>
							{#if row.candidates.length === 0}
								<p class="t-meta muted">
									Nothing in the book looks like it. Somebody has to say which account this is, or
									that it is nobody.
								</p>
							{:else}
								<p class="t-meta muted">
									The closest matches, and how sure the matcher was. None of them was decisive.
								</p>
								<ul class="candidates">
									{#each row.candidates as candidate (`${candidate.target_kind}|${candidate.target_id}`)}
										<li>
											<span>{candidate.name ?? candidate.target_id}</span>
											<span class="t-meta muted">
												{Math.round(candidate.score * 100)}% sure
												{#if candidate.detail}
													<span aria-hidden="true">·</span>{candidate.detail}
												{/if}
											</span>
											<form
												method="POST"
												action="?/link"
												use:enhance={() => {
													working = `${row.subject_raw}|${candidate.target_id}`;
													return async ({ update }) => {
														working = null;
														await update({ reset: false });
													};
												}}
											>
												<input type="hidden" name="rawKind" value="name" />
												<input type="hidden" name="rawValue" value={row.subject_raw} />
												<input type="hidden" name="targetKind" value={candidate.target_kind} />
												<input type="hidden" name="targetId" value={candidate.target_id} />
												<input type="hidden" name="decision" value="accepted" />
												<input
													type="hidden"
													name="requestId"
													value="{data.requestId}-link-{candidate.target_id}"
												/>
												<SubmitButton
													label="This is them"
													workingLabel="Matching"
													working={working === `${row.subject_raw}|${candidate.target_id}`}
													record="{row.subject_raw} is {candidate.name ?? candidate.target_id}"
													tone="plain"
												/>
											</form>
										</li>
									{/each}
								</ul>
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{/if}
</Page>

<style>
	.count {
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
	}

	.unresolved {
		display: grid;
		gap: 4px;
		padding: var(--space-3);
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

	.unresolved p {
		margin: 0;
	}

	.candidates {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.candidates > li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
		padding: 4px 0;
	}

	.candidates > li > form {
		margin-left: auto;
	}
</style>
