<script lang="ts">
	// One quote request: what arrived, what was read out of it, what the
	// checks decided, the fixes a person can make, and the proposal to
	// approve or reject. Approving is what creates the quote and the
	// commitment; until then nothing exists but this.
	import { invalidateAll } from '$app/navigation';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import RunTrail from '$lib/components/agentruns/RunTrail.svelte';
	import Attachments from '$lib/components/rfq/Attachments.svelte';
	import ChangeForm from '$lib/components/rfq/ChangeForm.svelte';
	import CheckBadge from '$lib/components/rfq/CheckBadge.svelte';
	import DraftLines from '$lib/components/rfq/DraftLines.svelte';
	import ProposalCard from '$lib/components/rfq/ProposalCard.svelte';
	import QuoteActions from '$lib/components/rfq/QuoteActions.svelte';
	import { day, moment, moneyExact, percent, place } from '$lib/format';
	import { routes } from '$lib/routes';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const d = $derived(data.draft);
	const v = $derived(d.validation);
	// Where each extracted line came from, kept on the draft rather than on
	// the validation, and lined up with the validated lines by position.
	const sources = $derived(d.draft.lines.map((line) => line.source ?? null));
	const editable = $derived(d.status === 'draft');
	const change = $derived({ draftId: d.id, updatedAt: d.updatedAt, requestId: data.requestIds.revise });
	const activeLines = $derived(v.lines.filter((l) => !l.removed));
	const failed = $derived(form !== null && form !== undefined && !('draftId' in form));

	const confidence = (value: number) => `${Math.round(value * 100)}% sure`;
</script>

<svelte:head>
	<title>R-{d.id} · Quote requests · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<div class="title-row">
			<h1>Quote request <span class="mono">R-{d.id}</span></h1>
			<span class="chip state {d.status}"
				>{d.status === 'draft' ? 'Draft' : d.status === 'approved' ? 'Approved' : 'Rejected'}</span
			>
		</div>
		<dl class="facts">
			<div>
				<dt>Came in as</dt>
				<dd>
					{#if data.item}
						<a class="link" href={routes.deskMessage(data.item.messageId)}>
							{data.item.source === 'person' ? 'a request typed at the desk' : 'mail at the order desk'}
						</a>
					{:else}
						{d.sourceName || 'a request with no desk item'}
					{/if}
				</dd>
			</div>
			<div>
				<dt>File</dt>
				<dd>{d.sourceName || 'no file'}</dd>
			</div>
			<div>
				<dt>Read by</dt>
				<dd>{d.extractor === 'claude' ? `Claude (${d.model})` : 'Rules extractor'}</dd>
			</div>
			<div>
				<dt>Made by</dt>
				<dd>{d.createdByName} · {moment(d.createdAt)}</dd>
			</div>
			{#if d.usage}
				<div>
					<dt>Tokens</dt>
					<dd title="{d.usage.input_tokens} in, {d.usage.output_tokens} out, {d.usage.cache_read_input_tokens} from cache">
						{d.usage.input_tokens + d.usage.output_tokens}
					</dd>
				</div>
			{/if}
		</dl>
	</header>

	{#if form?.message}
		<p class="notice" class:error={failed} role={failed ? 'alert' : 'status'}>
			<span>{form.message}</span>
			{#if 'conflict' in form && form.conflict}
				<button class="button" onclick={() => invalidateAll()}>Reload</button>
			{/if}
		</p>
	{/if}

	{#each v.warnings as warning (warning)}
		<p class="notice warning" role="note"><TriangleAlert size={14} aria-hidden="true" />{warning}</p>
	{/each}

	{#if d.status === 'approved'}
		<p class="notice done" role="status">
			<span>
				Approved by {d.decidedByName}{d.decidedAt ? ` on ${moment(d.decidedAt)}` : ''}. Quote
				<a class="link mono" href="/quotes/{d.quoteId}">SQ-{d.quoteId}</a> was created for commitment
				<a class="link mono" href="/commitments/{d.commitmentId}">C-{d.commitmentId}</a>.
			</span>
			<a class="button" href="/quotes/{d.quoteId}">Open the quote</a>
		</p>
	{:else if d.status === 'rejected'}
		<p class="notice" role="status">
			Rejected by {d.decidedByName}{d.decidedAt ? ` on ${moment(d.decidedAt)}` : ''}.
			{#if d.rejectReason}Reason: {d.rejectReason}{/if} Nothing was created.
		</p>
	{/if}

	{#if data.run}
		<!-- What the agent did to turn what arrived into this. -->
		<RunTrail run={data.run} heading="What the agent did to read this" />
	{/if}

	{#if d.attachments.length > 0}
		<section class="panel" aria-labelledby="files">
			<header class="panel-head">
				<h2 id="files">What arrived</h2>
				<span class="chip">{d.attachments.length} {d.attachments.length === 1 ? 'file' : 'files'}</span>
			</header>
			<Attachments attachments={d.attachments} draftId={d.id} />
		</section>
	{/if}

	<section class="panel" aria-labelledby="customer">
		<header class="panel-head">
			<h2 id="customer">Customer</h2>
			<CheckBadge check={v.customer.check} compact />
		</header>
		<div class="body grid">
			<div class="stack">
				{#if v.customer.customer_no}
					<p>
						<strong>{v.customer.name}</strong>
						<span class="mono faint">{v.customer.customer_no}</span>
						{#if v.customer.city}<span class="muted">· {place(v.customer.city, v.customer.state, 'US')}</span>{/if}
					</p>
					<p class="muted small">
						{v.customer.price_group_label}: {percent(v.customer.discount ?? 0)} off list
						{#if v.customer.contact_name}· buyer {v.customer.contact_name}{/if}
					</p>
				{:else}
					<p class="muted">Not settled yet.</p>
				{/if}
				<p class="small reason">{v.customer.check.reason}</p>

				{#if editable && v.customer.candidates.length > 0 && v.customer.check.status === 'needs_review'}
					<ChangeForm {...change} change="customer" label="Choose the customer account">
						{#snippet children({ saving })}
							<select name="customerNo" aria-label="Candidate accounts" required>
								{#each v.customer.candidates as c (c.customer_no)}
									<option value={c.customer_no} disabled={c.blocked || c.closed}>
										{c.name} ({c.customer_no}), {place(c.city, c.state, 'US')}{c.blocked
											? ', blocked'
											: c.closed
												? ', closed'
												: ''}
									</option>
								{/each}
							</select>
							<button class="button" disabled={saving}>Use this account</button>
						{/snippet}
					</ChangeForm>
				{/if}
				{#if editable && v.customer.check.status === 'needs_review'}
					<ChangeForm {...change} change="customer" label="Enter an account number">
						{#snippet children({ saving })}
							<input
								name="customerNo"
								class="mono account"
								placeholder="Account number"
								aria-label="Account number"
								required
								maxlength="20"
							/>
							<button class="button" disabled={saving}>Use</button>
						{/snippet}
					</ChangeForm>
				{/if}
			</div>

			<dl class="as-written">
				<div>
					<dt>Sender</dt>
					<dd>
						{d.draft.sender_email.value ?? 'unknown'}
						{#if d.draft.sender_email.value}<span class="faint">{confidence(d.draft.sender_email.confidence)}</span
							>{/if}
					</dd>
				</div>
				<div>
					<dt>Signed as</dt>
					<dd>{d.draft.customer_name.value ?? 'not given'}</dd>
				</div>
				<div>
					<dt>Branch named</dt>
					<dd>{d.draft.branch_hint.value ?? 'none'}</dd>
				</div>
			</dl>
		</div>
	</section>

	<section class="panel" aria-labelledby="lines">
		<header class="panel-head">
			<h2 id="lines">Requested parts</h2>
			<CheckBadge check={v.lines_check} compact />
		</header>
		{#if v.lines.length === 0}
			<p class="body muted">{v.lines_check.reason}</p>
		{:else}
			<DraftLines
				lines={v.lines}
				{sources}
				draftId={d.id}
				updatedAt={d.updatedAt}
				requestId={data.requestIds.revise}
				{editable}
			/>
		{/if}
	</section>

	<div class="two">
		<section class="panel" aria-labelledby="needed">
			<header class="panel-head">
				<h2 id="needed">Needed by</h2>
				<CheckBadge check={v.needed_by.check} compact />
			</header>
			<div class="body stack">
				<p class="figure">
					{v.needed_by.date ? day(v.needed_by.date, data.year) : 'No date'}
					{#if v.needed_by.text}<span class="faint small">written "{v.needed_by.text}"</span>{/if}
				</p>
				<p class="small reason">{v.needed_by.check.reason}</p>
				{#if editable}
					<ChangeForm {...change} change="needed_by" label="Set the needed-by date">
						{#snippet children({ saving })}
							<input
								type="date"
								name="neededBy"
								min={v.today}
								value={v.needed_by.date ?? ''}
								aria-label="Needed-by date"
								required
							/>
							<button class="button" disabled={saving}>Set date</button>
						{/snippet}
					</ChangeForm>
					<ChangeForm {...change} change="needed_by" label="Use no date">
						{#snippet children({ saving })}
							<input type="hidden" name="neededBy" value="" />
							<button class="button quiet" disabled={saving}>No date (90-day window)</button>
						{/snippet}
					</ChangeForm>
				{/if}
			</div>
		</section>

		<section class="panel" aria-labelledby="totals">
			<header class="panel-head">
				<h2 id="totals">Totals</h2>
				<CheckBadge check={v.totals.check} compact />
			</header>
			<div class="body stack">
				<p class="figure num left">
					{v.totals.subtotal === null ? 'Not priced yet' : moneyExact(v.totals.subtotal)}
					<span class="faint small"
						>our price, {activeLines.length} {activeLines.length === 1 ? 'line' : 'lines'}</span
					>
				</p>
				{#if v.totals.stated_subtotal !== null}
					<p class="small">They wrote {moneyExact(v.totals.stated_subtotal)}.</p>
				{/if}
				{#if v.totals.check.reason}<p class="small reason">{v.totals.check.reason}</p>{/if}
				{#if editable && v.totals.check.status === 'needs_review'}
					<ChangeForm {...change} change="accept_totals" label="Quote the lines and ignore their total">
						{#snippet children({ saving })}
							<button class="button" disabled={saving}>Quote the lines, ignore their total</button>
						{/snippet}
					</ChangeForm>
				{/if}
			</div>
		</section>
	</div>

	{#if d.draft.notes}
		<section class="panel" aria-labelledby="notes">
			<header class="panel-head"><h2 id="notes">Notes from the request</h2></header>
			<p class="body">{d.draft.notes}</p>
		</section>
	{/if}

	{#if editable && data.draftQuote && data.draftMail}
		<section class="panel" aria-labelledby="send">
			<header class="panel-head">
				<h2 id="send">Send it as a draft quote</h2>
				<span class="chip">Not approved</span>
			</header>
			<div class="body">
				<QuoteActions
					pdfUrl={routes.quoteRequestPdf(d.id)}
					mail={data.draftMail}
					lineCount={data.draftQuote.lineCount}
					subtotal={data.draftQuote.subtotal}
					fileName={data.draftQuote.fileName}
				/>
				<p class="faint small">
					The PDF is marked DRAFT QUOTE and says nothing has been approved. Approving below writes the real
					quote, with its own number.
				</p>
			</div>
		</section>
	{/if}

	{#if editable}
		<ProposalCard
			draftId={d.id}
			updatedAt={d.updatedAt}
			requestIds={{ approve: data.requestIds.approve, reject: data.requestIds.reject }}
			customerName={v.customer.name}
			lineCount={activeLines.length}
			total={v.totals.subtotal}
			neededBy={v.needed_by.date}
			needsReview={v.needs_review}
			year={data.year}
		/>
	{/if}

	<details class="panel source">
		<summary>The request as it was received</summary>
		<pre class="mono">{d.sourceText}</pre>
	</details>

	<p>
		<a class="link" href={data.item ? routes.deskMessage(data.item.messageId) : '/desk'}>
			{data.item ? 'Back to the desk item' : 'Back to the desk'}
		</a>
	</p>
</main>

<style>
	.page {
		max-width: 1080px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: var(--space-3);
		margin-bottom: var(--space-1);
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		flex-wrap: wrap;
	}

	.facts,
	.as-written {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-5);
		margin: 0;
	}

	.facts dt,
	.as-written dt {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.facts dd,
	.as-written dd {
		margin: 0;
	}

	.as-written {
		align-content: start;
	}

	.as-written dd .faint {
		margin-left: 4px;
		font-size: 0.85rem;
	}

	.body {
		padding: var(--space-3);
	}

	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3) var(--space-5);
	}

	.grid > * {
		flex: 1 1 300px;
	}

	.stack {
		display: grid;
		gap: 6px;
		align-content: start;
	}

	.small {
		font-size: 0.88rem;
	}

	.reason {
		color: var(--text-muted);
	}

	.figure {
		font-size: 1.15rem;
		font-weight: 600;
		letter-spacing: -0.01em;
	}

	.figure .small {
		font-weight: 400;
		letter-spacing: 0;
		margin-left: 4px;
	}

	.left {
		text-align: left;
	}

	.account {
		height: var(--control-h);
		width: 140px;
	}

	.two {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.two > * {
		flex: 1 1 320px;
	}

	.notice.done {
		justify-content: space-between;
		flex-wrap: wrap;
		border-color: color-mix(in srgb, var(--status-kept) 40%, var(--hairline));
	}

	.notice :global(svg) {
		flex: none;
	}

	.chip.state.approved {
		color: var(--status-kept);
	}

	.chip.state.rejected {
		color: var(--status-broken);
	}

	.source summary {
		padding: 8px var(--space-3);
		cursor: pointer;
		font-weight: 500;
		border-radius: var(--radius-lg);
		transition: background-color var(--speed) var(--ease);
	}

	.source summary:hover {
		background: var(--surface-hover);
	}

	.source pre {
		margin: 0;
		padding: var(--space-3);
		border-top: 1px solid var(--hairline);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 0.85rem;
		max-height: 420px;
		overflow: auto;
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
