<script lang="ts">
	// The buyer on a commitment. A commitment with nobody named shows a
	// button, not the words "No buyer named": pressing it lists the people at
	// the account, and offers to add someone who is not on file yet.
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import type { BuyerChoice } from './types';

	let {
		commitmentId,
		customerNo,
		updatedAt,
		buyerName,
		buyerEmail,
		choices,
		canEdit,
		setRequestId,
		addRequestId,
		message
	}: {
		commitmentId: number;
		customerNo: string;
		updatedAt: string;
		buyerName: string | null;
		buyerEmail: string | null;
		choices: BuyerChoice[];
		canEdit: boolean;
		setRequestId: string;
		addRequestId: string;
		message: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	// 'closed', 'pick' (choose from the list) or 'new' (add a person).
	let mode = $state<'closed' | 'pick' | 'new'>('closed');
	let saving = $state(false);

	const submitting: SubmitFunction = () => {
		saving = true;
		return async ({ update, result }) => {
			await update({ reset: false });
			saving = false;
			if (result.type === 'success') mode = 'closed';
		};
	};
</script>

<div class="buyer" id="buyer">
	{#if buyerName}
		<span class="named">
			<a class="link" href="/accounts/{customerNo}">{buyerName}</a>
			{#if buyerEmail}<a class="faint" href="mailto:{buyerEmail}">{buyerEmail}</a>{/if}
		</span>
		{#if canEdit}
			<button class="button quiet tiny" onclick={() => (mode = mode === 'closed' ? 'pick' : 'closed')}>
				Change
			</button>
		{/if}
	{:else if canEdit}
		<button class="button tiny" onclick={() => (mode = mode === 'closed' ? 'pick' : 'closed')} aria-expanded={mode !== 'closed'}>
			<UserPlus size={13} strokeWidth={1.75} aria-hidden="true" />
			Name the buyer
		</button>
	{:else}
		<span class="chip warn">No buyer named</span>
	{/if}

	{#if mode !== 'closed'}
		<div class="picker">
			{#if mode === 'pick'}
				{#if choices.length > 0}
					<form method="POST" action="?/buyer" class="row" use:enhance={submitting}>
						<input type="hidden" name="commitmentId" value={commitmentId} />
						<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
						<input type="hidden" name="requestId" value={setRequestId} />
						<label>
							<span class="sr-only">Who said they would buy</span>
							<select name="contactId">
								{#if buyerName}<option value="">Nobody</option>{/if}
								{#each choices as person (person.id)}
									<option value={person.id}>
										{person.fullName}{person.title ? `, ${person.title}` : ''}
										{person.customerNo === customerNo ? '' : ` (${person.customerName})`}
									</option>
								{/each}
							</select>
						</label>
						<button class="button primary" disabled={saving}>Save</button>
						<button class="button quiet" type="button" onclick={() => (mode = 'new')}>
							Someone new
						</button>
					</form>
				{:else}
					<p class="muted">
						Nobody is on file at this account yet.
						<button class="button tiny" onclick={() => (mode = 'new')}>Add the buyer</button>
					</p>
				{/if}
			{:else}
				<form method="POST" action="?/addBuyer" class="new" use:enhance={submitting}>
					<input type="hidden" name="commitmentId" value={commitmentId} />
					<input type="hidden" name="customerNo" value={customerNo} />
					<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
					<input type="hidden" name="requestId" value={addRequestId} />
					<label>
						<span>Name</span>
						<input name="fullName" required minlength="2" maxlength="100" placeholder="Jordan Keller" />
					</label>
					<label>
						<span>Title</span>
						<input name="title" maxlength="80" placeholder="Buyer" value="Buyer" />
					</label>
					<label>
						<span>Email</span>
						<input name="email" type="email" maxlength="200" />
					</label>
					<label>
						<span>Phone</span>
						<input name="phone" maxlength="40" />
					</label>
					<div class="actions">
						<button class="button quiet" type="button" onclick={() => (mode = choices.length ? 'pick' : 'closed')}>
							Back
						</button>
						<button class="button primary" disabled={saving}>Add and name buyer</button>
					</div>
				</form>
			{/if}

			{#if message}
				<p class="msg" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
					{message.text}
				</p>
			{/if}
		</div>
	{/if}
</div>

<style>
	.buyer {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		scroll-margin-top: calc(var(--topbar-h) + var(--space-4));
	}

	.named {
		display: inline-flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.tiny {
		height: 22px;
		padding: 0 8px;
		font-size: 0.88rem;
	}

	/* The form opens under the field, inside the facts row. */
	.picker {
		flex: 1 1 100%;
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface-sunken);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.row {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.new {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2) var(--space-3);
	}

	.new label {
		flex: 1 1 150px;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		margin-left: auto;
	}

	.msg {
		font-size: 0.92rem;
		color: var(--text-muted);
	}

	.msg.error {
		color: var(--danger);
	}
</style>
