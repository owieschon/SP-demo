<script lang="ts">
	/*
	  The quotes behind a commitment, newest version first, with what changed
	  between versions and why, and how each version ended.

	  No chart: this is a history, and a history is a list. The figure that
	  matters is each version's total next to the one before it, which the
	  change line states in words.
	*/
	import { day, money, moneyExact, percent } from '$lib/format';
	import { QUOTE_OUTCOME_LABEL, type QuoteHistory } from './types';

	let { quotes, year }: { quotes: QuoteHistory[]; year: number } = $props();

	/** Which version's lines are open. Only one at a time, like a disclosure. */
	let openRevision = $state<number | null>(null);

	function toggle(id: number) {
		openRevision = openRevision === id ? null : id;
	}
</script>

<section class="panel" aria-labelledby="quote-history">
	<header class="panel-head">
		<h2 id="quote-history">Quotes</h2>
		<span class="t-meta muted">Every version, with what moved between them</span>
	</header>

	{#if quotes.length === 0}
		<p class="empty">
			<span>No quote on file. This customer buys on a standing arrangement, or nobody has priced it yet.</span>
		</p>
	{:else}
		<ul class="quotes">
			{#each quotes as quote (quote.id)}
				<li class="quote">
					<div class="quote-head">
						<a class="link mono" href="/quotes/{quote.id}">SQ-{quote.id}</a>
						<span class="outcome" style:--tone="var(--quote-{quote.outcome})">
							{QUOTE_OUTCOME_LABEL[quote.outcome]}{#if quote.lostReason}, {quote.lostReason}{/if}
						</span>
						<span class="muted t-meta">
							{day(quote.quotedOn, year)}
							{#if quote.versions > 1}· {quote.versions} versions{/if}
							{#if !quote.linked}· written for the same account, not this commitment{/if}
						</span>
						<span class="num push">{money(quote.total)}</span>
					</div>

					<ol class="revisions">
						{#each quote.revisions as revision (revision.id)}
							<li class:latest={revision.isLatest}>
								<div class="rev-head">
									<span class="version">v{revision.version}</span>
									<span class="reason">{revision.changeReason}</span>
									<span class="muted t-meta">
										{day(revision.revisedOn, year)} · {revision.sentByName}
										{#if revision.validUntil}
											· {revision.stillValid ? 'valid to' : 'ran out'}
											{day(revision.validUntil, year)}
										{/if}
									</span>
									<span class="num push">{money(revision.total)}</span>
									<button
										class="chip"
										aria-expanded={openRevision === revision.id}
										onclick={() => toggle(revision.id)}
									>
										{revision.lineCount} lines
									</button>
								</div>

								{#if revision.outcome !== 'superseded' || revision.outcomeNote}
									<p class="verdict">
										<span class="outcome" style:--tone="var(--quote-{revision.outcome})">
											{QUOTE_OUTCOME_LABEL[revision.outcome]}
										</span>
										{#if revision.outcomeReason}<span class="muted">on {revision.outcomeReason}</span>{/if}
										{#if revision.decidedOn}<span class="muted t-meta">{day(revision.decidedOn, year)}</span>{/if}
										{#if revision.outcomeNote}<span class="note">{revision.outcomeNote}</span>{/if}
									</p>
								{/if}

								{#if revision.changeNote}
									<p class="muted why">{revision.changeNote}</p>
								{/if}

								{#if revision.changes.length > 0}
									<ul class="changes">
										{#each revision.changes as change, i (i)}
											<li>{change.text}</li>
										{/each}
									</ul>
								{/if}

								{#if openRevision === revision.id}
									<div class="table-wrap">
										<table>
											<caption class="sr-only">Lines on version {revision.version} of quote SQ-{quote.id}</caption>
											<thead>
												<tr>
													<th scope="col">Item</th>
													<th scope="col">Description</th>
													<th scope="col" class="num">Qty</th>
													<th scope="col" class="num">Each</th>
													<th scope="col" class="num">Extended</th>
													<th scope="col">Priced off</th>
													<th scope="col" class="num">Lead days</th>
												</tr>
											</thead>
											<tbody>
												{#each revision.lines as line (line.lineNo)}
													<tr>
														<td class="mono">{line.itemNo}</td>
														<td>{line.description}</td>
														<td class="num">{line.quantity}</td>
														<td class="num">{moneyExact(line.unitPrice)}</td>
														<td class="num">{money(line.extended)}</td>
														<td class="muted">{line.priceRule ?? 'not recorded'}</td>
														<td class="num">{line.leadDays ?? '·'}</td>
													</tr>
												{/each}
											</tbody>
										</table>
									</div>
								{/if}
							</li>
						{/each}
					</ol>

					{#if quote.revisions.length > 1}
						{@const newest = quote.revisions[0]}
						{@const oldest = quote.revisions[quote.revisions.length - 1]}
						<p class="muted summary t-meta">
							{#if oldest.total > 0 && newest.total !== oldest.total}
								Version {newest.version} is {percent(Math.abs(newest.total - oldest.total) / oldest.total)}
								{newest.total > oldest.total ? 'above' : 'below'} the first issue
								({money(oldest.total)} to {money(newest.total)}).
							{:else}
								The total never moved off {money(oldest.total)} across {quote.revisions.length} versions.
							{/if}
						</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>

<style>
	/* Quote outcomes borrow the commitment status colors, which already carry
	   the same meanings: won reads like kept, lost like broken. */
	.quote {
		--quote-open: var(--status-quoted);
		--quote-won: var(--status-kept);
		--quote-lost: var(--status-broken);
		--quote-expired: var(--status-pushed);
		--quote-superseded: var(--status-promised);
		--quote-withdrawn: var(--status-promised);
	}

	.quotes,
	.revisions,
	.changes {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.quote + .quote {
		border-top: 1px solid var(--hairline-strong);
	}

	.quote-head,
	.rev-head {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
		padding: 8px var(--space-3);
	}

	.quote-head {
		background: var(--surface-sunken);
	}

	.revisions li {
		padding-bottom: 6px;
	}

	.revisions li + li {
		border-top: 1px solid var(--hairline);
	}

	/* The version that counts gets the marker, not a color on its own. */
	.revisions li.latest {
		box-shadow: inset 2px 0 0 var(--hairline-strong);
	}

	.version {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.reason {
		font-weight: 500;
	}

	.outcome {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-weight: 500;
		white-space: nowrap;
	}

	.outcome::before {
		content: '';
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: color-mix(in srgb, var(--tone) 30%, transparent);
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}

	.verdict {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0 var(--space-3) 2px;
	}

	.why,
	.summary {
		margin: 0;
		padding: 0 var(--space-3) 2px;
	}

	.note {
		color: var(--text-muted);
	}

	.changes {
		padding: 2px var(--space-3) 4px;
		display: grid;
		gap: 1px;
		font-size: var(--fs-meta);
		color: var(--text-muted);
	}

	.changes li::before {
		content: '→ ';
		color: var(--text-faint);
	}

	.push {
		margin-left: auto;
	}

	.table-wrap {
		overflow-x: auto;
		border-top: 1px solid var(--hairline);
		margin-top: 4px;
	}
</style>
