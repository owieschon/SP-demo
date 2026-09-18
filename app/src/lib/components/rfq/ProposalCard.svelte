<script lang="ts">
	// The decision. It says exactly what approval will create, and nothing is
	// created until a person presses Approve. Approve sends only the draft id,
	// its row version and a request id: the server takes everything else from
	// the stored, validated draft.
	import Blank from '$lib/components/ui/Blank.svelte';
	import { enhance } from '$app/forms';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import { day, moneyExact } from '$lib/format';

	let {
		draftId,
		updatedAt,
		requestIds,
		customerName,
		lineCount,
		total,
		neededBy,
		needsReview,
		year
	}: {
		draftId: number;
		updatedAt: string;
		requestIds: { approve: string; reject: string };
		customerName: string | null;
		lineCount: number;
		total: number | null;
		neededBy: string | null;
		needsReview: number;
		year: number;
	} = $props();

	let approving = $state(false);
	let rejecting = $state(false);
	let showReject = $state(false);

	const ready = $derived(needsReview === 0);
</script>

<section class="proposal panel" class:ready aria-labelledby="proposal-title">
	<header class="panel-head">
		<h2 id="proposal-title">Proposal</h2>
		<span class="muted">Nothing is created until you approve.</span>
	</header>

	<div class="body">
		{#if ready}
			<p>Approving creates, in one step:</p>
			<ul class="plan">
				<li>
					<CircleCheck size={14} aria-hidden="true" />
					<span>
						A quote for <strong>{customerName}</strong>, {lineCount}
						{lineCount === 1 ? 'line' : 'lines'} totaling
						<strong class="num">{#if total === null}<Blank word="not priced yet" />{:else}{moneyExact(total)}{/if}</strong>, valid for 30 days.
					</span>
				</li>
				<li>
					<CircleCheck size={14} aria-hidden="true" />
					<span>
						A commitment in <strong>Quoted</strong> status, owned by you, confidence 50%, for the same parts,
						{#if neededBy}
							with a window from today to {day(neededBy, year)}.
						{:else}
							with a 90-day window (no date was given).
						{/if}
					</span>
				</li>
			</ul>
		{:else}
			<p class="notice warning" role="status">
				{needsReview}
				{needsReview === 1 ? 'field needs' : 'fields need'} review before this can be approved.
			</p>
		{/if}

		<div class="actions">
			<form
				method="POST"
				action="?/approve"
				use:enhance={() => {
					approving = true;
					return async ({ update }) => {
						await update();
						approving = false;
					};
				}}
			>
				<input type="hidden" name="draftId" value={draftId} />
				<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
				<input type="hidden" name="requestId" value={requestIds.approve} />
				<button class="button primary" disabled={!ready || approving} aria-busy={approving}>
					{#if approving}<span class="spinner" aria-hidden="true"></span>{/if}
					Approve and create
				</button>
			</form>

			{#if !showReject}
				<button class="button" onclick={() => (showReject = true)}>Reject</button>
			{/if}
		</div>

		{#if showReject}
			<form
				method="POST"
				action="?/reject"
				class="reject"
				use:enhance={() => {
					rejecting = true;
					return async ({ update }) => {
						await update();
						rejecting = false;
					};
				}}
			>
				<input type="hidden" name="draftId" value={draftId} />
				<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
				<input type="hidden" name="requestId" value={requestIds.reject} />
				<label>
					<span>Why reject it? <span class="faint">(optional, kept on record)</span></span>
					<textarea name="reason" rows="2" maxlength="500" placeholder="Not a request, duplicate, spam..."></textarea>
				</label>
				<div class="actions">
					<button class="button danger" disabled={rejecting} aria-busy={rejecting}>
						{#if rejecting}<span class="spinner" aria-hidden="true"></span>{/if}
						Reject for good
					</button>
					<button type="button" class="button quiet" onclick={() => (showReject = false)}>Cancel</button>
				</div>
			</form>
		{/if}
	</div>
</section>

<style>
	.proposal {
		transition: border-color var(--speed-slow) var(--ease);
	}

	.proposal.ready {
		border-color: color-mix(in srgb, var(--status-kept) 40%, var(--hairline));
	}

	.body {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	.plan {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}

	.plan li {
		display: flex;
		gap: 8px;
		align-items: baseline;
	}

	.plan :global(svg) {
		flex: none;
		color: var(--status-kept);
		transform: translateY(2px);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.actions form {
		margin: 0;
	}

	.reject {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-3);
		border-top: 1px solid var(--hairline);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 1.5px solid currentColor;
		border-top-color: transparent;
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
