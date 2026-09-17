<script lang="ts">
	// The decision. This is the only way anything the assistant suggests gets
	// written, and the card says so out loud.
	//
	// Each option carries the exact input that would run, and the form sends
	// that input back with the approval. The server does not use it to write:
	// it compares it with the stored proposal and refuses if the two differ, so
	// approving something other than what is on the screen is not possible.
	import { enhance } from '$app/forms';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import { APPROVAL_PROMISE, type ProposalView } from '$lib/assistant/types';
	import { moment } from '$lib/format';

	let {
		proposal,
		conversationId,
		requestId
	}: { proposal: ProposalView; conversationId: number; requestId: string } = $props();

	let busy = $state(-1);
	let rejecting = $state(false);
	let showReject = $state(false);

	const open = $derived(proposal.status === 'draft' || (proposal.status === 'approved' && proposal.error !== null));
	const chosen = $derived(proposal.chosenIndex === null ? null : proposal.options[proposal.chosenIndex]);
</script>

<section class="proposal" class:open aria-labelledby="proposal-{proposal.id}-title">
	<header>
		<ShieldCheck size={14} aria-hidden="true" />
		<h3 id="proposal-{proposal.id}-title">
			{#if open}
				Your decision
			{:else if proposal.status === 'executed'}
				Done
			{:else if proposal.status === 'rejected'}
				Rejected
			{:else}
				Approved
			{/if}
		</h3>
		<span class="faint small">{open ? APPROVAL_PROMISE : `Proposal ${proposal.id}`}</span>
	</header>

	<p class="summary">{proposal.summary}</p>

	{#if open}
		<ul class="options">
			{#each proposal.options as option, index (index)}
				<li>
					<div class="what">
						<span class="label">{option.label}</span>
						<span class="faint small mono">{option.tool}({JSON.stringify(option.input)})</span>
					</div>
					<form
						method="POST"
						action="?/decide"
						use:enhance={() => {
							busy = index;
							return async ({ update }) => {
								await update();
								busy = -1;
							};
						}}
					>
						<input type="hidden" name="proposalId" value={proposal.id} />
						<input type="hidden" name="conversationId" value={conversationId} />
						<input type="hidden" name="decision" value="approve" />
						<input type="hidden" name="optionIndex" value={index} />
						<input type="hidden" name="expectedUpdatedAt" value={proposal.updatedAt} />
						<input type="hidden" name="requestId" value="{requestId}-{proposal.id}-{index}" />
						<!-- What this page is showing. The server checks it against the
						     stored proposal and writes from the stored one. -->
						<input type="hidden" name="shownTool" value={option.tool} />
						<input type="hidden" name="shownInput" value={JSON.stringify(option.input)} />
						<button class="button primary" disabled={busy !== -1} aria-busy={busy === index}>
							{#if busy === index}<span class="spinner" aria-hidden="true"></span>{/if}
							Approve
						</button>
					</form>
				</li>
			{/each}
		</ul>

		{#if proposal.error}
			<p class="notice error" role="alert">
				The last attempt did not go through: {proposal.error} You can approve it again.
			</p>
		{/if}

		{#if showReject}
			<form
				method="POST"
				action="?/decide"
				class="reject"
				use:enhance={() => {
					rejecting = true;
					return async ({ update }) => {
						await update();
						rejecting = false;
					};
				}}
			>
				<input type="hidden" name="proposalId" value={proposal.id} />
				<input type="hidden" name="conversationId" value={conversationId} />
				<input type="hidden" name="decision" value="reject" />
				<input type="hidden" name="expectedUpdatedAt" value={proposal.updatedAt} />
				<input type="hidden" name="requestId" value="{requestId}-{proposal.id}-no" />
				<label>
					<span>Why not? <span class="faint">(optional, kept on record)</span></span>
					<textarea name="reason" rows="2" maxlength="500" placeholder="Not what the buyer said..."></textarea>
				</label>
				<div class="row">
					<button class="button danger" disabled={rejecting} aria-busy={rejecting}>
						{#if rejecting}<span class="spinner" aria-hidden="true"></span>{/if}
						Reject for good
					</button>
					<button type="button" class="button quiet" onclick={() => (showReject = false)}>Cancel</button>
				</div>
			</form>
		{:else}
			<div class="row">
				<button type="button" class="button" onclick={() => (showReject = true)}>Reject</button>
				<span class="faint small">Rejecting is final. Nothing is written either way until you choose.</span>
			</div>
		{/if}
	{:else}
		<p class="settled">
			{#if proposal.status === 'executed' && chosen}
				<CircleCheck size={13} aria-hidden="true" />
				<span>
					{chosen.label}. Written {proposal.decidedAt ? moment(proposal.decidedAt) : 'just now'} by you, through
					the same function the pages use.
				</span>
			{:else if proposal.status === 'rejected'}
				<span>
					Rejected{proposal.decidedAt ? ` ${moment(proposal.decidedAt)}` : ''}{proposal.reason
						? `: ${proposal.reason}`
						: '.'} Nothing was written.
				</span>
			{:else if chosen}
				<span>Approved: {chosen.label}. Waiting to run.</span>
			{/if}
		</p>
	{/if}
</section>

<style>
	.proposal {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius-lg);
		background: var(--surface);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.proposal.open {
		border-color: color-mix(in srgb, var(--status-quoted) 45%, var(--hairline));
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.04);
	}

	header {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	header :global(svg) {
		flex: none;
		color: var(--status-quoted);
	}

	h3 {
		font-size: 0.92rem;
	}

	.small {
		font-size: 0.88rem;
	}

	.summary {
		max-width: 76ch;
	}

	.options {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: var(--space-2);
	}

	.options li {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: var(--space-2);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface-sunken);
	}

	.what {
		display: grid;
		gap: 2px;
		min-width: 0;
	}

	.what .label {
		font-weight: 500;
	}

	.what .mono {
		overflow-wrap: anywhere;
	}

	.options form {
		margin: 0;
		flex: none;
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.reject {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--hairline);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.settled {
		display: flex;
		align-items: baseline;
		gap: 6px;
		color: var(--text-muted);
	}

	.settled :global(svg) {
		flex: none;
		color: var(--status-kept);
		transform: translateY(2px);
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

	@media (max-width: 720px) {
		.options li {
			flex-direction: column;
			align-items: stretch;
		}

		.options form button {
			width: 100%;
			height: 34px;
		}
	}
</style>
