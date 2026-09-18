<script lang="ts">
	// One desk item. How it arrived, what the agent made of it, the trail of
	// everything it did, the document it read with the reading beside it, and
	// the draft reply.
	//
	// The mail is shown as text and never as HTML, whatever the sender sent.
	import PhoneIncoming from '@lucide/svelte/icons/phone-incoming';
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import RunTrail from '$lib/components/agentruns/RunTrail.svelte';
	import DraftCard from '$lib/components/desk/DraftCard.svelte';
	import Attachments from '$lib/components/rfq/Attachments.svelte';
	import CheckBadge from '$lib/components/rfq/CheckBadge.svelte';
	import DraftLines from '$lib/components/rfq/DraftLines.svelte';
	import { INTENT_LABEL, MESSAGE_STATUS_LABEL } from '$lib/desk/types';
	import { count, moment, percent } from '$lib/format';
	import { routes } from '$lib/routes';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const message = $derived(data.detail.message);
	const run = $derived(data.detail.runs[0] ?? null);
	const trails = $derived(data.runs);
	const request = $derived(data.request);
	// Where each extracted line came from, lined up with the validated lines
	// by position, the same way the quote request page does it.
	const sources = $derived(request ? request.draft.lines.map((line) => line.source ?? null) : []);
	const unmatched = $derived(
		request ? request.validation.lines.filter((line) => !line.removed && line.item_no === null) : []
	);
</script>

<svelte:head>
	<title>{message.subject || 'Desk item'} · Desk · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>{message.subject || '(no subject)'}</h1>
		<p class="faint small">
			{message.fromName ? `${message.fromName}, ` : ''}<span class="mono">{message.fromAddress}</span>
			{#if data.item.source === 'person'}
				· typed at the desk{data.item.enteredByName ? ` by ${data.item.enteredByName}` : ''}
			{:else}
				to <span class="mono">{data.detail.toAddresses.join(', ')}</span>
			{/if}
			· {moment(message.receivedAt)} · {message.mailboxLabel}
		</p>
		<p class="tags">
			<span class="chip source">
				{#if data.item.source === 'person'}
					<PhoneIncoming size={12} aria-hidden="true" />Entered by a person
				{:else}
					Arrived as mail
				{/if}
			</span>
			{#if message.intent}
				<span class="chip">
					{INTENT_LABEL[message.intent]}
					{#if message.intentConfidence !== null}
						<span class="faint">{percent(message.intentConfidence)} sure</span>
					{/if}
				</span>
			{/if}
			<span class="chip state {message.status}">{MESSAGE_STATUS_LABEL[message.status]}</span>
			{#if message.customerNo}
				<a class="chip link" href={routes.account(message.customerNo)}>
					{message.customerName} ({message.customerNo})
				</a>
			{/if}
			{#if message.contactName}<span class="chip">{message.contactName}</span>{/if}
			{#if message.rfqDraftId}
				<a class="chip link" href={routes.quoteRequest(message.rfqDraftId)}>
					Quote request R-{message.rfqDraftId}
				</a>
			{/if}
		</p>
	</header>

	{#if form?.message}
		<p class="notice" role="status">{form.message}</p>
	{/if}

	<section class="panel" aria-labelledby="found">
		<header class="panel-head">
			<h2 id="found">What the agent made of it</h2>
			{#if run}<span class="chip">{run.mode === 'mock' ? 'scripted demo model' : run.model}</span>{/if}
		</header>
		<div class="body found">
			<p>{message.summary || 'Nobody has worked this item yet.'}</p>
			{#if message.matchReason}
				<p class="faint small">{message.matchReason}</p>
			{/if}
			{#if run}
				<p class="faint small">
					{count(run.lookupCount)} {run.lookupCount === 1 ? 'lookup' : 'lookups'},
					{run.rounds} {run.rounds === 1 ? 'round' : 'rounds'},
					{run.inputTokens + run.outputTokens === 0
						? 'no model tokens'
						: `${count(run.inputTokens + run.outputTokens)} tokens`}.
					Run {run.id}, {run.finishedAt ? `finished ${moment(run.finishedAt)}` : 'still running'}.
				</p>
				{#if run.error}
					<p class="notice error" role="alert">{run.error}</p>
				{/if}
			{/if}
			{#if message.customerNo === null && message.vendorNo === null}
				<p class="notice warning" role="note">
					<TriangleAlert size={13} aria-hidden="true" />
					<span>Nothing was priced: this sender is not matched to an account.</span>
				</p>
			{/if}
		</div>

		<!--
			The trail. This is what makes approving without doing the work
			again reasonable: every lookup, every decision, and everything the
			agent would not do with the rule that stopped it.
		-->
		<div class="body trails">
			{#if trails.length === 0}
				<p class="muted small">No run trail was recorded for this item.</p>
			{:else}
				{#each trails as trail, i (trail.id)}
					<RunTrail
						run={trail}
						open={i === 0 && trail.refusals > 0}
						heading={i === 0 ? 'What the agent did, step by step' : `An earlier run, ${moment(trail.startedAt)}`}
					/>
				{/each}
			{/if}
		</div>
	</section>

	{#if request}
		<!--
			The evidence: the file as it arrived beside the agent's reading of
			it. Which line came from which sheet and row, what the checks
			accepted, what they could not match, and therefore what the agent
			did not assume.
		-->
		<section class="panel" aria-labelledby="evidence">
			<header class="panel-head">
				<h2 id="evidence">What it read, and what it checked</h2>
				<span class="chip">
					{request.validation.lines.length}
					{request.validation.lines.length === 1 ? 'line' : 'lines'}
					{#if request.validation.needs_review > 0}
						· <span class="warn">{request.validation.needs_review} need a person</span>
					{/if}
				</span>
			</header>

			{#if request.attachments.length > 0}
				<div class="sub">
					<h3>What arrived</h3>
					<Attachments attachments={request.attachments} draftId={request.id} />
				</div>
			{/if}

			<div class="sub">
				<h3>
					The account it settled on
					<CheckBadge check={request.validation.customer.check} compact />
				</h3>
				<p class="body small">{request.validation.customer.check.reason}</p>
			</div>

			<div class="sub">
				<h3>
					The lines it took out of it
					<CheckBadge check={request.validation.lines_check} compact />
				</h3>
				{#if request.validation.lines.length === 0}
					<p class="body muted">{request.validation.lines_check.reason}</p>
				{:else}
					<DraftLines
						lines={request.validation.lines}
						{sources}
						draftId={request.id}
						updatedAt={request.updatedAt}
						requestId={data.requestId}
						editable={false}
					/>
				{/if}
			</div>

			{#if unmatched.length > 0}
				<div class="sub">
					<h3>What it would not assume</h3>
					<ul class="body unmatched">
						{#each unmatched as line (line.index)}
							<li>
								<span class="mono">{line.item_as_written ?? 'no part number'}</span>
								<span class="faint small">{line.item_check.reason}</span>
							</li>
						{/each}
					</ul>
				</div>
			{/if}

			<p class="body rules faint small">
				Nothing is created from this until somebody approves it.
				<a class="link" href={routes.quoteRequest(request.id)}>
					Open quote request R-{request.id}
				</a>
				to fix a line, approve it or reject it.
			</p>
		</section>
	{:else if message.rfqDraftId !== null}
		<p class="notice" role="note">
			This item became quote request R-{message.rfqDraftId}, which was made for somebody else, so it is not
			shown here.
		</p>
	{/if}

	<section class="panel" aria-labelledby="original">
		<header class="panel-head">
			<h2 id="original">
				{data.item.source === 'person' ? 'The request, as it was typed' : 'The email, as it arrived'}
			</h2>
			{#if data.detail.attachments.length > 0}
				<span class="chip">{data.detail.attachments.length} attached</span>
			{/if}
		</header>
		<!-- Text, never rendered HTML: this is somebody else's writing. -->
		<pre class="body mail">{data.detail.bodyText}</pre>
		{#if data.detail.attachments.length > 0}
			<ul class="body attachments">
				{#each data.detail.attachments as attachment (attachment.id)}
					<li>
						<span class="mono">{attachment.fileName}</span>
						<span class="faint small">
							{attachment.mediaType}, {count(attachment.sizeBytes)} bytes
							{#if attachment.documentAttachmentId}· parsed{/if}
						</span>
					</li>
				{/each}
			</ul>
		{/if}
	</section>

	{#if data.item.source === 'person' && data.detail.drafts.length === 0}
		<p class="notice" role="note">
			No reply was drafted, because nobody emailed in. Quote this from the request above.
		</p>
	{:else}
		<section class="panel" aria-labelledby="reply">
			<header class="panel-head">
				<h2 id="reply">The draft reply</h2>
				<span class="chip"><ShieldCheck size={12} aria-hidden="true" />Nothing is sent until you approve</span>
			</header>
			{#if data.detail.drafts.length === 0}
				<p class="body muted">No reply was drafted for this item.</p>
			{:else}
				<ul class="drafts">
					{#each data.detail.drafts as draft (draft.id)}
						<li><DraftCard {draft} requestId={data.requestId} showMessageLink={false} /></li>
					{/each}
				</ul>
			{/if}
			<p class="body rules faint small">
				{data.allowlist.describe}
				{#if !data.provider.live}
					This server has no mail key, so approving records a simulated send and nothing leaves the building.
				{/if}
			</p>
		</section>
	{/if}
</main>

<style>
	.page {
		max-width: 1000px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: 5px;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}

	.chip.source {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.body {
		padding: var(--space-3);
	}

	.found {
		display: grid;
		gap: 6px;
	}

	.found p {
		max-width: 84ch;
	}

	.trails {
		border-top: 1px solid var(--hairline);
		display: grid;
		gap: var(--space-2);
	}

	.sub {
		border-top: 1px solid var(--hairline);
	}

	.sub h3 {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 8px var(--space-3) 0;
		font-size: 0.92rem;
		font-weight: 500;
	}

	.small {
		font-size: 0.88rem;
	}

	.warn {
		color: var(--warning);
	}

	.mail {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.85rem;
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.attachments,
	.drafts,
	.unmatched {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.attachments {
		border-top: 1px solid var(--hairline);
		display: grid;
		gap: 4px;
	}

	.attachments li,
	.unmatched li {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
	}

	.unmatched {
		display: grid;
		gap: 4px;
	}

	.drafts li + li {
		border-top: 1px solid var(--hairline);
	}

	.rules {
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
		max-width: none;
	}

	.chip.state.needs_person {
		background: var(--warning-soft);
		color: var(--warning);
	}

	.chip.state.drafted {
		color: var(--status-delivering);
	}

	@media (max-width: 860px) {
		.page {
			padding: var(--space-3);
		}
	}
</style>
