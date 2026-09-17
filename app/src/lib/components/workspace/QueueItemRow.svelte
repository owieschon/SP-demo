<script lang="ts">
	// One waiting request. Closed it is a line: what is proposed, who it is
	// for, what it is worth. Open it shows the facts behind it and the two
	// decisions, with whatever this source lets a person correct first.
	//
	// The form sends only the source, the id, the row version, a request id,
	// the note, the chosen option and the corrections. Everything else that
	// gets written comes out of the stored record inside the source's own
	// write function, so nothing here can be tampered into a different write.
	import { enhance } from '$app/forms';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import X from '@lucide/svelte/icons/x';
	import { money, moment } from '$lib/format';
	import {
		SOURCE_EDIT,
		SOURCE_EDITABLE,
		SOURCE_HREF,
		SOURCE_LABEL,
		STATUS_LABEL,
		type QueueItem
	} from '$lib/workspace/types';

	let {
		item,
		requestBase,
		open = false
	}: { item: QueueItem; requestBase: string; open?: boolean } = $props();

	// Whether a person has opened or closed this row themselves; until they
	// have, it follows whatever the page asked for.
	let toggled = $state<boolean | null>(null);
	const expanded = $derived(toggled ?? open);

	let busy = $state(false);
	let note = $state('');
	let optionIndex = $state(0);

	/**
	 * Only what a person actually typed. Empty until they change something,
	 * which keeps "as proposed" and "corrected" honestly apart, and means the
	 * proposal's own values are read at render time rather than copied here.
	 */
	let typed = $state<{
		quantities: Record<number, number>;
		neededBy?: string;
		subject?: string;
		body?: string;
	}>({ quantities: {} });

	/** What each field shows: what the person typed, or what was proposed. */
	function quantityOf(line: { line: number; quantity: number | null }): number {
		return typed.quantities[line.line] ?? line.quantity ?? 1;
	}
	const neededBy = $derived(typed.neededBy ?? item.detail.neededBy ?? '');
	const subject = $derived(typed.subject ?? item.detail.subject ?? '');
	const body = $derived(typed.body ?? item.detail.body ?? '');

	const corrections = $derived.by(() => {
		if (!SOURCE_EDITABLE[item.source]) return '';
		const edit: Record<string, unknown> = {};
		if (item.source === 'rfq') {
			const lines = item.detail.lines
				.filter((line) => quantityOf(line) !== (line.quantity ?? 1))
				.map((line) => ({ line: line.line, quantity: Number(quantityOf(line)) }));
			if (lines.length > 0) edit.lines = lines;
			if (neededBy !== (item.detail.neededBy ?? '')) edit.neededBy = neededBy;
		}
		if (item.source === 'mail') {
			if (subject !== (item.detail.subject ?? '')) edit.subject = subject;
			if (body !== (item.detail.body ?? '')) edit.body = body;
		}
		return Object.keys(edit).length === 0 ? '' : JSON.stringify(edit);
	});

	const corrected = $derived(corrections !== '');
	const approveLabel = $derived(corrected ? 'Correct and approve' : 'Approve');
	/** Nothing can be approved while a field on it still needs a person. */
	const blocked = $derived(item.status === 'needs_review');
	const requestId = $derived(`${requestBase}-${item.source}-${item.sourceId}`);
</script>

<li class="row" class:open={expanded}>
	<button
		type="button"
		class="head pressable"
		aria-expanded={expanded}
		onclick={() => (toggled = !expanded)}
	>
		<span class="chip source {item.source}">{SOURCE_LABEL[item.source]}</span>
		<span class="what">
			<span class="summary">{item.summary}</span>
			<span class="faint small">
				{item.subjectName ?? 'no account on it yet'} · {item.createdBy} · {moment(item.createdAt)}
			</span>
		</span>
		{#if item.value !== null}
			<span class="num value">{money(item.value)}</span>
		{/if}
		{#if item.status !== 'waiting'}
			<span class="chip warn"><CircleAlert size={12} aria-hidden="true" />{STATUS_LABEL[item.status]}</span>
		{/if}
		<ChevronDown size={14} class="caret" aria-hidden="true" />
	</button>

	{#if expanded}
		<div class="detail">
			<dl class="facts">
				{#each item.detail.facts as fact, i (i)}
					<div>
						<dt>{fact.label}</dt>
						<dd>{fact.value}</dd>
					</div>
				{/each}
			</dl>

			<form
				method="POST"
				action="?/decide"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update({ reset: false });
						busy = false;
					};
				}}
			>
				<input type="hidden" name="source" value={item.source} />
				<input type="hidden" name="sourceId" value={item.sourceId} />
				<input type="hidden" name="expectedUpdatedAt" value={item.rowVersion} />
				<input type="hidden" name="requestId" value={requestId} />
				<input type="hidden" name="edit" value={corrections} />

				{#if item.detail.lines.length > 0}
					<table class="lines">
						<thead>
							<tr>
								<th scope="col">Part</th>
								<th scope="col" class="num">Quantity</th>
								<th scope="col" class="num">Each</th>
								<th scope="col" class="num">Amount</th>
							</tr>
						</thead>
						<tbody>
							{#each item.detail.lines as line (line.line)}
								<tr>
									<td>
										<span class="mono">{line.itemNo ?? 'not settled'}</span>
										{#if line.description}
											<span class="faint small block">{line.description}</span>
										{/if}
									</td>
									<td class="num">
										<input
											type="number"
											min="1"
											max="10000"
											step="1"
											class="qty"
											aria-label="Quantity of {line.itemNo ?? 'this line'}"
											value={quantityOf(line)}
											oninput={(e) => (typed.quantities[line.line] = Number(e.currentTarget.value))}
										/>
									</td>
									<td class="num">{line.unitPrice === null ? '' : money(line.unitPrice)}</td>
									<td class="num">{line.amount === null ? '' : money(line.amount)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
					<label class="field">
						<span>Needed by</span>
						<input type="date" value={neededBy} oninput={(e) => (typed.neededBy = e.currentTarget.value)} />
					</label>
				{/if}

				{#if item.detail.options.length > 0}
					<fieldset class="options">
						<legend>What to do</legend>
						{#each item.detail.options as option (option.index)}
							<label class="option">
								<input type="radio" name="optionIndex" value={option.index} bind:group={optionIndex} />
								<span>
									<span class="option-label">{option.label}</span>
									<span class="faint small block mono">{option.tool}</span>
									<pre class="input mono">{option.input}</pre>
								</span>
							</label>
						{/each}
					</fieldset>
				{/if}

				{#if item.detail.subject !== null || item.detail.body !== null}
					<label class="field">
						<span>Subject</span>
						<input
							type="text"
							maxlength="300"
							value={subject}
							oninput={(e) => (typed.subject = e.currentTarget.value)}
						/>
					</label>
					<label class="field">
						<span>Body</span>
						<textarea rows="6" value={body} oninput={(e) => (typed.body = e.currentTarget.value)}
						></textarea>
					</label>
				{/if}

				<p class="faint small edit-note">{SOURCE_EDIT[item.source]}</p>

				<label class="field">
					<span>Note <span class="faint">(kept with the decision)</span></span>
					<input type="text" name="note" maxlength="500" bind:value={note} />
				</label>

				{#if blocked}
					<p class="notice warning" role="status">
						Something on this one has to be settled before it can be approved, so its own write
						function would refuse it. The facts above say what. Reject it here, or open it on its
						own page to settle it.
					</p>
				{/if}

				<div class="actions">
					<button class="button primary" name="decision" value="approve" disabled={busy || blocked}>
						<Check size={13} aria-hidden="true" />
						{approveLabel}
					</button>
					<button class="button" name="decision" value="reject" disabled={busy}>
						<X size={13} aria-hidden="true" />
						Reject
					</button>
					<a class="button quiet" href={item.detail.href ?? SOURCE_HREF[item.source](item.sourceId)}>
						<ExternalLink size={13} aria-hidden="true" />
						Open it
					</a>
					{#if corrected}
						<span class="chip warn">Corrected, not yet approved</span>
					{/if}
				</div>
			</form>
		</div>
	{/if}
</li>

<style>
	.head {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-height: 40px;
		padding: 6px var(--space-3);
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color var(--speed) var(--ease);
	}

	.head:hover {
		background: var(--surface-hover);
	}

	.what {
		display: grid;
		gap: 1px;
		min-width: 0;
		margin-right: auto;
	}

	.summary {
		font-weight: 500;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.small {
		font-size: 0.85rem;
	}

	.block {
		display: block;
	}

	.value {
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}

	.chip.source {
		flex: none;
		min-width: 106px;
		justify-content: center;
	}

	.head :global(.caret) {
		flex: none;
		color: var(--text-faint);
		transition: transform var(--speed) var(--ease);
	}

	.row.open .head :global(.caret) {
		transform: rotate(180deg);
	}

	.detail {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-3);
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		animation: fade-in var(--speed-slow) var(--ease);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-4);
		margin: 0;
	}

	.facts dt {
		font-size: 0.82rem;
		color: var(--text-muted);
	}

	.facts dd {
		margin: 0;
		font-weight: 500;
	}

	form {
		display: grid;
		gap: var(--space-3);
		margin: 0;
	}

	.lines {
		background: var(--surface);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
	}

	.qty {
		width: 76px;
		text-align: right;
	}

	.field {
		display: grid;
		gap: 3px;
		max-width: 520px;
	}

	.options {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: var(--space-2);
		border: 1px solid var(--hairline);
		border-radius: var(--radius);
		background: var(--surface);
	}

	.options legend {
		padding: 0 4px;
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.option {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
	}

	.option-label {
		font-weight: 500;
	}

	.input {
		margin: 4px 0 0;
		padding: 6px 8px;
		font-size: 0.82rem;
		white-space: pre-wrap;
		overflow-x: auto;
		border-radius: var(--radius-sm);
		background: var(--surface-sunken);
		color: var(--text-muted);
	}

	.edit-note {
		max-width: 76ch;
		margin: 0;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	@media (max-width: 720px) {
		.chip.source {
			min-width: 0;
		}

		.head {
			flex-wrap: wrap;
			row-gap: 4px;
		}

		.what {
			flex-basis: 100%;
			order: 3;
		}

		.summary {
			white-space: normal;
		}
	}
</style>
