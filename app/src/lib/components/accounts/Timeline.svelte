<script lang="ts">
	// What has happened with this account: calls, emails, meetings and notes,
	// newest first, with a small form at the top to log another one. Picking
	// "Call" reveals the outcome choices, because only a call has one.
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import MessageSquare from '@lucide/svelte/icons/message-square';
	import PhoneCall from '@lucide/svelte/icons/phone-call';
	import Mail from '@lucide/svelte/icons/mail';
	import Users from '@lucide/svelte/icons/users';
	import { count, moment } from '$lib/format';
	import {
		ACTIVITY_LABEL,
		CALL_OUTCOMES,
		CALL_OUTCOME_LABEL,
		type ActivityKind,
		type Contact,
		type Timeline
	} from './types';

	let {
		timeline,
		contacts,
		customerNo,
		requestId,
		message
	}: {
		timeline: Timeline;
		contacts: Contact[];
		customerNo: string;
		requestId: string;
		message: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	const ICONS = { note: MessageSquare, call: PhoneCall, email: Mail, meeting: Users };
	const KINDS: ActivityKind[] = ['call', 'email', 'meeting', 'note'];

	let kind = $state<ActivityKind>('call');
	let saving = $state(false);
	const current = $derived(contacts.filter((c) => c.leftOn === null));

	const submitting: SubmitFunction = () => {
		saving = true;
		return async ({ update }) => {
			// A saved note should leave an empty box behind, so this one resets.
			await update();
			saving = false;
		};
	};
</script>

<section class="panel" aria-labelledby="timeline-title">
	<header class="panel-head">
		<h2 id="timeline-title">Activity</h2>
		<span class="faint">
			{count(timeline.total)} logged{#if timeline.total > timeline.entries.length}, showing the
				{timeline.entries.length} most recent{/if}
		</span>
	</header>

	<form method="POST" action="?/activity" class="logger" use:enhance={submitting}>
		<input type="hidden" name="customerNo" value={customerNo} />
		<input type="hidden" name="requestId" value={requestId} />

		<div class="picks">
			<div class="segmented" role="group" aria-label="What happened">
				{#each KINDS as choice (choice)}
					<button
						type="button"
						aria-pressed={kind === choice}
						onclick={() => (kind = choice)}
					>
						{ACTIVITY_LABEL[choice]}
					</button>
				{/each}
			</div>
			<input type="hidden" name="kind" value={kind} />

			{#if kind === 'call'}
				<label class="inline">
					<span class="sr-only">How the call went</span>
					<select name="callOutcome">
						{#each CALL_OUTCOMES as choice (choice.value)}
							<option value={choice.value}>{choice.label}</option>
						{/each}
					</select>
				</label>
			{/if}

			{#if current.length > 0}
				<label class="inline">
					<span class="sr-only">Who it was with</span>
					<select name="contactId">
						<option value="">Nobody in particular</option>
						{#each current as person (person.id)}
							<option value={person.id}>{person.fullName}{person.title ? `, ${person.title}` : ''}</option>
						{/each}
					</select>
				</label>
			{/if}

			<label class="inline when">
				<span class="sr-only">When it happened</span>
				<input type="datetime-local" name="occurredAt" />
			</label>
		</div>

		<textarea
			name="body"
			rows="2"
			required
			maxlength="2000"
			placeholder={kind === 'call'
				? 'What did they say? Parts, quantities, dates.'
				: 'What happened, in a line or two.'}
		></textarea>

		<div class="send">
			{#if message}
				<span class="note" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
					{message.text}
				</span>
			{/if}
			<button class="button primary" disabled={saving}>
				Log {ACTIVITY_LABEL[kind].toLowerCase()}
			</button>
		</div>
	</form>

	{#if timeline.entries.length === 0}
		<p class="body muted">Nothing logged here yet. The first call or note goes in the box above.</p>
	{:else}
		<ol class="entries">
			{#each timeline.entries as entry (entry.id)}
				{@const Icon = ICONS[entry.kind]}
				<li class="entry">
					<span class="icon {entry.kind}" aria-hidden="true">
						<Icon size={13} strokeWidth={1.75} />
					</span>
					<div class="what">
						<p class="body-text">{entry.body}</p>
						<div class="who muted">
							<span>{ACTIVITY_LABEL[entry.kind]}</span>
							{#if entry.callOutcome}<span>{CALL_OUTCOME_LABEL[entry.callOutcome]}</span>{/if}
							{#if entry.contactName}<span>with {entry.contactName}</span>{/if}
							<span>{entry.authorName}</span>
							<span>{moment(entry.occurredAt)}</span>
							{#if entry.commitmentId}
								<span>
									<a class="link" href="/commitments/{entry.commitmentId}">
										{entry.commitmentTitle ?? `C-${entry.commitmentId}`}
									</a>
								</span>
							{/if}
							{#if entry.via === 'automation'}<span class="chip">Automation</span>{/if}
						</div>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.body {
		padding: var(--space-3);
	}

	.logger {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3);
		border-bottom: 1px solid var(--hairline);
		background: var(--surface-sunken);
	}

	.picks {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.inline {
		display: inline-flex;
		align-items: center;
	}

	.when input {
		height: var(--control-h);
	}

	.send {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: var(--space-3);
	}

	.note {
		margin-right: auto;
		font-size: 0.92rem;
		color: var(--text-muted);
	}

	.note.error {
		color: var(--danger);
	}

	.entries {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.entry {
		display: flex;
		gap: var(--space-2);
		padding: 8px var(--space-3);
	}

	.entry + .entry {
		border-top: 1px solid var(--hairline);
	}

	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 22px;
		height: 22px;
		margin-top: 1px;
		border-radius: 50%;
		color: var(--tone, var(--text-muted));
		background: var(--surface-sunken);
		box-shadow: inset 0 0 0 1px var(--hairline);
	}

	.icon.call {
		--tone: var(--status-delivering);
	}

	.icon.email {
		--tone: var(--status-quoted);
	}

	.icon.meeting {
		--tone: var(--status-kept);
	}

	.what {
		min-width: 0;
	}

	.body-text {
		white-space: pre-line;
	}

	.who {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-2);
		font-size: 0.88rem;
	}

	.who > * + *::before {
		content: '·';
		margin-right: var(--space-2);
		color: var(--text-faint);
	}

	@media (max-width: 720px) {
		.send {
			justify-content: space-between;
		}
	}
</style>
