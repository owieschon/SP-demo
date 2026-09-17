<script lang="ts">
	// One draft in the review queue: who it goes to, what it says, the facts it
	// rests on, and the three decisions a person can make about it.
	//
	// Nothing on this card sends anything by itself. Every button is a form
	// post, and the server checks the reviewer, the row version and the
	// recipient allowlist all over again.
	import { enhance } from '$app/forms';
	import Check from '@lucide/svelte/icons/check';
	import PencilLine from '@lucide/svelte/icons/pencil-line';
	import Send from '@lucide/svelte/icons/send';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import FactList from './FactList.svelte';
	import { DRAFT_STATUS_LABEL, INTENT_LABEL, type DraftView } from '$lib/desk/types';
	import { moment } from '$lib/format';

	let {
		draft,
		requestId,
		showMessageLink = true
	}: { draft: DraftView; requestId: string; showMessageLink?: boolean } = $props();

	// Editing opens in place, seeded with what the agent wrote, so a reviewer
	// changes a sentence rather than retyping the reply.
	let editing = $state(false);
	// Filled from the draft when editing opens, not up here: reading a prop
	// into state at setup would freeze the first value the card ever saw.
	let subject = $state('');
	let body = $state('');
	let busy = $state(false);

	function startEditing() {
		subject = draft.subject;
		body = draft.body;
		editing = true;
	}

	const decided = $derived(draft.status === 'sent' || draft.status === 'rejected');
	const sendable = $derived(draft.status === 'draft' && draft.blockedReason === '' && draft.recipientsAllowed);
</script>

<article class="draft" class:held={draft.blockedReason !== ''}>
	<header>
		<span class="mono id">M-{draft.id}</span>
		<span class="chip">{INTENT_LABEL[draft.intent]}</span>
		<span class="chip state {draft.status}">{DRAFT_STATUS_LABEL[draft.status]}</span>
		{#if draft.edited}<span class="chip">Edited by {draft.reviewedByName}</span>{/if}
		<span class="faint small when">{moment(draft.createdAt)}</span>
	</header>

	<dl class="head">
		<dt>From</dt>
		<dd class="mono small">{draft.mailboxAddress}</dd>
		<dt>To</dt>
		<dd class="mono small">{draft.to.join(', ')}{draft.cc.length > 0 ? ` (cc ${draft.cc.join(', ')})` : ''}</dd>
		<dt>Subject</dt>
		<dd>{draft.subject}</dd>
		{#if showMessageLink && draft.inReplyToId}
			<dt>In reply to</dt>
			<dd><a class="link" href="/desk/{draft.inReplyToId}">{draft.replySubject || 'the message'}</a></dd>
		{/if}
	</dl>

	{#if draft.blockedReason !== ''}
		<p class="notice warning" role="alert">
			<TriangleAlert size={13} aria-hidden="true" />
			<span>{draft.blockedReason}</span>
		</p>
	{/if}
	{#if !draft.recipientsAllowed}
		<p class="notice warning" role="alert">
			<TriangleAlert size={13} aria-hidden="true" />
			<span>
				{draft.blockedRecipients.join(', ')} is not on this server's mail allowlist, so this cannot be sent
				from here.
			</span>
		</p>
	{/if}
	{#if draft.error}
		<p class="notice error" role="alert">{draft.error}</p>
	{/if}

	<!-- Plain text. Nothing the agent or a customer wrote is ever rendered as HTML. -->
	<pre class="body">{draft.body}</pre>

	{#if draft.attachments.length > 0}
		<p class="small muted">
			Attached: {draft.attachments.map((a) => a.name).join(', ')}
		</p>
	{/if}

	<FactList facts={draft.facts} />

	{#if draft.status === 'sent'}
		<p class="small muted">
			Sent {draft.sentAt ? moment(draft.sentAt) : ''} as <span class="mono">{draft.providerMessageId}</span>.
		</p>
	{:else if draft.status === 'rejected'}
		<p class="small muted">
			Rejected by {draft.reviewedByName}{draft.rejectReason ? `: ${draft.rejectReason}` : '.'}
		</p>
	{/if}

	{#if !decided}
		{#if editing}
			<form
				method="POST"
				action="?/approve"
				class="editor"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update();
						busy = false;
						editing = false;
					};
				}}
			>
				<input type="hidden" name="draftId" value={draft.id} />
				<input type="hidden" name="expectedUpdatedAt" value={draft.updatedAt} />
				<input type="hidden" name="requestId" value="{requestId}-edit-{draft.id}" />
				<label>
					<span>Subject</span>
					<input name="subject" bind:value={subject} maxlength="300" />
				</label>
				<label>
					<span>Reply</span>
					<textarea name="body" rows="12" class="mono" bind:value={body} maxlength="20000"></textarea>
				</label>
				<div class="actions">
					<button class="button primary" disabled={busy}>
						<Send size={13} aria-hidden="true" />
						Approve and send
					</button>
					<button type="button" class="button quiet" onclick={() => (editing = false)}>Cancel</button>
				</div>
			</form>
		{:else}
			<div class="actions">
				{#if draft.status === 'draft'}
					<form
						method="POST"
						action="?/approve"
						use:enhance={() => {
							busy = true;
							return async ({ update }) => {
								await update();
								busy = false;
							};
						}}
					>
						<input type="hidden" name="draftId" value={draft.id} />
						<input type="hidden" name="expectedUpdatedAt" value={draft.updatedAt} />
						<input type="hidden" name="requestId" value="{requestId}-approve-{draft.id}" />
						<button class="button primary" disabled={busy || !sendable}>
							<Check size={13} aria-hidden="true" />
							Approve and send
						</button>
					</form>
					<button type="button" class="button" onclick={startEditing}>
						<PencilLine size={13} aria-hidden="true" />
						Edit and approve
					</button>
					<form
						method="POST"
						action="?/reject"
						class="reject"
						use:enhance={() => {
							busy = true;
							return async ({ update }) => {
								await update();
								busy = false;
							};
						}}
					>
						<input type="hidden" name="draftId" value={draft.id} />
						<input type="hidden" name="expectedUpdatedAt" value={draft.updatedAt} />
						<input type="hidden" name="requestId" value="{requestId}-reject-{draft.id}" />
						<input name="reason" placeholder="Why not? (optional)" maxlength="500" />
						<button class="button quiet" disabled={busy}>
							<X size={13} aria-hidden="true" />
							Reject
						</button>
					</form>
				{:else}
					<form
						method="POST"
						action="?/retry"
						use:enhance={() => {
							busy = true;
							return async ({ update }) => {
								await update();
								busy = false;
							};
						}}
					>
						<input type="hidden" name="draftId" value={draft.id} />
						<button class="button primary" disabled={busy}>
							<Send size={13} aria-hidden="true" />
							{draft.status === 'failed' ? 'Try sending again' : 'Send it'}
						</button>
					</form>
				{/if}
			</div>
		{/if}
	{/if}
</article>

<style>
	.draft {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	.draft.held {
		background: var(--surface-sunken);
	}

	header {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.id {
		color: var(--text-muted);
	}

	.when {
		margin-left: auto;
	}

	.chip.state.sent {
		color: var(--status-kept);
	}

	.chip.state.rejected,
	.chip.state.failed {
		color: var(--danger);
	}

	.chip.state.approved {
		color: var(--status-delivering);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		gap: 2px var(--space-2);
		margin: 0;
		font-size: 0.9rem;
	}

	.head dt {
		flex: none;
		width: 84px;
		color: var(--text-faint);
	}

	.head dd {
		flex: 1;
		min-width: 220px;
		margin: 0;
	}

	.body {
		margin: 0;
		padding: var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface-sunken);
		font-family: var(--font-mono);
		font-size: 0.85rem;
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.small {
		font-size: 0.88rem;
	}

	.editor {
		display: grid;
		gap: var(--space-2);
	}

	.editor input,
	.editor textarea {
		width: 100%;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.actions form {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
	}

	.reject input {
		width: 200px;
		height: var(--control-h);
	}

	@media (max-width: 720px) {
		.head dt {
			width: 64px;
		}

		.reject {
			flex-wrap: wrap;
		}

		.reject input {
			width: 100%;
		}
	}
</style>
