<script lang="ts">
	// The people at an account: current ones first, then anyone who left.
	// Each card can open a small inline form; "Add contact" opens the same
	// fields with nothing in them. Both post to the account page's actions.
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Mail from '@lucide/svelte/icons/mail';
	import Phone from '@lucide/svelte/icons/phone';
	import Plus from '@lucide/svelte/icons/plus';
	import Smartphone from '@lucide/svelte/icons/smartphone';
	import { day } from '$lib/format';
	import type { Contact } from './types';

	let {
		contacts,
		customerNo,
		emailDomain,
		year,
		addRequestId,
		editRequestId,
		message
	}: {
		contacts: Contact[];
		customerNo: string;
		emailDomain: string | null;
		year: number;
		addRequestId: string;
		editRequestId: string;
		message: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	// Which form is open: 'add', or the id of the contact being edited.
	let open = $state<'add' | number | null>(null);
	let saving = $state(false);

	const current = $derived(contacts.filter((c) => c.leftOn === null));
	const former = $derived(contacts.filter((c) => c.leftOn !== null));

	// Every form here submits the same way: keep what was typed while it is
	// in flight, and close the form once the server said yes.
	const submitting: SubmitFunction = () => {
		saving = true;
		return async ({ update, result }) => {
			await update({ reset: false });
			saving = false;
			if (result.type === 'success') open = null;
		};
	};
</script>

<section class="panel" aria-labelledby="contacts-title">
	<header class="panel-head">
		<h2 id="contacts-title">People</h2>
		<button class="button" onclick={() => (open = open === 'add' ? null : 'add')} aria-expanded={open === 'add'}>
			<Plus size={13} strokeWidth={2} aria-hidden="true" />
			Add contact
		</button>
	</header>

	{#if message}
		<p class="body notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
			{message.text}
		</p>
	{/if}

	{#if open === 'add'}
		<form method="POST" action="?/addContact" class="editor" use:enhance={submitting}>
			<input type="hidden" name="customerNo" value={customerNo} />
			<input type="hidden" name="requestId" value={addRequestId} />
			<div class="fields">
				<label>
					<span>Name</span>
					<input name="fullName" required minlength="2" maxlength="100" placeholder="Jordan Keller" />
				</label>
				<label>
					<span>Title</span>
					<input name="title" maxlength="80" placeholder="Parts Manager" list="contact-titles" />
				</label>
				<label>
					<span>Email</span>
					<input
						name="email"
						type="email"
						maxlength="200"
						placeholder={emailDomain ? `name@${emailDomain}` : 'name@example.example'}
					/>
				</label>
				<label>
					<span>Direct phone</span>
					<input name="phone" maxlength="40" placeholder="(555) 555-0100" />
				</label>
				<label>
					<span>Mobile</span>
					<input name="mobile" maxlength="40" placeholder="(555) 555-0101" />
				</label>
				<label class="wide">
					<span>Notes</span>
					<input name="notes" maxlength="1000" placeholder="Best reached before 10am" />
				</label>
			</div>
			<div class="row-end">
				<label class="tick">
					<input type="checkbox" name="isPrimary" />
					<span>Primary contact</span>
				</label>
				<button class="button quiet" type="button" onclick={() => (open = null)}>Cancel</button>
				<button class="button primary" disabled={saving}>Add contact</button>
			</div>
		</form>
	{/if}

	{#if contacts.length === 0 && open !== 'add'}
		<p class="body muted">
			Nobody is on file here yet. Add the buyer or parts manager so calls and commitments have a name.
		</p>
	{:else}
		<ul class="cards">
			{#each current as person (person.id)}
				<li class="card">
					<div class="top">
						<span class="who">
							<span class="name">{person.fullName}</span>
							{#if person.isPrimary}<span class="chip">Primary</span>{/if}
						</span>
						{#if person.canEdit}
							<button
								class="button quiet small"
								onclick={() => (open = open === person.id ? null : person.id)}
								aria-expanded={open === person.id}
							>
								Edit
							</button>
						{/if}
					</div>
					<div class="muted title">{person.title || 'No title on file'}</div>
					<div class="ways">
						{#if person.email}
							<a class="way link" href="mailto:{person.email}">
								<Mail size={12} strokeWidth={1.75} aria-hidden="true" />{person.email}
							</a>
						{/if}
						{#if person.phone}
							<a class="way link" href="tel:{person.phone.replace(/[^0-9+]/g, '')}">
								<Phone size={12} strokeWidth={1.75} aria-hidden="true" />{person.phone}
							</a>
						{/if}
						{#if person.mobile}
							<a class="way link" href="tel:{person.mobile.replace(/[^0-9+]/g, '')}">
								<Smartphone size={12} strokeWidth={1.75} aria-hidden="true" />{person.mobile}
							</a>
						{/if}
					</div>
					{#if person.notes}<p class="notes muted">{person.notes}</p>{/if}

					{#if open === person.id}
						<form method="POST" action="?/editContact" class="editor inner" use:enhance={submitting}>
							<input type="hidden" name="contactId" value={person.id} />
							<input type="hidden" name="expectedUpdatedAt" value={person.updatedAt} />
							<input type="hidden" name="requestId" value="{editRequestId}-{person.id}" />
							<div class="fields">
								<label>
									<span>Name</span>
									<input name="fullName" value={person.fullName} required minlength="2" maxlength="100" />
								</label>
								<label>
									<span>Title</span>
									<input name="title" value={person.title} maxlength="80" list="contact-titles" />
								</label>
								<label>
									<span>Email</span>
									<input name="email" type="email" value={person.email ?? ''} maxlength="200" />
								</label>
								<label>
									<span>Direct phone</span>
									<input name="phone" value={person.phone ?? ''} maxlength="40" />
								</label>
								<label>
									<span>Mobile</span>
									<input name="mobile" value={person.mobile ?? ''} maxlength="40" />
								</label>
								<label class="wide">
									<span>Notes</span>
									<input name="notes" value={person.notes} maxlength="1000" />
								</label>
							</div>
							<div class="row-end">
								<label class="tick">
									<input type="checkbox" name="isPrimary" checked={person.isPrimary} />
									<span>Primary contact</span>
								</label>
								<label class="tick">
									<input type="checkbox" name="left" />
									<span>No longer there</span>
								</label>
								<button class="button quiet" type="button" onclick={() => (open = null)}>Cancel</button>
								<button class="button primary" disabled={saving}>Save</button>
							</div>
						</form>
					{/if}
				</li>
			{/each}

			{#each former as person (person.id)}
				<li class="card gone">
					<div class="top">
						<span class="who">
							<span class="name">{person.fullName}</span>
							<span class="chip">No longer there</span>
						</span>
					</div>
					<div class="muted title">
						{person.title || 'No title on file'}{#if person.leftOn} · left {day(person.leftOn, year)}{/if}
					</div>
					{#if person.notes}<p class="notes muted">{person.notes}</p>{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<!-- The titles the team uses, offered as suggestions but never forced. -->
<datalist id="contact-titles">
	<option value="Buyer"></option>
	<option value="Purchasing Agent"></option>
	<option value="Parts Manager"></option>
	<option value="Service Manager"></option>
	<option value="Fleet Maintenance Manager"></option>
	<option value="Owner"></option>
	<option value="General Manager"></option>
	<option value="Accounts Payable"></option>
</datalist>

<style>
	.body {
		padding: var(--space-3);
	}

	.cards {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.card {
		display: grid;
		gap: 2px;
		padding: 8px var(--space-3) 10px;
	}

	.card + .card {
		border-top: 1px solid var(--hairline);
	}

	.card.gone .name {
		color: var(--text-muted);
	}

	.top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-height: 22px;
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-width: 0;
	}

	.name {
		font-weight: 500;
	}

	.title {
		font-size: 0.92rem;
	}

	.ways {
		display: flex;
		flex-wrap: wrap;
		gap: 2px var(--space-3);
		margin-top: 2px;
	}

	.way {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 0.92rem;
	}

	.notes {
		margin-top: 4px;
		font-size: 0.92rem;
	}

	.small {
		height: 22px;
		padding: 0 8px;
		font-size: 0.88rem;
	}

	/* The inline forms: label above field, wrapping at phone width. */
	.editor {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.editor.inner {
		margin-top: 8px;
		border-radius: var(--radius);
		border: 1px solid var(--hairline);
	}

	.fields {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-3);
	}

	.fields label {
		flex: 1 1 170px;
	}

	.fields label.wide {
		flex-basis: 100%;
	}

	.row-end {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.tick {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.tick input {
		width: 14px;
		height: 14px;
	}

	.row-end .button:nth-last-child(2) {
		margin-left: auto;
	}
</style>
