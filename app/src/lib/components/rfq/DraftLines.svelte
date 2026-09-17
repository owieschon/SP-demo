<script lang="ts">
	// The requested lines: what the email said, what it resolved to, and
	// each check. Lines that need review offer the fixes a person can make:
	// pick a suggested part (or type one), set a quantity, quote at our
	// price, or remove the line.
	import { moneyExact } from '$lib/format';
	import type { ValidatedLine } from '$lib/server/rfq/schema';
	import ChangeForm from './ChangeForm.svelte';
	import CheckBadge from './CheckBadge.svelte';

	let {
		lines,
		draftId,
		updatedAt,
		requestId,
		editable
	}: {
		lines: ValidatedLine[];
		draftId: number;
		updatedAt: string;
		requestId: string;
		editable: boolean;
	} = $props();

	const form = $derived({ draftId, updatedAt, requestId });

	function asWritten(line: ValidatedLine): string {
		if (line.quantity_as_written === null) return 'no quantity';
		return line.unit_as_written ? `${line.quantity_as_written} ${line.unit_as_written}` : String(line.quantity_as_written);
	}
</script>

<div class="table-wrap">
	<table>
		<thead>
			<tr>
				<th>As written</th>
				<th>Part</th>
				<th class="num">Qty</th>
				<th class="num">Unit price</th>
				<th class="num">Line total</th>
				<th>Price check</th>
			</tr>
		</thead>
		<tbody>
			{#each lines as line (line.index)}
				{@const attention =
					!line.removed &&
					[line.item_check, line.quantity_check, line.price_check].some((c) => c.status === 'needs_review')}
				<tr class:removed={line.removed} class:attention>
					<td data-label="As written" class="written">
						<div class="stack">
							<span class="mono">{line.item_as_written ?? 'no part number'}</span>
							<span class="faint raw" title={line.raw_text}>{line.raw_text}</span>
						</div>
					</td>

					{#if line.removed}
						<td colspan="5" class="removed-note">
							<span class="muted">Removed; it will not be quoted.</span>
							{#if editable}
								<ChangeForm {...form} change="restore_line" line={line.index} label="Restore line {line.index + 1}">
									{#snippet children({ saving })}
										<button class="button quiet" disabled={saving}>Restore</button>
									{/snippet}
								</ChangeForm>
							{/if}
						</td>
					{:else}
						<td data-label="Part" class="part">
							<div class="stack">
								{#if line.item_no}
									<span class="mono">{line.item_no}</span>
									<span class="muted desc">{line.description}</span>
								{/if}
								<CheckBadge check={line.item_check} compact={line.item_check.status === 'ok'} />

								{#if editable && line.item_check.status === 'needs_review'}
									{#if line.suggestions.length > 0}
										<ul class="suggestions" aria-label="Suggested parts">
											{#each line.suggestions as s (s.item_no)}
												<li>
													<ChangeForm {...form} change="item" line={line.index} label="Use {s.item_no}">
														{#snippet children({ saving })}
															<input type="hidden" name="itemNo" value={s.item_no} />
															<button class="suggestion pressable" disabled={saving}>
																<span class="mono">{s.item_no}</span>
																<span class="muted">{s.description}</span>
																<span class="faint why">{s.why}</span>
															</button>
														{/snippet}
													</ChangeForm>
												</li>
											{/each}
										</ul>
									{/if}
									<ChangeForm {...form} change="item" line={line.index} label="Type a part number for line {line.index + 1}">
										{#snippet children({ saving })}
											<input
												name="itemNo"
												class="mono small-input"
												placeholder="Part number"
												aria-label="Part number"
												required
												maxlength="40"
												autocomplete="off"
											/>
											<button class="button" disabled={saving}>Use</button>
										{/snippet}
									</ChangeForm>
								{/if}
							</div>
						</td>

						<td data-label="Qty" class="num qty">
							<div class="stack">
								<span class="figure">{line.quantity ?? '?'}</span>
								{#if line.unit_as_written || line.quantity_check.status !== 'ok'}
									<span class="faint small">written: {asWritten(line)}</span>
								{/if}
								<CheckBadge check={line.quantity_check} compact={line.quantity_check.status === 'ok'} />
								{#if editable && line.quantity_check.status === 'needs_review'}
									<ChangeForm {...form} change="quantity" line={line.index} label="Set the quantity for line {line.index + 1}">
										{#snippet children({ saving })}
											<input
												name="quantity"
												type="number"
												min="1"
												max="10000"
												step="1"
												required
												class="small-input qty-input"
												aria-label="Quantity in pieces"
												value={line.quantity ?? ''}
											/>
											<button class="button" disabled={saving}>Set</button>
										{/snippet}
									</ChangeForm>
								{/if}
							</div>
						</td>

						<td data-label="Unit price" class="num">
							<div class="stack">
								{#if line.unit_price !== null}
									<span class="figure">{moneyExact(line.unit_price)}</span>
								{:else}
									<span class="faint">·</span>
								{/if}
								{#if line.stated_unit_price !== null}
									<span class="faint small">they wrote {moneyExact(line.stated_unit_price)}</span>
								{/if}
							</div>
						</td>

						<td data-label="Line total" class="num">
							<div class="stack">
								{#if line.line_total !== null}
									<span class="figure">{moneyExact(line.line_total)}</span>
								{:else}
									<span class="faint">·</span>
								{/if}
								{#if line.stated_line_total !== null}
									<span class="faint small">they wrote {moneyExact(line.stated_line_total)}</span>
								{/if}
							</div>
						</td>

						<td data-label="Price check" class="price">
							<div class="stack">
								<CheckBadge check={line.price_check} />
								<!-- What the late-order forecast says about shipping it in time.
								     Information only: it never blocks approval. -->
								{#if line.supply}
									<span class="faint small supply">{line.supply}</span>
								{/if}
								{#if editable}
									<div class="line-actions">
										{#if line.price_check.status === 'needs_review'}
											<ChangeForm {...form} change="accept_price" line={line.index} label="Quote line {line.index + 1} at our price">
												{#snippet children({ saving })}
													<button class="button" disabled={saving}>Quote at our price</button>
												{/snippet}
											</ChangeForm>
										{/if}
										<ChangeForm {...form} change="remove_line" line={line.index} label="Remove line {line.index + 1}">
											{#snippet children({ saving })}
												<button class="button quiet" disabled={saving}>Remove line</button>
											{/snippet}
										</ChangeForm>
									</div>
								{/if}
							</div>
						</td>
					{/if}
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<style>
	.table-wrap {
		overflow-x: auto;
	}

	td {
		vertical-align: top;
		padding-top: 8px;
		padding-bottom: 8px;
	}

	/* A row that needs a person gets a quiet amber edge. */
	tr.attention td:first-child {
		box-shadow: inset 2px 0 0 var(--status-pushed);
	}

	tr.removed {
		opacity: 0.6;
	}

	/* Everything in a cell stacks, with a little air between. */
	.stack {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.num .stack {
		justify-items: end;
	}

	.written {
		max-width: 220px;
	}

	.raw {
		font-size: 0.85rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.desc,
	/* The supply note can be a sentence; let it wrap in its cell. */
	.supply {
		max-width: 32ch;
		white-space: normal;
	}

	.small {
		font-size: 0.85rem;
	}

	.figure {
		font-weight: 500;
	}

	.removed-note {
		color: var(--text-muted);
	}

	.removed-note :global(form) {
		display: inline-flex;
		margin-left: var(--space-2);
	}

	.suggestions {
		list-style: none;
		margin: 2px 0;
		padding: 0;
		display: grid;
		gap: 4px;
	}

	.suggestion {
		display: grid;
		grid-template-columns: auto 1fr;
		column-gap: 8px;
		width: 100%;
		padding: 5px 8px;
		border: 1px solid var(--hairline-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		transition:
			background-color var(--speed) var(--ease),
			border-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.suggestion:hover:not(:disabled) {
		background: var(--surface-hover);
		border-color: var(--text-faint);
	}

	.suggestion .why {
		grid-column: 1 / -1;
		font-size: 0.82rem;
	}

	.small-input {
		height: var(--control-h);
		width: 130px;
	}

	.qty-input {
		width: 80px;
		text-align: right;
	}

	.qty :global(form) {
		justify-content: flex-end;
	}

	.line-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	/* On a phone each line becomes a small card of labelled fields. */
	@media (max-width: 720px) {
		thead {
			display: none;
		}

		table,
		tbody,
		tr,
		td {
			display: block;
			width: 100%;
		}

		tr {
			padding: var(--space-2) 0;
			border-bottom: 1px solid var(--hairline);
		}

		tbody tr:last-child {
			border-bottom: 0;
		}

		td {
			height: auto;
			border: 0;
			padding: 4px var(--space-3);
			text-align: left;
		}

		td.num {
			text-align: left;
		}

		.num .stack {
			justify-items: start;
		}

		td[data-label]::before {
			content: attr(data-label);
			display: block;
			font-size: 0.78rem;
			color: var(--text-faint);
		}

		.written {
			max-width: none;
		}

		.qty :global(form) {
			justify-content: flex-start;
		}

		tr.attention td:first-child {
			box-shadow: none;
		}

		tr.attention {
			box-shadow: inset 2px 0 0 var(--status-pushed);
		}
	}
</style>
