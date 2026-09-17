<script lang="ts">
	// RFQ intake: paste or upload a customer's email, and the server reads it
	// into a draft, checks it against the book and opens it for review.
	import { enhance } from '$app/forms';
	import Lock from '@lucide/svelte/icons/lock';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import DraftListSkeleton from '$lib/components/rfq/DraftListSkeleton.svelte';
	import { moment } from '$lib/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let email = $state('');
	let sampleName = $state('');
	let reading = $state(false);
	let unlocking = $state(false);

	const liveMessage = $derived(form && 'liveMessage' in form ? form.liveMessage : null);
	const extractMessage = $derived(form && 'message' in form ? form.message : null);

	function loadSample(name: string) {
		const sample = data.samples.find((s) => s.name === name);
		email = sample?.text ?? '';
		sampleName = sample?.name ?? '';
	}

	const STATUS_LABEL = { draft: 'Draft', approved: 'Approved', rejected: 'Rejected' } as const;
</script>

<svelte:head>
	<title>RFQ intake · Northline</title>
</svelte:head>

<main class="page">
	<header class="head">
		<h1>RFQ intake</h1>
		<p class="faint">
			Paste a customer's email asking for parts. It is read into a draft, every field is checked against the
			catalog and the customer's account, and nothing is created until you approve it.
		</p>
	</header>

	<section class="panel" aria-labelledby="new-request">
		<header class="panel-head">
			<h2 id="new-request">New request</h2>
			{#if data.live.unlocked}
				<span class="chip live"><Sparkles size={12} aria-hidden="true" />Live: {data.live.model}</span>
			{:else}
				<span class="chip">Rules extractor</span>
			{/if}
		</header>

		<form
			method="POST"
			action="?/extract"
			enctype="multipart/form-data"
			class="body intake"
			use:enhance={() => {
				reading = true;
				return async ({ update }) => {
					await update({ reset: false });
					reading = false;
				};
			}}
		>
			<input type="hidden" name="requestId" value={data.requestId} />
			<input type="hidden" name="sampleName" value={sampleName} />

			<div class="row">
				<label class="sample">
					<span>Load a sample <span class="faint">(invented emails from the eval set)</span></span>
					<select onchange={(e) => loadSample(e.currentTarget.value)} value={sampleName}>
						<option value="">Choose one...</option>
						{#each data.samples as s (s.name)}
							<option value={s.name}>{s.name.slice(0, 2)}. {s.label}</option>
						{/each}
					</select>
				</label>
				<label class="file">
					<span>Or upload a .txt or .eml file</span>
					<input type="file" name="file" accept=".txt,.eml,text/plain,message/rfc822" />
				</label>
			</div>

			<label>
				<span>Email, with its From, Subject and Date lines if you have them</span>
				<textarea
					name="email"
					rows="14"
					class="mono"
					spellcheck="false"
					placeholder={'From: Buyer <buyer@shop.example>\nSubject: quote\nDate: Wed, 16 Sep 2026 09:00:00 -0500\n\nPlease quote 4 S6-96BC by Oct 2.'}
					bind:value={email}
					oninput={() => (sampleName = '')}
				></textarea>
			</label>

			<p class="faint small">PDF attachments are out of scope for now: paste the text of the request instead.</p>

			{#if extractMessage}
				<p class="notice error" role="alert">{extractMessage}</p>
			{/if}

			<div class="actions">
				<button class="button primary" disabled={reading} aria-busy={reading}>
					{#if reading}<span class="spinner" aria-hidden="true"></span>{/if}
					{reading ? 'Reading...' : 'Read and check'}
				</button>
				<span class="faint small">
					{#if data.live.unlocked}
						Claude reads the email; code checks the result.
					{:else}
						The rules extractor reads the email; no AI is called.
					{/if}
				</span>
			</div>
		</form>

		<div class="body live-mode">
			{#if !data.live.configured}
				<p class="faint small">
					Live mode is off on this server (no API key is set), so the rules extractor reads every email.
				</p>
			{:else if data.live.unlocked}
				<form method="POST" action="?/lock" use:enhance class="inline">
					<span class="small muted">Live mode is on for you. Each email read costs API credit.</span>
					<button class="button quiet">Turn off</button>
				</form>
			{:else}
				<form
					method="POST"
					action="?/unlock"
					class="inline"
					use:enhance={() => {
						unlocking = true;
						return async ({ update }) => {
							await update();
							unlocking = false;
						};
					}}
				>
					<Lock size={13} aria-hidden="true" />
					<label class="inline-label" for="passphrase">Live mode passphrase</label>
					<input id="passphrase" name="passphrase" type="password" autocomplete="off" required />
					<button class="button" disabled={unlocking}>Unlock for an hour</button>
				</form>
			{/if}
			{#if liveMessage}
				<p class="small" class:error-text={form && 'liveOk' in form && !form.liveOk} role="status">
					{liveMessage}
				</p>
			{/if}
		</div>
	</section>

	<section class="panel" aria-labelledby="recent">
		<header class="panel-head">
			<h2 id="recent">Your recent drafts</h2>
		</header>
		{#await data.drafts}
			<DraftListSkeleton />
		{:then drafts}
			{#if drafts.length === 0}
				<p class="body muted">No drafts yet. Load a sample above to see how it works.</p>
			{:else}
				<ul class="drafts">
					{#each drafts as d (d.id)}
						<li>
							<a href="/rfq/{d.id}" class="pressable-row">
								<span class="mono id">R-{d.id}</span>
								<span class="what">
									<span class="name">{d.customerName ?? 'Customer not settled'}</span>
									<span class="faint small">{d.sourceName} · {d.lines} {d.lines === 1 ? 'line' : 'lines'} · {d.extractor}</span>
								</span>
								{#if d.status === 'draft' && d.needsReview > 0}
									<span class="chip warn">{d.needsReview} to review</span>
								{:else}
									<span class="chip state {d.status}">{STATUS_LABEL[d.status]}</span>
								{/if}
								<span class="faint small when">{moment(d.createdAt)}</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		{:catch}
			<p class="body notice error" role="alert">Your drafts could not be loaded. Reload the page to try again.</p>
		{/await}
	</section>
</main>

<style>
	.page {
		max-width: 880px;
		margin: 0 auto;
		padding: var(--space-5) var(--space-4) var(--space-6);
		display: grid;
		gap: var(--space-3);
	}

	.head {
		display: grid;
		gap: 4px;
	}

	.head p {
		max-width: 72ch;
	}

	.body {
		padding: var(--space-3);
	}

	.intake {
		display: grid;
		gap: var(--space-3);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-3);
	}

	.row label {
		flex: 1 1 240px;
	}

	.file input {
		padding: 3px;
	}

	.small {
		font-size: 0.88rem;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}

	.live-mode {
		display: grid;
		gap: 6px;
		border-top: 1px solid var(--hairline);
		background: var(--surface-sunken);
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin: 0;
		color: var(--text-muted);
	}

	.inline-label {
		display: inline;
	}

	.inline input {
		height: var(--control-h);
		width: 200px;
	}

	.error-text {
		color: var(--danger);
	}

	.chip.live {
		color: var(--text);
	}

	.chip.state.approved {
		color: var(--status-kept);
	}

	.chip.state.rejected {
		color: var(--status-broken);
	}

	.drafts {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.drafts li + li {
		border-top: 1px solid var(--hairline);
	}

	.pressable-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 44px;
		padding: 6px var(--space-3);
		transition:
			background-color var(--speed) var(--ease),
			transform var(--speed) var(--ease);
	}

	.pressable-row:hover {
		background: var(--surface-hover);
	}

	.pressable-row:active {
		background: var(--surface-press);
	}

	.drafts li:last-child .pressable-row {
		border-radius: 0 0 var(--radius-lg) var(--radius-lg);
	}

	.id {
		flex: none;
		width: 56px;
		color: var(--text-muted);
	}

	.what {
		flex: 1;
		min-width: 0;
		display: grid;
	}

	.what > span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.name {
		font-weight: 500;
	}

	.when {
		flex: none;
		white-space: nowrap;
	}

	.spinner {
		width: 11px;
		height: 11px;
		border-radius: 50%;
		border: 1.5px solid currentColor;
		border-top-color: transparent;
		animation: spin 700ms linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 720px) {
		.page {
			padding: var(--space-3);
		}

		.when {
			display: none;
		}
	}
</style>
