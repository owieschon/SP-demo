<script lang="ts">
	// Next steps on this account: open ones first, overdue ones marked, then
	// what was finished recently. Each open step a person is allowed to close
	// has a Done button; the form carries the row version, so two people
	// closing the same step do not both succeed silently.
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import Check from '@lucide/svelte/icons/check';
	import Plus from '@lucide/svelte/icons/plus';
	import { day, moment } from '$lib/format';
	import type { NextStep, PersonOption } from './types';

	let {
		steps,
		customerNo,
		people,
		defaultOwnerId,
		year,
		today,
		addRequestId,
		completeRequestId,
		message
	}: {
		steps: NextStep[];
		customerNo: string;
		people: PersonOption[];
		defaultOwnerId: number;
		year: number;
		/** Today as 'YYYY-MM-DD', so the date field cannot offer the past. */
		today: string;
		addRequestId: string;
		completeRequestId: string;
		message: { text: string; failed: boolean; conflict: boolean } | null;
	} = $props();

	let adding = $state(false);
	let busy = $state(false);

	const open = $derived(steps.filter((s) => !s.done));
	const done = $derived(steps.filter((s) => s.done));

	const submitting: SubmitFunction = () => {
		busy = true;
		return async ({ update, result }) => {
			await update();
			busy = false;
			if (result.type === 'success') adding = false;
		};
	};
</script>

<section class="panel" aria-labelledby="steps-title">
	<header class="panel-head">
		<h2 id="steps-title">Next steps</h2>
		<button class="button" onclick={() => (adding = !adding)} aria-expanded={adding}>
			<Plus size={13} strokeWidth={2} aria-hidden="true" />
			Add
		</button>
	</header>

	{#if message}
		<p class="body notice" class:error={message.failed} role={message.failed ? 'alert' : 'status'}>
			{message.text}
		</p>
	{/if}

	{#if adding}
		<form method="POST" action="?/addStep" class="editor" use:enhance={submitting}>
			<input type="hidden" name="customerNo" value={customerNo} />
			<input type="hidden" name="requestId" value={addRequestId} />
			<label class="wide">
				<span>What needs doing</span>
				<input name="title" required minlength="3" maxlength="200" placeholder="Send the chrome stack quote" />
			</label>
			<label>
				<span>Due</span>
				<input type="date" name="dueOn" min={today} />
			</label>
			<label>
				<span>Who</span>
				<select name="ownerId" value={defaultOwnerId}>
					{#each people as person (person.id)}
						<option value={person.id}>{person.fullName}</option>
					{/each}
				</select>
			</label>
			<div class="row-end">
				<button class="button quiet" type="button" onclick={() => (adding = false)}>Cancel</button>
				<button class="button primary" disabled={busy}>Add step</button>
			</div>
		</form>
	{/if}

	{#if steps.length === 0 && !adding}
		<p class="body muted">
			Nothing planned here. Add a step so this account does not go quiet by accident.
		</p>
	{:else}
		<ul class="list">
			{#each open as step (step.id)}
				<li class="step" class:overdue={step.overdue}>
					<div class="what">
						<span class="title">{step.title}</span>
						<span class="muted small">
							{step.ownerName}{#if step.dueOn} · due {day(step.dueOn, year)}{/if}{#if step.overdue} · overdue{/if}
							{#if step.commitmentId}
								· <a class="link" href="/commitments/{step.commitmentId}">C-{step.commitmentId}</a>
							{/if}
						</span>
					</div>
					{#if step.canComplete}
						<form method="POST" action="?/completeStep" use:enhance={submitting}>
							<input type="hidden" name="stepId" value={step.id} />
							<input type="hidden" name="expectedUpdatedAt" value={step.updatedAt} />
							<input type="hidden" name="requestId" value="{completeRequestId}-{step.id}" />
							<button class="button small" disabled={busy}>
								<Check size={12} strokeWidth={2} aria-hidden="true" />
								Done
							</button>
						</form>
					{/if}
				</li>
			{/each}

			{#each done as step (step.id)}
				<li class="step finished">
					<div class="what">
						<span class="title">{step.title}</span>
						<span class="muted small">
							{#if step.completedBy}{step.completedBy}{/if}
							{#if step.completedAt} · {moment(step.completedAt)}{/if}
						</span>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	.body {
		padding: var(--space-3);
	}

	.editor {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-3);
		border-bottom: 1px solid var(--hairline);
		background: var(--surface-sunken);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.editor label.wide {
		flex: 1 1 100%;
	}

	.row-end {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-left: auto;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.step {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		padding: 7px var(--space-3);
		transition: background-color var(--speed) var(--ease);
	}

	.step + .step {
		border-top: 1px solid var(--hairline);
	}

	.step:hover {
		background: var(--surface-hover);
	}

	/* An overdue step carries a thin amber edge, nothing louder. */
	.step.overdue {
		box-shadow: inset 2px 0 0 var(--status-pushed);
	}

	.what {
		display: grid;
		gap: 1px;
		min-width: 0;
	}

	.small {
		font-size: 0.88rem;
	}

	.step.finished .title {
		color: var(--text-faint);
		text-decoration: line-through;
	}

	.button.small {
		height: 22px;
		padding: 0 8px;
		font-size: 0.88rem;
	}
</style>
