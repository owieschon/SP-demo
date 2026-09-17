<script lang="ts">
	// "Can we ship it?": a part number, a quantity and a date, answered by
	// nl.available_to_promise. The same netting as the projection, asked
	// forwards, so an order desk can answer a customer on the phone.
	//
	// It is a read behind a form (no request id, nothing is written), posted
	// with use:enhance so the answer appears in place.
	import { enhance } from '$app/forms';
	import { count, day } from '$lib/format';
	import type { AtpAnswer } from './types';

	let {
		answer = null,
		message = null,
		today
	}: {
		answer?: AtpAnswer | null;
		/** Why the last question could not be answered, if it could not. */
		message?: string | null;
		today: string;
	} = $props();

	let submitting = $state(false);

	/*
	  Every date on this panel goes through day(iso, thisYear). Without the
	  second argument day() prints "Mar 3" and drops the year, so an
	  availability date in the next calendar year looked like one in this
	  year, on the one screen whose job is telling a customer a date on the
	  phone. `today` is already here, so the year comes from the same clock
	  the answer did.
	*/
	const thisYear = $derived(Number(today.slice(0, 4)));

	const basis = $derived(
		answer === null
			? ''
			: answer.earliestBasis === 'stock'
				? 'from stock on the shelf'
				: answer.earliestBasis === 'supply'
					? 'from supply already on order'
					: `only by buying or making it: lead time ${answer.leadDays} days`
	);
</script>

<section class="panel" aria-labelledby="atp-title">
	<header class="panel-head">
		<h2 id="atp-title">Can we ship it?</h2>
		<span class="faint">On hand, minus earlier promises, plus what is on order</span>
	</header>

	<form
		method="POST"
		action="?/canWeShip"
		class="ask"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update({ reset: false });
				submitting = false;
			};
		}}
	>
		<label>
			<span>Part number</span>
			<!-- Uncontrolled inputs: use:enhance keeps what was typed (reset: false),
			     and after an answer they show what was asked. -->
			<input name="itemNo" value={answer?.itemNo ?? ''} placeholder="L3515-630SC" required maxlength="40" />
		</label>
		<label>
			<span>Quantity</span>
			<input name="quantity" type="number" value={answer?.quantity ?? 10} min="1" max="1000000" required />
		</label>
		<label>
			<span>Needed by</span>
			<input name="neededBy" type="date" value={answer?.neededBy ?? today} required />
		</label>
		<button class="button primary" disabled={submitting} aria-busy={submitting}>Check</button>
	</form>

	{#if message}
		<p class="body notice error" role="alert">{message}</p>
	{:else if answer}
		<div class="answer" class:yes={answer.canMeet} role="status">
			<p class="verdict">
				{#if answer.canMeet}
					Yes: {count(answer.quantity)} of <span class="mono">{answer.itemNo}</span> can be there by
					{day(answer.neededBy, thisYear)}, {basis}.
				{:else}
					No: {count(answer.quantity)} of <span class="mono">{answer.itemNo}</span> cannot be there by
					{day(answer.neededBy, thisYear)}. The earliest is {day(answer.earliestDate, thisYear)}, {basis}.
				{/if}
			</p>
			<dl class="facts">
				<div>
					<dt>On hand</dt>
					<dd class="num">{count(answer.onHand)}</dd>
				</div>
				<div>
					<dt>Promised to earlier lines</dt>
					<dd class="num">{count(answer.promisedEarlier)}</dd>
				</div>
				<div>
					<dt>Free now</dt>
					<dd class="num">{count(answer.freeNow)}</dd>
				</div>
				<div>
					<dt>Earliest date</dt>
					<dd>{day(answer.earliestDate, thisYear)}</dd>
				</div>
			</dl>
			{#if answer.covering}
				<p class="faint small">
					The quantity is reached by
					{#if answer.covering.source === 'stock'}
						stock on the shelf.
					{:else}
						<span class="mono">{answer.covering.documentNo}</span>
						{#if answer.covering.party}({answer.covering.party}){/if}
						due {day(answer.covering.dueDate ?? answer.covering.availableOn, thisYear)}{answer.covering.overdue
							? ', which is itself past due'
							: ''}.
					{/if}
				</p>
			{/if}
			{#if answer.incoming.length > 0}
				<ul class="incoming">
					{#each answer.incoming.slice(0, 6) as i (i.documentNo)}
						<li>
							<span class="mono">{i.documentNo}</span>
							<span class="faint">
								{count(i.quantity)} pcs, {i.source === 'purchase' ? 'due' : 'off the floor'}
								{day(i.dueDate, thisYear)}{i.overdue ? ' (past due)' : ''}
							</span>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="faint small">Nothing is on order for this part.</p>
			{/if}
		</div>
	{/if}
</section>

<style>
	.ask {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) var(--space-3);
	}

	.ask label {
		flex: 1 1 150px;
		min-width: 0;
	}

	.ask label span {
		font-size: 0.85rem;
	}

	.ask input {
		width: 100%;
	}

	.body {
		margin: var(--space-2) var(--space-3) var(--space-3);
	}

	.answer {
		display: grid;
		gap: 6px;
		padding: 10px var(--space-3) var(--space-3);
		border-top: 1px solid var(--hairline);
	}

	.verdict {
		font-weight: 500;
		color: var(--danger);
	}

	.answer.yes .verdict {
		color: var(--status-kept);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-4);
		margin: 0;
	}

	.facts dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.facts dd {
		margin: 0;
		font-size: 1.05rem;
		font-weight: 600;
	}

	.small {
		font-size: 0.9rem;
	}

	.incoming {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 2px;
		font-size: 0.9rem;
	}
</style>
