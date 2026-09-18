<script lang="ts">
	// One message. The original mail, its attachments, what the agent made of
	// it, the run's own record of every lookup, and the draft reply.
	//
	// The mail is shown as text and never as HTML, whatever the sender sent.
	import ShieldCheck from '@lucide/svelte/icons/shield-check';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import DraftCard from '$lib/components/desk/DraftCard.svelte';
	import { INTENT_LABEL, MESSAGE_STATUS_LABEL } from '$lib/desk/types';
	import { count, moment, percent } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const message = $derived(data.detail.message);
	const run = $derived(data.detail.runs[0] ?? null);
</script>

<svelte:head>
	<title>{message.subject || 'Message'} · Desk · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>{message.subject || '(no subject)'}</h1>
		<p class="faint small">
			{message.fromName ? `${message.fromName}, ` : ''}<span class="mono">{message.fromAddress}</span>
			to <span class="mono">{data.detail.toAddresses.join(', ')}</span>
			· {moment(message.receivedAt)} · {message.mailboxLabel}
		</p>
		<p class="tags">
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
				<a class="chip link" href="/accounts/{message.customerNo}">
					{message.customerName} ({message.customerNo})
				</a>
			{/if}
			{#if message.contactName}<span class="chip">{message.contactName}</span>{/if}
			{#if message.rfqDraftId}
				<a class="chip link" href="/rfq/{message.rfqDraftId}">Quote draft R-{message.rfqDraftId}</a>
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
			<p>{message.summary || 'Nobody has worked this message yet.'}</p>
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
				{#if run.lookups.length > 0}
					<details>
						<summary>Every lookup it made</summary>
						<table>
							<thead>
								<tr><th scope="col">Lookup</th><th scope="col" class="num">Rows</th><th scope="col" class="num">ms</th><th scope="col">Asked</th></tr>
							</thead>
							<tbody>
								{#each run.lookups as lookup, i (i)}
									<tr>
										<td class="mono">{lookup.name}</td>
										<td class="num">{lookup.rows}</td>
										<td class="num">{lookup.ms}</td>
										<td class="mono tiny">{JSON.stringify(lookup.input)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</details>
				{/if}
			{/if}
			{#if message.customerNo === null && message.vendorNo === null}
				<p class="notice warning" role="note">
					<TriangleAlert size={13} aria-hidden="true" />
					<span>Nothing was priced: this sender is not matched to an account.</span>
				</p>
			{/if}
		</div>
	</section>

	<section class="panel" aria-labelledby="original">
		<header class="panel-head">
			<h2 id="original">The email, as it arrived</h2>
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

	<section class="panel" aria-labelledby="reply">
		<header class="panel-head">
			<h2 id="reply">The draft reply</h2>
			<span class="chip"><ShieldCheck size={12} aria-hidden="true" />Nothing is sent until you approve</span>
		</header>
		{#if data.detail.drafts.length === 0}
			<p class="body muted">No reply was drafted for this message.</p>
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

	.small {
		font-size: 0.88rem;
	}

	.tiny {
		font-size: 0.78rem;
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
	.drafts {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.attachments {
		border-top: 1px solid var(--hairline);
		display: grid;
		gap: 4px;
	}

	.attachments li {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: baseline;
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

	details {
		margin-top: 4px;
	}

	summary {
		cursor: pointer;
		color: var(--text-muted);
		font-size: 0.88rem;
	}

	details table {
		margin-top: var(--space-2);
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
