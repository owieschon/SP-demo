<script lang="ts">
	// The people at a vendor, and the form that adds one.
	//
	// The form only appears for operations and admins (the database refuses
	// anyone else anyway). It posts with use:enhance, so the list updates
	// without a full page load, and it still works with JavaScript off.
	import { enhance } from '$app/forms';
	import Plus from '@lucide/svelte/icons/plus';
	import { VENDOR_CONTACT_TITLES, type VendorContact } from './types';

	let {
		contacts,
		vendorNo,
		updatedAt,
		requestId,
		canAdd,
		message = null
	}: {
		contacts: VendorContact[];
		vendorNo: string;
		/** The vendor's row version, sent back with the form. */
		updatedAt: string;
		requestId: string;
		canAdd: boolean;
		message: { text: string; failed: boolean } | null;
	} = $props();

	// The form stays closed until someone asks for it, and opens by itself
	// when a submission came back with something to fix.
	let open = $state(false);
	let saving = $state(false);
	const showForm = $derived(open || (message?.failed ?? false));
</script>

<section class="panel" aria-labelledby="contacts">
	<header class="panel-head">
		<h2 id="contacts">Contacts</h2>
		{#if canAdd && !showForm}
			<button class="button quiet" onclick={() => (open = true)}>
				<Plus size={13} strokeWidth={2} aria-hidden="true" />
				Add contact
			</button>
		{/if}
	</header>

	{#if contacts.length === 0}
		<p class="body muted">
			Nobody is on file here.
			{#if canAdd}
				{#if !showForm}
					<button class="button" onclick={() => (open = true)}>Add the first contact</button>
				{/if}
			{:else}
				Operations keeps the vendor list.
			{/if}
		</p>
	{:else}
		<ul class="list">
			{#each contacts as contact (contact.id)}
				<li class:gone={!contact.active}>
					<span class="line">
						<span class="name">{contact.fullName}</span>
						{#if contact.isPrimary}<span class="chip">primary</span>{/if}
						{#if !contact.active}<span class="chip">no longer there</span>{/if}
						<span class="muted title">{contact.title}</span>
					</span>
					<span class="line reach">
						{#if contact.email}
							<a class="link" href="mailto:{contact.email}">{contact.email}</a>
						{/if}
						{#if contact.phone}<span class="muted num">{contact.phone}</span>{/if}
					</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if message}
		<p class="body">
			<span class="notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
				{message.text}
			</span>
		</p>
	{/if}

	{#if canAdd && showForm}
		<form
			method="POST"
			action="?/addContact"
			class="add"
			use:enhance={() => {
				saving = true;
				return async ({ update, result }) => {
					await update({ reset: result.type === 'success' });
					saving = false;
					if (result.type === 'success') open = false;
				};
			}}
		>
			<input type="hidden" name="vendorNo" value={vendorNo} />
			<input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
			<input type="hidden" name="requestId" value={requestId} />

			<label>
				Name
				<input name="fullName" required maxlength="80" autocomplete="off" placeholder="Jamie Keller" />
			</label>
			<label>
				Title
				<select name="title">
					{#each VENDOR_CONTACT_TITLES as title (title)}
						<option value={title}>{title}</option>
					{/each}
				</select>
			</label>
			<label>
				Email
				<input name="email" type="email" maxlength="120" autocomplete="off" placeholder="name@vendor.example" />
			</label>
			<label>
				Phone
				<input name="phone" maxlength="30" autocomplete="off" placeholder="(216) 555-0142" />
			</label>
			<label class="tick">
				<input name="isPrimary" type="checkbox" />
				<span>The one to call about orders</span>
			</label>

			<div class="actions">
				<button class="button" type="button" onclick={() => (open = false)}>Cancel</button>
				<button class="button primary" disabled={saving} aria-busy={saving}>Add contact</button>
			</div>
		</form>
	{/if}
</section>

<style>
	.body {
		padding: var(--space-3);
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list li {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		flex-wrap: wrap;
		gap: 2px var(--space-3);
		padding: 7px var(--space-3);
	}

	.list li + li {
		border-top: 1px solid var(--hairline);
	}

	.line {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-width: 0;
	}

	.name {
		font-weight: 500;
	}

	.title {
		font-size: 0.92rem;
	}

	.gone .name {
		color: var(--text-faint);
	}

	.reach {
		font-size: 0.92rem;
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-3);
		padding: var(--space-3);
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}

	.add label {
		flex: 1 1 150px;
	}

	.add .tick {
		flex: 1 1 100%;
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.add .tick input {
		width: auto;
	}

	.actions {
		display: flex;
		gap: var(--space-2);
		margin-left: auto;
	}

	@media (max-width: 720px) {
		.add label {
			flex-basis: 100%;
		}

		.actions {
			width: 100%;
		}
	}
</style>
