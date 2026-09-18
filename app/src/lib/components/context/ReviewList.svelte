<script lang="ts">
	/*
	  "I could not tell what this means", and claims that failed validation.

	  Both are first-class outcomes and both keep their snippet, because the
	  alternative is dropping them silently and finding out from a customer.
	  The two kinds are labelled differently on purpose: one is a gap in the
	  dictionary, the other is a value we did not believe, and they lead to
	  different work.
	*/
	import { enhance } from '$app/forms';
	import SubmitButton from '$lib/components/ui/SubmitButton.svelte';
	import { sourceLink } from '$lib/context/links';
	import { routes } from '$lib/routes';
	import { day } from '$lib/format';
	import type { ReviewItem } from '$lib/context/types';

	let {
		items,
		requestId,
		thisYear
	}: { items: ReviewItem[]; requestId: string; thisYear?: number } = $props();

	let working = $state<string | null>(null);
	const notes = $state<Record<number, string>>({});

	const KIND_LABEL: Record<ReviewItem['kind'], string> = {
		unparsed: 'Could not tell what it means',
		failed_validation: 'Did not pass validation'
	};
</script>

<ul class="rows">
	{#each items as item (item.id)}
		{@const link = sourceLink(item)}
		<li>
			<div class="head">
				<span class="chip">{KIND_LABEL[item.kind]}</span>
				{#if item.subject_name || item.subject_raw}
					<span class="t-meta">
						about
						{#if item.subject_kind && item.subject_id}
							<a class="link" href={routes.contextFor(item.subject_kind, item.subject_id)}>
								{item.subject_name ?? item.subject_id}
							</a>
						{:else}
							{item.subject_raw}
						{/if}
					</span>
				{/if}
				{#if item.proposed_attribute}
					<span class="t-meta muted mono">{item.proposed_attribute}</span>
				{/if}
				<span class="t-meta muted spacer">{day(item.created_at.slice(0, 10), thisYear)}</span>
			</div>

			<blockquote>{item.snippet}</blockquote>
			<p class="t-meta muted">
				{item.reason}
			</p>
			<p class="t-meta muted">
				{item.source_name}
				<span aria-hidden="true">·</span>
				{item.locator}
				<span aria-hidden="true">·</span>
				read by {item.extractor || 'nobody named'}{#if item.extractor_version}
					v{item.extractor_version}{/if}
				{#if link.href}
					<span aria-hidden="true">·</span>
					<a class="link" href={link.href}>{link.label}</a>
				{:else if item.document_title}
					<span aria-hidden="true">·</span>
					<span>{item.document_title}</span>
				{/if}
			</p>

			<form
				method="POST"
				action="?/review"
				use:enhance={() => {
					working = `${item.id}`;
					return async ({ update }) => {
						working = null;
						await update({ reset: false });
					};
				}}
			>
				<input type="hidden" name="itemId" value={item.id} />
				<input type="hidden" name="rowVersion" value={item.row_version} />
				<input type="hidden" name="requestId" value="{requestId}-review-{item.id}" />
				<input type="hidden" name="note" value={notes[item.id] ?? ''} />
				<label>
					<span class="sr-only">Why, for the record</span>
					<input
						type="text"
						maxlength="500"
						placeholder="Optional note"
						value={notes[item.id] ?? ''}
						oninput={(event) => (notes[item.id] = event.currentTarget.value)}
					/>
				</label>
				<SubmitButton
					label="Dealt with"
					workingLabel="Recording"
					working={working === `${item.id}`}
					record={item.snippet.slice(0, 40)}
					name="decision"
					value="resolved"
					tone="plain"
				/>
				<SubmitButton
					label="Not worth it"
					workingLabel="Recording"
					working={working === `${item.id}`}
					record={item.snippet.slice(0, 40)}
					name="decision"
					value="dismissed"
					tone="plain"
				/>
			</form>
		</li>
	{/each}
</ul>

<style>
	li {
		display: grid;
		gap: 4px;
		padding: var(--space-3);
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
	}

	.spacer {
		margin-left: auto;
	}

	blockquote {
		margin: 0;
		padding-left: var(--space-3);
		border-left: 2px solid var(--hairline);
	}

	p {
		margin: 0;
	}

	form {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		flex-wrap: wrap;
		margin-top: 4px;
	}

	form label {
		flex: 1 1 200px;
		min-width: 0;
	}

	form input[type='text'] {
		width: 100%;
	}
</style>
